import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { firefoxEndpoint, callFirefoxOwner, closeFirefoxOwner } from "../firefox-runtime.ts";

const browser = process.argv[2] && resolve(process.argv[2]);
const root = process.argv[3] && resolve(process.argv[3]);
if (!browser || !root) {
  throw new Error("usage: bun scripts/firefox-owner-smoke.mjs <browser> <new-test-directory> [--headed]");
}

await mkdir(root, { recursive: false });
const record = join(root, "owner.json");
const configPath = join(root, "firefox-config.json");
const stage = (name) => console.log(`firefox-owner-smoke:${name}`);
async function startManager() {
  const manager = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "firefox-owner-smoke-manager.mjs"),
    browser,
    join(root, "profile"),
    record,
    configPath,
    process.argv.includes("--headed") ? "headed" : "headless",
  ], { stdout: "ignore", stderr: "inherit" });
  if (await manager.exited !== 0) throw new Error("Firefox owner smoke manager did not exit cleanly");
  return JSON.parse(await readFile(record, "utf8"));
}
stage("launch");
const firstOwner = await startManager();

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Firefox owner proof</title><h1>Owner context fixture</h1>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
function startBridge(endpoint, mode) {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "firefox-owner-bridge-smoke-runner.mjs"),
    origin,
    mode,
  ], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  child.stdin.write(JSON.stringify({ endpoint }));
  child.stdin.end();
  return child;
}
async function runBridge(endpoint, mode) {
  const child = startBridge(endpoint, mode);
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error("Firefox bridge smoke runner did not exit cleanly");
  return JSON.parse(stdout);
}
async function holdBridge(endpoint) {
  const child = startBridge(endpoint, "hold");
  const reader = child.stdout.getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  if (done || new TextDecoder().decode(value).trim() !== "{\"ready\":true}") throw new Error("Firefox bridge smoke runner did not become ready");
  return child;
}
const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function requireExit(pid) {
  const deadline = Date.now() + 30_000;
  while (processAlive(pid) && Date.now() < deadline) await Bun.sleep(100);
  assert.equal(processAlive(pid), false, `process ${pid} did not stop`);
}
let owner;
try {
  owner = firstOwner;
  const savedConfig = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(savedConfig).sort(), ["config", "runtimeVersion", "version"]);
  assert.ok(Object.keys(savedConfig.config).length > 0, "generated config must not be empty");
  const endpoint = firefoxEndpoint(owner);
  assert.equal(endpoint.includes(owner.token), false, "the public endpoint hides the owner token");

  const status = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  assert.equal(status.generation, owner.generation);
  assert.equal(status.directory, join(root, "profile"));
  assert.equal(status.executablePath, browser);
  assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0);
  assert.ok(Number.isSafeInteger(status.browserPid) && status.browserPid > 0);

  const tools = await callFirefoxOwner(owner, "mcp-list", {}, { timeoutMs: 30_000 });
  assert.ok(tools.some((tool) => tool.name === "browser_snapshot"));
  assert.equal(tools.some((tool) => /pdf/i.test(tool.name)), false);
  const snapshot = await callFirefoxOwner(owner, "mcp-call", {
    name: "browser_snapshot",
    arguments: {},
  }, { timeoutMs: 30_000 });
  assert.notEqual(snapshot.isError, true, JSON.stringify(snapshot));

  stage("script");
  const bridge = await callFirefoxOwner(owner, "playwright-endpoint", {}, { timeoutMs: 30_000 });
  const run = await runBridge(bridge.endpoint, "write");
  assert.equal(run.stored, "saved");
  assert.equal(typeof run.identity.userAgent, "string");
  assert.deepEqual(run.identity.screen, [1920, 1080]);
  const hung = await holdBridge(bridge.endpoint);
  const duringHang = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  assert.equal(duringHang.hasPages, true, "owner remains responsive while an external runner is hung");
  hung.kill();
  await hung.exited;
  const afterHang = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  assert.equal(afterHang.hasPages, true, "external runner disconnect preserves the owner context and pages");
  assert.equal((await runBridge(bridge.endpoint, "verify")).stored, "saved");

  const beforeCapture = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  stage("capture");
  const session = JSON.parse(await callFirefoxOwner(owner, "session-capture", {
    captureSeed: { origins: [origin] },
  }, { timeoutMs: 30_000 }));
  assert.ok(session.cookies.some((cookie) => cookie.name === "owner-proof" && cookie.value === "saved"));
  assert.deepEqual(session.origins.find((entry) => entry.origin === origin)?.localStorage, [{ name: "owner-proof", value: "saved" }]);
  const afterCapture = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  assert.deepEqual(afterCapture.pageTargets, beforeCapture.pageTargets, "native closed-origin capture must not publish a page");

  stage("restore");
  await callFirefoxOwner(owner, "session-restore", { bundle: JSON.stringify(session), urls: [] }, { timeoutMs: 30_000 });
  const restored = await runBridge(bridge.endpoint, "verify");
  assert.equal(restored.stored, "saved");

  stage("close");
  await closeFirefoxOwner(owner, { timeoutMs: 30_000 });
  await requireExit(status.pid);
  await requireExit(status.browserPid);
  await assert.rejects(() => callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 }), { name: "FirefoxOwnerError" });
  owner = undefined;

  const configBeforeRestart = await readFile(configPath, "utf8");
  stage("reopen");
  owner = await startManager();
  firefoxEndpoint(owner);
  const restartStatus = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  assert.equal(restartStatus.generation, owner.generation);
  const restartBridge = await callFirefoxOwner(owner, "playwright-endpoint", {}, { timeoutMs: 30_000 });
  const restarted = await runBridge(restartBridge.endpoint, "verify");
  assert.deepEqual(restarted.identity, run.identity);
  assert.equal(restarted.stored, "saved");
  stage("close");
  await closeFirefoxOwner(owner, { timeoutMs: 30_000 });
  await requireExit(restartStatus.pid);
  await requireExit(restartStatus.browserPid);
  owner = undefined;
  assert.equal(await readFile(configPath, "utf8"), configBeforeRestart, "the saved generated config must not change across restart");
  const result = {
    platform: process.platform,
    detachedOwnerSurvivesManagerExit: true,
    ownerStatus: true,
    nativeStorageCapture: true,
    nativeStorageRestore: true,
    externalPlaywrightBridge: true,
    officialMcp: true,
    scriptContext: true,
    generatedConfig: true,
    generatedConfigSurvivesRestart: true,
    gracefulClose: true,
  };
  await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  if (owner) await closeFirefoxOwner(owner, { timeoutMs: 30_000 }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

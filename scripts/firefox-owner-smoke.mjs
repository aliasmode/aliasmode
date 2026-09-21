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

  const script = join(root, "owner-script.mjs");
  await writeFile(script, `export default async ({ browser, context, page, profile, inputs, credentials, log }) => {
    await page.goto(inputs.origin);
    await context.addCookies([{ name: "owner-proof", value: "saved", url: inputs.origin }]);
    await page.evaluate(() => localStorage.setItem("owner-proof", "saved"));
    log("script ran for %s", profile.id);
    return {
      sameBrowser: context.browser() === browser,
      credentials,
      profileId: profile.id,
      identity: await page.evaluate(() => ({ userAgent: navigator.userAgent, screen: [screen.width, screen.height] })),
    };
  };\n`);
  const run = await callFirefoxOwner(owner, "run-script", {
    scriptPath: script,
    input: { profile: { id: "owner-profile" }, inputs: { origin }, credentials: null },
  }, { timeoutMs: 30_000 });
  assert.equal(run.result.sameBrowser, true);
  assert.equal(run.result.credentials, null);
  assert.equal(run.result.profileId, "owner-profile");
  assert.equal(typeof run.result.identity.userAgent, "string");
  assert.deepEqual(run.result.identity.screen, [1920, 1080]);
  assert.deepEqual(run.logs, ["script ran for owner-profile"]);

  const session = JSON.parse(await callFirefoxOwner(owner, "session-capture", {
    captureSeed: { origins: [origin] },
  }, { timeoutMs: 30_000 }));
  assert.ok(session.cookies.some((cookie) => cookie.name === "owner-proof" && cookie.value === "saved"));
  assert.deepEqual(session.origins.find((entry) => entry.origin === origin)?.localStorage, [{ name: "owner-proof", value: "saved" }]);

  await closeFirefoxOwner(owner, { timeoutMs: 30_000 });
  await requireExit(status.pid);
  await requireExit(status.browserPid);
  await assert.rejects(() => callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 }), { name: "FirefoxOwnerError" });
  owner = undefined;

  const configBeforeRestart = await readFile(configPath, "utf8");
  owner = await startManager();
  firefoxEndpoint(owner);
  const restartStatus = await callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 });
  assert.equal(restartStatus.generation, owner.generation);
  const restarted = await callFirefoxOwner(owner, "run-script", {
    scriptPath: script,
    input: { profile: { id: "owner-profile" }, inputs: { origin }, credentials: null },
  }, { timeoutMs: 30_000 });
  assert.deepEqual(restarted.result.identity, run.result.identity);
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

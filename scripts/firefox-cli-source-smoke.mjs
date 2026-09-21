import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [binaryArg, rootArg, expectedSha256] = process.argv.slice(2);
if (!binaryArg || !rootArg || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) {
  throw new Error("usage: bun scripts/firefox-cli-source-smoke.mjs <browser> <new-test-directory> <sha256>");
}

const binary = resolve(binaryArg);
const root = resolve(rootArg);
const agentNonce = "a".repeat(64);
const desktopNonce = "b".repeat(64);
await mkdir(root, { recursive: false });

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("loopback port is unavailable");
  return address.port;
}

const port = await freeLoopbackPort();
const baseUrl = `http://127.0.0.1:${port}`;
const scriptHeaders = {
  authorization: `Bearer ${agentNonce}`,
  "content-type": "application/json",
};
const child = Bun.spawn([
  process.execPath,
  "--no-env-file",
  join(import.meta.dir, "..", "cli.ts"),
  "start",
  "--desktop-stdio",
  "--desktop-root", join(root, "desktop"),
  "--headless",
  "--port", String(port),
  "--state-root", join(root, "state"),
], {
  cwd: root,
  stdin: "pipe",
  stdout: "ignore",
  stderr: "ignore",
  env: {
    ...process.env,
    HUB_URL: "",
    ALIASMODE_CLOUD_URL: "http://127.0.0.1:1",
    ALIASMODE_SUPABASE_URL: "http://127.0.0.1:1",
    ALIASMODE_SUPABASE_ANON_KEY: "firefox-cli-source-smoke",
    ALIASMODE_AGENT_NONCE: agentNonce,
    ALIASMODE_DESKTOP_NONCE: desktopNonce,
    ALIASMODE_DESKTOP_VERSION: "source-smoke",
    ALIASMODE_FIREFOX_BINARY_PATH: binary,
    ALIASMODE_FIREFOX_BINARY_SHA256: expectedSha256,
    CLOAKBROWSER_BINARY_PATH: process.execPath,
    CLOAKBROWSER_BINARY_SHA256: "0".repeat(64),
  },
});

async function runScript(language, source, marker, profileId) {
  const saved = await fetch(`${baseUrl}/ui/api/scripts`, {
    method: "POST",
    headers: scriptHeaders,
    body: JSON.stringify({ name: `Firefox ${language} source smoke`, description: "CI source runner smoke", language, source }),
  });
  assert.equal(saved.ok, true, `${language} source script saves through the product API`);
  const script = (await saved.json()).script;
  assert.equal(typeof script?.id, "string", `${language} source script receives an id`);

  const started = await fetch(`${baseUrl}/ui/api/scripts/run`, {
    method: "POST",
    headers: scriptHeaders,
    body: JSON.stringify({ scriptId: script.id, profileIds: [profileId], inputs: {}, useCredentials: false }),
  });
  assert.equal(started.ok, true, `${language} source script starts through ScriptSupervisor`);
  const runId = (await started.json()).run?.id;
  assert.equal(typeof runId, "string", `${language} ScriptSupervisor returns a run id`);

  let run;
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await fetch(`${baseUrl}/ui/api/scripts/run`, { headers: { authorization: `Bearer ${agentNonce}` } });
    assert.equal(status.ok, true, `${language} ScriptSupervisor status is available`);
    run = (await status.json()).run;
    if (run?.id === runId && run.status === "finished") break;
    await Bun.sleep(250);
  }
  assert.equal(run?.status, "finished", `${language} source script finishes`);
  assert.equal(run.profiles?.[0]?.status, "succeeded", `${language} source script uses the Firefox owner`);

  const log = await fetch(`${baseUrl}/ui/api/scripts/log?runId=${encodeURIComponent(runId)}&offset=0`, {
    headers: { authorization: `Bearer ${agentNonce}` },
  });
  assert.equal(log.ok, true, `${language} source script log is available`);
  assert.ok((await log.json()).text.includes(marker), `${language} source script ran in the Firefox context`);
}

let profileId;
let started = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/ui/api/health`);
      if (response.ok && (await response.json()).ok === true) {
        ready = true;
        break;
      }
    } catch {}
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(250).then(() => false)])) break;
  }
  assert.equal(ready, true, "bun cli.ts start serves the source dashboard");

  const created = await fetch(`${baseUrl}/ui/api/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "firefox", name: "Firefox CLI source smoke", screen: "1440x900" }),
  });
  assert.equal(created.ok, true, "source API creates a Firefox profile");
  const createdBody = await created.json();
  assert.equal(createdBody.ok, true, "Firefox profile creation reports success");
  assert.equal(typeof createdBody.id, "string", "Firefox profile creation returns an id");
  profileId = createdBody.id;

  const opened = await fetch(`${baseUrl}/ui/api/profiles/${encodeURIComponent(profileId)}/open`, { method: "POST" });
  assert.equal(opened.ok, true, "source API opens the Firefox profile");
  const openedBody = await opened.json();
  assert.equal(openedBody.ok, true, "Firefox open reports success");
  assert.equal(openedBody.engine, "firefox", "source API reports a native Firefox launch");
  started = true;

  const profiles = await fetch(`${baseUrl}/ui/api/profiles`);
  assert.equal(profiles.ok, true, "source API lists profiles after launch");
  const listed = (await profiles.json()).profiles;
  const profile = listed.find((item) => item.id === profileId);
  assert.equal(profile?.engine, "firefox", "source API preserves the Firefox engine");
  assert.equal(profile?.running, true, "source API reports the Firefox profile as running");

  const closed = await fetch(`${baseUrl}/ui/api/profiles/${encodeURIComponent(profileId)}/close`, { method: "POST" });
  assert.equal(closed.ok, true, "source API closes the Firefox profile");
  assert.equal((await closed.json()).ok, true, "Firefox close reports success");
  started = false;

  await runScript("javascript", `export default async ({ page, log }) => {
  await page.evaluate(() => { document.title = "Firefox source JavaScript smoke"; });
  log("firefox-source-javascript-ran");
};`, "firefox-source-javascript-ran", profileId);
  await runScript("python", `async def run(*, page, log, **_kwargs):
    await page.evaluate("() => { document.title = 'Firefox source Python smoke'; }")
    log("firefox-source-python-ran")
`, "firefox-source-python-ran", profileId);

  const result = {
    sourceCliStart: true,
    apiProfileCreate: true,
    apiProfileOpen: true,
    apiProfileClose: true,
    sourceJavaScriptRunner: true,
    sourcePythonRunner: true,
    engine: "firefox",
  };
  await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  if (started && profileId) {
    await fetch(`${baseUrl}/ui/api/profiles/${encodeURIComponent(profileId)}/close`, { method: "POST" }).catch(() => {});
  }
  try {
    child.stdin.write(`${JSON.stringify({ protocol: "aliasmode-desktop-v1", command: "shutdown", nonce: desktopNonce })}\n`);
    child.stdin.end();
  } catch {}
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!exited) {
    child.kill();
    await child.exited;
  }
}

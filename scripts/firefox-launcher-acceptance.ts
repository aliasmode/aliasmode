import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { Launcher } from "../launcher.ts";
import { createFirefoxProfileConfig } from "../firefox-config.ts";
import { callFirefoxOwner } from "../firefox-runtime.ts";
import { decodePortableProfile, encodePortableProfile } from "../portable-profile.ts";
import { resolvePlaywrightRuntime } from "../playwright-runtime.ts";
import { applySessionToEndpoint, readSessionInSubprocess } from "../session.ts";
import { ProfileStore } from "../store.ts";
import type { Profile } from "../types.ts";

const [binaryArg, rootArg, expectedSha256] = process.argv.slice(2);
if (!binaryArg || !rootArg || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) {
  throw new Error("usage: bun scripts/firefox-launcher-acceptance.ts <aliasmode.exe> <new-directory> <sha256>");
}

const binary = resolve(binaryArg);
const root = resolve(rootArg);
const localDataRoot = join(root, "local-data");
const cloudDataRoot = join(root, "cloud-data");
await mkdir(root, { recursive: false });
const localStore = new ProfileStore(join(root, "local.sqlite"));
const cloudStore = new ProfileStore(join(root, "cloud.sqlite"));
let server: ReturnType<typeof createServer> | undefined;
let proxyServer: ReturnType<typeof createServer> | undefined;
let localLauncher: Launcher | undefined;
let cloudLauncher: Launcher | undefined;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function stop(launcher: Launcher | undefined, profileId: string): Promise<void> {
  if (launcher) await launcher.stop(profileId).catch(() => {});
}

async function ownerScript(
  launcher: Launcher,
  profileId: string,
  scriptPath: string,
  input: Record<string, unknown>,
  language: "javascript" | "python" = "javascript",
): Promise<{ result: unknown; logs: string[] }> {
  const store = launcher === localLauncher ? localStore : launcher === cloudLauncher ? cloudStore : undefined;
  assert.ok(store, "Firefox script uses its launcher's ProfileStore");
  const launch = store.getLaunch(profileId);
  const profile = store.getProfile(profileId);
  assert.equal(launch?.engine, "firefox", "Firefox launch is stored as Firefox");
  assert.ok(launch?.firefoxOwner, "Firefox launch has a Node owner");
  assert.ok(profile, "Firefox script has a saved profile");
  const bridge = await callFirefoxOwner<{ endpoint?: unknown }>(launch.firefoxOwner!, "playwright-endpoint", {});
  assert.equal(typeof bridge.endpoint, "string", "Firefox owner supplies a private Playwright endpoint");
  const runtime = resolvePlaywrightRuntime();
  const sourceRoot = resolve(import.meta.dir, "..");
  const executable = language === "python"
    ? runtime.kind === "packaged" ? join(runtime.root, "python", "python.exe") : "python"
    : runtime.nodeExecutable;
  const runner = runtime.kind === "packaged"
    ? join(runtime.root, "agent", language === "python" ? "script-runner.py" : "script-runner.mjs")
    : join(sourceRoot, "agent", language === "python" ? "script-runner.py" : "script-runner.mjs");
  const resultPath = join(root, `external-result-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const child = Bun.spawn([executable, ...(language === "python" ? ["-u", "-X", "utf8"] : []), runner, scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({
    endpoint: bridge.endpoint,
    engine: "firefox",
    profile: { id: profile.id, name: profile.name, group: profile.group, platform: profile.platform ?? "" },
    inputs: { ...input, resultPath },
    credentials: null,
  })}\n`);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error("Firefox external script runner failed");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  return { result, logs: `${stdout}${stderr}`.split(/\r?\n/).filter(Boolean) };
}

function profile(id: string, config: ReturnType<typeof createFirefoxProfileConfig>): Profile {
  return {
    id,
    engine: "firefox",
    firefox: config,
    accId: "launcher-acceptance",
    name: "Firefox launcher acceptance",
    group: "acceptance",
    platform: "",
    username: "",
    password: "",
    email: "",
    emailPassword: "",
    twofa: "",
    proxy: null,
    extensions: [],
    tags: [],
    ua: "",
    timezone: "",
    screenWidth: 1440,
    screenHeight: 900,
    fingerprintSeed: 101,
    platformOs: "Windows",
    cookies: [],
    seeded: false,
  };
}

try {
  assert.equal(await sha256File(binary), expectedSha256, "CI passes the approved Firefox executable hash");

  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>AliasMode local Firefox fixture</title><main>${request.url}</main>`);
  });
  await new Promise<void>((done, fail) => {
    server!.once("error", fail);
    server!.listen(0, "127.0.0.1", done);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const proxyUser = "acceptance-user";
  const proxyPassword = "acceptance-password";
  const expectedProxyAuthorization = `Basic ${Buffer.from(`${proxyUser}:${proxyPassword}`).toString("base64")}`;
  let proxyRequests = 0;
  let proxyFixtureRequests = 0;
  let proxyFailure: string | undefined;
  proxyServer = createServer((request, response) => {
    if (request.headers["proxy-authorization"] !== expectedProxyAuthorization) {
      proxyFailure = "Firefox did not authenticate through the Launcher proxy relay";
      response.writeHead(407, { "proxy-authenticate": "Basic realm=AliasMode" });
      response.end();
      return;
    }
    let target: URL;
    try { target = new URL(request.url ?? ""); }
    catch {
      proxyFailure = "Firefox did not send an absolute URL to the Launcher proxy relay";
      response.writeHead(400);
      response.end();
      return;
    }
    proxyRequests++;
    if (target.origin === origin) proxyFixtureRequests++;
    const headers = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"];
    const upstream = httpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      proxyFailure = "Launcher proxy relay could not reach the loopback fixture";
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise<void>((done, fail) => {
    proxyServer!.once("error", fail);
    proxyServer!.listen(0, "127.0.0.1", done);
  });
  const proxyPort = (proxyServer.address() as { port: number }).port;
  const telegramOrigin = "https://web.telegram.org";
  const firstTab = `${origin}/first`;
  const secondTab = `${origin}/second`;
  const telegramTab = `${telegramOrigin}/k/`;
  const mutator = join(root, "mutate.mjs");
  const verifier = join(root, "verify.mjs");
  await writeFile(mutator, `
import { writeFile } from "node:fs/promises";
export default async ({ context, inputs, log }) => {
  const first = context.pages()[0] ?? await context.newPage();
  await first.goto(inputs.firstTab, { waitUntil: "domcontentloaded" });
  await context.addCookies([{ name: "launcher-proof", value: "saved", url: inputs.origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
  await first.evaluate(async () => {
    localStorage.setItem("launcher-proof", "saved");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("launcher-proof", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("state", "readwrite");
        transaction.objectStore("state").put("saved", "session");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  const second = await context.newPage();
  await second.goto(inputs.secondTab, { waitUntil: "domcontentloaded" });
  await context.route("https://web.telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>AliasMode Telegram fixture</title>",
  }));
  const telegram = await context.newPage();
  await telegram.goto(inputs.telegramTab, { waitUntil: "domcontentloaded" });
  await telegram.evaluate(async () => {
    localStorage.setItem("dc2_auth_key", "synthetic-auth");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("tweb-common", 8);
      request.onupgradeneeded = () => request.result.createObjectStore("localStorage__encrypted");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("localStorage__encrypted", "readwrite");
        transaction.objectStore("localStorage__encrypted").put("synthetic-auth", "data");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await telegram.close();
  const result = {
    identity: await first.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: [screen.width, screen.height, screen.colorDepth],
    })),
    tabs: context.pages().map((page) => page.url()),
  };
  await writeFile(inputs.resultPath, JSON.stringify(result) + "\\n");
  log("Fixture state saved");
};
`);
  await writeFile(verifier, `
import { writeFile } from "node:fs/promises";
export default async ({ context, inputs, log }) => {
  const page = context.pages().find((item) => item.url().startsWith(inputs.origin)) ?? await context.newPage();
  if (!page.url().startsWith(inputs.origin)) await page.goto(inputs.firstTab, { waitUntil: "domcontentloaded" });
  await context.route("https://web.telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>AliasMode Telegram fixture</title>",
  }));
  const telegram = await context.newPage();
  await telegram.goto(inputs.telegramTab, { waitUntil: "domcontentloaded" });
  const telegramAuth = await telegram.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("tweb-common", 8);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("localStorage__encrypted", "readonly");
      const operation = transaction.objectStore("localStorage__encrypted").get("data");
      operation.onsuccess = () => resolve(operation.result);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  await telegram.close();
  const stored = inputs.verifyGenericIndexedDB ? await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("launcher-proof", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("state", "readonly");
      const operation = transaction.objectStore("state").get("session");
      operation.onsuccess = () => resolve(operation.result);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error);
    };
  })) : null;
  const result = {
    identity: await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: [screen.width, screen.height, screen.colorDepth],
    })),
    localStorage: await page.evaluate(() => localStorage.getItem("launcher-proof")),
    indexedDB: stored,
    telegramAuth,
    cookies: await context.cookies(inputs.origin),
    tabs: context.pages().map((item) => item.url()),
  };
  await writeFile(inputs.resultPath, JSON.stringify(result) + "\\n");
  log("Fixture state verified");
};
`);

  const pythonVerifier = join(root, "verify.py");
  await writeFile(pythonVerifier, `
import json

async def run(*, context, inputs, log, **_kwargs):
    page = next((item for item in context.pages if item.url.startswith(inputs["origin"])), None)
    if page is None:
        page = await context.new_page()
        await page.goto(inputs["firstTab"], wait_until="domcontentloaded")
    result = {
        "localStorage": await page.evaluate("localStorage.getItem('launcher-proof')"),
        "tabs": [item.url for item in context.pages],
    }
    with open(inputs["resultPath"], "w", encoding="utf-8") as file:
        json.dump(result, file)
    log("Python fixture context verified")
`);

  const profileId = "firefoxlaunchproof";
  const generatedConfig = createFirefoxProfileConfig(1440, 900);
  const savedProfile: Profile = {
    ...profile(profileId, generatedConfig),
    proxy: { type: "http", host: "127.0.0.1", port: String(proxyPort), user: proxyUser, pass: proxyPassword },
  };
  localStore.upsertProfile(savedProfile);
  assert.deepEqual(localStore.getProfile(profileId)?.firefox, generatedConfig, "generated Firefox identity persists in ProfileStore");

  localLauncher = new Launcher({
    store: localStore,
    dataRoot: localDataRoot,
    firefoxBinaryPath: binary,
    expectedFirefoxBinarySha256: expectedSha256,
    headless: true,
    portRange: { start: 18000, end: 18999 },
  });
  const initial = await localLauncher.start(profileId, [], { autoNavigate: false });
  const initialLaunch = localStore.getLaunch(profileId)!;
  const localOwnerGeneration = initialLaunch.firefoxOwner?.generation;
  assert.ok(localOwnerGeneration, "local Firefox owner has a generation");
  assert.equal(initialLaunch.binarySha256, expectedSha256, "Launcher stores the approved Firefox executable hash");
  assert.ok(initialLaunch.firefoxOwner && initialLaunch.firefoxOwner.pid > 0 && initialLaunch.firefoxOwner.browserPid > 0, "Launcher starts a real Node owner and browser");
  assert.equal(await localLauncher.certifiedActive(profileId), true, "Launcher certifies the owned Firefox process");
  const mutationRun = await ownerScript(localLauncher, profileId, mutator, { origin, firstTab, secondTab, telegramTab });
  assert.ok(mutationRun.logs.includes("Fixture state saved"), "external JavaScript runner returns fixture logs");
  const mutated = mutationRun.result as { identity: unknown; tabs: string[] };
  assert.equal(proxyFailure, undefined, "Launcher relays Firefox through the authenticated proxy");
  assert.ok(proxyRequests > 0 && proxyFixtureRequests > 0, "Firefox reaches the loopback fixture through the Launcher proxy relay");
  assert.ok(mutated.tabs.includes(firstTab) && mutated.tabs.includes(secondTab), "fixture opens two local tabs");

  // Do not save a portable bundle before this stop. Local reopen must use Firefox's
  // native persistent session, including the latest tabs and origin storage.
  assert.equal(await localLauncher.stop(profileId), true, "Launcher stops the owned Firefox process");
  const reopened = await localLauncher.start(profileId, [], { autoNavigate: false });
  assert.equal(await localLauncher.certifiedActive(profileId), true, "Launcher certifies Firefox after local reopen");
  const localVerification = await ownerScript(localLauncher, profileId, verifier, { origin, firstTab, telegramTab, verifyGenericIndexedDB: true });
  assert.ok(localVerification.logs.includes("Fixture state verified"), "external JavaScript runner returns verification logs");
  const localState = localVerification.result;
  assert.deepEqual((localState as any).identity, mutated.identity, "local reopen keeps the generated Firefox identity");
  assert.equal((localState as any).localStorage, "saved", "local reopen keeps Local Storage");
  assert.equal((localState as any).indexedDB, "saved", "local reopen keeps IndexedDB");
  assert.equal((localState as any).telegramAuth, "synthetic-auth", "local reopen keeps selected Telegram IndexedDB auth");
  assert.ok((localState as any).cookies.some((cookie: { name: string; value: string }) => cookie.name === "launcher-proof" && cookie.value === "saved"), "local reopen keeps cookies");
  assert.ok((localState as any).tabs.includes(firstTab) && (localState as any).tabs.includes(secondTab), "local reopen keeps native tabs without a saved bundle");
  if (resolvePlaywrightRuntime().kind === "packaged") {
    const pythonRun = await ownerScript(localLauncher, profileId, pythonVerifier, { origin, firstTab }, "python");
    assert.ok(pythonRun.logs.includes("Python fixture context verified"), "external Python runner returns fixture logs");
    assert.equal((pythonRun.result as any).localStorage, "saved", "external Python runner uses the owned Firefox context");
  }

  const captured = await readSessionInSubprocess(reopened.ws, {
    captureSeed: { origins: [origin, telegramOrigin], telegramClient: "k" },
  });
  const capturedTelegram = JSON.parse(captured).origins.find((entry: { origin: string }) => entry.origin === telegramOrigin);
  assert.ok(capturedTelegram?.indexedDB?.some((database: { name: string; stores: Array<{ name: string; records: Array<{ key: string; value: string }> }> }) =>
    database.name === "tweb-common" && database.stores.some((store) =>
      store.name === "localStorage__encrypted" && store.records.some((record) => record.key === "data" && record.value === "synthetic-auth")
    )
  ), "native worker captures only the selected synthetic Telegram auth record");
  const portable = encodePortableProfile(localStore.getProfile(profileId)!, captured);
  const handoff = decodePortableProfile(portable);
  assert.equal(handoff.profile.engine, "firefox", "portable profile keeps the Firefox engine");
  assert.deepEqual(handoff.profile.firefox, generatedConfig, "portable profile keeps the exact generated Firefox identity");
  cloudStore.upsertProfile(handoff.profile);

  cloudLauncher = new Launcher({
    store: cloudStore,
    dataRoot: cloudDataRoot,
    firefoxBinaryPath: binary,
    expectedFirefoxBinarySha256: expectedSha256,
    headless: true,
    portRange: { start: 19000, end: 19999 },
  });
  const cloud = await cloudLauncher.start(profileId, [], { autoNavigate: false });
  assert.equal(await cloudLauncher.certifiedActive(profileId), true, "cloud handoff owner is certified");
  assert.notEqual(cloudStore.getLaunch(profileId)?.firefoxOwner?.generation, localOwnerGeneration, "cloud handoff uses a distinct Firefox owner");
  await applySessionToEndpoint(cloud.ws, handoff.sessionBundle, []);
  const cloudVerification = await ownerScript(cloudLauncher, profileId, verifier, { origin, firstTab, telegramTab });
  assert.ok(cloudVerification.logs.includes("Fixture state verified"), "cloud external JavaScript runner returns logs");
  const cloudState = cloudVerification.result;
  assert.deepEqual((cloudState as any).identity, mutated.identity, "cloud handoff keeps the generated Firefox identity");
  assert.equal((cloudState as any).localStorage, "saved", "cloud handoff applies Local Storage");
  assert.equal(JSON.parse(captured).origins.find((entry: { origin: string }) => entry.origin === origin)?.indexedDB, undefined, "portable capture excludes unsupported generic IndexedDB");
  assert.equal((cloudState as any).telegramAuth, "synthetic-auth", "cloud handoff applies selected Telegram IndexedDB auth");
  assert.ok((cloudState as any).cookies.some((cookie: { name: string; value: string }) => cookie.name === "launcher-proof" && cookie.value === "saved"), "cloud handoff applies cookies");
  assert.ok((cloudState as any).tabs.includes(firstTab) && (cloudState as any).tabs.includes(secondTab), "cloud handoff applies portable tabs");

  console.log(JSON.stringify({
    engine: "firefox",
    binarySha256: expectedSha256,
    localNativePersistence: true,
    cloudPortableHandoff: true,
    initialPort: initial.port,
    cloudPort: cloud.port,
  }));
} finally {
  await stop(cloudLauncher, "firefoxlaunchproof");
  await stop(localLauncher, "firefoxlaunchproof");
  cloudStore.close();
  localStore.close();
  await new Promise<void>((done) => proxyServer?.close(() => done()) ?? done());
  await new Promise<void>((done) => server?.close(() => done()) ?? done());
  await rm(root, { recursive: true, force: true });
}

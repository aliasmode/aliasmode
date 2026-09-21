import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Launcher } from "../launcher.ts";
import { createFirefoxProfileConfig } from "../firefox-config.ts";
import { callFirefoxOwner } from "../firefox-runtime.ts";
import { decodePortableProfile, encodePortableProfile } from "../portable-profile.ts";
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
const localStore = new ProfileStore(join(root, "local.sqlite"));
const cloudStore = new ProfileStore(join(root, "cloud.sqlite"));
let server: ReturnType<typeof createServer> | undefined;
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

async function ownerScript(launcher: Launcher, profileId: string, scriptPath: string, input: Record<string, unknown>): Promise<unknown> {
  const launch = localStore.getLaunch(profileId) ?? cloudStore.getLaunch(profileId);
  assert.equal(launch?.engine, "firefox", "Firefox launch is stored as Firefox");
  assert.ok(launch?.firefoxOwner, "Firefox launch has a Node owner");
  return callFirefoxOwner(launch.firefoxOwner!, "run-script", { scriptPath, input });
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
  await mkdir(root, { recursive: false });
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
  const telegramOrigin = "https://web.telegram.org";
  const firstTab = `${origin}/first`;
  const secondTab = `${origin}/second`;
  const telegramTab = `${telegramOrigin}/k/`;
  const mutator = join(root, "mutate.mjs");
  const verifier = join(root, "verify.mjs");
  const interceptor = join(root, "intercept-telegram.mjs");
  await writeFile(interceptor, `
export default async ({ context }) => {
  await context.route("https://web.telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>AliasMode Telegram fixture</title>",
  }));
};
`);
  await writeFile(mutator, `
export default async ({ context, inputs }) => {
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
  return {
    identity: await first.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: [screen.width, screen.height, screen.colorDepth],
    })),
    tabs: context.pages().map((page) => page.url()),
  };
};
`);
  await writeFile(verifier, `
export default async ({ context, inputs }) => {
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
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
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
  }));
  return {
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
};
`);

  const profileId = "firefoxlaunchproof";
  const generatedConfig = createFirefoxProfileConfig(1440, 900);
  const savedProfile = profile(profileId, generatedConfig);
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
  assert.equal(initialLaunch.binarySha256, expectedSha256, "Launcher stores the approved Firefox executable hash");
  assert.ok(initialLaunch.firefoxOwner && initialLaunch.firefoxOwner.pid > 0 && initialLaunch.firefoxOwner.browserPid > 0, "Launcher starts a real Node owner and browser");
  assert.equal(await localLauncher.certifiedActive(profileId), true, "Launcher certifies the owned Firefox process");
  const mutated = await ownerScript(localLauncher, profileId, mutator, { origin, firstTab, secondTab, telegramTab }) as { identity: unknown; tabs: string[] };
  assert.ok(mutated.tabs.includes(firstTab) && mutated.tabs.includes(secondTab), "fixture opens two local tabs");

  // Do not save a portable bundle before this stop. Local reopen must use Firefox's
  // native persistent session, including the latest tabs and origin storage.
  assert.equal(await localLauncher.stop(profileId), true, "Launcher stops the owned Firefox process");
  const reopened = await localLauncher.start(profileId, [], { autoNavigate: false });
  assert.equal(await localLauncher.certifiedActive(profileId), true, "Launcher certifies Firefox after local reopen");
  const localState = await ownerScript(localLauncher, profileId, verifier, { origin, firstTab, telegramTab });
  assert.deepEqual((localState as any).identity, mutated.identity, "local reopen keeps the generated Firefox identity");
  assert.equal((localState as any).localStorage, "saved", "local reopen keeps Local Storage");
  assert.equal((localState as any).indexedDB, "saved", "local reopen keeps IndexedDB");
  assert.equal((localState as any).telegramAuth, "synthetic-auth", "local reopen keeps selected Telegram IndexedDB auth");
  assert.ok((localState as any).cookies.some((cookie: { name: string; value: string }) => cookie.name === "launcher-proof" && cookie.value === "saved"), "local reopen keeps cookies");
  assert.ok((localState as any).tabs.includes(firstTab) && (localState as any).tabs.includes(secondTab), "local reopen keeps native tabs without a saved bundle");

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
  await ownerScript(cloudLauncher, profileId, interceptor, {});
  await applySessionToEndpoint(cloud.ws, handoff.sessionBundle, []);
  const cloudState = await ownerScript(cloudLauncher, profileId, verifier, { origin, firstTab, telegramTab });
  assert.deepEqual((cloudState as any).identity, mutated.identity, "cloud handoff keeps the generated Firefox identity");
  assert.equal((cloudState as any).localStorage, "saved", "cloud handoff applies Local Storage");
  assert.equal((cloudState as any).indexedDB, "saved", "cloud handoff applies IndexedDB");
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
  await new Promise<void>((done) => server?.close(() => done()) ?? done());
  await rm(root, { recursive: true, force: true });
}

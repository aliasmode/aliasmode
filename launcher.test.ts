import { test, expect } from "bun:test";
import { closeSync, fstatSync, mkdirSync, openSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, statSync, truncateSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ProfileStore } from "./store.ts";
import { AutofillBridge } from "./autofill-bridge.ts";
import { CloudBrowserCoordinator } from "./cloud-browser.ts";
import { PendingSyncQueue } from "./pending-sync.ts";
import type { ExitLocation } from "./geoip.ts";
import { autofillExtensionDir } from "./autofill-extension.ts";
import {
  BrowserLaunchError,
  Launcher as ProductionLauncher,
  buildWindowLabel,
  profileDisplayNo,
  collectLinuxProcessTree,
  createInFlightSnapshotReader,
  createFailureBackoffReader,
  defaultSpawn,
  isTelegramPlatform,
  matchOwnedBrowserPids,
  matchProfileDirHolderPids,
  parseTasklistImageNames,
  parseWindowsProcessEntry,
  decodeWindowsCommandLine,
  readWindowsProcessSnapshotNative,
  readWindowsProcessSnapshotWmi,
  parseDarwinFirefoxPsSnapshot,
  parseDarwinKernelExecutablePath,
  parseDarwinKernelArgv,
  parseDarwinPsSnapshot,
  parseLinuxProcStat,
  launchIdentityChanged,
  platformHomeUrl,
  quoteWindowsCommandArg,
  readSnapshotChildBounded,
  shouldLaunchViaWindowsSession,
  splitLaunchUrls,
  type SpawnFn,
  type FetchFn,
  type SearchProviderEnsurer,
  type HostProcessSnapshot,
} from "./launcher.ts";
import { matchFirefoxProcesses } from "./firefox-lifecycle.ts";
import { parseExport } from "./parse.ts";
import { buildNewProfile } from "./create.ts";
import { aliasmodeChromiumExecutable } from "./aliasmode-chromium.ts";
import { SessionRestoreError } from "./session.ts";
import type { FingerprintSample } from "./diagnose.ts";
import { handleUiRequest } from "./ui.ts";

const linuxTest = process.platform === "win32" ? test.skip : test;

/** Unit tests use fake executables, hosts, and CDP fleets. */
class Launcher extends ProductionLauncher {
  constructor(opts: ConstructorParameters<typeof ProductionLauncher>[0]) {
    super({
      // Production policy is exercised explicitly in dedicated gate tests below.
      unsafeDisableIdentityGates: true,
      findProfileDirHolderPids: async () => [],
      captureFingerprint: async () => null,
      ...opts,
    });
  }
}

const TEST_DATA_ROOTS = new WeakMap<ProfileStore, string>();
function testDataRoot(store: ProfileStore): string {
  let root = TEST_DATA_ROOTS.get(store);
  if (!root) {
    root = join(tmpdir(), `cloak-launcher-test-${crypto.randomUUID()}`);
    TEST_DATA_ROOTS.set(store, root);
  }
  return root;
}

const SAMPLE = `id=k1d0cd11
name=acct
group=g
cookie=[]
proxytype=http
proxy=1.2.3.4:8080:u:p
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

/**
 * Shared fake browser fleet keyed by debug port. spawn() marks a port alive;
 * kill() marks it dead. fetch(/json/version) reports liveness — so this models
 * a real browser whose CDP port stops answering when the process dies.
 */
function fleet() {
  const aliveByPort = new Map<number, boolean>();
  const pidByPort = new Map<number, number>();
  const aliveByPid = new Map<number, boolean>();
  const wsByPort = new Map<number, string>();
  const killed: number[] = [];
  let nextPid = 6000;

  const spawn: SpawnFn = (_bin, args) => {
    const port = Number(args.find((a) => a.startsWith("--remote-debugging-port="))!.split("=")[1]);
    aliveByPort.set(port, true);
    const pid = nextPid++;
    pidByPort.set(port, pid);
    aliveByPid.set(pid, true);
    return {
      pid,
      kill: () => {
        killed.push(pid);
        aliveByPort.set(port, false);
        aliveByPid.set(pid, false);
      },
    };
  };
  const fetchFn: FetchFn = async (url) => {
    const port = Number(url.match(/:(\d+)\//)?.[1] ?? "0");
    const ok = aliveByPort.get(port) ?? false;
    const ws = wsByPort.get(port) ?? `ws://127.0.0.1:${port}/devtools/browser/x`;
    return { ok, json: async () => ({ webSocketDebuggerUrl: ws }) };
  };
  const setWs = (port: number, ws: string) => wsByPort.set(port, ws);
  const crash = (port: number) => {
    aliveByPort.set(port, false);
    const pid = pidByPort.get(port);
    if (pid !== undefined) aliveByPid.set(pid, false);
  };
  const killPid = (pid: number) => {
    aliveByPid.set(pid, false);
    for (const [port, owner] of pidByPort) {
      if (owner === pid) aliveByPort.set(port, false);
    }
  };
  const isPidAlive = (pid: number) => aliveByPid.get(pid) ?? false;
  const findOwnedBrowserPids = async ({ debugPort }: { debugPort: number }) => {
    const pid = pidByPort.get(debugPort);
    return pid !== undefined && (aliveByPid.get(pid) ?? false) ? [pid] : [];
  };
  return { aliveByPort, pidByPort, aliveByPid, killed, spawn, fetchFn, setWs, crash, killPid, isPidAlive, findOwnedBrowserPids };
}

function newLauncher(
  store: ProfileStore,
  f: ReturnType<typeof fleet>,
  spawnedArgs: string[][],
  killedPids?: number[],
  ensureSearchProvider?: SearchProviderEnsurer,
  overrides: Partial<ConstructorParameters<typeof ProductionLauncher>[0]> = {},
) {
  return new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, args) => {
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureSearchProvider: ensureSearchProvider ?? (async () => ({
      status: "already-default",
      engine: "DuckDuckGo",
    })),
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    // Unit tests must never invoke the real OS-wide process scan (seconds per launch,
    // and it reports this dev box's own browsers). The reap behaviour has its own test.
    findProfileDirHolderPids: async () => [],
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async (pid) => {
      killedPids?.push(pid);
      f.killPid(pid);
    },
    browserClose: async () => false, // force-kill path; graceful close is unit-tested in server.test.ts
    cdpReadyTimeoutMs: 1000,
    // A Windows profile of Chromium 155 on Linux needs the Windows font pack; tests never download it.
    ensureFirefoxFontPack: async () => {
      const fontsDir = join(testDataRoot(store), "font-pack", "fonts");
      mkdirSync(fontsDir, { recursive: true });
      return fontsDir;
    },
    ...overrides,
  });
}

function seeded(): ProfileStore {
  const store = new ProfileStore(":memory:");
  for (const p of parseExport(SAMPLE).profiles) store.upsertProfile(p);
  return store;
}

function makeDirect(store: ProfileStore): void {
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, proxy: null, timezone: "", cookies: [] });
}

function legacyProxyPersonaDigest(store: ProfileStore, profileId: string, binarySha256: string): string {
  const profile = store.getProfile(profileId)!;
  const extensions = (profile.extensions ?? []).map((id) => ({
    id,
    loadDir: store.getExtension(id)?.loadDir ?? null,
  }));
  return createHash("sha256").update(JSON.stringify({
    schema: 1,
    binarySha256,
    host: [process.platform, process.arch],
    headless: false,
    windowScale: [0.65, 0.9],
    ua: profile.ua,
    platform: profile.platform,
    proxy: profile.proxy,
    timezone: profile.timezone,
    screen: [profile.screenWidth, profile.screenHeight],
    fingerprintSeed: profile.fingerprintSeed,
    extensions,
  })).digest("hex");
}

test("autofill alone does not disable extensions installed directly in the browser", async () => {
  const store = seeded();
  makeDirect(store);
  const autofill = new AutofillBridge(store);
  autofill.listen();
  const args: string[][] = [];
  const launcher = newLauncher(store, fleet(), args, undefined, undefined, { autofill });
  try {
    await launcher.start("k1d0cd11");
    expect(args[0]!.some((arg) => arg.startsWith("--load-extension="))).toBe(true);
    expect(args[0]!.some((arg) => arg.startsWith("--disable-extensions-except="))).toBe(false);
  } finally {
    await launcher.stop("k1d0cd11");
    autofill.close();
    store.close();
    rmSync(testDataRoot(store), { recursive: true, force: true });
  }
});

for (const headless of [false, true]) {
  test(`autofill is bundled with assigned extensions and retired on stop (headless=${headless})`, async () => {
    const store = seeded();
    makeDirect(store);
    const profile = store.getProfile("k1d0cd11")!;
    store.addExtension({ id: "assigned", name: "Fixture", loadDir: "/data/extensions/assigned" });
    store.upsertProfile({ ...profile, platform: "x.com", username: "test-user", extensions: ["assigned"] });
    const autofill = new AutofillBridge(store);
    autofill.listen();
    const args: string[][] = [];
    const launcher = newLauncher(store, fleet(), args, undefined, undefined, { autofill });
    const directory = autofillExtensionDir(launcher.userDataDir(profile.id));
    try {
      await launcher.start(profile.id, [], { headless });
      expect(args[0]).toContain(`--load-extension=${directory},/data/extensions/assigned`);
      expect(args[0]).toContain(`--disable-extensions-except=${directory},/data/extensions/assigned`);
      const binding = JSON.parse(readFileSync(join(directory, "bind.json"), "utf8"));
      expect(binding.port).toBe(autofill.port);
      const request = () => new Request(`http://127.0.0.1:${binding.port}/v1/menu`, {
        method: "POST", headers: { authorization: `Bearer ${binding.token}` }, body: JSON.stringify({ url: "https://x.com" }),
      });
      expect((await autofill.handle(request())).status).toBe(200);
      expect(JSON.stringify(store.getLaunch(profile.id)).includes(binding.token)).toBe(false);
      await launcher.start(profile.id, [], { headless });
      expect(args).toHaveLength(1);
      expect((await autofill.handle(request())).status).toBe(200);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect((await autofill.handle(request())).status).toBe(401);
      expect(existsSync(join(directory, "bind.json"))).toBe(false);
    } finally {
      await launcher.stop(profile.id);
      autofill.close();
      store.close();
      rmSync(testDataRoot(store), { recursive: true, force: true });
    }
  });
}

test("autofill refreshes a surviving browser binding without spawning or changing its persona", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const firstBridge = new AutofillBridge(store);
  firstBridge.listen();
  const first = newLauncher(store, f, [], undefined, undefined, { autofill: firstBridge });
  const nextBridge = new AutofillBridge(store);
  const args: string[][] = [];
  const next = newLauncher(store, f, args, undefined, undefined, { autofill: nextBridge });
  const id = "k1d0cd11";
  try {
    await first.start(id);
    const launch = store.getLaunch(id)!;
    const file = join(autofillExtensionDir(first.userDataDir(id)), "bind.json");
    const previous = JSON.parse(readFileSync(file, "utf8"));
    firstBridge.close();
    nextBridge.listen();
    const current = JSON.parse(readFileSync(file, "utf8"));
    expect(current.token !== previous.token).toBe(true);
    expect(current.port).toBe(nextBridge.port);
    await next.reconcileOrphans();
    await next.start(id);
    expect(args).toHaveLength(0);
    expect(store.getLaunch(id)!.personaDigest).toBe(launch.personaDigest);
    expect(await next.stop(id)).toBe(true);
    expect(existsSync(file)).toBe(false);
  } finally {
    await next.stop(id);
    firstBridge.close();
    nextBridge.close();
    store.close();
    rmSync(testDataRoot(store), { recursive: true, force: true });
  }
});

test("autofill setup failure rolls back the reservation without spawning a browser", async () => {
  const store = seeded();
  makeDirect(store);
  const autofill = new AutofillBridge(store);
  autofill.listen();
  const args: string[][] = [];
  const launcher = newLauncher(store, fleet(), args, undefined, undefined, { autofill });
  const directory = autofillExtensionDir(launcher.userDataDir("k1d0cd11"));
  mkdirSync(join(directory, "background.js"), { recursive: true });
  try {
    await expect(launcher.start("k1d0cd11")).rejects.toBeInstanceOf(BrowserLaunchError);
    expect(args).toHaveLength(0);
    expect(store.getLaunch("k1d0cd11")).toBeNull();
    expect(existsSync(join(directory, "bind.json"))).toBe(false);
  } finally {
    autofill.close();
    store.close();
    rmSync(testDataRoot(store), { recursive: true, force: true });
  }
});

test("autofill is retired after a post-spawn session restore failure", async () => {
  const store = seeded();
  makeDirect(store);
  const id = "k1d0cd11";
  store.upsertProfiles([store.getProfile(id)!], new Map([[id, JSON.stringify({ cookies: [], origins: [] })]]));
  const autofill = new AutofillBridge(store);
  autofill.listen();
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    autofill, applySession: async () => { throw new SessionRestoreError("origin_storage", "failed"); },
  });
  try {
    await expect(launcher.start(id)).rejects.toBeInstanceOf(SessionRestoreError);
    expect(store.getLaunch(id)).toBeNull();
    expect(existsSync(join(autofillExtensionDir(launcher.userDataDir(id)), "bind.json"))).toBe(false);
  } finally {
    autofill.close();
    store.close();
    rmSync(testDataRoot(store), { recursive: true, force: true });
  }
});

for (const proxied of [false, true]) {
  test(`Cloud login preserves a pre-autofill survivor without restarting it (proxied=${proxied})`, async () => {
    const store = seeded();
    if (!proxied) makeDirect(store);
    const f = fleet();
    const prior = newLauncher(store, f, []);
    const autofill = new AutofillBridge(store);
    const spawned: string[][] = [];
    const killed: number[] = [];
    const next = newLauncher(store, f, spawned, killed, undefined, { autofill });
    const root = testDataRoot(store);
    mkdirSync(root, { recursive: true });
    const queue = new PendingSyncQueue(join(root, "pending.sqlite"), new Uint8Array(32).fill(7));
    const id = "k1d0cd11";
    try {
      await prior.start(id, [], { sessionBaseVersion: 7 });
      (prior as any).closeRelay(id);
      const original = store.getLaunch(id)!;
      const profile = store.getProfile(id)!;
      queue.recordOpen({ accountId: "test-account", profileId: id, registrationId: "test-registration", expectedVersion: 7 });
      queue.updateOpen(id, "test-account", "running", { debugPort: original.debugPort, startedAt: original.startedAt });
      autofill.listen();
      const coordinator = new CloudBrowserCoordinator({
        cloud: {} as any,
        launcher: next,
        store,
        queue: () => queue,
        accountId: () => "test-account",
        deviceId: () => "test-device",
        readSession: async () => { throw new Error("healthy survivor must not be captured"); },
        applySession: async () => { throw new Error("healthy survivor must not be restored"); },
        heartbeatMs: 0,
        storageCheckpoints: false,
      });

      await next.reconcileOrphans();
      await coordinator.resumeAfterAuthentication();
      await next.verifyRunningIdentity(id);
      await next.start(id);

      expect(spawned).toHaveLength(0);
      expect(killed).toEqual([]);
      expect(store.getLaunch(id)).toMatchObject({
        pid: original.pid, debugPort: original.debugPort, startedAt: original.startedAt,
        personaDigest: original.personaDigest, sessionBaseVersion: 7,
      });
      expect(store.getProfile(id)).toEqual(profile);
      expect(queue.getOpen(id, "test-account")?.registrationId).toBe("test-registration");
      expect(queue.list("test-account")).toEqual([]);
      const manifest = join(autofillExtensionDir(next.userDataDir(id)), "manifest.json");
      expect(existsSync(manifest)).toBe(false);
      expect(await next.stop(id)).toBe(true);
      await next.start(id);
      expect(spawned).toHaveLength(1);
      expect(existsSync(manifest)).toBe(true);
      expect(store.getLaunch(id)!.personaDigest).not.toBe(original.personaDigest);
    } finally {
      await next.stop(id);
      (prior as any).closeRelay(id);
      autofill.close();
      queue.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a proxied survivor logs its relay restoration once, not at every Cloud checkpoint check", async () => {
  const store = seeded();
  const f = fleet();
  const prior = newLauncher(store, f, []);
  const logs: string[] = [];
  const next = newLauncher(store, f, [], undefined, undefined, { log: (message) => logs.push(message) });
  const id = "k1d0cd11";
  try {
    await prior.start(id);
    (prior as any).closeRelay(id);
    await next.reconcileOrphans();
    for (let check = 0; check < 3; check++) await next.verifyRunningIdentity(id);
    expect(logs.filter((message) => message.includes("reattached proxy relay"))).toHaveLength(1);
    expect(logs.filter((message) => message.includes("relay restored"))).toHaveLength(1);
  } finally {
    await next.stop(id);
    (prior as any).closeRelay(id);
    store.close();
    rmSync(testDataRoot(store), { recursive: true, force: true });
  }
});

for (const changed of ["proxy", "fingerprint", "timezone", "extensions", "ua", "kernel", "headless", "missing digest", "old WebRTC policy"] as const) {
  test(`pre-autofill compatibility still rejects changed ${changed}`, async () => {
    const store = seeded();
    const f = fleet();
    const prior = newLauncher(store, f, []);
    const autofill = new AutofillBridge(store);
    const spawned: string[][] = [];
    const killed: number[] = [];
    const next = newLauncher(store, f, spawned, killed, undefined, { autofill });
    const id = "k1d0cd11";
    try {
      await prior.start(id);
      (prior as any).closeRelay(id);
      const original = store.getLaunch(id)!;
      // Saved edits wait for the next start, so a changed identity here is one the launch row
      // claims but its digest does not match.
      const persona = original.persona!;
      const claim = (changes: Partial<NonNullable<typeof original.persona>>) =>
        store.recordLaunch({ ...original, persona: { ...persona, ...changes } });
      switch (changed) {
        case "proxy": claim({ proxy: null }); break;
        case "fingerprint": claim({ fingerprintSeed: persona.fingerprintSeed! + 1 }); break;
        case "timezone": claim({ timezone: "Etc/UTC" }); break;
        case "extensions": claim({ extensions: ["different-extension"] }); break;
        case "ua": claim({ ua: `${persona.ua} changed` }); break;
        case "kernel": store.recordLaunch({ ...original, binarySha256: "f".repeat(64) }); break;
        case "headless": store.recordLaunch({ ...original, headless: true }); break;
        case "missing digest": store.recordLaunch({ ...original, personaDigest: undefined }); break;
        case "old WebRTC policy": store.recordLaunch({ ...original, personaDigest: legacyProxyPersonaDigest(store, id, original.binarySha256!) }); break;
      }
      const retained = store.getLaunch(id)!;
      await expect(next.verifyRunningIdentity(id)).rejects.toThrow();
      expect(store.getLaunch(id)).toEqual(retained);
      expect(spawned).toEqual([]);
      expect(killed).toEqual([]);
    } finally {
      await next.stop(id);
      (prior as any).closeRelay(id);
      autofill.close();
      store.close();
      rmSync(testDataRoot(store), { recursive: true, force: true });
    }
  });
}

test("Local imports restore storage once before navigation, not on subsequent launches or captures", async () => {
  const store = seeded();
  makeDirect(store);
  const id = "k1d0cd11";
  const bundle = JSON.stringify({ cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "device", value: "test" }] }], tabs: ["https://example.com/account"] });
  const cookies = [{ name: "custom_session", value: "session", domain: "example.com", path: "/" }];
  store.upsertProfiles([{ ...store.getProfile(id)!, cookies }], new Map([[id, bundle]]));
  const events: string[] = [];
  const args: string[][] = [];
  const launcher = newLauncher(store, fleet(), args, undefined, undefined, {
    applySession: async (_ws, value, urls) => {
      expect(value).toBe(bundle);
      expect(urls).toEqual([]);
      events.push("restore");
    },
    ensureCookies: async () => { events.push("cookies"); return { injected: true }; },
    navigate: async () => { events.push("navigate"); },
  });
  const dir = launcher.userDataDir(id);
  mkdirSync(join(dir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(dir, "Default", "Sessions", "Tabs_1"), "old native session");
  try {
    await launcher.start(id);
    expect(events).toEqual(["restore"]);
    expect(args[0]).not.toContain("--restore-last-session");
    expect(store.getPendingSessionBundle(id)).toBeNull();
    expect(await launcher.stop(id)).toBe(true);
    store.saveSessionBundle(id, JSON.stringify({ cookies: [], origins: [] }));
    await launcher.start(id);
    expect(events.filter(event => event === "restore")).toHaveLength(1);
    expect(events.filter(event => event === "cookies")).toHaveLength(1);
  } finally { await launcher.stop(id); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a Local Telegram restore lands on Web K unless the session holds a Web A login", async () => {
  const login = { origin: "https://web.telegram.org", localStorage: [{ name: "dc4_auth_key", value: "KEY" }] };
  for (const [bundle, expected] of [
    [{ cookies: [], telegramClient: "a", origins: [] }, "https://web.telegram.org/k/"],
    [{ cookies: [], telegramClient: "a", origins: [login] }, "https://web.telegram.org/a/"],
  ] as const) {
    const store = seeded();
    makeDirect(store);
    const id = "k1d0cd11";
    store.upsertProfiles([{ ...store.getProfile(id)!, platform: "telegram.org" }], new Map([[id, JSON.stringify(bundle)]]));
    const opened: string[][] = [];
    const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
      applySession: async (_ws: string, _bundle: string, urls: readonly string[]) => { opened.push([...urls]); },
    });
    try {
      await launcher.start(id);
      expect(opened).toEqual([[expected]]);
    } finally { await launcher.stop(id); store.close(); }
  }
});

test("failed Local restore stays pending for retry and Cloud/remote can disable it", async () => {
  const store = seeded();
  makeDirect(store);
  const id = "k1d0cd11";
  const bundle = JSON.stringify({ cookies: [], origins: [] });
  store.upsertProfiles([store.getProfile(id)!], new Map([[id, bundle]]));
  let attempts = 0;
  let navigated = 0;
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    applySession: async () => { if (++attempts === 1) throw new SessionRestoreError("origin_storage", "failed"); },
    navigate: async () => { navigated++; },
  });
  try {
    await expect(launcher.start(id, ["https://example.com"])).rejects.toThrow("session_restore/origin_storage");
    expect(navigated).toBe(0);
    expect(store.getPendingSessionBundle(id)).toBe(bundle);
    await launcher.start(id, [], { restoreLocalSession: false, autoNavigate: false });
    expect(attempts).toBe(1);
    expect(store.getPendingSessionBundle(id)).toBe(bundle);
    await launcher.stop(id);
    await launcher.start(id);
    expect(attempts).toBe(2);
    expect(store.getPendingSessionBundle(id)).toBeNull();
  } finally { await launcher.stop(id); store.close(); rmSync(launcher.userDataDir(id), { recursive: true, force: true }); }
});

test("unavailable imported tabs do not replay successfully restored storage on every open", async () => {
  const store = seeded();
  makeDirect(store);
  const id = "k1d0cd11";
  store.upsertProfiles([store.getProfile(id)!], new Map([[id, JSON.stringify({ cookies: [], origins: [], tabs: ["https://offline.example/"] })]]));
  let attempts = 0;
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    applySession: async () => { attempts++; throw new SessionRestoreError("navigation", "failed"); },
    log: () => {},
  });
  try {
    await launcher.start(id);
    expect(store.getPendingSessionBundle(id)).toBeNull();
    await launcher.stop(id);
    await launcher.start(id);
    expect(attempts).toBe(1);
  } finally { await launcher.stop(id); store.close(); rmSync(launcher.userDataDir(id), { recursive: true, force: true }); }
});

test("Local snapshots capture only a verified unchanged live generation and retain the previous bundle on failure", async () => {
  const store = seeded();
  makeDirect(store);
  const id = "k1d0cd11";
  const previous = JSON.stringify({ cookies: [], origins: [{ origin: "https://example.com", localStorage: [] }] });
  const fresh = JSON.stringify({ cookies: [], origins: [], tabs: ["https://example.com/latest"] });
  store.saveSessionBundle(id, previous);
  let mode = "success";
  let reads = 0;
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    readSession: async (_ws, options) => {
      reads++;
      if (reads === 1) expect(options?.captureSeed?.origins).toEqual(["https://example.com"]);
      if (mode === "failure") throw new Error("private session error");
      if (mode === "replacement") store.recordLaunch({ ...store.getLaunch(id)!, startedAt: 123 });
      return fresh;
    },
    log: () => {},
  });
  try {
    expect(await launcher.captureLocalSession(id)).toBe(false);
    expect(reads).toBe(0);
    await launcher.start(id);
    expect(await launcher.captureLocalSession(id)).toBe(true);
    expect(store.getSessionBundle(id)).toBe(fresh);
    expect(store.getPendingSessionBundle(id)).toBeNull();
    store.saveSessionBundle(id, previous);
    mode = "failure";
    expect(await launcher.captureLocalSession(id)).toBe(false);
    expect(store.getSessionBundle(id)).toBe(previous);
    mode = "replacement";
    const launch = store.getLaunch(id)!;
    expect(await launcher.captureLocalSession(id)).toBe(false);
    expect(store.getSessionBundle(id)).toBe(previous);
    store.recordLaunch(launch);
  } finally { await launcher.stop(id); store.close(); rmSync(launcher.userDataDir(id), { recursive: true, force: true }); }
});

test("after a restart, a bootstrapped browser reattaches without rerunning search setup", async () => {
  const store = seeded();
  const f = fleet();
  const prepared: string[] = [];

  const argsA: string[][] = [];
  const launcherA = newLauncher(store, f, argsA, undefined, async (options) => {
    prepared.push(options.userDataDir);
    return { status: "configured", engine: "DuckDuckGo" };
  });
  const a = await launcherA.start("k1d0cd11", [], { sessionBaseVersion: 7 });
  expect(argsA.length).toBe(1);
  expect(prepared).toEqual([launcherA.userDataDir("k1d0cd11")]);
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBe(2);
  (launcherA as any).closeRelay("k1d0cd11");

  const argsB: string[][] = [];
  const launcherB = newLauncher(store, f, argsB, undefined, async () => {
    throw new Error("reattach reran search setup");
  });
  await launcherB.reconcileOrphans();
  const b = await launcherB.start("k1d0cd11", [], { sessionBaseVersion: -1 });
  const repeated = await launcherB.start("k1d0cd11", [], { sessionBaseVersion: -1 });

  expect(argsB.length).toBe(0);
  expect(b.port).toBe(a.port);
  expect(repeated).toEqual(b);
  expect(store.getLaunch("k1d0cd11")?.sessionBaseVersion).toBe(-1);
  expect((launcherB as any).relays.has("k1d0cd11")).toBe(true);

  const changedWs = `ws://127.0.0.1:${b.port}/devtools/browser/restarted`;
  f.setWs(b.port, changedWs);
  expect(await launcherB.start("k1d0cd11")).toEqual({ ws: changedWs, port: b.port, nativeSessionRestored: false, reattached: true });
  expect(prepared).toHaveLength(1);
  store.close();
});

test("Windows search bootstrap runs once without suppressing native restore", async () => {
  const store = seeded();
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const userDataDir = join(testDataRoot(store), "k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
  let prepared = 0;
  const launcher = newLauncher(store, f, spawnedArgs, undefined, async () => {
    prepared++;
    return { status: "configured", engine: "DuckDuckGo" };
  }, {
    hostPlatform: "win32",
    fetch: async (url) => url.endsWith("/json/list")
      ? { ok: true, json: async () => [{ type: "page", url: "https://restored.example/account" }] }
      : f.fetchFn(url),
  });

  await launcher.start("k1d0cd11");
  expect(prepared).toBe(1);
  expect(spawnedArgs[0]).toContain("--restore-last-session");
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBe(2);
  expect(await launcher.stop("k1d0cd11")).toBe(true);

  await launcher.start("k1d0cd11");
  expect(prepared).toBe(1);
  expect(spawnedArgs[1]).toContain("--restore-last-session");
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBe(2);
  store.close();
});

test("Windows Local preserves native session artifacts without appending platform home", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, platform: "x.com" });
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const navigated: string[][] = [];
  const userDataDir = join(testDataRoot(store), "k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
  let prepared = 0;
  let targets: Array<{ type: string; url: string }> = [
    { type: "page", url: "https://restored.example/one" },
    { type: "page", url: "https://restored.example/two" },
    { type: "page", url: "https://example.com/?__aliasmode_session_restore__=1" },
    { type: "page", url: "http://127.0.0.1:50400/card?id=k1d0cd11" },
  ];
  const fetchFn: FetchFn = async (url) => url.endsWith("/json/list")
    ? { ok: true, json: async () => targets }
    : f.fetchFn(url);
  const launcher = newLauncher(store, f, spawnedArgs, undefined, async () => {
    prepared++;
    return { status: "configured", engine: "DuckDuckGo" };
  }, {
    hostPlatform: "win32",
    fetch: fetchFn,
    navigate: async (_ws, urls) => { navigated.push(urls); },
  });

  await launcher.start("k1d0cd11", ["https://explicit.example/start"], { restoreLastSession: true });
  expect(prepared).toBe(1);
  expect(spawnedArgs[0]).toContain("--restore-last-session");
  expect(navigated).toEqual([["https://explicit.example/start"]]);
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBe(2);
  expect(await launcher.stop("k1d0cd11")).toBe(true);

  targets = [{ type: "page", url: "about:blank" }];
  // Chromium loaded its last session, cookies included, even though no page came back.
  expect(await launcher.start("k1d0cd11")).toMatchObject({ nativeSessionRestored: false, nativeSessionLoaded: true });
  expect(prepared).toBe(1);
  expect(spawnedArgs[1]).toContain("--restore-last-session");
  expect(navigated).toEqual([
    ["https://explicit.example/start"],
  ]);
  store.close();
});

test("Windows Local removes a legacy first-run tab without replacing restored tabs", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, platform: "x.com" });
  const f = fleet();
  const navigated: string[][] = [];
  const userDataDir = join(testDataRoot(store), "k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  const launcher = newLauncher(store, f, [], undefined, async () => ({
    status: "configured",
    engine: "DuckDuckGo",
  }), {
    hostPlatform: "win32",
    fetch: async (url) => url.endsWith("/json/list")
      ? {
          ok: true,
          json: async () => [
            { type: "page", url: "https://restored.example/account" },
            { type: "page", url: "chrome://ungoogled-first-run/" },
          ],
        }
      : f.fetchFn(url),
    navigate: async (_ws, urls) => { navigated.push(urls); },
  });

  await launcher.start("k1d0cd11");
  expect(navigated).toEqual([[]]);
  store.close();
});

for (const hostPlatform of ["darwin", "linux"] as const) {
  test(`${hostPlatform} Local restores native tabs instead of opening platform home`, async () => {
    const store = seeded();
    const profile = store.getProfile("k1d0cd11")!;
    store.upsertProfile({ ...profile, platform: "x.com" });
    const f = fleet();
    const spawnedArgs: string[][] = [];
    const navigated: string[][] = [];
    const userDataDir = join(testDataRoot(store), "k1d0cd11");
    mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
    writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
    const launcher = newLauncher(store, f, spawnedArgs, undefined, async () => ({
      status: "already-default",
      engine: "DuckDuckGo",
    }), {
      hostPlatform,
      fetch: async (url) => url.endsWith("/json/list")
        ? {
            ok: true,
            json: async () => [
              { type: "page", url: "https://restored.example/account" },
              { type: "page", url: "chrome://ungoogled-first-run/" },
            ],
          }
        : f.fetchFn(url),
      navigate: async (_ws, urls) => { navigated.push(urls); },
    });

    await launcher.start("k1d0cd11");

    expect(spawnedArgs[0]).toContain("--restore-last-session");
    expect(navigated).toEqual([[]]);
    await launcher.stop("k1d0cd11");
    store.close();
  });
}

for (const caller of ["Local", "Cloud"] as const) {
  test(`${caller} open of a native session ${caller === "Cloud" ? "waits for a delayed restored tab" : "reads the tabs once"} and opens no platform home`, async () => {
    const store = seeded();
    const profile = store.getProfile("k1d0cd11")!;
    store.upsertProfile({ ...profile, platform: "x.com" });
    const f = fleet();
    const navigated: string[][] = [];
    const userDataDir = join(testDataRoot(store), "k1d0cd11");
    mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
    writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
    let targetReads = 0;
    const launcher = newLauncher(store, f, [], undefined, async () => ({
      status: "already-default",
      engine: "DuckDuckGo",
    }), {
      hostPlatform: "win32",
      fetch: async (url) => url.endsWith("/json/list")
        ? {
            ok: true,
            json: async () => ++targetReads >= 22
              ? [{ type: "page", url: "https://restored.example/delayed" }]
              : [{ type: "page", url: "about:blank" }],
          }
        : f.fetchFn(url),
      navigate: async (_ws, urls) => { navigated.push(urls); },
    });

    // Only Cloud, which navigates by itself, uses the late restored tab.
    const launched = await launcher.start("k1d0cd11", [], caller === "Cloud" ? { autoNavigate: false } : {});

    if (caller === "Cloud") {
      expect(targetReads).toBeGreaterThanOrEqual(22);
      expect(launched.nativeSessionRestored).toBe(true);
    } else {
      expect(targetReads).toBe(1);
    }
    expect(navigated).toEqual([]);
    await launcher.stop("k1d0cd11");
    store.close();
  });
}

test("fresh native session restore reports only a restored user page", async () => {
  const store = seeded();
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const userDataDir = join(testDataRoot(store), "k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
  const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
    fetch: async (url) => url.endsWith("/json/list")
      ? { ok: true, json: async () => [{ type: "page", url: "https://restored.example/account" }] }
      : f.fetchFn(url),
  });

  const result = await launcher.start("k1d0cd11");

  expect(spawnedArgs[0]).toContain("--restore-last-session");
  expect(result.nativeSessionRestored).toBe(true);
  store.close();
});

test("fresh launch reports false when native session restore has no artifacts or is opted out", async () => {
  const store = seeded();
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const launcher = newLauncher(store, f, spawnedArgs);

  const missing = await launcher.start("k1d0cd11");
  expect(spawnedArgs[0]).not.toContain("--restore-last-session");
  expect(missing.nativeSessionRestored).toBe(false);
  await launcher.stop("k1d0cd11");

  const userDataDir = launcher.userDataDir("k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
  const optedOut = await launcher.start("k1d0cd11", [], { restoreLastSession: false });
  expect(spawnedArgs[1]).not.toContain("--restore-last-session");
  expect(optedOut.nativeSessionRestored).toBe(false);
  store.close();
});

test("stale cleanup prevents a deleted native session from being reported restored", async () => {
  const store = seeded();
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const userDataDir = join(testDataRoot(store), "k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
  writeFileSync(join(userDataDir, "SingletonLock"), "stale");
  const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
    resetStorageOnUncleanExit: true,
  });

  const result = await launcher.start("k1d0cd11");

  expect(existsSync(join(userDataDir, "Default", "Sessions"))).toBe(false);
  expect(spawnedArgs[0]).not.toContain("--restore-last-session");
  expect(result.nativeSessionRestored).toBe(false);
  store.close();
});

test("native session is unreadable only when DPAPI rejects its cookie key, once per key", async () => {
  const store = seeded();
  const checked: string[][] = [];
  let answer: boolean[] | null = [false];
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    dpapiKeysReadable: async (keys) => { checked.push(keys); return answer; },
  });
  const dir = launcher.userDataDir("k1d0cd11");
  mkdirSync(dir, { recursive: true });
  expect(await launcher.nativeSessionReadable("k1d0cd11")).toBe(true); // no Local State
  const blob = Buffer.concat([Buffer.from("DPAPI"), Buffer.from("other account")]);
  writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: blob.toString("base64") } }));
  expect(await launcher.nativeSessionReadable("k1d0cd11")).toBe(false);
  expect(await launcher.nativeSessionReadable("k1d0cd11")).toBe(false);
  expect(checked).toEqual([[Buffer.from("other account").toString("base64")]]);

  // An unanswered check keeps native reuse and is not cached.
  writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), Buffer.from("new key")]).toString("base64") } }));
  answer = null;
  expect(await launcher.nativeSessionReadable("k1d0cd11")).toBe(true);
  answer = [true];
  expect(await launcher.nativeSessionReadable("k1d0cd11")).toBe(true);
  expect(checked.length).toBe(3);
  store.close();
});

test("free space is read from the drive that holds profile data", () => {
  const store = seeded();
  const root = join(tmpdir(), `cloak-disk-${crypto.randomUUID()}`);
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, { dataRoot: root });
  expect(launcher.dataDriveFreeBytes()).toBeNull(); // not created yet
  mkdirSync(root, { recursive: true });
  expect(launcher.dataDriveFreeBytes()).toBeGreaterThan(0);
  rmSync(root, { recursive: true, force: true });
  store.close();
});

// Windows Chromium deletes every cookie it cannot decrypt. A Local profile has no other copy.
test("Windows Local keeps a copy of unreadable cookies and does not open the profile", async () => {
  for (const readable of [false, true]) {
    const store = seeded();
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform: "win32",
      dpapiKeysReadable: async () => [readable],
    });
    const dir = launcher.userDataDir("k1d0cd11");
    const localState = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("DPAPIother account").toString("base64") } });
    mkdirSync(join(dir, "Default", "Network"), { recursive: true });
    writeFileSync(join(dir, "Local State"), localState);
    writeFileSync(join(dir, "Default", "Network", "Cookies"), "cookie jar");
    writeFileSync(join(dir, "Default", "Network", "Cookies-journal"), "journal");
    writeFileSync(join(dir, "Default", "Network", "TransportSecurity"), "other");
    if (readable) {
      await launcher.start("k1d0cd11");
      expect(spawnedArgs.length).toBe(1);
      expect(existsSync(join(dir, "cookie-backups"))).toBe(false);
      expect(await launcher.stop("k1d0cd11")).toBe(true);
    } else {
      const error = await launcher.start("k1d0cd11").catch((caught) => caught);
      expect(error).toBeInstanceOf(BrowserLaunchError);
      expect(error.preflightReason).toBe("cookie_key_unreadable");
      expect(error.guidance).toContain("AliasMode did not open this profile");
      expect(spawnedArgs).toEqual([]);
      expect(store.getLaunch("k1d0cd11")).toBeNull();
      const [dated] = readdirSync(join(dir, "cookie-backups"));
      const backup = join(dir, "cookie-backups", dated!);
      expect(readFileSync(join(backup, "Local State"), "utf8")).toBe(localState);
      expect(readdirSync(join(backup, "Default", "Network")).sort()).toEqual(["Cookies", "Cookies-journal"]);
      expect(readFileSync(join(backup, "Default", "Network", "Cookies"), "utf8")).toBe("cookie jar");
      // The originals stay where they were.
      expect(readFileSync(join(dir, "Default", "Network", "Cookies"), "utf8")).toBe("cookie jar");
      // Another try keeps the one copy of these cookies.
      await expect(launcher.start("k1d0cd11")).rejects.toBeInstanceOf(BrowserLaunchError);
      expect(readdirSync(join(dir, "cookie-backups"))).toEqual([dated!]);
    }
    store.close();
  }
});

test("Cloud opens leave unreadable Windows cookies to the Cloud copy", async () => {
  const store = seeded();
  const spawnedArgs: string[][] = [];
  let checks = 0;
  const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
    hostPlatform: "win32",
    dpapiKeysReadable: async () => { checks++; return [false]; },
  });
  const dir = launcher.userDataDir("k1d0cd11");
  mkdirSync(join(dir, "Default", "Network"), { recursive: true });
  writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("DPAPIother account").toString("base64") } }));
  writeFileSync(join(dir, "Default", "Network", "Cookies"), "cookie jar");
  await launcher.start("k1d0cd11", [], { restoreLocalSession: false, restoreLastSession: false });
  expect(spawnedArgs.length).toBe(1);
  expect(checks).toBe(0);
  expect(await launcher.stop("k1d0cd11")).toBe(true);
  store.close();
});

test("a Local Windows profile with no saved cookies or with a pending session opens without the cookie key check", async () => {
  for (const pending of [false, true]) {
    const store = seeded();
    const spawnedArgs: string[][] = [];
    let checks = 0;
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform: "win32",
      dpapiKeysReadable: async () => { checks++; return [false]; },
      applySession: async () => {},
    });
    const dir = launcher.userDataDir("k1d0cd11");
    mkdirSync(join(dir, "Default", "Network"), { recursive: true });
    writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("DPAPIother account").toString("base64") } }));
    if (pending) {
      // The pending bundle replaces the cookies, so losing the unreadable ones does no harm.
      writeFileSync(join(dir, "Default", "Network", "Cookies"), "cookie jar");
      store.upsertProfiles([store.getProfile("k1d0cd11")!], new Map([["k1d0cd11", JSON.stringify({ cookies: [], origins: [], tabs: [] })]]));
    }
    await launcher.start("k1d0cd11");
    expect(spawnedArgs.length).toBe(1);
    expect(checks).toBe(0);
    expect(await launcher.stop("k1d0cd11")).toBe(true);
    store.close();
  }
});

test("cloud session authority marker is durable and invalidatable", () => {
  const store = seeded();
  const f = fleet();
  const signature = createHash("sha256").update("cloud session").digest("hex");
  const otherSignature = createHash("sha256").update("other cloud session").digest("hex");
  const first = newLauncher(store, f, []);

  expect(first.matchesCloudSession("k1d0cd11", signature)).toBe(false);
  first.recordCloudSession("k1d0cd11", signature);

  const marker = join(first.userDataDir("k1d0cd11"), ".aliasmode-cloud-session-authority-v1");
  expect(readFileSync(marker, "utf8")).toBe(signature);
  const restarted = newLauncher(store, f, []);
  expect(restarted.matchesCloudSession("k1d0cd11", signature)).toBe(true);
  expect(restarted.matchesCloudSession("k1d0cd11", otherSignature)).toBe(false);

  writeFileSync(marker, "malformed");
  expect(restarted.matchesCloudSession("k1d0cd11", signature)).toBe(false);
  restarted.recordCloudSession("k1d0cd11", signature);
  restarted.recordCloudSession("k1d0cd11", null);
  expect(existsSync(marker)).toBe(false);
  expect(restarted.matchesCloudSession("k1d0cd11", signature)).toBe(false);
  store.close();
});

test("Cloud session marker invalidation fails closed", () => {
  const store = seeded();
  const launcher = newLauncher(store, fleet(), []);
  const marker = join(launcher.userDataDir("k1d0cd11"), ".aliasmode-cloud-session-authority-v1");
  mkdirSync(marker, { recursive: true });

  expect(() => launcher.recordCloudSession("k1d0cd11", null)).toThrow("cannot invalidate Cloud session");
  store.close();
});

test("reattach safely migrates one revision-1 browser through managed search setup", async () => {
  const store = seeded();
  const f = fleet();
  const first = newLauncher(store, f, []);
  await first.start("k1d0cd11");
  rmSync(join(first.userDataDir("k1d0cd11"), ".aliasmode-search-bootstrap-v2"), { force: true });
  writeFileSync(join(first.userDataDir("k1d0cd11"), ".aliasmode-search-bootstrap-v1"), "1\n");
  const legacy = store.getLaunch("k1d0cd11")!;
  store.recordLaunch({ ...legacy, searchBootstrapRevision: 1 });
  (first as any).closeRelay("k1d0cd11");

  const prepared: string[] = [];
  const spawnedArgs: string[][] = [];
  const launcher = newLauncher(store, f, spawnedArgs, undefined, async (options) => {
    prepared.push(options.userDataDir);
    return { status: "already-default", engine: "DuckDuckGo" };
  });

  await launcher.reconcileOrphans();
  const opened = await launcher.start("k1d0cd11");

  expect(opened.port).toBe(legacy.debugPort);
  expect(spawnedArgs).toHaveLength(1);
  expect(prepared).toEqual([launcher.userDataDir("k1d0cd11")]);
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBe(2);
  store.close();
});

test("legacy search bootstrap never spawns while safe teardown is unconfirmed", async () => {
  const store = seeded();
  const f = fleet();
  const first = newLauncher(store, f, []);
  await first.start("k1d0cd11");
  const legacy = store.getLaunch("k1d0cd11")!;
  store.recordLaunch({ ...legacy, searchBootstrapRevision: undefined });
  (first as any).closeRelay("k1d0cd11");

  let spawned = 0;
  let prepared = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: () => {
      spawned++;
      throw new Error("unsafe second browser spawn");
    },
    fetch: f.fetchFn,
    ensureSearchProvider: async () => {
      prepared++;
      return { status: "configured", engine: "DuckDuckGo" };
    },
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(
    new BrowserLaunchError("preflight", "browser_unresponsive"),
  );
  expect(spawned).toBe(0);
  expect(prepared).toBe(0);
  expect(store.getLaunch("k1d0cd11")?.pid).toBe(legacy.pid);
  store.close();
});

test("survivor certification retires an unstamped browser before exposure", async () => {
  const store = seeded();
  const f = fleet();
  const first = newLauncher(store, f, []);
  await first.start("k1d0cd11");
  const legacy = store.getLaunch("k1d0cd11")!;
  store.recordLaunch({ ...legacy, searchBootstrapRevision: undefined });
  (first as any).closeRelay("k1d0cd11");

  const killed: number[] = [];
  const launcher = newLauncher(store, f, [], killed);
  expect(await launcher.certifySurvivors()).toEqual({ certified: 0, stopped: 1 });
  expect(killed).toEqual([legacy.pid]);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("startup adopts a matching legacy launch identity only to stop it before reuse", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const launcherA = newLauncher(store, f, []);
  await launcherA.start("k1d0cd11");
  const current = store.getLaunch("k1d0cd11")!;
  const ownedPid = current.pid;
  store.recordLaunch({
    ...current,
    binaryPath: undefined,
    userDataDir: undefined,
    binarySha256: undefined,
    personaDigest: undefined,
  });

  const killed: number[] = [];
  const launcherB = newLauncher(store, f, [], killed);
  expect(await launcherB.certifySurvivors()).toEqual({ certified: 0, stopped: 1 });
  expect(killed).toEqual([ownedPid]);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("startup retains an unmatched legacy launch row in quarantine", async () => {
  const store = seeded();
  makeDirect(store);
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 4321,
    debugPort: 49123,
    ws: "ws://127.0.0.1:49123/devtools/browser/legacy",
    startedAt: 1,
  });
  const f = fleet();
  const killed: number[] = [];
  const launcher = newLauncher(store, f, [], killed);

  expect(await launcher.certifySurvivors()).toEqual({ certified: 0, stopped: 1 });
  expect(killed).toEqual([]);
  expect(store.getLaunch("k1d0cd11")?.debugPort).toBe(49123);
  store.close();
});

test("restart config drift scans the survivor with its persisted binary and user-data paths", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const oldRoot = join(tmpdir(), `cloak-old-root-${crypto.randomUUID()}`);
  const newRoot = join(tmpdir(), `cloak-new-root-${crypto.randomUUID()}`);
  const launcherA = new Launcher({
    store,
    binaryPath: "/old/cloakbrowser",
    dataRoot: oldRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    ensureSearchProvider: async () => ({ status: "already-default", engine: "DuckDuckGo" }),
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 1000,
  });
  await launcherA.start("k1d0cd11");
  // Simulate the old manager process exiting: its loopback listener disappears
  // while the browser/launch row survives for the replacement manager.
  (launcherA as any).closeRelay("k1d0cd11");
  const persisted = store.getLaunch("k1d0cd11")!;
  const scanned: Array<{ binaryPath: string; userDataDir: string }> = [];
  let spawns = 0;
  const launcherB = new Launcher({
    store,
    binaryPath: "/new/cloakbrowser",
    dataRoot: newRoot,
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: async (identity) => {
      scanned.push({ binaryPath: identity.binaryPath, userDataDir: identity.userDataDir });
      return f.findOwnedBrowserPids(identity);
    },
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
  });

  const result = await launcherB.start("k1d0cd11");
  expect(result.port).toBe(persisted.debugPort);
  expect(spawns).toBe(0);
  expect(scanned[0]).toEqual({
    binaryPath: "/old/cloakbrowser",
    userDataDir: resolve(oldRoot, "k1d0cd11"),
  });
  await launcherB.stop("k1d0cd11");
  store.close();
  rmSync(oldRoot, { recursive: true, force: true });
  rmSync(newRoot, { recursive: true, force: true });
});

test("a live browser rejects a requested launch-mode change until it is closed", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const launcherA = newLauncher(store, f, []);
  await launcherA.start("k1d0cd11");
  const launcherB = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    headless: true,
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
  });

  await expect(launcherB.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("mode_conflict"));
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("a restart retires a proxied survivor launched with the old WebRTC persona policy", async () => {
  const store = seeded();
  const f = fleet();
  const launcherA = newLauncher(store, f, []);
  await launcherA.start("k1d0cd11");
  (launcherA as any).closeRelay("k1d0cd11");
  const launch = store.getLaunch("k1d0cd11")!;
  store.recordLaunch({
    ...launch,
    personaDigest: legacyProxyPersonaDigest(store, "k1d0cd11", launch.binarySha256!),
  });

  const launcherB = newLauncher(store, f, []);
  await expect(launcherB.start("k1d0cd11")).rejects.toMatchObject({
    failure: "preflight",
    preflightReason: "stored_identity",
  });
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("after a restart, a surviving SOCKS5 browser rebinds its relay before reuse", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...profile,
    proxy: { type: "socks5", host: "proxy.example", port: "1080", user: "u", pass: "p" },
  });
  const f = fleet();
  const launcherA = newLauncher(store, f, []);
  await launcherA.start("k1d0cd11");
  (launcherA as any).closeRelay("k1d0cd11");

  const launcherB = newLauncher(store, f, []);
  await launcherB.start("k1d0cd11");
  await launcherB.start("k1d0cd11");

  expect(store.getLaunch("k1d0cd11")?.relayPort).toBeNumber();
  await launcherB.stop("k1d0cd11");
  store.close();
});

test("certifiedActive keeps a browser edited while open; a launch row without its start identity needs this process's proof", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...profile,
    proxy: { type: "socks5", host: "proxy.example", port: "1080", user: "", pass: "" },
    timezone: "America/New_York",
  });
  const f = fleet();
  const priorLauncher = newLauncher(store, f, []);
  await priorLauncher.start("k1d0cd11");
  (priorLauncher as any).closeRelay("k1d0cd11");
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    spawn: () => { throw new Error("must not spawn"); },
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    browserClose: async () => false,
    killPid: async (pid) => f.killPid(pid),
  });

  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);

  const edited = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...edited, timezone: "Europe/London", proxy: { type: "socks5", host: "other.example", port: "1081", user: "", pass: "" } });
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  expect(launchIdentityChanged(store.getProfile("k1d0cd11")!, store.getLaunch("k1d0cd11"))).toBe(true);
  const fresh = () => new Launcher({
    store,
    binaryPath: "/fake/cloak",
    spawn: () => { throw new Error("must not spawn"); },
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    browserClose: async () => false,
    killPid: async (pid) => f.killPid(pid),
  });
  // The launch row keeps the start identity, so a process that never proved the browser keeps it too.
  (launcher as any).closeRelay("k1d0cd11");
  const unproven = fresh();
  expect(await unproven.certifiedActive("k1d0cd11")).toBe(true);
  (unproven as any).closeRelay("k1d0cd11");

  // A launch row from before launch identities were saved: this process proved the browser, so it keeps running.
  const { persona: _persona, ...legacy } = store.getLaunch("k1d0cd11")!;
  store.recordLaunch(legacy);
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  // After an app restart nothing proved it, and a survivor that differs from its profile stops.
  expect(await fresh().certifiedActive("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("a proxy or fingerprint saved while the browser runs keeps it running; its next start uses them", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const args: string[][] = [];
  const launcher = newLauncher(store, f, args);
  await launcher.start("k1d0cd11");
  const before = store.getLaunch("k1d0cd11")!;
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, name: "Renamed", screenWidth: 1366, screenHeight: 768, fingerprintSeed: profile.fingerprintSeed + 1 });
  // Open again while it runs: the running browser is returned, not stopped or relaunched.
  await launcher.start("k1d0cd11");
  expect(args).toHaveLength(1);
  expect(store.getLaunch("k1d0cd11")!.startedAt).toBe(before.startedAt);
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  await launcher.stop("k1d0cd11");
  await launcher.start("k1d0cd11");
  expect(args).toHaveLength(2);
  expect(args[1]).toContain("--fingerprint-screen-width=1366");
  expect(launchIdentityChanged(store.getProfile("k1d0cd11")!, store.getLaunch("k1d0cd11"))).toBe(false);
  await launcher.stop("k1d0cd11");
  store.close();
});

test("Open restarts a browser with a launch row from before launch identities when it was edited while open", async () => {
  const store = seeded();
  const f = fleet();
  const spawned: string[][] = [];
  const launcher = newLauncher(store, f, spawned);
  await launcher.start("k1d0cd11");
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  const { persona: _persona, ...legacy } = store.getLaunch("k1d0cd11")!;
  store.recordLaunch(legacy);

  store.upsertProfile({ ...store.getProfile("k1d0cd11")!, timezone: "Europe/London" });
  // Until the next open it keeps running with its launch-time settings.
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);

  // Without a stored start identity the relay and checks would read the edited profile, so Open restarts it.
  const second = await launcher.start("k1d0cd11");
  expect(spawned).toHaveLength(2);
  expect(second.reattached).toBeUndefined();
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  await launcher.stop("k1d0cd11");
  store.close();
});

test("a browser launched before launch identities were saved gets its identity at the next check", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const launcher = newLauncher(store, f, []);
  await launcher.start("k1d0cd11");
  const { persona: _persona, ...legacy } = store.getLaunch("k1d0cd11")!;
  store.recordLaunch(legacy);
  const survivor = newLauncher(store, f, []);
  expect(await survivor.certifiedActive("k1d0cd11")).toBe(true);
  expect(store.getLaunch("k1d0cd11")!.persona).toBeDefined();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, screenWidth: 1366, screenHeight: 768 });
  expect(await survivor.certifiedActive("k1d0cd11")).toBe(true);
  expect(launchIdentityChanged(store.getProfile("k1d0cd11")!, store.getLaunch("k1d0cd11"))).toBe(true);
  await survivor.stop("k1d0cd11");
  store.close();
});

test("start sets cookies added while closed before the first page, then clears them", async () => {
  const store = seeded();
  makeDirect(store);
  store.addPendingCookies("k1d0cd11", [
    { name: "auth_token", value: "new", domain: ".x.com", path: "/", expires: Date.now() / 1000 + 3600 },
    { name: "expired", value: "old", domain: ".x.com", path: "/", expires: 1 },
  ]);
  const events: string[] = [];
  const set: unknown[] = [];
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    setCookies: async (_ws, cookies) => { events.push("setCookies"); set.push(cookies.map((cookie) => cookie.name)); },
    navigate: async (_ws, urls) => { events.push(`navigate:${urls.join(",")}`); },
  });
  try {
    await launcher.start("k1d0cd11", ["https://x.com/home"]);
    expect(set).toEqual([["auth_token"]]);
    expect(events).toEqual(["setCookies", "navigate:https://x.com/home"]);
    expect(store.getPendingCookies("k1d0cd11")).toEqual([]);
  } finally {
    await launcher.stop("k1d0cd11");
    store.close();
  }
});

test("cookies added while closed stay for the next start when setting them fails", async () => {
  const store = seeded();
  makeDirect(store);
  const cookie = { name: "auth_token", value: "new", domain: ".x.com", path: "/" };
  store.addPendingCookies("k1d0cd11", [cookie]);
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    setCookies: async () => { throw new Error("worker failed"); },
  });
  try {
    await launcher.start("k1d0cd11");
    expect(store.getLaunch("k1d0cd11")).not.toBeNull();
    expect(store.getPendingCookies("k1d0cd11")).toEqual([cookie]);
  } finally {
    await launcher.stop("k1d0cd11");
    store.close();
  }
});

test("certifiedActive rides out a transient CDP miss and retains a survivor that stays silent", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const prior = newLauncher(store, f, []);
  await prior.start("k1d0cd11");

  let versionProbes = 0;
  let failThirdProbe = true;
  let silent = false;
  let browserCloses = 0;
  const killed: number[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    spawn: () => { throw new Error("must not spawn"); },
    fetch: async (url) => {
      if (url.includes("/json/version") && (silent || (++versionProbes === 3 && failThirdProbe))) {
        return { ok: false, json: async () => ({}) };
      }
      return f.fetchFn(url);
    },
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    browserClose: async () => { browserCloses++; return false; },
    killPid: async (pid) => { killed.push(pid); f.killPid(pid); },
  });

  // One missed probe of a running browser is retried, not read as a dead browser.
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  expect(versionProbes).toBeGreaterThan(3);

  // A browser that stops answering reads as not active, but is never closed for it.
  silent = true;
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(browserCloses).toBe(0);
  expect(killed).toEqual([]);

  silent = false;
  failThirdProbe = false;
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(true);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("after a restart, start() drops a dead launch row and launches fresh", async () => {
  const store = seeded();
  const f = fleet();

  const argsA: string[][] = [];
  const a = await newLauncher(store, f, argsA).start("k1d0cd11");
  f.crash(a.port); // the previous browser died

  const argsB: string[][] = [];
  const launcherB = newLauncher(store, f, argsB);
  const b = await launcherB.start("k1d0cd11");

  expect(argsB.length).toBe(1); // spawned a fresh browser
  expect(b.ws).toContain("ws://");
  store.close();
});

test("same manager starts fresh when an externally-killed tracked browser was never stopped through AliasMode", async () => {
  const store = seeded();
  const f = fleet();
  const args: string[][] = [];
  const launcher = newLauncher(store, f, args);
  const first = await launcher.start("k1d0cd11");
  f.crash(first.port); // e.g. Automation' debug-port backstop/orphan sweeper

  const second = await launcher.start("k1d0cd11");

  expect(args.length).toBe(2);
  expect(second.port).toBe(first.port);
  expect(store.getLaunch("k1d0cd11")?.ws).toBe(second.ws);
  store.close();
});

test("reconcileOrphans clears dead rows WITHOUT killing by the stored PID", async () => {
  const store = seeded();
  const f = fleet();
  const launcherA = newLauncher(store, f, []);
  const a = await launcherA.start("k1d0cd11");
  const base = launcherA.userDataDir("k1d0cd11");
  const cacheDir = join(base, "Default", "GPUCache");
  const cookies = join(base, "Default", "Network", "Cookies");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "data_0"), "junk");
  mkdirSync(join(base, "Default", "Network"), { recursive: true });
  writeFileSync(cookies, "SQLite-cookies");
  f.crash(a.port);

  const launcherB = newLauncher(store, f, []);
  const { cleared } = await launcherB.reconcileOrphans();

  expect(cleared).toBe(1);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(f.killed.length).toBe(0); // no blind SIGKILL of a possibly-recycled PID
  await (launcherB as any).cacheClears.get("k1d0cd11");
  expect(existsSync(cacheDir)).toBe(false);
  expect(existsSync(cookies)).toBe(true);
  rmSync(base, { recursive: true, force: true });
  store.close();
});

test("reconcileOrphans keeps a still-live launch row and reserves its port", async () => {
  const store = seeded();
  const f = fleet();
  await newLauncher(store, f, []).start("k1d0cd11");

  const launcherB = newLauncher(store, f, []);
  const { cleared } = await launcherB.reconcileOrphans();

  expect(cleared).toBe(0);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("reconcileOrphans frees the dead launch's reserved port (no port leak)", async () => {
  const store = seeded();
  const f = fleet();
  const launcher = newLauncher(store, f, []);
  const a = await launcher.start("k1d0cd11"); // reserves a.port
  f.crash(a.port); // browser killed outside the manager (the automation teardown path)
  await launcher.reconcileOrphans(); // clears the row AND must free the port

  // Same launcher relaunches → reuses the freed port instead of skipping past it.
  const b = await launcher.start("k1d0cd11");
  expect(b.port).toBe(a.port);
  store.close();
});

test("reconcileOrphans keeps a launch when CDP misses but its recorded process is still alive", async () => {
  const store = seeded();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 7001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/slow",
    startedAt: 1,
  });
  const logs: string[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    fetch: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
    isPidAlive: (pid) => pid === 7001,
    findOwnedBrowserPids: async () => [7001],
    spawn: () => ({ pid: 1, kill() {} }),
    ensureCookies: async () => ({ injected: false }),
    log: (m) => logs.push(m),
  });

  const { cleared } = await launcher.reconcileOrphans();

  expect(cleared).toBe(0);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(logs.some((m) => m.includes("quarantined unverified launch"))).toBe(true);
  store.close();
});

test("reconcileOrphans clears PID-0 launch once CDP is dead and exact ownership is empty", async () => {
  const store = seeded();
  let cdpAlive = true;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-pid-recovery-test",
    portProbe: () => true,
    spawn: () => ({ pid: 0, kill() {} }),
    fetch: async () => ({
      ok: cdpAlive,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/pidless" }),
    }),
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => [],
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    pidRecoveryGraceMs: 30_000,
  });

  await launcher.start("k1d0cd11");
  cdpAlive = false;

  // CDP-dead current handles are exact-scanned immediately; PID 0 is never
  // provisional proof of life once a successful scan finds no owner.
  expect((await launcher.reconcileOrphans()).cleared).toBe(1);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("successful start exact-scans and persists a PID when the session helper still reports 0", async () => {
  const store = seeded();
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-pre-record-pid-test",
    portProbe: () => true,
    spawn: () => ({ pid: 0, kill() {} }),
    fetch: async (url) => {
      const port = url.match(/:(\d+)\//)?.[1] ?? "9333";
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/pid-recovered` }) };
    },
    isPidAlive: (pid) => pid === 7444,
    findOwnedBrowserPids: async ({ debugPort, userDataDir, binaryPath }) => {
      expect(debugPort).toBe(9333);
      expect(userDataDir).toContain("cloak-pre-record-pid-test");
      expect(binaryPath).toBe("/fake/cloak");
      return [7444];
    },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
  });

  await launcher.start("k1d0cd11");

  expect(store.getLaunch("k1d0cd11")?.pid).toBe(7444);
  store.close();
});

test("ownership snapshot reads coalesce only while in flight and never cache an empty result", async () => {
  let reads = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const read = createInFlightSnapshotReader(async () => {
    reads++;
    if (reads === 1) {
      await firstBlocked;
      return [] as number[];
    }
    return [7444];
  });

  const a = read();
  const b = read();
  const c = read();
  expect(a).toBe(b);
  expect(b).toBe(c);
  await Promise.resolve();
  expect(reads).toBe(1);
  releaseFirst();
  expect(await Promise.all([a, b, c])).toEqual([[], [], []]);

  // Settled empty snapshots are not stale-cached: the next call reads again.
  expect(await read()).toEqual([7444]);
  expect(reads).toBe(2);
});

test("failed ownership snapshots back off without caching successful results", async () => {
  let reads = 0;
  let now = 1_000;
  const read = createFailureBackoffReader(
    async () => {
      reads++;
      return reads === 1 ? null : { records: [], incomplete: false };
    },
    (value) => value === null,
    60_000,
    () => now,
  );

  expect(await read()).toBeNull();
  expect(await read()).toBeNull();
  expect(reads).toBe(1);

  now += 60_000;
  expect(await read()).toEqual({ records: [], incomplete: false });
  expect(await read()).toEqual({ records: [], incomplete: false });
  expect(reads).toBe(3);
});

test("tasklist image parser ignores localized status text", () => {
  expect(parseTasklistImageNames([
    '"chrome.exe","123","Console","1","10,000 K"',
    '"CloakBrowser.exe","456","Console","1","20,000 K"',
    "INFO: No tasks are running which match the specified criteria.",
  ].join("\r\n"))).toEqual(new Set(["chrome.exe", "cloakbrowser.exe"]));
});

linuxTest("exact process matching adopts Linux deleted executables and quarantines wrong binaries", () => {
  const identity = {
    profileId: "k1d0cd11",
    debugPort: 9333,
    binaryPath: "/opt/cloak/chrome",
    userDataDir: "/profiles/k1d0cd11",
  };
  const argv = [
    "/opt/cloak/chrome",
    "--remote-debugging-port=9333",
    "--user-data-dir=/profiles/k1d0cd11",
  ];
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 41, executablePath: "/opt/cloak/chrome (deleted)", argv }],
  })).toEqual([41]);
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 42, executablePath: "/usr/bin/chromium", argv }],
  })).toBeNull();
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 43, executablePath: "/usr/bin/chromium", argv: ["/usr/bin/chromium", "--other"] }],
  })).toEqual([]);
});

test("exact process matching handles Chromium's flattened Linux process title", () => {
  const identity = {
    profileId: "k1d0cd11",
    debugPort: 9333,
    binaryPath: "/opt/cloak/chrome",
    userDataDir: "/profiles/k1d0cd11",
  };
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{
      pid: 44,
      executablePath: identity.binaryPath,
      commandLine: `${identity.binaryPath} --remote-debugging-port=9333 --user-data-dir=${identity.userDataDir} --headless=new`,
    }],
  })).toEqual([44]);
});

test("exact process matching handles macOS ps-style command lines (spaces + port boundaries)", () => {
  const identity = {
    profileId: "k1d0cd11",
    debugPort: 9333,
    binaryPath: "/opt/cloakbrowser/Chromium.app/Contents/MacOS/Chromium",
    userDataDir: "/Users/jp/My Profiles/k1d0cd11",
  };
  const line = (extra: string) =>
    `${identity.binaryPath} --remote-debugging-port=9333 --user-data-dir=/Users/jp/My Profiles/k1d0cd11 ${extra}`;

  // The browser process — exact port + user-data-dir (incl. a space in the path) — is owned.
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 4242, executablePath: identity.binaryPath, commandLine: line("--type=browser") }],
  })).toEqual([4242]);

  // A renderer/helper shares the user-data-dir but lacks the debug port → not the owner.
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 4243, executablePath: identity.binaryPath, commandLine: `${identity.binaryPath} --type=renderer --user-data-dir=/Users/jp/My Profiles/k1d0cd11` }],
  })).toEqual([]);

  // A longer port number must not match on a prefix boundary.
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 4244, executablePath: identity.binaryPath, commandLine: `${identity.binaryPath} --remote-debugging-port=93330 --user-data-dir=/Users/jp/My Profiles/k1d0cd11` }],
  })).toEqual([]);

  // Browser gone → confirmed absence (empty, not null) so teardown can be confirmed.
  expect(matchOwnedBrowserPids(identity, { incomplete: false, records: [] })).toEqual([]);
});

test("macOS ps parsing preserves exact ownership when the app executable path has spaces", () => {
  const identity = {
    profileId: "k1d0cd11",
    debugPort: 9444,
    binaryPath: "/Applications/Cloak Browser.app/Contents/MacOS/Cloak Browser",
    userDataDir: "/Users/jp/AliasMode Profiles/k1d0cd11",
  };
  const commandLine =
    `${identity.binaryPath} --remote-debugging-port=${identity.debugPort} --user-data-dir=${identity.userDataDir}`;
  const snapshot = parseDarwinPsSnapshot(`  4242 ${commandLine}\n  55 /usr/sbin/syslogd\n`);

  // The parser cannot split argv[0] on whitespace, but the classifier can
  // compare the flattened line with the full launch-time executable path.
  expect(snapshot.records[0]?.executablePath).toBe("/Applications/Cloak");
  expect(matchOwnedBrowserPids(identity, snapshot)).toEqual([4242]);

  // A trustworthy OS executable field still wins over a spoofed argv[0].
  expect(matchOwnedBrowserPids(identity, {
    incomplete: false,
    records: [{ pid: 4243, executablePath: "/tmp/not-cloak", commandLine }],
  })).toBeNull();
});

test("Darwin Firefox kernel argv requires the actual executable and exact profile", () => {
  const identity = {
    binaryPath: "/Applications/Alias Mode.app/Contents/MacOS/firefox",
    userDataDir: "/Users/test/Alias Profiles/profile one",
    ownerBinaryPath: "/Applications/Alias Mode.app/Contents/MacOS/bun",
    generation: "generation-one",
  };
  const raw = [
    `  101 1 /tmp/spoofed -profile ${identity.userDataDir}`,
    `  102 1 /tmp/spoofed --aliasmode-firefox-owner=${identity.generation}`,
  ].join("\n");
  const snapshot = parseDarwinFirefoxPsSnapshot(raw, (pid) => pid === 101
    ? { executablePath: identity.binaryPath, argv: [identity.binaryPath, "-profile", identity.userDataDir] }
    : { executablePath: identity.ownerBinaryPath, argv: [identity.ownerBinaryPath, "firefox-worker.mjs", `--aliasmode-firefox-owner=${identity.generation}`] });

  expect(snapshot.incomplete).toBe(false);
  expect(snapshot.records[0]?.parentPid).toBe(1);
  expect(matchFirefoxProcesses(identity, snapshot)).toEqual({ browsers: [101], owners: [102] });

  const spoofed = parseDarwinFirefoxPsSnapshot(raw, (pid) => pid === 101
    ? { executablePath: "/tmp/other", argv: [identity.binaryPath, "-profile", identity.userDataDir] }
    : { executablePath: identity.ownerBinaryPath, argv: [identity.ownerBinaryPath, "firefox-worker.mjs", `--aliasmode-firefox-owner=${identity.generation}`] });
  expect(matchFirefoxProcesses(identity, spoofed)).toBeNull();
});

test("Darwin Firefox kernel argv rejects split and sibling profiles, bad generations, and failed queries", () => {
  const identity = {
    binaryPath: "/Applications/Alias Mode.app/Contents/MacOS/firefox",
    userDataDir: "/Users/test/Alias Profiles/profile one",
    ownerBinaryPath: "/Applications/Alias Mode.app/Contents/MacOS/bun",
    generation: "generation-one",
  };
  const raw = [
    "  201 1 firefox -profile candidate",
    "  202 1 firefox -profile candidate",
    "  203 1 bun --aliasmode-firefox-owner=candidate",
  ].join("\n");
  const snapshot = parseDarwinFirefoxPsSnapshot(raw, (pid) => {
    if (pid === 201) return {
      executablePath: identity.binaryPath,
      argv: [identity.binaryPath, "-profile", "/Users/test/Alias", "Profiles/profile one"],
    };
    if (pid === 202) return {
      executablePath: identity.binaryPath,
      argv: [identity.binaryPath, "-profile", `${identity.userDataDir} sibling`],
    };
    return {
      executablePath: identity.ownerBinaryPath,
      argv: [identity.ownerBinaryPath, "firefox-worker.mjs", `--aliasmode-firefox-owner=${identity.generation}-extra`],
    };
  });
  expect(matchFirefoxProcesses(identity, snapshot)).toEqual({ browsers: [], owners: [] });

  const malformed = parseDarwinFirefoxPsSnapshot(raw, () => null);
  expect(malformed.incomplete).toBe(true);
  expect(matchFirefoxProcesses(identity, malformed)).toBeNull();
  expect(parseDarwinKernelArgv(Uint8Array.of(1, 0, 0, 0, 47, 0, 0, 102))).toBeNull();

  const encoded = new TextEncoder().encode("/kernel/firefox\0\0firefox\0-profile\0/Users/test/Alias Profiles/profile one\0");
  const valid = new Uint8Array(encoded.byteLength + 4);
  valid[0] = 3;
  valid.set(encoded, 4);
  expect(parseDarwinKernelArgv(valid)).toEqual([
    "firefox", "-profile", "/Users/test/Alias Profiles/profile one",
  ]);

  const executable = Uint8Array.of(47, 98, 105, 110, 0);
  expect(parseDarwinKernelExecutablePath(executable, 4)).toBe("/bin");
  expect(parseDarwinKernelExecutablePath(executable, 3)).toBeNull();
});

test("native Windows process structures decode into exact identity fields", () => {
  const entry = new Uint8Array(568);
  const entryView = new DataView(entry.buffer);
  entryView.setUint32(8, 4321, true);
  entryView.setUint32(32, 1234, true);
  entry.set(Buffer.from("chrome.exe\0", "utf16le"), 44);
  expect(parseWindowsProcessEntry(entry)).toEqual({ pid: 4321, parentPid: 1234, processName: "chrome.exe" });

  const commandLine = '"C:\\Cloak\\chrome.exe" --remote-debugging-port=9333 "--user-data-dir=C:\\Data\\profile one"';
  const text = Buffer.from(commandLine, "utf16le");
  const buffer = new Uint8Array(16 + text.byteLength);
  const header = new DataView(buffer.buffer);
  header.setUint16(0, text.byteLength, true);
  header.setBigUint64(8, 0x10000n + 16n, true);
  buffer.set(text, 16);
  expect(decodeWindowsCommandLine(buffer, 0x10000)).toBe(commandLine);
  expect(matchOwnedBrowserPids(
    { profileId: "p1", debugPort: 9333, userDataDir: "C:\\Data\\profile one", binaryPath: "C:\\Cloak\\chrome.exe" },
    { records: [{ pid: 4321, executablePath: "C:\\Cloak\\chrome.exe", commandLine }], incomplete: false },
  )).toEqual([4321]);
  // A string pointer outside the buffer is unreadable, not an empty command line.
  expect(decodeWindowsCommandLine(buffer, 0x20000)).toBeNull();
  // WMI ends a command line at the first NUL that a process wrote into it.
  buffer.set(Buffer.from("\0", "utf16le"), 16 + 2 * commandLine.indexOf(" --remote"));
  expect(decodeWindowsCommandLine(buffer, 0x10000)).toBe('"C:\\Cloak\\chrome.exe"');
  header.setUint16(0, 0, true);
  expect(decodeWindowsCommandLine(buffer, 0x10000)).toBe("");
});

test.skipIf(process.platform === "win32")("the native Windows scan throws off Windows so the WMI fallback runs", () => {
  expect(() => readWindowsProcessSnapshotNative()).toThrow();
});

test.skipIf(process.platform !== "win32")("native Windows scan lists this process with the same fields as WMI", async () => {
  const native = readWindowsProcessSnapshotNative();
  expect(native.incomplete).toBe(false);
  const self = native.records.find((record) => record.pid === process.pid);
  expect(self?.executablePath).toBeTruthy();
  expect(self?.commandLine).toBeTruthy();
  expect(self?.parentPid).toBeGreaterThan(0);
  const wmi = await readWindowsProcessSnapshotWmi();
  const wmiSelf = wmi?.records.find((record) => record.pid === process.pid);
  // WMI may report a different letter case for the same path; every matcher compares paths case-insensitively.
  expect(wmiSelf?.executablePath?.toLowerCase()).toBe(self!.executablePath!.toLowerCase());
  expect(wmiSelf?.commandLine).toBe(self!.commandLine);
  expect(wmiSelf?.processName).toBe(self!.processName);
}, 90_000);

test("bounded process snapshot reader kills a hung scanner and returns unknown", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let finishExit!: (code: number) => void;
  let kills = 0;
  const exited = new Promise<number>((resolve) => { finishExit = resolve; });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
  });
  const child = {
    stdout,
    exited,
    kill() {
      kills++;
      streamController.close();
      finishExit(1);
    },
  };

  expect(await readSnapshotChildBounded(child, 5)).toBeNull();
  expect(kills).toBe(1);
});

test("start reports a live-but-CDP-unresponsive browser as retryable failure without spawning a duplicate", async () => {
  const store = seeded();
  const f = fleet();
  const args: string[][] = [];
  const launcher = newLauncher(store, f, args);
  const first = await launcher.start("k1d0cd11");

  // Memory pressure wedges the debug endpoint without ending Chromium.
  f.aliveByPort.set(first.port, false);
  const retained = store.getLaunch("k1d0cd11")!;
  const failure = await launcher.start("k1d0cd11").catch((error) => error);
  expect(failure).toEqual(new BrowserLaunchError("preflight", "browser_unresponsive"));
  expect(launcher.failedStartGeneration(failure)).toEqual({
    debugPort: retained.debugPort,
    startedAt: retained.startedAt,
  });

  expect(args.length).toBe(1); // never opened a second persistent user-data dir
  expect(store.getLaunch("k1d0cd11")?.debugPort).toBe(first.port);
  store.close();
});

test("platformHomeUrl lands supported platforms on their home pages", () => {
  expect(platformHomeUrl("linkedin.com")).toBe("https://www.linkedin.com/feed/");
  expect(platformHomeUrl("x.com")).toBe("https://x.com/home");
  expect(platformHomeUrl("instagram.com")).toBe("https://www.instagram.com/");
  expect(platformHomeUrl("facebook")).toBe("https://www.facebook.com/");
  expect(platformHomeUrl("www.tiktok.com")).toBe("https://www.tiktok.com/");
  expect(platformHomeUrl("reddit")).toBe("https://www.reddit.com/");
  expect(platformHomeUrl("telegram.org")).toBe("https://web.telegram.org/k/"); // standalone compatibility
  expect(platformHomeUrl("telegram.org", "a")).toBe("https://web.telegram.org/a/");
  expect(platformHomeUrl("telegram.org", "k")).toBe("https://web.telegram.org/k/");
  expect(platformHomeUrl("youtube.com")).toBe("https://www.youtube.com/");
  expect(platformHomeUrl("threads.net")).toBe("https://www.threads.com/");
  expect(platformHomeUrl("snapchat.com")).toBe("https://www.snapchat.com/web");
  expect(platformHomeUrl("discord")).toBe("https://discord.com/app");
  expect(platformHomeUrl("gmail.com")).toBe("https://mail.google.com/");
  expect(platformHomeUrl("ebay.com")).toBe("https://www.ebay.com/");
  expect(platformHomeUrl("")).toBeNull(); // unset platform → keep the browser default page
  expect(platformHomeUrl(undefined)).toBeNull();
});

test("isTelegramPlatform owns the shared Telegram alias set", () => {
  for (const alias of ["telegram", "telegram.org", "web.telegram.org", " Telegram.ORG "]) {
    expect(isTelegramPlatform(alias)).toBe(true);
  }
  for (const other of ["telegram.com", "nottelegram.org", "", undefined]) {
    expect(isTelegramPlatform(other)).toBe(false);
  }
});

test("Windows service sessions use the active-desktop launcher unless explicitly disabled", () => {
  expect(shouldLaunchViaWindowsSession({ SESSIONNAME: "Services" }, "win32")).toBe(true);
  expect(shouldLaunchViaWindowsSession({ SESSIONNAME: "Services", ALIASMODE_SESSION_LAUNCH: "0" }, "win32")).toBe(false);
  expect(shouldLaunchViaWindowsSession({ SESSIONNAME: "Services", ALIASMODE_LAUNCH_IN_SESSION: "0" }, "win32")).toBe(false);
  expect(shouldLaunchViaWindowsSession({ SESSIONNAME: "RDP-Tcp#3" }, "win32")).toBe(false);
  expect(shouldLaunchViaWindowsSession({ ALIASMODE_SESSION_LAUNCH: "1" }, "win32")).toBe(true);
  expect(shouldLaunchViaWindowsSession({ ALIASMODE_LAUNCH_IN_SESSION: "1" }, "win32")).toBe(true);
  expect(shouldLaunchViaWindowsSession({ SESSIONNAME: "Services" }, "darwin")).toBe(false);
});

test("quoteWindowsCommandArg preserves argv boundaries for the session-launch command line", () => {
  expect(quoteWindowsCommandArg("plain")).toBe("plain");
  expect(quoteWindowsCommandArg("C:\\Program Files\\Cloak\\chrome.exe")).toBe('"C:\\Program Files\\Cloak\\chrome.exe"');
  expect(quoteWindowsCommandArg('a"b')).toBe('"a\\"b"');
  // A trailing backslash right before the closing quote must be doubled — otherwise
  // Windows reads backslash+quote as an escaped literal quote instead of the argument's
  // closing quote, and the next argument gets swallowed into this one.
  expect(quoteWindowsCommandArg("C:\\path with space\\")).toBe('"C:\\path with space\\\\"');
  expect(quoteWindowsCommandArg("")).toBe('""');
});

test("start imports unexpired cookies for any site without a platform selection", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  const cookies = [
    { name: "SID", value: "google-session", domain: ".google.com", path: "/", expires: Date.now() / 1000 + 3600 },
    { name: "custom_session", value: "", domain: "example.org", path: "/" },
    { name: "expired", value: "old", domain: ".example.net", path: "/", expires: 1 },
  ];
  store.upsertProfile({ ...profile, platform: "", cookies });
  const injected: unknown[] = [];
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    ensureCookies: async (_ws, cookies) => { injected.push(cookies); return { injected: true }; },
  });
  try {
    await launcher.start(profile.id);
    expect(injected).toEqual([cookies.slice(0, 2)]);
    expect(store.getProfile(profile.id)!.seeded).toBe(true);
  } finally {
    await launcher.stop(profile.id);
    store.close();
  }
});

test("start skips expired imports without marking the profile seeded", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, cookies: [{ name: "SID", value: "old", domain: ".google.com", path: "/", expires: 1 }] });
  let calls = 0;
  const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
    ensureCookies: async () => { calls++; return { injected: true }; },
  });
  try {
    await launcher.start(profile.id);
    expect(calls).toBe(0);
    expect(store.getProfile(profile.id)!.seeded).toBe(false);
  } finally {
    await launcher.stop(profile.id);
    store.close();
  }
});

test("splitLaunchUrls separates startup URLs from chromium flags", () => {
  expect(splitLaunchUrls(["--start-maximized", "https://x.com/home", "http://example.test"])).toEqual({
    chromeArgs: ["--start-maximized"],
    startupUrls: ["https://x.com/home", "http://example.test"],
  });
});

test("buildArgs keeps AliasMode and forwarded Automation ownership markers distinct", () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    baseArgs: ["--aliasmode-launcher-pid=MANAGER"],
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
  });
  const profile = store.getProfile("k1d0cd11")!;
  const args = launcher.buildArgs(profile, 9333, "/data", ["--automation-launcher-pid=4242"]);
  const managerIdx = args.indexOf("--aliasmode-launcher-pid=MANAGER");
  const automationIdx = args.indexOf("--automation-launcher-pid=4242");
  expect(managerIdx).toBeGreaterThanOrEqual(0);
  expect(automationIdx).toBeGreaterThan(managerIdx);
  expect(args.filter((arg) => arg.startsWith("--automation-launcher-pid="))).toEqual([
    "--automation-launcher-pid=4242",
  ]);
  store.close();
});

test("CLI identifies the manager with the AliasMode marker, never the Automation marker", () => {
  const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  expect(cli).toContain('`--aliasmode-launcher-pid=${process.pid}`');
  expect(cli).toContain('has(rest, "no-sandbox") ? ["--no-sandbox"] : []');
  expect(cli).toContain('const unsafeCanary = has(rest, "unsafe-disable-identity-gates")');
  expect(cli).toContain("unsafeDisableIdentityGates: unsafeCanary");
  expect(cli).not.toContain('`--automation-launcher-pid=${process.pid}`');
});

test("buildArgs never forwards startup URLs to chromium argv", () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
  });
  const profile = store.getProfile("k1d0cd11")!;
  const args = launcher.buildArgs(profile, 9333, "/data", ["--disable-sync", "https://x.com/home"]);
  expect(args).toContain("--disable-sync");
  expect(args).toContain("--no-first-run");
  expect(args).toContain("--no-default-browser-check");
  expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  expect(launcher.buildArgs({ ...profile, proxy: null }, 9333, "/data", []))
    .toContain("--force-webrtc-ip-handling-policy=default_public_interface_only");
  expect(args).not.toContain("https://x.com/home");
  store.close();
});

test("buildArgs accepts the fixed Automation runtime flag bundle", () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn });
  const profile = store.getProfile("k1d0cd11")!;
  const launchArgs = [
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
    "--disable-features=BackForwardCache",
    "--disk-cache-size=1",
    "--media-cache-size=1",
    "--v8-cache-options=none",
    "--disable-gpu-shader-disk-cache",
    "--js-flags=--max-old-space-size=512",
    "--memory-pressure-off",
    "--automation-launcher-pid=4242",
  ];
  const args = launcher.buildArgs(profile, 9333, "/data", launchArgs);
  for (const arg of launchArgs) expect(args).toContain(arg);
  store.close();
});

test("buildArgs keeps Chromium 155 Google logins off the TPM binding and merges a forwarded --disable-features", () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn });
  const cloak = store.getProfile("k1d0cd11")!;
  const chromium155 = { ...cloak, chromiumRuntime: "aliasmode" as const };
  const features = (args: string[]) => args.filter((arg) => arg.startsWith("--disable-features="));

  expect(features(launcher.buildArgs(chromium155, 9333, "/data", [])))
    .toEqual(["--disable-features=DeviceBoundSessions,EnableBoundSessionCredentials"]);
  expect(features(launcher.buildArgs(chromium155, 9333, "/data", ["--disable-features=BackForwardCache"])))
    .toEqual(["--disable-features=DeviceBoundSessions,EnableBoundSessionCredentials,BackForwardCache"]);
  expect(features(launcher.buildArgs(cloak, 9333, "/data", []))).toEqual([]);
  store.close();
});

test("buildArgs forwards any client-named launcher-pid ownership marker verbatim", () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  const f = fleet();
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn });

  expect(launcher.buildArgs(profile, 9333, "/data", ["--xactions-launcher-pid=4242"]))
    .toContain("--xactions-launcher-pid=4242");
  expect(() => launcher.buildArgs(profile, 9333, "/data", ["--xactions-launcher-pid=0"]))
    .toThrow("unsafe launch_args rejected");
  expect(() => launcher.buildArgs(profile, 9333, "/data", ["--launcher-pid=4242"]))
    .toThrow("unsafe launch_args rejected");
  store.close();
});

test("buildArgs loads the exact extension assigned through the registry", () => {
  const store = seeded();
  store.addExtension({ id: "aapbdbdomjkkjkaonfhkkikfgjllcleb", name: "Fixture", loadDir: "/data/extensions/store-fixture" });
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, extensions: ["aapbdbdomjkkjkaonfhkkikfgjllcleb"] });
  const f = fleet();
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn });

  const args = launcher.buildArgs(store.getProfile("k1d0cd11")!, 9333, "/data", []);
  expect(args).toContain("--load-extension=/data/extensions/store-fixture");
  expect(args).toContain("--disable-extensions-except=/data/extensions/store-fixture");
  store.close();
});

test("buildArgs logs assigned extensions missing on this device", () => {
  const store = seeded();
  store.addExtension({ id: "installed", name: "Fixture", loadDir: "/data/extensions/store-fixture" });
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, extensions: ["installed", "missing-device"] });
  const logs: string[] = [];
  const f = fleet();
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    spawn: f.spawn,
    fetch: f.fetchFn,
    log: (message) => logs.push(message),
  });

  const args = launcher.buildArgs(store.getProfile("k1d0cd11")!, 9333, "/data", []);
  expect(args).toContain("--load-extension=/data/extensions/store-fixture");
  expect(logs).toEqual([
    "profile k1d0cd11: assigned extension missing-device is not installed on this device; skipped",
  ]);
  store.close();
});

test("buildArgs rejects identity, proxy, storage, extension, mode, and WebRTC overrides", () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn });
  const profile = store.getProfile("k1d0cd11")!;
  for (const arg of [
    "--proxy-server=http://attacker:8080",
    "--user-data-dir=/shared",
    "--fingerprint=1",
    "--fingerprint-platform=linux",
    "--user-agent=other",
    "--headless=new",
    "--load-extension=/tmp/e",
    "--force-webrtc-ip-handling-policy=default",
    "--remote-debugging-address=0.0.0.0",
    "--js-flags=--max-old-space-size=1024",
  ]) {
    expect(() => launcher.buildArgs(profile, 9333, "/data", [arg])).toThrow("unsafe launch_args rejected");
  }
  const safe = launcher.buildArgs(profile, 9333, "/data", ["--disable-sync", "https://x.com/home"]);
  expect(safe).toContain("--disable-sync");
  expect(safe).toContain("--remote-debugging-address=127.0.0.1");
  expect(safe).not.toContain("https://x.com/home");
  store.close();
});

test("authenticated SOCKS5 uses the compatibility relay before browser setup", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...profile,
    proxy: { type: "socks5", host: "proxy.example", port: "1080", user: "u", pass: "p@ss" },
  });
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const events: string[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, args) => { spawnedArgs.push(args); return f.spawn(bin, args); },
    fetch: f.fetchFn,
    ensureSearchProvider: async () => {
      events.push("ensureSearchProvider");
      return { status: "configured", engine: "DuckDuckGo" };
    },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");

  expect(spawnedArgs[0]!.some((arg) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(arg))).toBe(true);
  expect(spawnedArgs[0]!.some((arg) => arg.includes("u:p%40ss"))).toBe(false);
  expect(events).toEqual(["ensureSearchProvider"]);
  await launcher.stop("k1d0cd11");
  store.close();
});

test("authenticated HTTP uses the compatibility relay before browser setup", async () => {
  const store = seeded();
  const f = fleet();
  const events: string[] = [];
  const spawnedArgs: string[][] = [];
  const launcher = newLauncher(
    store,
    f,
    spawnedArgs,
    undefined,
    async () => { events.push("ensureSearchProvider"); return { status: "configured", engine: "DuckDuckGo" }; },
  );

  await launcher.start("k1d0cd11");

  expect(spawnedArgs[0]!.some((arg) => /^--proxy-server=http:\/\/127\.0\.0\.1:/.test(arg))).toBe(true);
  expect(events).toEqual(["ensureSearchProvider"]);
  await launcher.stop("k1d0cd11");
  store.close();
});

test("proxy relay failures do not expose upstream or target details through launcher logs", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  const secretHost = "secret-proxy-host.invalid";
  const secretUser = "secret-relay-user";
  const secretPass = "secret-relay-pass";
  store.upsertProfile({
    ...profile,
    proxy: { type: "http", host: secretHost, port: "8080", user: secretUser, pass: secretPass },
  });
  const f = fleet();
  const logs: string[] = [];
  const spawnedArgs: string[][] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, args) => { spawnedArgs.push(args); return f.spawn(bin, args); },
    fetch: f.fetchFn,
    ensureSearchProvider: async () => ({ status: "configured", engine: "DuckDuckGo" }),
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
    log: (message) => logs.push(message),
  });

  await launcher.start("k1d0cd11");

  const output = logs.join("\n");
  for (const secret of [secretHost, secretUser, secretPass]) {
    expect(output).not.toContain(secret);
  }
  await launcher.stop("k1d0cd11");
  store.close();
});

test("proxied launch preserves stored timezone and routes through the relay", async () => {
  const store = seeded();
  const original = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...original,
    proxy: { type: "socks5", host: "proxy.example", port: "1080", user: "u", pass: "p@ss" },
    timezone: "Europe/London",
    cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }],
  });
  const f = fleet();
  const events: string[] = [];
  const spawnedArgs: string[][] = [];
  const dataRoot = join(tmpdir(), `cloak-proxy-identity-${process.pid}`);
  rmSync(dataRoot, { recursive: true, force: true });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: (binary, args) => { events.push("spawn"); spawnedArgs.push(args); return f.spawn(binary, args); },
    fetch: f.fetchFn,
    ensureSearchProvider: async () => {
      events.push("search");
      return { status: "configured", engine: "DuckDuckGo" };
    },
    ensureCookies: async () => { events.push("cookies"); return { injected: false }; },
    navigate: async () => { events.push("navigate"); },
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11", ["https://x.com/home"]);
  expect(events).toEqual(["spawn", "search", "cookies", "navigate"]);
  expect(spawnedArgs[0]!.some((arg) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(arg))).toBe(true);
  expect(spawnedArgs[0]!.some((arg) => arg.includes("u:p%40ss"))).toBe(false);
  expect(spawnedArgs[0]!.some((arg) => arg.startsWith("--fingerprint-webrtc-ip="))).toBe(false);
  expect(spawnedArgs[0]).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  expect(spawnedArgs[0]).toContain("--fingerprint-timezone=Europe/London");
  expect(store.getProfile("k1d0cd11")?.timezone).toBe("Europe/London");
  const prefs = JSON.parse(readFileSync(join(dataRoot, "k1d0cd11", "Default", "Preferences"), "utf8"));
  expect(prefs.webrtc.ip_handling_policy).toBe("disable_non_proxied_udp");

  await launcher.stop("k1d0cd11");
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("host policy still blocks mobile and unrecognized personas before spawn", async () => {
  const store = seeded();
  const base = store.getProfile("k1d0cd11")!;
  const spawned: string[] = [];
  const logs: string[] = [];
  const make = (hostPlatform: NodeJS.Platform, hostArch: string) => new Launcher({
    store,
    binaryPath: "/fake",
    spawn: () => { spawned.push("spawn"); return { pid: 1, kill() {} }; },
    enforceHostCompatibility: true,
    hostPlatform,
    hostArch,
    log: (message) => logs.push(message),
  });

  // Cross-OS desktop spoofing is allowed now, but a desktop browser still can't
  // coherently emulate a mobile persona, and an imported UA must name a
  // recognized desktop platform.
  store.upsertProfile({ ...base, proxy: null, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/146.0 Mobile Safari/537.36" });
  await expect(make("win32", "x64").start("k1d0cd11")).rejects.toMatchObject({
    failure: "preflight",
    preflightReason: "persona_mobile",
  });
  store.upsertProfile({ ...base, proxy: null, ua: "not-a-real-user-agent" });
  await expect(make("darwin", "arm64").start("k1d0cd11")).rejects.toMatchObject({
    failure: "preflight",
    preflightReason: "persona_unsupported",
  });
  expect(spawned).toEqual([]);
  // The public error stays closed, while the local log gives fixed safe guidance.
  expect(logs.some((m) => m.includes(new BrowserLaunchError("preflight", "persona_mobile").guidance!))).toBe(true);
  expect(logs.some((m) => m.includes(new BrowserLaunchError("preflight", "persona_unsupported").guidance!))).toBe(true);
  store.close();
});

test("a custom spawner does not implicitly disable host policy", async () => {
  const store = seeded();
  const base = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...base, proxy: null, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/146.0 Mobile Safari/537.36" });
  let spawns = 0;
  const launcher = new ProductionLauncher({
    store,
    binaryPath: "/fake/cloak",
    expectedBinarySha256: "a".repeat(64),
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
    hostPlatform: "win32",
    hostArch: "x64",
  });

  await expect(launcher.start("k1d0cd11")).rejects.toMatchObject({
    failure: "preflight",
    preflightReason: "persona_mobile",
  });
  expect(spawns).toBe(0);
  store.close();
});

test("a Windows persona launches on a Mac host (cross-OS spoofing allowed)", async () => {
  const root = join(tmpdir(), `cloak-cross-os-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const binary = join(root, "cloakbrowser");
  writeFileSync(binary, "approved cloakbrowser kernel");
  const approved = createHash("sha256").update("approved cloakbrowser kernel").digest("hex");
  const store = seeded(); // seeded profile carries a Windows UA
  makeDirect(store);
  const f = fleet();
  let spawns = 0;
  const launcher = new ProductionLauncher({
    store,
    binaryPath: binary,
    expectedBinarySha256: approved,
    dataRoot: join(root, "profiles"),
    hostPlatform: "darwin",
    hostArch: "arm64",
    portProbe: () => true,
    spawn: (path, args) => { spawns++; return f.spawn(path, args); },
    captureFingerprint: async () => null,
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");
  expect(spawns).toBe(1);
  expect(store.getLaunch("k1d0cd11")!.personaDigest).toMatch(/^[a-f0-9]{64}$/);
  await launcher.stop("k1d0cd11");
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("fresh production launches require and verify the pinned CloakBrowser SHA-256", async () => {
  const root = join(tmpdir(), `cloak-kernel-pin-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const binary = join(root, "cloakbrowser");
  writeFileSync(binary, "approved cloakbrowser kernel");
  const approved = createHash("sha256").update("approved cloakbrowser kernel").digest("hex");
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  let spawns = 0;
  const launcher = new ProductionLauncher({
    store,
    binaryPath: binary,
    expectedBinarySha256: approved,
    dataRoot: join(root, "profiles"),
    hostPlatform: "win32",
    hostArch: "x64",
    portProbe: () => true,
    spawn: (path, args) => { expect(path).toBe(realpathSync(binary)); spawns++; return f.spawn(path, args); },
    captureFingerprint: async () => null,
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");
  const launch = store.getLaunch("k1d0cd11")!;
  expect(spawns).toBe(1);
  expect(launch.binaryPath).toBe(realpathSync(binary));
  expect(launch.binarySha256).toBe(approved);
  expect(launch.personaDigest).toMatch(/^[a-f0-9]{64}$/);
  await launcher.stop("k1d0cd11");

  const noPin = new ProductionLauncher({
    store,
    binaryPath: binary,
    expectedBinarySha256: "",
    hostPlatform: "win32",
    hostArch: "x64",
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
  });
  const noPinFailure = await noPin.start("k1d0cd11").catch((error) => error);
  expect(noPinFailure).toMatchObject({
    failure: "preflight",
    preflightReason: "chromium_setup",
  });

  const mismatch = new ProductionLauncher({
    store,
    binaryPath: binary,
    expectedBinarySha256: "f".repeat(64),
    hostPlatform: "win32",
    hostArch: "x64",
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
  });
  await expect(mismatch.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("binary_verification"));
  expect(spawns).toBe(1);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("missing Firefox kernel pin has an engine-specific preflight reason before owner startup", async () => {
  const root = join(tmpdir(), `firefox-kernel-pin-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const binary = join(root, "aliasmode-firefox");
  writeFileSync(binary, "approved Firefox kernel");
  const store = new ProfileStore(":memory:");
  const profile = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile({
    ...profile,
    engine: "firefox",
    firefox: {
      version: 1,
      runtimeVersion: "156.0.1-beta.36",
      config: {
        "navigator.userAgent": "Mozilla/5.0 Firefox/156.0",
        timezone: "UTC",
      },
    },
  });
  let spawns = 0;
  const launcher = new ProductionLauncher({
    store,
    firefoxBinaryPath: binary,
    expectedFirefoxBinarySha256: "",
    dataRoot: join(root, "profiles"),
    hostPlatform: "darwin",
    hostArch: "arm64",
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
  });

  const failure = await launcher.start("k1d0cd11").catch((error) => error);
  expect(failure).toMatchObject({
    failure: "preflight",
    preflightReason: "firefox_setup",
  });
  expect(spawns).toBe(0);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("authenticated HTTPS is rejected before spawn", async () => {
  const store = seeded();
  const base = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...base,
    proxy: { type: "https", host: "proxy.example", port: "8443", user: "u", pass: "p" },
  });
  let spawns = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
  });

  await expect(launcher.start("k1d0cd11")).rejects.toMatchObject({
    failure: "preflight",
    preflightReason: "proxy_https_auth",
  });
  expect(spawns).toBe(0);
  store.close();
});

test("a quarantined legacy proxy is visible but cannot launch direct", async () => {
  const store = seeded();
  (store as any)["db"].query("UPDATE profiles SET proxy_json = ? WHERE id = ?").run(
    JSON.stringify({ type: "socks4", host: "legacy.example", port: "1080", user: "u", pass: "p" }),
    "k1d0cd11",
  );
  let spawned = false;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    spawn: () => { spawned = true; return { pid: 1, kill() {} }; },
  });

  expect(store.getProfile("k1d0cd11")!.proxyError).toContain("unsupported proxy type");
  await expect(launcher.start("k1d0cd11")).rejects.toMatchObject({
    failure: "preflight",
    preflightReason: "proxy_invalid",
  });
  expect(spawned).toBe(false);
  store.close();
});

test("start injects cookies before navigating startup URLs", async () => {
  const store = seeded();
  const p = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...p,
    cookies: [{ name: "auth_token", value: "v", domain: ".x.com", path: "/", expires: Date.now() / 1000 + 99999 }],
  });
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const events: string[] = [];
  let searchOptions: Parameters<SearchProviderEnsurer>[0] | undefined;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, args) => {
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureSearchProvider: async (options) => {
      searchOptions = options;
      events.push("ensureSearchProvider");
      return { status: "configured", engine: "DuckDuckGo" };
    },
    ensureCookies: async () => { events.push("ensureCookies"); return { injected: true }; },
    navigate: async (_ws, urls) => { events.push(`navigate:${urls.join(",")}`); },
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11", ["--disable-sync", "https://x.com/home"]);
  expect(spawnedArgs[0]).toContain("--disable-sync");
  expect(spawnedArgs[0]).not.toContain("https://x.com/home");
  expect(events).toEqual([
    "ensureSearchProvider",
    "ensureCookies",
    "navigate:https://x.com/home",
  ]);
  expect(searchOptions).toEqual({
    executablePath: "/fake/cloak",
    executableSha256: "0".repeat(64),
    userDataDir: launcher.userDataDir("k1d0cd11"),
    endpoint: "ws://127.0.0.1:9333/devtools/browser/x",
  });
  store.close();
});

test("per-launch headless mode skips address-bar search provider setup", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-search-headless-${process.pid}`);
  let attempts = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureSearchProvider: async () => {
      attempts++;
      return { status: "configured", engine: "DuckDuckGo" };
    },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    cdpReadyTimeoutMs: 1000,
  });

  const launch = await launcher.start("k1d0cd11", [], { headless: true });
  expect(attempts).toBe(0);
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBeUndefined();
  expect(await launcher.start("k1d0cd11", [], { headless: true })).toEqual({ ...launch, reattached: true });
  await expect(launcher.verifyRunningIdentity("k1d0cd11")).resolves.toBeUndefined();

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("search provider failure keeps launch healthy and retries next time", async () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-search-fail-${process.pid}`);
  const logs: string[] = [];
  let attempts = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureSearchProvider: async () => { attempts++; throw new Error("settings unavailable"); },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
    log: (message) => logs.push(message),
  });

  const launch = await launcher.start("k1d0cd11");

  expect(launch.ws).toContain("/devtools/browser/x");
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBeUndefined();
  expect(attempts).toBe(1);
  expect(logs.some((message) =>
    message.includes("search provider setup failed") && message.includes("continuing")
  )).toBe(true);

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  await launcher.start("k1d0cd11");
  expect(attempts).toBe(2);
  expect(store.getLaunch("k1d0cd11")?.searchBootstrapRevision).toBeUndefined();

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start opens the platform home page (deferred) when the caller passes no URL", async () => {
  const store = seeded();
  const p = store.getProfile("k1d0cd11")!;
  store.upsertProfile({
    ...p,
    platform: "x.com",
    cookies: [{ name: "auth_token", value: "v", domain: ".x.com", path: "/", expires: Date.now() / 1000 + 99999 }],
  });
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const events: string[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, args) => { spawnedArgs.push(args); return f.spawn(bin, args); },
    fetch: f.fetchFn,
    ensureCookies: async () => { events.push("ensureCookies"); return { injected: true }; },
    navigate: async (_ws, urls) => { events.push(`navigate:${urls.join(",")}`); },
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11");
  expect(spawnedArgs[0]).not.toContain("https://x.com/home"); // home page is navigated, never an argv URL
  expect(events).toEqual(["ensureCookies", "navigate:https://x.com/home"]);
  store.close();
});

test("standalone Telegram launch preserves the historical Web K fallback", async () => {
  const store = seeded();
  const p = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...p, platform: "telegram.org", cookies: [] });
  const f = fleet();
  const navigated: string[][] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async (_ws, urls) => { navigated.push(urls); },
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");

  expect(navigated).toEqual([["https://web.telegram.org/k/"]]);
  store.close();
});

test("remote launch disables native restoration and startup navigation", async () => {
  const store = seeded();
  const p = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...p, platform: "x.com" });
  const f = fleet();
  const args: string[][] = [];
  const userDataDir = join(testDataRoot(store), "k1d0cd11");
  mkdirSync(join(userDataDir, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Sessions", "Tabs_1"), "native session bytes");
  const events: string[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (binary, launchArgs) => { args.push(launchArgs); return f.spawn(binary, launchArgs); },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async (_ws, urls) => { events.push(`navigate:${urls.join(",")}`); },
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11", [], {
    autoNavigate: false,
    restoreLastSession: false,
  });
  expect(args[0]).not.toContain("--restore-last-session");
  expect(events).toEqual([]);
  store.close();
});

test("buildArgs omits --headless when headful, and adds it only when headless", () => {
  const store = seeded();
  const f = fleet();
  const profile = store.getProfile("k1d0cd11")!;

  const headful = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const argsHeadful = headful.buildArgs(profile, 9333, "/data", []);
  expect(argsHeadful.some((a) => a.startsWith("--headless"))).toBe(false); // raw chromium: any --headless = headless ON
  expect(headful.buildArgs(profile, 9333, "/data", [], undefined, true)).toContain("--headless=new");

  const headless = new Launcher({ store, binaryPath: "/fake", headless: true, spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const argsHeadless = headless.buildArgs(profile, 9333, "/data", []);
  expect(argsHeadless).toContain("--headless=new");
  expect(headless.buildArgs(profile, 9333, "/data", [], undefined, false).some((a) => a.startsWith("--headless"))).toBe(false);
  store.close();
});

test("start applies and persists a per-launch headless override", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const args: string[][] = [];
  const launcher = newLauncher(store, f, args);

  await launcher.start("k1d0cd11", [], { headless: true });

  expect(args[0]).toContain("--headless=new");
  expect(store.getLaunch("k1d0cd11")?.headless).toBe(true);
  await launcher.stop("k1d0cd11");
  store.close();
});

test("concurrent starts with different modes do not silently coalesce", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const launcher = newLauncher(store, f, []);

  const opening = launcher.start("k1d0cd11", [], { headless: true });
  await expect(launcher.start("k1d0cd11", [], { headless: false })).rejects.toEqual(
    new BrowserLaunchError("mode_conflict"),
  );
  await opening;
  await launcher.stop("k1d0cd11");
  store.close();
});

test("concurrent start() for the same profile coalesces into a single spawn", async () => {
  const store = seeded();
  const f = fleet();
  const args: string[][] = [];
  const launcher = newLauncher(store, f, args);

  // Two overlapping starts before the first records its launch row.
  const [a, b] = await Promise.all([launcher.start("k1d0cd11"), launcher.start("k1d0cd11")]);

  expect(args.length).toBe(1); // never two browsers on the same user-data dir
  expect(a.port).toBe(b.port);
  store.close();
});

test("start persists provisional ownership before spawn and CDP readiness", async () => {
  const store = seeded();
  const current = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...current, proxy: null, timezone: "", cookies: [] });
  let release!: () => void;
  let sawPreSpawnReservation = false;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    portProbe: () => true,
    spawn: () => {
      sawPreSpawnReservation = true;
      expect(store.getLaunch("k1d0cd11")).toMatchObject({
        pid: 0,
        debugPort: 9333,
        ws: "",
        binaryPath: "/fake",
      });
      return { pid: 8124, kill() {} };
    },
    fetch: async () => {
      await ready;
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/x" }) };
    },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    findProfileDirHolderPids: async () => [],
    isPidAlive: () => true,
    cdpReadyTimeoutMs: 1000,
  });

  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(false);
  const starting = launcher.start("k1d0cd11");
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(true); // startsInFlight, before a launch row
  for (let i = 0; i < 20 && !store.getLaunch("k1d0cd11"); i++) await Bun.sleep(0);
  expect(store.getLaunch("k1d0cd11")).toMatchObject({ pid: 8124, debugPort: 9333, ws: "" });
  expect(sawPreSpawnReservation).toBe(true);
  release();
  await starting;
  expect(store.getLaunch("k1d0cd11")?.ws).toContain("devtools/browser/x");
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(true); // tracked running process
  store.close();
});

test("a spawner that throws after invocation retains ownership and returns a safe category", async () => {
  const store = seeded();
  makeDirect(store);
  let scans = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-spawn-throw-test",
    portProbe: () => true,
    spawn: () => {
      expect(store.getLaunch("k1d0cd11")).toMatchObject({ pid: 0, debugPort: 9333, ws: "" });
      throw new Error("spawner lost its child handle");
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => { scans++; return []; },
    findProfileDirHolderPids: async () => [],
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(
    new BrowserLaunchError("process_spawn"),
  );
  expect(store.getLaunch("k1d0cd11")).toMatchObject({
    pid: 0,
    binaryPath: "/fake/cloak",
    userDataDir: resolve("/tmp/cloak-spawn-throw-test/k1d0cd11"),
  });
  expect(scans).toBe(1); // an early empty scan is intentionally not trusted
  expect((await launcher.reconcileOrphans()).cleared).toBe(1);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("stop-start-stop preserves generation order and tears down the queued replacement", async () => {
  const store = seeded();
  const current = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...current, proxy: null, timezone: "", cookies: [] });
  const f = fleet();
  let releaseFirstKill!: () => void;
  let enteredFirstKill!: () => void;
  const firstKillGate = new Promise<void>((resolve) => { releaseFirstKill = resolve; });
  const firstKillEntered = new Promise<void>((resolve) => { enteredFirstKill = resolve; });
  let kills = 0;
  let spawns = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    portProbe: () => true,
    spawn: (binary, args) => { spawns++; return f.spawn(binary, args); },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    browserClose: async () => false,
    killPid: async (pid) => {
      kills++;
      if (kills === 1) {
        enteredFirstKill();
        await firstKillGate;
      }
      f.killPid(pid);
    },
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11");

  const firstStop = launcher.stop("k1d0cd11");
  await firstKillEntered;
  const restart = launcher.start("k1d0cd11");
  const secondStop = launcher.stop("k1d0cd11");
  releaseFirstKill();

  expect(await firstStop).toBe(true);
  await restart;
  expect(await secondStop).toBe(true);
  expect(spawns).toBe(2);
  expect(kills).toBe(2);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("generation-fenced stop refuses a replacement before deferred teardown", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const killed: number[] = [];
  const launcher = newLauncher(store, f, [], killed, undefined, { hostPlatform: "win32" });
  await launcher.start("k1d0cd11");
  const original = store.getLaunch("k1d0cd11")!;

  const stopping = launcher.stop("k1d0cd11", {
    debugPort: original.debugPort,
    startedAt: original.startedAt,
  });
  const replacement = {
    ...original,
    pid: 7000,
    debugPort: 9444,
    ws: "ws://127.0.0.1:9444/devtools/browser/replacement",
    startedAt: original.startedAt + 1,
  };
  f.aliveByPort.set(replacement.debugPort, true);
  f.pidByPort.set(replacement.debugPort, replacement.pid);
  f.aliveByPid.set(replacement.pid, true);
  store.recordLaunch(replacement);

  expect(await stopping).toBe(false);
  expect(killed).toEqual([]);
  expect(store.getLaunch("k1d0cd11")).toEqual(replacement);
  store.close();
});

test("generation-fenced stop refuses a replacement found by the force scan", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const browserCloses: string[] = [];
  const killedPids: number[] = [];
  const killedGroups: number[] = [];
  let armed = false;
  let scans = 0;
  let replacement!: NonNullable<ReturnType<ProfileStore["getLaunch"]>>;
  const launcher = newLauncher(store, f, [], undefined, undefined, {
    hostPlatform: "win32",
    browserClose: async (ws) => {
      browserCloses.push(ws);
      return false;
    },
    findOwnedBrowserPids: async (input) => {
      if (armed && ++scans === 2) {
        f.pidByPort.set(replacement.debugPort, replacement.pid);
        f.aliveByPid.set(replacement.pid, true);
        store.recordLaunch(replacement);
      }
      return f.findOwnedBrowserPids(input);
    },
    killPid: async (pid) => {
      killedPids.push(pid);
      f.killPid(pid);
    },
    killProcessGroup: async (group) => { killedGroups.push(group); },
  });
  await launcher.start("k1d0cd11");
  const original = store.getLaunch("k1d0cd11")!;
  replacement = {
    ...original,
    pid: 7000,
    ws: "ws://127.0.0.1:9333/devtools/browser/replacement",
    startedAt: original.startedAt + 1,
  };
  armed = true;

  expect(await launcher.stop("k1d0cd11", {
    debugPort: original.debugPort,
    startedAt: original.startedAt,
  })).toBe(false);
  expect(scans).toBe(2);
  expect(browserCloses).toEqual([original.ws]);
  expect(killedPids).toEqual([]);
  expect(killedGroups).toEqual([]);
  expect(store.getLaunch("k1d0cd11")).toEqual(replacement);
  store.close();
});

test("stop never closes a recycled CDP websocket", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const browserCloses: string[] = [];
  const killedPids: number[] = [];
  const launcher = newLauncher(store, f, [], undefined, undefined, {
    hostPlatform: "win32",
    browserClose: async (ws) => {
      browserCloses.push(ws);
      return false;
    },
    killPid: async (pid) => {
      killedPids.push(pid);
      f.aliveByPid.set(pid, false);
    },
  });
  await launcher.start("k1d0cd11");
  const original = store.getLaunch("k1d0cd11")!;
  const replacementWs = "ws://127.0.0.1:9333/devtools/browser/recycled";
  f.setWs(original.debugPort, replacementWs);

  expect(await launcher.stop("k1d0cd11", {
    debugPort: original.debugPort,
    startedAt: original.startedAt,
  })).toBe(true);
  expect(browserCloses).toEqual([]);
  expect(killedPids).toEqual([original.pid]);
  expect(f.aliveByPort.get(original.debugPort)).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("a synchronously reentrant start sees the registered single-flight transition", async () => {
  const store = seeded();
  const stored = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...stored, proxy: null, timezone: "" });
  const f = fleet();
  await newLauncher(store, f, []).start("k1d0cd11");
  let launcher!: Launcher;
  let nested: Promise<{ ws: string; port: number }> | undefined;
  let reentered = false;
  let fetches = 0;
  launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    enforceHostCompatibility: false,
    dataRoot: "/tmp/cloak-reentrant-start-test",
    fetch: (async () => {
      fetches++;
      if (!reentered) {
        reentered = true;
        nested = launcher.start("k1d0cd11");
      }
      return {
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/current" }),
      };
    }) as FetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
  });

  const outer = launcher.start("k1d0cd11");
  const first = await outer;
  const second = await nested!;

  expect(fetches).toBe(1);
  expect(second).toEqual(first);
  store.close();
});

test("stop waits for an in-flight proxied start and tears down what it creates", async () => {
  const store = seeded();
  const f = fleet();
  const args: string[][] = [];
  const killed: number[] = [];
  const launcher = newLauncher(store, f, args, killed);

  // SAMPLE uses an authenticated proxy, so start() yields while its loopback
  // relay begins listening — before the process handle/launch row exist.
  const starting = launcher.start("k1d0cd11");
  const stopping = launcher.stop("k1d0cd11");
  await Promise.all([starting, stopping]);

  expect(args.length).toBe(1);
  expect(killed.length).toBe(1);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("a replacement start waits for the full in-flight stop and keeps the new launch generation", async () => {
  const store = seeded();
  const f = fleet();
  const args: string[][] = [];
  let killEntered!: () => void;
  let releaseKill!: () => void;
  const entered = new Promise<void>((resolve) => { killEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseKill = resolve; });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-start-stop-transition-test",
    portProbe: () => true,
    spawn: (bin, launchArgs) => {
      args.push(launchArgs);
      return f.spawn(bin, launchArgs);
    },
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    browserClose: async () => false,
    killPid: async (pid) => {
      killEntered();
      await blocked;
      f.killPid(pid);
    },
  });

  const first = await launcher.start("k1d0cd11");
  const stopping = launcher.stop("k1d0cd11");
  await entered;

  let restartSettled = false;
  const restarting = launcher.start("k1d0cd11").finally(() => { restartSettled = true; });
  await Promise.resolve();
  expect(restartSettled).toBe(false); // it must not reattach to the launch being destroyed

  releaseKill();
  expect(await stopping).toBe(true);
  const second = await restarting;

  expect(args.length).toBe(2);
  expect(second.port).toBe(first.port);
  expect(store.getLaunch("k1d0cd11")?.ws).toBe(second.ws);
  store.close();
});

test("concurrent stop calls share one destructive teardown", async () => {
  const store = seeded();
  const f = fleet();
  let killCalls = 0;
  let killEntered!: () => void;
  let releaseKill!: () => void;
  const entered = new Promise<void>((resolve) => { killEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseKill = resolve; });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-stop-single-flight-test",
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    browserClose: async () => false,
    killPid: async (pid) => {
      killCalls++;
      killEntered();
      await blocked;
      f.killPid(pid);
    },
  });
  await launcher.start("k1d0cd11");

  const first = launcher.stop("k1d0cd11");
  await entered;
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(true); // stop still owns the data directory
  const second = launcher.stop("k1d0cd11");
  await Promise.resolve();
  expect(killCalls).toBe(1);

  releaseKill();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(killCalls).toBe(1);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  // Deletion waits for the post-stop cache delete, which runs on after stop() returns.
  await (launcher as any).cacheClears.get("k1d0cd11");
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(false);
  store.close();
});

test("app delete right after stop waits for the post-stop cache delete; a running profile stays undeletable", async () => {
  const store = seeded();
  const launcher = newLauncher(store, fleet(), []);
  const post = (path: string, ids: string[]) => handleUiRequest(
    new Request(`http://x/ui/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }),
    launcher, store,
  ).then((r) => r!);
  await launcher.start("k1d0cd11");

  const running = await post("profiles/delete", ["k1d0cd11"]);
  expect(running.status).toBe(409);
  expect(await running.json()).toMatchObject({ deleted: 0, locked: ["k1d0cd11"] });
  expect(store.getProfile("k1d0cd11")).not.toBeNull();

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(true); // the cache delete runs on
  const closed = await post("profiles/delete", ["k1d0cd11"]);
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ ok: true, deleted: 1, locked: [] });
  expect(store.listTrashed().map((p) => p.id)).toEqual(["k1d0cd11"]);

  // Empty Trash right after a close also waits instead of answering profile_open.
  expect(store.restoreProfile("k1d0cd11")).toBe(true);
  await launcher.start("k1d0cd11");
  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(store.trashProfile("k1d0cd11")).toBe(true);
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(true);
  const purged = await post("trash/purge", ["k1d0cd11"]);
  expect(await purged.json()).toMatchObject({ ok: true, results: [{ id: "k1d0cd11", status: "purged" }] });
  store.close();
});

test("the wait for the post-stop cache delete is bounded and deletion stays blocked after it", async () => {
  const store = seeded();
  const launcher = newLauncher(store, fleet(), []);
  (launcher as any).cacheClears.set("k1d0cd11", new Promise<void>(() => {}));
  const startedAt = Date.now();
  await launcher.cacheCleanupSettled("k1d0cd11", 20);
  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(true);
  store.close();
});

test("failed start tree-kills only an exact owned process and never uses the raw handle fallback", async () => {
  const store = seeded();
  const treeKilled: number[] = [];
  const parentKilled: number[] = [];
  let ownedAlive = true;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-failed-start-tree-kill-test",
    portProbe: () => true,
    spawn: () => ({ pid: 8123, kill: () => parentKilled.push(8123) }),
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: (pid) => pid === 8123 && ownedAlive,
    findOwnedBrowserPids: async () => ownedAlive ? [8123] : [],
    killPid: async (pid) => { treeKilled.push(pid); ownedAlive = false; },
    cdpReadyTimeoutMs: 1,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(
    new BrowserLaunchError("cdp_readiness"),
  );

  expect(treeKilled).toEqual([8123]);
  expect(parentKilled).toEqual([]); // retained handle PID alone is never trusted
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("failed start retains launch ownership when its exact process scan is inconclusive", async () => {
  const store = seeded();
  let spawns = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-failed-start-unknown-test",
    portProbe: () => true,
    spawn: () => { spawns++; return { pid: 8123, kill() {} }; },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: () => true,
    findOwnedBrowserPids: async () => null,
    killPid: async () => { throw new Error("must not kill without exact identity"); },
    cdpReadyTimeoutMs: 1,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(
    new BrowserLaunchError("cdp_readiness"),
  );
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight", "browser_unresponsive"));
  expect(spawns).toBe(1);
  store.close();
});

test("failed start retains launch ownership when an exact kill reports but the process survives", async () => {
  const store = seeded();
  const killed: number[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-failed-start-survivor-test",
    portProbe: () => true,
    spawn: () => ({ pid: 8123, kill() {} }),
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: (pid) => pid === 8123,
    findOwnedBrowserPids: async () => [8123],
    killPid: async (pid) => { killed.push(pid); }, // simulated taskkill exit-0 without death
    cdpReadyTimeoutMs: 1,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(
    new BrowserLaunchError("cdp_readiness"),
  );
  expect(killed).toEqual([8123]);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("stop() does not kill a stored PID when both CDP and the process are dead", async () => {
  const store = seeded();
  const f = fleet();
  const killed: number[] = [];
  const a = await newLauncher(store, f, [], killed).start("k1d0cd11");
  f.crash(a.port); // browser died; port no longer answers

  // Fresh launcher = no in-memory handle, so stop() must rely on the stored PID.
  const launcherB = newLauncher(store, f, [], killed);
  await launcherB.stop("k1d0cd11");

  expect(killed.length).toBe(0); // both liveness signals say dead
  expect(store.getLaunch("k1d0cd11")).toBeNull(); // row still cleared
  store.close();
});

test("stop() ignores a different CDP browser that recycled the old debug port", async () => {
  const store = seeded();
  const logs: string[] = [];
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 8123,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/old-generation",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-recycled-port-test/k1d0cd11",
  });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    fetch: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/new-generation" }),
    }),
    findOwnedBrowserPids: async () => [],
    isPidAlive: () => false,
    killPid: async () => { throw new Error("dead launch must not be killed"); },
    log: (message) => logs.push(message),
  });

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(logs.some((message) => message.includes("recycled by a different CDP browser"))).toBe(true);
  store.close();
});

test("stop() retains a launch when its recorded CDP browser still answers", async () => {
  const store = seeded();
  const ws = "ws://127.0.0.1:9333/devtools/browser/same-generation";
  const dataRoot = join(tmpdir(), `cloak-stop-unconfirmed-cache-${process.pid}`);
  const cacheDir = join(dataRoot, "k1d0cd11", "Default", "Cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "data_0"), "junk");
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 8123,
    debugPort: 9333,
    ws,
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: join(dataRoot, "k1d0cd11"),
  });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: ws }) }),
    findOwnedBrowserPids: async () => [],
    isPidAlive: () => false,
    browserClose: async () => false,
  });

  expect(await launcher.stop("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(existsSync(cacheDir)).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("stop() reaps a post-restart browser whose PID is alive even when CDP is unresponsive", async () => {
  const store = seeded();
  const f = fleet();
  const killed: number[] = [];
  const first = await newLauncher(store, f, [], killed).start("k1d0cd11");
  const pid = store.getLaunch("k1d0cd11")!.pid;
  f.aliveByPort.set(first.port, false); // CDP wedged; process remains alive

  const launcherB = newLauncher(store, f, [], killed); // restart: no process handle
  await launcherB.stop("k1d0cd11");

  expect(killed).toEqual([pid]);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("stop() kills only an exact launch-identity match, never a recycled stored PID", async () => {
  const store = seeded();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 7001, // now recycled by an unrelated process
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/stale",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-exact-owner-test/k1d0cd11",
  });
  let ownedAlive = true;
  const killed: number[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-exact-owner-test",
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    isPidAlive: (pid) => pid === 7001 || (pid === 8123 && ownedAlive),
    // Exact executable+port+user-data-dir scan identifies 8123, not the
    // recycled PID saved in SQLite.
    findOwnedBrowserPids: async () => ownedAlive ? [8123] : [],
    killPid: async (pid) => { killed.push(pid); if (pid === 8123) ownedAlive = false; },
    browserClose: async () => false,
  });

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(killed).toEqual([8123]);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("same-manager stop never kills a recycled SpawnedProcess PID when exact ownership is empty", async () => {
  const store = seeded();
  let cdpAlive = true;
  const killed: number[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-recycled-handle-test",
    portProbe: () => true,
    spawn: () => ({ pid: 7001, kill() {} }),
    fetch: async () => ({
      ok: cdpAlive,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/current" }),
    }),
    // signal-0 lies because 7001 was recycled after external browser death.
    isPidAlive: (pid) => pid === 7001,
    findOwnedBrowserPids: async () => [],
    killPid: async (pid) => { killed.push(pid); },
    browserClose: async () => false,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
  });
  await launcher.start("k1d0cd11");
  cdpAlive = false;

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(killed).toEqual([]); // never taskkill the unrelated recycled PID
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("same-manager stop kills a different exact owner, never the recycled SpawnedProcess PID", async () => {
  const store = seeded();
  let cdpAlive = true;
  let ownedAlive = true;
  const killed: number[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-recycled-different-owner-test",
    portProbe: () => true,
    spawn: () => ({ pid: 7001, kill() {} }),
    fetch: async () => ({
      ok: cdpAlive,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/current" }),
    }),
    isPidAlive: (pid) => pid === 7001 || (pid === 8123 && ownedAlive),
    findOwnedBrowserPids: async () => ownedAlive ? [8123] : [],
    killPid: async (pid) => { killed.push(pid); if (pid === 8123) ownedAlive = false; cdpAlive = false; },
    browserClose: async () => false,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
  });
  await launcher.start("k1d0cd11");
  cdpAlive = false;

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(killed).toEqual([8123]);
  expect(killed).not.toContain(7001);
  store.close();
});

test("graceful CDP close still exact-kills an owned process that survived after dropping its port", async () => {
  const store = seeded();
  let cdpAlive = true;
  let ownedAlive = true;
  const killed: number[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-graceful-survivor-test",
    portProbe: () => true,
    spawn: () => ({ pid: 8123, kill() {} }),
    fetch: async () => ({
      ok: cdpAlive,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/graceful" }),
    }),
    isPidAlive: (pid) => pid === 8123 && ownedAlive,
    findOwnedBrowserPids: async () => ownedAlive ? [8123] : [],
    browserClose: async () => { cdpAlive = false; return true; },
    killPid: async (pid) => { killed.push(pid); ownedAlive = false; },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
  });
  await launcher.start("k1d0cd11");

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(killed).toEqual([8123]);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("a stop succeeds when a dashboard poll clears the same closed launch first", async () => {
  const store = seeded();
  let alive = true;
  let launcher!: Launcher;
  launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-graceful-reconciled-test",
    portProbe: () => true,
    spawn: () => ({ pid: 8124, kill() {} }),
    fetch: async () => ({
      ok: alive,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/reconciled" }),
    }),
    isPidAlive: (pid) => pid === 8124 && alive,
    findOwnedBrowserPids: async () => alive ? [8124] : [],
    browserClose: async () => {
      alive = false;
      // The dashboard's poll runs while the browser closes and forgets the dead launch.
      await launcher.reconcileOrphans();
      return true;
    },
    killPid: async () => { throw new Error("must not force-kill a closed browser"); },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
  });
  await launcher.start("k1d0cd11");

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("a forced stop succeeds when a dashboard poll clears the same dead launch first", async () => {
  const store = seeded();
  let cdpAlive = true;
  let ownedAlive = true;
  const killed: number[] = [];
  let launcher!: Launcher;
  launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-forced-reconciled-test",
    portProbe: () => true,
    spawn: () => ({ pid: 8125, kill() {} }),
    fetch: async () => ({
      ok: cdpAlive,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/forced" }),
    }),
    isPidAlive: (pid) => pid === 8125 && ownedAlive,
    findOwnedBrowserPids: async () => ownedAlive ? [8125] : [],
    // The process outlives the graceful window, as a slow Windows exit does.
    browserClose: async () => { cdpAlive = false; return true; },
    teardownTimeoutMs: 0,
    killPid: async (pid) => {
      killed.push(pid);
      ownedAlive = false;
      // The dashboard's poll sees the dead browser and forgets the launch before stop() does.
      await launcher.reconcileOrphans();
    },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
  });
  await launcher.start("k1d0cd11");

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(killed).toEqual([8125]);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("post-restart reattach verifies ownership and refreshes a changed live CDP websocket", async () => {
  const store = seeded();
  const profile = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...profile, proxy: null, timezone: "" });
  const f = fleet();
  await newLauncher(store, f, []).start("k1d0cd11");
  store.recordLaunch({ ...store.getLaunch("k1d0cd11")!, ws: "ws://127.0.0.1:9333/devtools/browser/stale" });
  let spawns = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-refresh-ws-test",
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
    fetch: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/current" }),
    }),
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    ensureCookies: async () => ({ injected: false }),
  });

  const result = await launcher.start("k1d0cd11");

  expect(result.ws).toBe("ws://127.0.0.1:9333/devtools/browser/current");
  expect(store.getLaunch("k1d0cd11")?.ws).toBe(result.ws);
  expect(spawns).toBe(0);
  store.close();
});

test("post-restart active exact-verifies once, then reuses its in-memory ownership proof", async () => {
  const store = seeded();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 9001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/current",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-external-proof-test/k1d0cd11",
  });
  let scans = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-external-proof-test",
    fetch: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/current" }),
    }),
    isPidAlive: (pid) => pid === 9001,
    findOwnedBrowserPids: async () => { scans++; return [9001]; },
  });

  expect(await launcher.active("k1d0cd11")).toBe(true);
  expect(await launcher.active("k1d0cd11")).toBe(true);
  expect(scans).toBe(1);
  store.close();
});

test("dashboard reconciliation reuses a post-restart ownership proof between polls", async () => {
  const store = seeded();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 9001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/current",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-reconcile-proof-test/k1d0cd11",
  });
  let scans = 0;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-reconcile-proof-test",
    fetch: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/current" }),
    }),
    isPidAlive: (pid) => pid === 9001,
    findOwnedBrowserPids: async () => { scans++; return [9001]; },
  });

  await launcher.reconcileOrphans();
  await launcher.reconcileOrphans();
  expect(scans).toBe(1);
  store.close();
});

test("startup reconciliation drops a foreign CDP responder when exact launch identity is absent", async () => {
  const store = seeded();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 9001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/stale",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-foreign-cdp-test/k1d0cd11",
  });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-foreign-cdp-test",
    fetch: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/foreign" }),
    }),
    isPidAlive: () => true,
    findOwnedBrowserPids: async () => [],
  });

  expect((await launcher.reconcileOrphans()).cleared).toBe(1);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("parallel reconciliation cannot apply a stale probe to a replacement launch generation", async () => {
  const store = seeded();
  const oldLaunch = {
    profileId: "k1d0cd11",
    pid: 9001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/old",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-reconcile-generation-test/k1d0cd11",
  };
  store.recordLaunch(oldLaunch);
  let scanEntered!: () => void;
  let finishScan!: () => void;
  const entered = new Promise<void>((resolve) => { scanEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { finishScan = resolve; });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-reconcile-generation-test",
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => { scanEntered(); await blocked; return []; },
  });

  const reconciling = launcher.reconcileOrphans();
  await entered;
  store.clearLaunch("k1d0cd11");
  store.recordLaunch({ ...oldLaunch, pid: 9002, debugPort: 9334, ws: "ws://127.0.0.1:9334/devtools/browser/new", startedAt: 2 });
  finishScan();

  expect((await reconciling).cleared).toBe(0);
  expect(store.getLaunch("k1d0cd11")?.debugPort).toBe(9334);
  store.close();
});

test("targeted orphan reconciliation cannot clear a replacement launch generation", async () => {
  const store = seeded();
  const oldLaunch = {
    profileId: "k1d0cd11",
    pid: 9001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/old",
    startedAt: 1,
    binaryPath: "/fake/cloak",
    userDataDir: "/tmp/cloak-targeted-reconcile-test/k1d0cd11",
  };
  store.recordLaunch(oldLaunch);
  let scanEntered!: () => void;
  let finishScan!: () => void;
  const entered = new Promise<void>((resolve) => { scanEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { finishScan = resolve; });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-targeted-reconcile-test",
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => { scanEntered(); await blocked; return []; },
  });

  const reconciling = launcher.reconcileOrphan("k1d0cd11", { debugPort: 9333, startedAt: 1 });
  await entered;
  store.clearLaunch("k1d0cd11");
  store.recordLaunch({ ...oldLaunch, pid: 9002, debugPort: 9334, ws: "ws://127.0.0.1:9334/devtools/browser/new", startedAt: 2 });
  finishScan();

  expect(await reconciling).toBe("generation_changed");
  expect(store.getLaunch("k1d0cd11")?.debugPort).toBe(9334);
  store.close();
});

test("stale teardown cleanup cannot clear a replacement launch generation", () => {
  const store = seeded();
  const oldLaunch = {
    profileId: "k1d0cd11",
    pid: 9001,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/old",
    startedAt: 1,
  };
  const replacement = {
    ...oldLaunch,
    pid: 9002,
    debugPort: 9334,
    ws: "ws://127.0.0.1:9334/devtools/browser/new",
    startedAt: 2,
  };
  store.recordLaunch(replacement);
  const launcher = new Launcher({ store, binaryPath: "/fake/cloak" });

  expect((launcher as any).forgetLaunch("k1d0cd11", oldLaunch)).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toEqual(replacement);
  store.close();
});

test("unknown ownership scan keeps PID-0 launch resources and reports stop failure", async () => {
  const store = seeded();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 0,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/unknown",
    startedAt: 1,
  });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-unknown-owner-test",
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => null,
    killPid: async () => { throw new Error("must not kill without identity"); },
    browserClose: async () => false,
  });

  expect((await launcher.reconcileOrphans()).cleared).toBe(0);
  expect(await launcher.stop("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("stop() kills an exact post-restart process match when CDP still answers", async () => {
  const store = seeded();
  const f = fleet();
  const killed: number[] = [];
  await newLauncher(store, f, [], killed).start("k1d0cd11"); // port stays alive

  const launcherB = newLauncher(store, f, [], killed); // no handle, but port answers
  await launcherB.stop("k1d0cd11");

  expect(killed.length).toBe(1); // exact process identity makes the kill safe
  store.close();
});

test("stop() tree-kills via killPidFn when it holds the spawned handle", async () => {
  const store = seeded();
  const f = fleet();
  const killed: number[] = [];
  const launcher = newLauncher(store, f, [], killed);
  await launcher.start("k1d0cd11"); // handle now held

  await launcher.stop("k1d0cd11");

  // Routed through killPidFn (taskkill /F /T tree-kill on Windows), NOT a
  // parent-only proc.kill() that would orphan renderer/GPU children.
  expect(killed.length).toBe(1);
  store.close();
});

test("Linux proc stat parsing handles spaces and parentheses in process names", () => {
  const fields = ["S", "1", "123", "123", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "987654"];
  expect(parseLinuxProcStat(`123 (cloak ) browser) ${fields.join(" ")}`)).toEqual({
    parentPid: 1,
    processGroupId: 123,
    startTime: "987654",
  });
});

test("Linux default spawn creates a dedicated process group and captures exact root start time", async () => {
  if (process.platform !== "linux") return;
  const proc = defaultSpawn("/bin/sh", ["-c", "sleep 30"]);
  try {
    expect(proc.processGroupId).toBe(proc.pid);
    expect(proc.rootStartTime).toMatch(/^\d+$/);
    const parsed = parseLinuxProcStat(readFileSync(`/proc/${proc.pid}/stat`, "utf8"));
    expect(parsed?.processGroupId).toBe(proc.pid);
    expect(parsed?.startTime).toBe(proc.rootStartTime);
  } finally {
    if (proc.processGroupId) {
      try { process.kill(-proc.processGroupId, "SIGKILL"); } catch {}
    } else {
      try { proc.kill(); } catch {}
    }
  }
});

test("legacy Linux cleanup kills exact-root descendants before root and never signals unrelated processes", async () => {
  const store = seeded();
  const alive = new Set([7100, 7101, 7999]);
  let cdpAlive = true;
  const signaled: number[] = [];
  store.recordLaunch({
    profileId: "k1d0cd11", pid: 7100, debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/linux-tree", startedAt: 1,
    binaryPath: "/fake/cloak", userDataDir: "/tmp/linux-tree/k1d0cd11",
  });
  const snapshot = (): HostProcessSnapshot => ({ records: [
    ...(alive.has(7100) ? [{ pid: 7100, executablePath: "/fake/cloak", parentPid: 1, processGroupId: 7000, startTime: "10" }] : []),
    ...(alive.has(7101) ? [{ pid: 7101, executablePath: "/fake/cloak", parentPid: 7100, processGroupId: 7000, startTime: "11" }] : []),
    { pid: 7999, executablePath: "/unrelated", parentPid: 1, processGroupId: 7999, startTime: "99" },
  ], incomplete: false });
  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", hostPlatform: "linux",
    fetch: async () => ({ ok: cdpAlive, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/linux-tree" }) }),
    findOwnedBrowserPids: async () => [...alive].filter((pid) => pid === 7100 || pid === 7101),
    isPidAlive: (pid) => alive.has(pid), readProcessSnapshot: async () => snapshot(),
    browserClose: async () => false,
    killPid: async (pid) => { signaled.push(pid); alive.delete(pid); if (pid === 7100) cdpAlive = false; },
    teardownTimeoutMs: 50, teardownPollMs: 1,
  });

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(signaled).toEqual([7101, 7100]);
  expect(alive.has(7999)).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("Linux group cleanup verifies the exact unchanged leader before signaling and confirms delayed tree death", async () => {
  const store = seeded();
  const alive = new Set([7200, 7201]);
  let cdpAlive = true;
  const events: string[] = [];
  store.recordLaunch({
    profileId: "k1d0cd11", pid: 7200, debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/linux-group", startedAt: 1,
    binaryPath: "/fake/cloak", userDataDir: "/tmp/linux-group/k1d0cd11",
    processGroupId: 7200, rootStartTime: "20",
  });
  const snapshot = (): HostProcessSnapshot => ({ records: [
    ...(alive.has(7200) ? [{ pid: 7200, executablePath: "/fake/cloak", parentPid: 1, processGroupId: 7200, startTime: "20" }] : []),
    ...(alive.has(7201) ? [{ pid: 7201, executablePath: "/fake/cloak", parentPid: 7200, processGroupId: 7200, startTime: "21" }] : []),
  ], incomplete: false });
  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", hostPlatform: "linux",
    fetch: async () => ({ ok: cdpAlive, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/linux-group" }) }),
    findOwnedBrowserPids: async () => {
      events.push("exact");
      return [...alive].filter((pid) => pid === 7200 || pid === 7201);
    },
    isPidAlive: (pid) => alive.has(pid), readProcessSnapshot: async () => snapshot(),
    browserClose: async () => false,
    killProcessGroup: async (pgid) => {
      events.push(`group:${pgid}`);
      setTimeout(() => { alive.clear(); cdpAlive = false; }, 10);
    },
    teardownTimeoutMs: 100, teardownPollMs: 2,
  });

  expect(await launcher.stop("k1d0cd11")).toBe(true);
  expect(events).toContain("group:7200");
  expect(events.indexOf("exact")).toBeLessThan(events.indexOf("group:7200"));
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("Linux group kill errors and surviving children retain launch ownership", async () => {
  for (const mode of ["error", "survivor"] as const) {
    const store = seeded();
    const alive = new Set([7300, 7301]);
    let cdpAlive = true;
    store.recordLaunch({
      profileId: "k1d0cd11", pid: 7300, debugPort: 9333,
      ws: "ws://127.0.0.1:9333/devtools/browser/linux-retain", startedAt: 1,
      binaryPath: "/fake/cloak", userDataDir: "/tmp/linux-retain/k1d0cd11",
      processGroupId: 7300, rootStartTime: "30",
    });
    const launcher = new Launcher({
      store, binaryPath: "/fake/cloak", hostPlatform: "linux",
      fetch: async () => ({ ok: cdpAlive, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/linux-retain" }) }),
      findOwnedBrowserPids: async () => alive.has(7300) ? [7300] : [],
      isPidAlive: (pid) => alive.has(pid),
      readProcessSnapshot: async () => ({ records: [
        ...(alive.has(7300) ? [{ pid: 7300, executablePath: "/fake/cloak", parentPid: 1, processGroupId: 7300, startTime: "30" }] : []),
        ...(alive.has(7301) ? [{ pid: 7301, executablePath: "/fake/cloak", parentPid: 7300, processGroupId: 7300, startTime: "31" }] : []),
      ], incomplete: false }),
      browserClose: async () => false,
      killProcessGroup: async () => {
        if (mode === "error") throw Object.assign(new Error("denied"), { code: "EPERM" });
        alive.delete(7300);
        cdpAlive = false;
      },
      teardownTimeoutMs: 10, teardownPollMs: 1,
    });

    expect(await launcher.stop("k1d0cd11")).toBe(false);
    expect(store.getLaunch("k1d0cd11")).not.toBeNull();
    store.close();
  }
});

test("Linux cleanup never signals a recycled stored PID or a changed group leader", async () => {
  const store = seeded();
  let signals = 0;
  store.recordLaunch({
    profileId: "k1d0cd11", pid: 7400, debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/recycled", startedAt: 1,
    binaryPath: "/fake/cloak", userDataDir: "/tmp/linux-recycled/k1d0cd11",
    processGroupId: 7400, rootStartTime: "40",
  });
  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", hostPlatform: "linux",
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/recycled" }) }),
    // The stored PID is now unrelated; the exact launch identity belongs to a
    // different root and therefore cannot inherit the old group proof.
    findOwnedBrowserPids: async () => [7499],
    isPidAlive: () => true,
    readProcessSnapshot: async () => ({ records: [
      { pid: 7400, executablePath: "/unrelated", parentPid: 1, processGroupId: 7400, startTime: "99" },
      { pid: 7499, executablePath: "/fake/cloak", parentPid: 1, processGroupId: 7499, startTime: "41" },
    ], incomplete: false }),
    browserClose: async () => false,
    killProcessGroup: async () => { signals++; },
    killPid: async () => { signals++; },
    teardownTimeoutMs: 5, teardownPollMs: 1,
  });

  expect(await launcher.stop("k1d0cd11")).toBe(false);
  expect(signals).toBe(0);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("hasPageTargets distinguishes a background-only browser", async () => {
  const store = seeded();
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9333, ws: "ws://x", startedAt: 1 });
  let targets: Array<{ type: string }> = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    fetch: async () => ({ ok: true, json: async () => targets }),
    ensureCookies: async () => ({ injected: false }),
  });

  expect(await launcher.hasPageTargets("k1d0cd11")).toBe(false);
  targets = [{ type: "page" }];
  expect(await launcher.hasPageTargets("k1d0cd11")).toBe(true);
  store.close();
});

test("active() requires a CDP webSocketDebuggerUrl, not just any HTTP 200", async () => {
  const store = seeded();
  // Record a launch row so active() has a port to probe.
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9333, ws: "ws://x", startedAt: 1 });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    dataRoot: "/tmp/cloak-active-test",
    spawn: () => ({ pid: 1, kill() {} }),
    // 200 OK, but the body is not a CDP /json/version payload (recycled port).
    fetch: async () => ({ ok: true, json: async () => ({ Browser: "not-cdp" }) }),
    ensureCookies: async () => ({ injected: false }),
    killPid: async () => {},
    cdpReadyTimeoutMs: 200,
  });
  expect(await launcher.active("k1d0cd11")).toBe(false);
  store.close();
});

test("clearCache removes cache dirs, preserves the session, and skips a live browser", async () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-clearcache-${process.pid}`);
  const base = join(dataRoot, "k1d0cd11");
  const cacheDir = join(base, "Default", "Cache");
  const scriptCache = join(base, "Default", "Service Worker", "ScriptCache");
  const cacheStorage = join(base, "Default", "Service Worker", "CacheStorage");
  const cookies = join(base, "Default", "Network", "Cookies");
  const localStorage = join(base, "Default", "Local Storage", "leveldb");
  const seedFs = () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "data_0"), "junk");
    mkdirSync(scriptCache, { recursive: true });
    writeFileSync(join(scriptCache, "script"), "junk");
    mkdirSync(cacheStorage, { recursive: true });
    writeFileSync(join(cacheStorage, "response"), "site-data");
    mkdirSync(join(base, "Default", "Network"), { recursive: true });
    writeFileSync(cookies, "SQLite-cookies");
    mkdirSync(localStorage, { recursive: true });
    writeFileSync(join(localStorage, "data"), "login-state");
  };
  seedFs();

  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    killPid: async (pid) => { f.killPid(pid); },
    cdpReadyTimeoutMs: 1000,
  });

  // Inactive profile → cache cleared, login session left intact.
  const r = await launcher.clearCache("k1d0cd11");
  expect(r.cleared).toBe(true);
  expect(existsSync(cacheDir)).toBe(false);
  expect(existsSync(scriptCache)).toBe(false);
  expect(existsSync(cacheStorage)).toBe(false);
  expect(existsSync(cookies)).toBe(true);
  expect(existsSync(localStorage)).toBe(true);

  // Live browser → must refuse (cache files are locked / deleting risks corruption).
  seedFs();
  await launcher.start("k1d0cd11");
  const r2 = await launcher.clearCache("k1d0cd11");
  expect(r2.cleared).toBe(false);
  expect(existsSync(cacheDir)).toBe(true);
  expect(existsSync(scriptCache)).toBe(true);
  expect(existsSync(cacheStorage)).toBe(true);

  await launcher.stop("k1d0cd11");
  // The post-stop cache delete runs on after stop() returns.
  await (launcher as any).cacheClears.get("k1d0cd11");
  // Site caches under the cap stay for the next open; Service Worker data goes.
  expect(existsSync(cacheDir)).toBe(true);
  expect(existsSync(scriptCache)).toBe(false);
  expect(existsSync(cacheStorage)).toBe(false);
  expect(existsSync(cookies)).toBe(true);
  expect(existsSync(localStorage)).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("after a stop, site caches stay up to 35 MB, the compiled-script cache going first", async () => {
  const store = seeded();
  const f = fleet();
  const launcher = newLauncher(store, f, []);
  const base = join(testDataRoot(store), "k1d0cd11");
  const sized = (rel: string, megabytes: number) => {
    const dir = join(base, ...rel.split("/"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "data");
    writeFileSync(file, "");
    truncateSync(file, megabytes * 1024 * 1024);
  };
  const cycle = async (code: number, http: number) => {
    await launcher.start("k1d0cd11");
    sized("Default/Code Cache", code);
    sized("Default/Cache", http);
    await launcher.stop("k1d0cd11");
    await (launcher as any).cacheClears.get("k1d0cd11");
    return [existsSync(join(base, "Default", "Code Cache")), existsSync(join(base, "Default", "Cache"))];
  };

  expect(await cycle(10, 20)).toEqual([true, true]);
  expect(await cycle(20, 20)).toEqual([false, true]);
  expect(await cycle(0, 40)).toEqual([true, false]);
  store.close();
});

test("clearCache refuses ids that escape the data root (path-traversal safety)", async () => {
  const store = seeded(); // only knows k1d0cd11
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-trav-${process.pid}`);
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    dataRoot,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    killPid: async () => {},
    cdpReadyTimeoutMs: 500,
  });

  // Unknown id → rejected outright (not in the store).
  expect((await launcher.clearCache("../whatever")).cleared).toBe(false);

  // Even an id that IS in the store but resolves outside the root is blocked by
  // the containment check — the out-of-root dir must be left intact.
  const escRoot = join(tmpdir(), `cloak-trav-${process.pid}-ESC`);
  const escCache = join(escRoot, "Default", "Cache");
  mkdirSync(escCache, { recursive: true });
  const escId = `../cloak-trav-${process.pid}-ESC`; // join(dataRoot, escId) → escRoot
  const p = store.getProfile("k1d0cd11")!;
  expect(() => store.upsertProfile({ ...p, id: escId })).toThrow("invalid profile id");

  const r = await launcher.clearCache(escId);
  expect(r.cleared).toBe(false);
  expect(existsSync(escCache)).toBe(true); // untouched

  rmSync(escRoot, { recursive: true, force: true });
  store.close();
});

test("removeUserDataDir refuses ids that escape the data root (path-traversal safety)", () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-rm-${process.pid}`);
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    dataRoot,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    killPid: async () => {},
    cdpReadyTimeoutMs: 500,
  });

  // An id resolving outside the root is refused; its dir is left intact.
  const escRoot = join(tmpdir(), `cloak-rm-${process.pid}-ESC`);
  mkdirSync(escRoot, { recursive: true });
  const escId = `../cloak-rm-${process.pid}-ESC`; // join(dataRoot, escId) → escRoot
  expect(launcher.removeUserDataDir(escId)).toBe(false);
  expect(existsSync(escRoot)).toBe(true);

  // A contained id is removed and reported true.
  const safeDir = join(dataRoot, "k1d0cd11");
  mkdirSync(safeDir, { recursive: true });
  expect(launcher.removeUserDataDir("k1d0cd11")).toBe(true);
  expect(existsSync(safeDir)).toBe(false);

  rmSync(escRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start() repairs a corrupt Preferences but leaves a valid one (and the session) intact", async () => {
  const store = seeded(); // id=k1d0cd11
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-prefs-${process.pid}`);
  const defaultDir = join(dataRoot, "k1d0cd11", "Default");
  mkdirSync(defaultDir, { recursive: true });
  const corrupt = join(defaultDir, "Preferences");
  const validSecure = join(defaultDir, "Secure Preferences");
  const cookies = join(defaultDir, "Network", "Cookies");
  writeFileSync(corrupt, "{ this is not valid json");
  writeFileSync(validSecure, JSON.stringify({ ok: true }));
  mkdirSync(join(defaultDir, "Network"), { recursive: true });
  writeFileSync(cookies, "SQLite-format-cookie-jar"); // stand-in for the session store

  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11");

  const repaired = JSON.parse(readFileSync(corrupt, "utf8"));
  expect(repaired.webrtc.ip_handling_policy).toBe("disable_non_proxied_udp"); // corrupt prefs replaced safely
  expect(existsSync(validSecure)).toBe(true); // valid prefs untouched
  expect(existsSync(cookies)).toBe(true); // session/cookies NEVER touched

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start() repairs an array-root Preferences before persisting proxied WebRTC policy", async () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-array-prefs-${process.pid}`);
  const defaultDir = join(dataRoot, "k1d0cd11", "Default");
  const preferences = join(defaultDir, "Preferences");
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(preferences, "[]");

  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");

  const repaired = JSON.parse(readFileSync(preferences, "utf8"));
  expect(Array.isArray(repaired)).toBe(false);
  expect(repaired.webrtc.ip_handling_policy).toBe("disable_non_proxied_udp");

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start() maps an unknown preparation failure to a fixed safe category", async () => {
  const store = seeded();
  const f = fleet();
  const logs: string[] = [];
  const rawFailure = "sentinel raw operating-system failure";
  const dataRoot = join(tmpdir(), `sentinel-private-profile-path-${process.pid}`);
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(join(dataRoot, "k1d0cd11"), { recursive: true });
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    findProfileDirHolderPids: async () => {
      throw new Error(rawFailure);
    },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
    log: (message) => logs.push(message),
  });

  let failure: unknown;
  try {
    await launcher.start("k1d0cd11");
  } catch (error) {
    failure = error;
  }

  expect(failure).toEqual(new BrowserLaunchError("profile_directory"));
  const publicOutput = `${failure}\n${logs.join("\n")}`;
  for (const secret of [rawFailure, dataRoot, "k1d0cd11"]) {
    expect(publicOutput).not.toContain(secret);
  }

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

// A missing Preferences makes Chromium treat the profile as new and drop session cookies; a
// half-written one shows a blocking dialog. Repairs keep the file, and every rewrite is a rename.
test("start() resets corrupt preferences to {} and replaces Preferences through a temp file", async () => {
  const store = seeded(); // proxied: the launch also writes the WebRTC policy
  const f = fleet();
  const launcher = newLauncher(store, f, []);
  const defaultDir = join(launcher.userDataDir("k1d0cd11"), "Default");
  mkdirSync(defaultDir, { recursive: true });
  const prefs = join(defaultDir, "Preferences");
  const secure = join(defaultDir, "Secure Preferences");
  writeFileSync(prefs, JSON.stringify({ profile: { exit_type: "Crashed" }, other: 1 }));
  writeFileSync(secure, "");
  // An open handle keeps the original inode from being reused by a later file. Windows refuses
  // to replace a file that is still open, so the inode check runs elsewhere.
  const original = process.platform === "win32" ? undefined : openSync(prefs, "r");
  const before = original === undefined ? undefined : fstatSync(original).ino;
  await launcher.start("k1d0cd11");
  if (original !== undefined) closeSync(original);
  expect(readFileSync(secure, "utf8")).toBe("{}");
  const after = JSON.parse(readFileSync(prefs, "utf8"));
  expect(after).toMatchObject({ profile: { exit_type: "Normal" }, other: 1, webrtc: { ip_handling_policy: "disable_non_proxied_udp" } });
  if (before !== undefined) expect(statSync(prefs).ino).not.toBe(before);
  expect(readdirSync(defaultDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(await launcher.stop("k1d0cd11")).toBe(true);

  writeFileSync(prefs, "{ cut off mid-wri");
  await launcher.start("k1d0cd11");
  expect(existsSync(prefs)).toBe(true);
  expect(JSON.parse(readFileSync(prefs, "utf8")).webrtc.ip_handling_policy).toBe("disable_non_proxied_udp");
  store.close();
});

test("start() clears an unclean-exit's stale Singleton lock and resets the Crashed exit marker", async () => {
  const store = seeded(); // id=k1d0cd11
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-stale-${process.pid}`);
  const profileDir = join(dataRoot, "k1d0cd11");
  const defaultDir = join(profileDir, "Default");
  mkdirSync(defaultDir, { recursive: true });
  // leftovers a force-kill leaves behind:
  const singletonLock = join(profileDir, "SingletonLock");
  const prefs = join(defaultDir, "Preferences");
  writeFileSync(singletonLock, "hostname-1234"); // stale process-singleton lock
  writeFileSync(prefs, JSON.stringify({ profile: { exit_type: "Crashed", exited_cleanly: false, name: "keep-me" }, other: 1 }));

  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11");

  expect(existsSync(singletonLock)).toBe(false); // stale lock removed so the next Chrome doesn't stall
  const after = JSON.parse(readFileSync(prefs, "utf8"));
  expect(after.profile.exit_type).toBe("Normal"); // crash marker flipped → no restore prompt
  expect(after.profile.exited_cleanly).toBe(true);
  expect(after.profile.name).toBe("keep-me"); // every other preference preserved
  expect(after.other).toBe(1);

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start() resets a crash-corrupted profile's volatile storage after an unclean exit (remote mode)", async () => {
  const store = seeded(); // id=k1d0cd11
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-resetstore-${process.pid}`);
  const profileDir = join(dataRoot, "k1d0cd11");
  const defaultDir = join(profileDir, "Default");
  mkdirSync(defaultDir, { recursive: true });
  // Unclean-exit signal + leveldb stores a crash could leave corrupt (the "something went wrong" cause):
  writeFileSync(join(profileDir, "SingletonLock"), "host-1234");
  mkdirSync(join(defaultDir, "Local Storage", "leveldb"), { recursive: true });
  writeFileSync(join(defaultDir, "Local Storage", "leveldb", "000003.log"), "half-written");
  mkdirSync(join(defaultDir, "IndexedDB", "x.leveldb"), { recursive: true });
  // Must NOT be touched — the cookie-encryption key lives here:
  const localState = join(profileDir, "Local State");
  writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: "keep" } }));

  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot, portProbe: () => true,
    spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: false }),
    navigate: async () => {}, labelWindow: async () => {}, killPid: async () => {},
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    resetStorageOnUncleanExit: true,
  });
  await launcher.start("k1d0cd11");

  expect(existsSync(join(defaultDir, "Local Storage"))).toBe(false); // corrupt leveldb reset → Chromium regenerates it
  expect(existsSync(join(defaultDir, "IndexedDB"))).toBe(false);
  expect(existsSync(join(profileDir, "SingletonLock"))).toBe(false); // stale lock still cleared
  expect(existsSync(localState)).toBe(true); // encryption key never touched

  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start() leaves volatile storage intact when resetStorageOnUncleanExit is off (standalone mode)", async () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-noreset-${process.pid}`);
  const defaultDir = join(dataRoot, "k1d0cd11", "Default");
  mkdirSync(join(defaultDir, "Local Storage"), { recursive: true });
  writeFileSync(join(dataRoot, "k1d0cd11", "SingletonLock"), "host-1234"); // unclean exit

  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot, portProbe: () => true,
    spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: false }),
    navigate: async () => {}, labelWindow: async () => {}, killPid: async () => {},
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    // resetStorageOnUncleanExit defaults to false → standalone mode never discards local session state
  });
  await launcher.start("k1d0cd11");
  expect(existsSync(join(defaultDir, "Local Storage"))).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("start() does NOT reset storage on a CLEAN exit, even with resetStorageOnUncleanExit on", async () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-cleanexit-${process.pid}`);
  const defaultDir = join(dataRoot, "k1d0cd11", "Default");
  mkdirSync(join(defaultDir, "Local Storage"), { recursive: true });
  // Clean exit: no SingletonLock, exit_type Normal → a healthy profile's cache must be preserved.
  writeFileSync(join(defaultDir, "Preferences"), JSON.stringify({ profile: { exit_type: "Normal", exited_cleanly: true } }));

  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot, portProbe: () => true,
    spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: false }),
    navigate: async () => {}, labelWindow: async () => {}, killPid: async () => {},
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    resetStorageOnUncleanExit: true,
  });
  await launcher.start("k1d0cd11");
  expect(existsSync(join(defaultDir, "Local Storage"))).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("userDataDir is ABSOLUTE even when dataRoot is relative (so --user-data-dir doesn't follow the browser's cwd)", () => {
  const store = new ProfileStore(":memory:");
  const launcher = new Launcher({ store, binaryPath: "/fake", dataRoot: "profiles" }); // relative dataRoot
  const dir = launcher.userDataDir("k1d0cd11");
  expect(isAbsolute(dir)).toBe(true);
  expect(dir).toBe(resolve("profiles", "k1d0cd11"));
  // and the launch flag carries the absolute path, not a bare "profiles/<id>"
  const args = launcher.buildArgs({ id: "k1d0cd11", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 1 } as any, 9333, dir, []);
  expect(args).toContain(`--user-data-dir=${dir}`);
  store.close();
});

test("start() does NOT reset volatile storage on an unclean exit when the launch can't restore the login (resetStorage:false)", async () => {
  const store = seeded(); // id=k1d0cd11
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-noresetsafe-${process.pid}`);
  const defaultDir = join(dataRoot, "k1d0cd11", "Default");
  mkdirSync(join(defaultDir, "Local Storage"), { recursive: true }); // e.g. a Telegram login living only here
  writeFileSync(join(dataRoot, "k1d0cd11", "SingletonLock"), "host"); // unclean-exit signal

  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot, portProbe: () => true,
    spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: false }),
    navigate: async () => {}, labelWindow: async () => {}, killPid: async () => {},
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    resetStorageOnUncleanExit: true, // mode is on...
  });
  await launcher.start("k1d0cd11", [], { resetStorage: false }); // ...but this launch has no restorable session to inject
  expect(existsSync(join(defaultDir, "Local Storage"))).toBe(true); // kept — never wipe the only local copy of a login
  rmSync(dataRoot, { recursive: true, force: true });
  store.close();
});

test("profileDisplayNo prefers the operator's custom NO. over the store serial", () => {
  expect(profileDisplayNo("907341", 1)).toBe("907341"); // custom wins
  expect(profileDisplayNo("  4421 ", 3)).toBe("4421"); // trimmed
  expect(profileDisplayNo("", 7)).toBe("7"); // blank -> serial
  expect(profileDisplayNo(undefined, 7)).toBe("7"); // legacy row -> serial
  expect(profileDisplayNo("", null)).toBe(null); // neither is known
});

test("buildWindowLabel carries a custom NO. into the window title", () => {
  expect(buildWindowLabel("sophie", "907341")).toBe("sophie · #907341 — ");
  expect(buildWindowLabel("sophie", "")).toBe("sophie — "); // empty is not a number
});

test("buildWindowLabel formats name + serial, with fallbacks", () => {
  expect(buildWindowLabel("sophie", 42)).toBe("sophie · #42 — ");
  expect(buildWindowLabel("  acct ", 1)).toBe("acct · #1 — "); // trimmed
  expect(buildWindowLabel("", 7)).toBe("profile · #7 — "); // blank name → 'profile'
  expect(buildWindowLabel("acct", null)).toBe("acct — "); // serial unknown → no number
});

test("start() labels the window with '<name> · #<serial> — '", async () => {
  const store = seeded(); // SAMPLE: id=k1d0cd11, name=acct
  const f = fleet();
  const spawnedArgs: string[][] = [];
  let labeled: { ws: string; label: string } | null = null;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, args) => { spawnedArgs.push(args); return f.spawn(bin, args); },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async (ws, label) => { labeled = { ws, label }; },
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11");
  const serial = store.getSerial("k1d0cd11");
  expect(labeled).not.toBeNull();
  expect(labeled!.label).toBe(`acct · #${serial} — `);
  store.close();
});

test("a thrown window labeler never fails the launch (best-effort)", async () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => { throw new Error("CDP down"); },
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  const r = await launcher.start("k1d0cd11"); // must resolve despite the labeler throwing
  expect(typeof r.port).toBe("number");
  store.close();
});

test("window opens at 65% width / 90% height by default (tall & narrow, not full-screen)", async () => {
  const store = seeded(); // SAMPLE resolution=1680*1050
  const f = fleet();
  const args: string[][] = [];
  await newLauncher(store, f, args).start("k1d0cd11");
  expect(args[0]).toContain("--window-size=1092,945"); // 1680*0.65, 1050*0.9
  store.close();
});

test("windowWidthScale / windowHeightScale control the launched window size", async () => {
  const store = seeded();
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    spawn: (bin, a) => { spawnedArgs.push(a); return f.spawn(bin, a); },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    windowWidthScale: 0.6,
    windowHeightScale: 1.0,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11");
  expect(spawnedArgs[0]).toContain("--window-size=1008,1050"); // 1680*0.6, 1050*1.0 (above the 800 width floor)
  store.close();
});

test("buildArgs keeps a minimized window's renderer priority but Chrome's page timers and visibility", () => {
  const store = seeded();
  const f = fleet();
  const profile = store.getProfile("k1d0cd11")!;
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const args = launcher.buildArgs(profile, 9333, "/data", []);
  // The session launcher opens the window MINIMIZED (/MIN) so it doesn't steal focus.
  // Process priority is invisible to pages, and Chromium still exits when the user
  // closes the final visible window instead of retaining a background process.
  expect(args).toContain("--disable-background-mode");
  expect(args).toContain("--disable-renderer-backgrounding");
  // Pages can measure these: hidden-tab timer rate and a covered window's visibility.
  expect(args).not.toContain("--disable-background-timer-throttling");
  expect(args).not.toContain("--disable-backgrounding-occluded-windows");
  expect(args).toContain("--disk-cache-size=20971520");
  store.close();
});

test("buildArgs floors the window width so small-resolution profiles aren't an unusable sliver", () => {
  const store = seeded();
  const f = fleet();
  // A profile that drew a small seed resolution (1366x768) would otherwise open
  // too narrow; with the default 65% width it should stay comfortably usable.
  const small = { ...store.getProfile("k1d0cd11")!, screenWidth: 1366, screenHeight: 768 };
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const args = launcher.buildArgs(small, 9333, "/data", []);
  expect(args).toContain("--window-size=888,691"); // round(1366*0.65) x round(768*0.9)
  store.close();
});

test("a spawner that proves the browser never started fails immediately with a safe category", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    // Models the Windows session helper refusing to launch (nobody logged in):
    // no process is created, so the debug port never answers.
    spawn: (_bin, args) => {
      spawnedArgs.push(args);
      return {
        pid: 0,
        kill: () => {},
        spawnFailed: Promise.resolve(
          "interactive session launch helper exited 2: No interactive user found (no explorer.exe).",
        ),
      };
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: async () => [],
    findProfileDirHolderPids: async () => [],
    // A full CDP budget: the point is that a PROVEN spawn failure must not wait it out.
    // Before the fix this test hangs until bun's per-test timeout instead of failing fast.
    cdpReadyTimeoutMs: 60_000,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(
    new BrowserLaunchError("process_spawn"),
  );
  expect(spawnedArgs.length).toBe(1);
  store.close();
});

test("a healthy CDP endpoint still wins over a late spawn-failure report", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: testDataRoot(store),
    portProbe: () => true,
    // The helper reports a nonzero exit, but the browser it started is up: the
    // launch must succeed rather than throw on a stale diagnostic.
    spawn: (bin, args) => ({ ...f.spawn(bin, args), spawnFailed: Promise.resolve("helper exited 1") }),
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    cdpReadyTimeoutMs: 1000,
  });

  const { port } = await launcher.start("k1d0cd11");
  expect(port).toBeGreaterThan(0);
  store.close();
});

test("matchProfileDirHolderPids finds a leaked browser on the same profile dir but ANY debug port", () => {
  const dir = "C:\aliasmode\profiles\dho7ab90";
  const snapshot = {
    incomplete: false,
    records: [
      // The leak: same persistent dir, a debug port from an earlier launch. The
      // owned-pid scan misses this because it also matches the RECORDED port.
      { pid: 4242, executablePath: "C:\cb\chrome.exe", commandLine: `"C:\cb\chrome.exe" --remote-debugging-port=9401 --user-data-dir=${dir}` },
      // A different profile whose dir merely shares a prefix must never match.
      { pid: 4243, executablePath: "C:\cb\chrome.exe", commandLine: `"C:\cb\chrome.exe" --remote-debugging-port=9402 --user-data-dir=${dir}2` },
      { pid: 4244, executablePath: "C:\cb\chrome.exe", commandLine: `"C:\cb\chrome.exe" --remote-debugging-port=9403 --user-data-dir=C:\aliasmode\profiles\other` },
    ],
  };
  expect(matchProfileDirHolderPids(dir, snapshot)).toEqual([4242]);
  // An incomplete scan that found nothing is inconclusive, never "no holders".
  expect(matchProfileDirHolderPids(dir, { incomplete: true, records: [] })).toBe(null);
});

test("a fresh launch reaps a leaked holder of the profile dir before spawning", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const dataRoot = join(tmpdir(), "cloak-reaped-profile-holder-test");
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(join(dataRoot, "k1d0cd11"), { recursive: true });
  const killedPids: number[] = [];
  const order: string[] = [];
  let held = true;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: (bin, args) => {
      order.push("spawn");
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    // A browser from an earlier run still holds this profile's user-data dir.
    findProfileDirHolderPids: async () => held ? [4242] : [],
    killPid: async (pid) => {
      order.push(`kill:${pid}`);
      killedPids.push(pid);
      held = false;
      f.killPid(pid);
    },
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");
  // Reaped FIRST: on Windows a live holder makes the new process hand off its
  // command line to the old instance and exit, so nothing listens on the new port.
  expect(killedPids).toEqual([4242]);
  expect(order).toEqual(["kill:4242", "spawn"]);
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

test("a fresh launch refuses to spawn while a leaked profile-dir holder survives", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const dataRoot = join(tmpdir(), "cloak-surviving-profile-holder-test");
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(join(dataRoot, "k1d0cd11"), { recursive: true });
  let spawned = false;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: (bin, args) => {
      spawned = true;
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [4242],
    killPid: async () => {},
    teardownPollMs: 1,
    teardownTimeoutMs: 5,
    cdpReadyTimeoutMs: 1000,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("profile_directory"));
  expect(spawned).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

test("a first launch skips the holder scan for a new profile directory", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const dataRoot = join(tmpdir(), "cloak-new-profile-holder-scan-test");
  rmSync(dataRoot, { recursive: true, force: true });
  let scanned = false;
  let spawned = false;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: (bin, args) => {
      spawned = true;
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => {
      scanned = true;
      return null;
    },
    cdpReadyTimeoutMs: 1000,
  });

  await launcher.start("k1d0cd11");
  expect(scanned).toBe(false);
  expect(spawned).toBe(true);
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

test("a fresh launch refuses to spawn after an inconclusive profile-dir scan", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const dataRoot = join(tmpdir(), "cloak-existing-profile-holder-scan-test");
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(join(dataRoot, "k1d0cd11"), { recursive: true });
  let spawned = false;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: (bin, args) => {
      spawned = true;
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {},
    labelWindow: async () => {},
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => null,
    cdpReadyTimeoutMs: 1000,
  });

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("profile_directory"));
  expect(spawned).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

(process.platform === "win32" ? test : test.skip)("the Windows process scan works when PATH has no PowerShell folder", async () => {
  // A failed scan stops every saved profile with browser_launch/profile_directory.
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  env.PATH = (process.env.PATH ?? "").split(";").filter((dir) => !/WindowsPowerShell/i.test(dir)).join(";");
  const child = Bun.spawn([
    process.execPath, "-e",
    'const { readHostProcessSnapshot } = await import("./launcher.ts"); process.stdout.write(String((await readHostProcessSnapshot()) !== null));',
  ], { cwd: import.meta.dir, env, stdout: "pipe", stderr: "ignore" });
  expect(await new Response(child.stdout).text()).toBe("true");
}, 120_000);

// --- fingerprint capture: bookkeeping that must never fail a launch ---

test("a fingerprint probe that throws does not fail the launch", async () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot: "/tmp/cloak-launcher-test",
    portProbe: () => true, spawn: f.spawn, fetch: f.fetchFn,
    isPidAlive: f.isPidAlive, findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {}, labelWindow: async () => {},
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    captureFingerprint: async () => {
      throw new Error("probe exploded");
    },
  });
  const result = await launcher.start("k1d0cd11");
  expect(result.port).toBeGreaterThan(0);
  expect(store.getProfile("k1d0cd11")!.fpObserved).toBeUndefined();
  store.close();
});

test("a successful probe persists a sample on the profile", async () => {
  const store = seeded();
  const f = fleet();
  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot: "/tmp/cloak-launcher-test",
    portProbe: () => true, spawn: f.spawn, fetch: f.fetchFn,
    isPidAlive: f.isPidAlive, findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {}, labelWindow: async () => {},
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    captureFingerprint: async () => ({ canvasHash: "a3f19c8e", hardwareConcurrency: 8 }),
  });
  await launcher.start("k1d0cd11");
  const back = store.getProfile("k1d0cd11")!;
  expect(back.fpObserved!.canvas).toBe("a3f19c8e");
  expect(back.fpObserved!.hardwareConcurrency).toBe(8);
  expect(back.fpVerdict).toBeUndefined(); // nothing was imported to check against
  store.close();
});

test("a launch verifies the profile against an imported attestation", async () => {
  const store = seeded();
  const imported = { ...store.getProfile("k1d0cd11")!, fpExpected: { canvas: "a3f19c8e" } };
  store.upsertProfile(imported);
  const f = fleet();
  const launcher = new Launcher({
    store, binaryPath: "/fake/cloak", dataRoot: "/tmp/cloak-launcher-test",
    portProbe: () => true, spawn: f.spawn, fetch: f.fetchFn,
    isPidAlive: f.isPidAlive, findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    ensureCookies: async () => ({ injected: true }),
    navigate: async () => {}, labelWindow: async () => {},
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false, cdpReadyTimeoutMs: 1000,
    captureFingerprint: async () => ({ canvasHash: "deadbeef" }),
  });
  await launcher.start("k1d0cd11");
  const verdict = store.getProfile("k1d0cd11")!.fpVerdict!;
  expect(verdict.verdict).toBe("mismatch");
  expect(verdict.differences[0]!.field).toBe("canvas");
  store.close();
});

test("Chromium 155 beta profiles launch the installed beta runtime without CloakBrowser-only flags", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  store.upsertProfile(profile);
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const binaries: string[] = [];
  const roots: string[] = [];
  const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
    chromiumRuntimeRoot: "/fake/runtimes",
    ensureAliasmodeChromium: async (root) => {
      roots.push(root);
      return "/fake/runtimes/chromium-155/chrome.exe";
    },
    spawn: (bin, args) => {
      binaries.push(bin);
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
  });

  await launcher.start(profile.id);
  expect(roots).toEqual(["/fake/runtimes", "/fake/runtimes"]);
  expect(binaries).toEqual(["/fake/runtimes/chromium-155/chrome.exe"]);
  expect(spawnedArgs[0]).toContain(`--fingerprint=${profile.fingerprintSeed}`);
  expect(spawnedArgs[0]!.some((arg) => arg.startsWith("--fingerprint-storage-quota="))).toBe(false);
  expect(store.getLaunch(profile.id)?.binaryPath).toBe("/fake/runtimes/chromium-155/chrome.exe");
  expect(await launcher.stop(profile.id)).toBe(true);
  store.close();
});

test("a stopped Chromium 155 profile shares its components beside the browser; CloakBrowser profiles keep theirs", async () => {
  const run = async (engine: "aliasmode" | "cloakbrowser") => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    const profile = engine === "aliasmode" ? chromium155 : cloakbrowser;
    store.upsertProfile(profile);
    const runtimes = join(testDataRoot(store), "runtimes");
    const executable = aliasmodeChromiumExecutable(runtimes, "win32");
    const own = join(testDataRoot(store), profile.id, "WidevineCdm");
    const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
      hostPlatform: "win32",
      hostArch: "x64",
      chromiumRuntimeRoot: runtimes,
      ensureAliasmodeChromium: async () => executable,
    });
    await launcher.start(profile.id);
    mkdirSync(join(own, "4.10.3112.0"), { recursive: true });
    writeFileSync(join(own, "4.10.3112.0", "manifest.json"), JSON.stringify({ version: "4.10.3112.0" }));
    mkdirSync(join(testDataRoot(store), profile.id, "component_crx_cache"), { recursive: true });
    writeFileSync(join(testDataRoot(store), profile.id, "component_crx_cache", "widevine.crx3"), "crx");
    await launcher.stop(profile.id);
    // The next start waits for the cleanup after the stop.
    await launcher.start(profile.id);
    await launcher.stop(profile.id);
    await (launcher as any).cacheClears.get(profile.id);
    const result = {
      shared: existsSync(join(executable, "..", "WidevineCdm", "manifest.json")),
      own: existsSync(own),
      crxCache: existsSync(join(testDataRoot(store), profile.id, "component_crx_cache")),
    };
    store.close();
    return result;
  };
  expect(await run("aliasmode")).toEqual({ shared: true, own: false, crxCache: false });
  expect(await run("cloakbrowser")).toEqual({ shared: false, own: true, crxCache: false });
});

test("at app start, stopped Chromium 155 profiles share their components; CloakBrowser profiles keep theirs", async () => {
  const store = new ProfileStore(":memory:");
  const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const { chromiumRuntime: _runtime, ...cloak } = buildNewProfile({ engine: "chromium" }, () => false);
  store.upsertProfile(chromium155);
  store.upsertProfile(cloak);
  const runtimes = join(testDataRoot(store), "runtimes");
  const executable = aliasmodeChromiumExecutable(runtimes, "win32");
  mkdirSync(join(executable, ".."), { recursive: true });
  for (const id of [chromium155.id, cloak.id]) {
    const version = join(testDataRoot(store), id, "WidevineCdm", "4.10.3112.0");
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "manifest.json"), JSON.stringify({ version: "4.10.3112.0" }));
    mkdirSync(join(testDataRoot(store), id, "component_crx_cache"), { recursive: true });
    writeFileSync(join(testDataRoot(store), id, "component_crx_cache", "widevine.crx3"), "crx");
  }
  const logs: string[] = [];
  const launcher = new ProductionLauncher({
    store,
    binaryPath: "",
    dataRoot: testDataRoot(store),
    chromiumRuntimeRoot: runtimes,
    hostPlatform: "win32",
    hostArch: "x64",
    ensureDownloadedCloakBrowser: async () => "unused",
    ensureAliasmodeChromium: async () => executable,
    log: (message) => logs.push(message),
    spawn: () => { throw new Error("must not spawn"); },
  });
  launcher.prefetchBrowserRuntimes(store.listProfiles());
  for (let i = 0; i < 100 && !logs.some((line) => line.startsWith("Chromium 155 components shared")); i++) await Bun.sleep(10);
  expect(logs.find((line) => line.startsWith("Chromium 155 components shared"))).toContain(": 1 stopped profiles checked");
  expect(existsSync(join(executable, "..", "WidevineCdm", "manifest.json"))).toBe(true);
  expect(existsSync(join(testDataRoot(store), chromium155.id, "WidevineCdm"))).toBe(false);
  expect(existsSync(join(testDataRoot(store), chromium155.id, "component_crx_cache"))).toBe(false);
  expect(existsSync(join(testDataRoot(store), cloak.id, "WidevineCdm", "4.10.3112.0", "manifest.json"))).toBe(true);
  expect(existsSync(join(testDataRoot(store), cloak.id, "component_crx_cache", "widevine.crx3"))).toBe(true);
  store.close();
});

test("Chromium 155 keeps WebGL without a graphics card, sharp pages on scaled Windows displays, and its own canvas", async () => {
  const launchArgs = async (hostPlatform: NodeJS.Platform, engine: "aliasmode" | "cloakbrowser") => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    const profile = engine === "aliasmode" ? chromium155 : cloakbrowser;
    store.upsertProfile(profile);
    const f = fleet();
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
    });
    await launcher.start(profile.id);
    await launcher.stop(profile.id);
    store.close();
    return spawnedArgs[0]!;
  };
  expect(await launchArgs("win32", "aliasmode")).toContain("--ignore-gpu-blocklist");
  // A Mac has a graphics card, and CloakBrowser reports a card by itself.
  expect(await launchArgs("darwin", "aliasmode")).not.toContain("--ignore-gpu-blocklist");
  expect(await launchArgs("win32", "cloakbrowser")).not.toContain("--ignore-gpu-blocklist");
  // Chromium 155 pages are drawn at 100%, so the Windows window must be at 100% too, or it is blurry.
  expect(await launchArgs("win32", "aliasmode")).toContain("--force-device-scale-factor=1");
  expect(await launchArgs("darwin", "aliasmode")).not.toContain("--force-device-scale-factor=1");
  expect(await launchArgs("win32", "cloakbrowser")).not.toContain("--force-device-scale-factor=1");
  // Each Chromium 155 profile draws its own canvas image. CloakBrowser varies it by itself.
  expect(await launchArgs("win32", "aliasmode")).toContain("--fingerprint-noise");
  expect(await launchArgs("win32", "cloakbrowser")).not.toContain("--fingerprint-noise");
});

test("AliasMode Chromium starts without the missing Google API keys bar; CloakBrowser keeps its environment", async () => {
  const launchEnv = async (engine: "aliasmode" | "cloakbrowser") => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    const profile = engine === "aliasmode" ? chromium155 : cloakbrowser;
    store.upsertProfile(profile);
    const f = fleet();
    const envs: Array<Record<string, string> | undefined> = [];
    const launcher = newLauncher(store, f, [], undefined, undefined, {
      hostPlatform: "win32",
      hostArch: "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      spawn: (bin, args, env) => { envs.push(env); return f.spawn(bin, args); },
    });
    await launcher.start(profile.id);
    await launcher.stop(profile.id);
    store.close();
    return envs;
  };
  expect(await launchEnv("aliasmode")).toEqual([{ GOOGLE_API_KEY: "no", GOOGLE_DEFAULT_CLIENT_ID: "no", GOOGLE_DEFAULT_CLIENT_SECRET: "no" }]);
  expect(await launchEnv("cloakbrowser")).toEqual([undefined]);
});

test("a Chromium 155 profile keeps the display scale of its first open on every Windows computer", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode", screen: "1920x1080" }, () => false);
  store.upsertProfile(profile);
  const open = async (hostScale: number) => {
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform: "win32",
      hostArch: "x64",
      hostScale,
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      captureFingerprint: async () => null,
      watchWindowFit: () => ({ stop: () => {} }),
    });
    await launcher.start(profile.id);
    await launcher.stop(profile.id);
    return spawnedArgs[0]!.filter((arg) => /^--(force-device-scale-factor|fingerprint-screen-(width|height))=/.test(arg));
  };
  const firstOpen = ["--fingerprint-screen-width=1536", "--fingerprint-screen-height=864", "--force-device-scale-factor=1.25"];
  expect(await open(1.25)).toEqual(firstOpen);
  expect(store.getProfile(profile.id)!.displayScale).toBe(1.25);
  // A computer at 100% or 150% shows the pages the same screen.
  expect(await open(1)).toEqual(firstOpen);
  expect(await open(1.5)).toEqual(firstOpen);
  // An edit that omits the scale keeps it.
  const { displayScale: _scale, ...edited } = store.getProfile(profile.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(profile.id)!.displayScale).toBe(1.25);
  store.close();
});

test("a Chromium 155 profile keeps the processor count of its first open", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  store.upsertProfile(profile);
  const open = async (hardwareConcurrency: number) => {
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform: "win32",
      hostArch: "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      captureFingerprint: async () => ({ hardwareConcurrency }),
      watchWindowFit: () => ({ stop: () => {} }),
    });
    await launcher.start(profile.id);
    // The launch is recorded with the kept count, so Cloud's identity check after the open passes.
    await launcher.verifyRunningIdentity(profile.id);
    // Nothing waits for a restart.
    expect(launchIdentityChanged(store.getProfile(profile.id)!, store.getLaunch(profile.id))).toBe(false);
    await launcher.stop(profile.id);
    return spawnedArgs[0]!.filter((arg) => arg.startsWith("--fingerprint-hardware-concurrency="));
  };
  // The first open shows the engine's own count and keeps it.
  expect(await open(2)).toEqual([]);
  expect(store.getProfile(profile.id)!.hardware).toEqual({ cores: 2 });
  // Another computer, where the engine would draw another count, shows the kept one.
  expect(await open(3)).toEqual(["--fingerprint-hardware-concurrency=2"]);
  expect(store.getProfile(profile.id)!.hardware).toEqual({ cores: 2 });
  store.close();
});

test("Chromium 155 on a scaled Windows display reports the screen in CSS pixels, as Chrome does there", async () => {
  const launch = async (
    hostPlatform: NodeJS.Platform,
    engine: "aliasmode" | "cloakbrowser",
    screen: string,
    hostScale: number,
    options: { storedAvailableScreen?: string; capture?: FingerprintSample } = {},
  ) => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode", screen }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    if (options.storedAvailableScreen) {
      store.saveObservedFingerprint(chromium155.id, { availableScreen: options.storedAvailableScreen }, null);
    }
    const spawnedArgs: string[][] = [];
    const areas: unknown[] = [];
    const scales: unknown[] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      hostScale,
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      captureFingerprint: async () => options.capture ?? null,
      watchWindowFit: (_ws, area, opts) => {
        areas.push(area);
        scales.push(opts?.scale);
        return { stop: () => {} };
      },
    });
    await launcher.start(chromium155.id);
    await launcher.stop(chromium155.id);
    store.close();
    const args = spawnedArgs[0]!;
    return {
      args: args.filter((arg) => /^--(force-device-scale-factor|fingerprint-screen-(width|height)|window-size)=/.test(arg)),
      areas,
      scales,
    };
  };

  expect(await launch("win32", "aliasmode", "1920x1080", 1.25)).toEqual({
    args: ["--window-size=998,778", "--fingerprint-screen-width=1536", "--fingerprint-screen-height=864", "--force-device-scale-factor=1.25"],
    areas: [{ left: 0, top: 0, width: 1536, height: 864 }],
    // The watcher reads window bounds rounded at that scale.
    scales: [1.25],
  });
  // A capture from an earlier launch at scale 1 is larger than this screen, so the whole screen
  // stands in; a capture from this launch is already in CSS pixels.
  expect((await launch("win32", "aliasmode", "1920x1080", 1.25, { storedAvailableScreen: "1920*1040" })).areas)
    .toEqual([{ left: 0, top: 0, width: 1536, height: 864 }]);
  const capture = { screen: { width: 1536, height: 864, availWidth: 1536, availHeight: 816, availLeft: 0, availTop: 0, colorDepth: 24, dpr: 1.25 } };
  expect((await launch("win32", "aliasmode", "1920x1080", 1.25, { capture })).areas)
    .toEqual([{ left: 0, top: 0, width: 1536, height: 816 }]);
  // The window never exceeds a screen that the scale made smaller than the window floors.
  expect((await launch("win32", "aliasmode", "1366x768", 1.75)).args).toEqual([
    "--window-size=781,439", "--fingerprint-screen-width=781", "--fingerprint-screen-height=439", "--force-device-scale-factor=1.75",
  ]);
  // The Mac build and CloakBrowser keep the stored screen and no forced scale.
  expect((await launch("darwin", "aliasmode", "1920x1080", 1.25)).args).toEqual([
    "--window-size=1248,972", "--fingerprint-screen-width=1920", "--fingerprint-screen-height=1080",
  ]);
  expect((await launch("win32", "cloakbrowser", "1920x1080", 1.25)).args).toEqual([
    "--window-size=1248,972", "--fingerprint-screen-width=1920", "--fingerprint-screen-height=1080",
  ]);
});

test("Chromium 155 names its window with a launch switch instead of a page title script", async () => {
  const launch = async (hostPlatform: NodeJS.Platform, engine: "aliasmode" | "cloakbrowser") => {
    const store = new ProfileStore(":memory:");
    const chromium155 = { ...buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false), name: "sophie" };
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    const label = buildWindowLabel("sophie", profileDisplayNo(undefined, store.getSerial(chromium155.id)));
    const scripted: string[] = [];
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      captureFingerprint: async () => null,
      labelWindow: async (_ws, text) => { scripted.push(text); },
    });
    await launcher.start(chromium155.id);
    await launcher.stop(chromium155.id);
    store.close();
    return { label, scripted, switches: spawnedArgs[0]!.filter((arg) => arg.startsWith("--aliasmode-window-label=")) };
  };

  const native = await launch("win32", "aliasmode");
  expect(native.label).toBe("sophie · #1 — ");
  // The engine adds the trailing space itself; Windows would strip it from a switch value.
  expect(native.switches).toEqual(["--aliasmode-window-label=sophie · #1 —"]);
  expect(native.scripted).toEqual([]);
  // AliasMode's own Linux and Mac builds take the same switch.
  for (const host of ["linux", "darwin"] as const) {
    const own = await launch(host, "aliasmode");
    expect(own.switches).toEqual(["--aliasmode-window-label=sophie · #1 —"]);
    expect(own.scripted).toEqual([]);
  }
  // CloakBrowser on Windows has no such switch, so it keeps the page script.
  const cloak = await launch("win32", "cloakbrowser");
  expect(cloak.switches).toEqual([]);
  expect(cloak.scripted).toEqual([cloak.label]);
  // On Mac CloakBrowser has no switch, and pages could read a title script.
  const mac = await launch("darwin", "cloakbrowser");
  expect(mac.switches).toEqual([]);
  expect(mac.scripted).toEqual([]);
});

test("a Cloud launch of Chromium 155 keeps the browser after its last window; other launches do not", async () => {
  const launch = async (hostPlatform: NodeJS.Platform, engine: "aliasmode" | "cloakbrowser", keepAliveWithoutWindows?: boolean) => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      chromiumSandboxBlocked: () => false,
      captureFingerprint: async () => null,
    });
    await launcher.start(chromium155.id, [], { keepAliveWithoutWindows });
    await launcher.stop(chromium155.id);
    store.close();
    return spawnedArgs[0]!.includes("--aliasmode-keep-alive");
  };
  expect(await launch("win32", "aliasmode", true)).toBe(true);
  expect(await launch("linux", "aliasmode", true)).toBe(true);
  // On macOS the process outlives its last window anyway, but reading cookies then needs the switch.
  expect(await launch("darwin", "aliasmode", true)).toBe(true);
  expect(await launch("win32", "aliasmode")).toBe(false);
  expect(await launch("darwin", "aliasmode")).toBe(false);
  // CloakBrowser lacks the switch.
  for (const [host, engine] of [["darwin", "cloakbrowser"], ["win32", "cloakbrowser"]] as const) {
    expect(await launch(host, engine, true)).toBe(false);
  }
});

test("a Windows profile of Chromium 155 on Linux gets the Windows font pack through fontconfig; others keep the system fonts", async () => {
  const launch = async (
    hostPlatform: NodeJS.Platform,
    engine: "aliasmode" | "cloakbrowser",
    platformOs: string,
    ensureFirefoxFontPack?: (root: string, pack: { os: string }) => Promise<string>,
  ) => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode", platformOs }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    const f = fleet();
    const envs: Array<Record<string, string> | undefined> = [];
    const packs: string[] = [];
    const fontsDir = join(testDataRoot(store), "font-pack", "fonts");
    const launcher = newLauncher(store, f, [], undefined, undefined, {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome",
      ensureDownloadedCloakBrowser: async () => "/fake/cloak",
      chromiumSandboxBlocked: () => false,
      captureFingerprint: async () => null,
      ensureFirefoxFontPack: ensureFirefoxFontPack ?? (async (_root, pack) => {
        packs.push(pack.os);
        mkdirSync(fontsDir, { recursive: true });
        return fontsDir;
      }),
      spawn: (bin, args, env) => {
        envs.push(env);
        return f.spawn(bin, args);
      },
    });
    try {
      await launcher.start(chromium155.id);
      await launcher.stop(chromium155.id);
    } finally {
      store.close();
    }
    const conf = envs[0]?.FONTCONFIG_FILE;
    return { packs, conf, content: conf ? readFileSync(conf, "utf8") : undefined, fontsDir, env: envs[0] };
  };
  const linux = await launch("linux", "aliasmode", "windows");
  expect(linux.packs).toEqual(["windows"]);
  expect(linux.conf).toBe(join(linux.fontsDir, "..", "chromium-fonts.conf"));
  // The pack is added to the system's fonts, which stay.
  expect(linux.content).toContain(`<dir>${linux.fontsDir}</dir>`);
  expect(linux.content).toContain(`<include ignore_missing="yes">${process.env.FONTCONFIG_FILE || "/etc/fonts/fonts.conf"}</include>`);
  expect(linux.env).toMatchObject({ GOOGLE_API_KEY: "no" });
  // The host's own OS, another host, and CloakBrowser get no pack.
  for (const [host, engine, os] of [["linux", "aliasmode", "linux"], ["win32", "aliasmode", "windows"], ["linux", "cloakbrowser", "windows"]] as const) {
    const other = await launch(host, engine, os);
    expect(other.packs).toEqual([]);
    expect(other.conf).toBeUndefined();
  }
  // Without the fonts the profile does not open with this computer's fonts.
  await expect(launch("linux", "aliasmode", "windows", async () => { throw new Error("offline"); }))
    .rejects.toEqual(new BrowserLaunchError("preflight", "firefox_fonts_download"));
});

test("Chromium 155 shows the proxy exit IP to WebRTC; CloakBrowser does not", async () => {
  const proxy = { type: "http" as const, host: "proxy.example", port: "8080", user: "", pass: "" };
  const launch = async (
    hostPlatform: NodeJS.Platform,
    engine: "aliasmode" | "cloakbrowser",
    lookup: () => Promise<string | null>,
    profileProxy: typeof proxy | null = proxy,
  ) => {
    const store = new ProfileStore(":memory:");
    const chromium155 = { ...buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false), proxy: profileProxy };
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    const asked: unknown[] = [];
    const spawnedArgs: string[][] = [];
    const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      chromiumSandboxBlocked: () => false,
      captureFingerprint: async () => null,
      lookupExitLocation: async (spec) => {
        asked.push(spec);
        const ip = await lookup();
        return ip ? { timezone: chromium155.timezone, ip } : null;
      },
    });
    await launcher.start(chromium155.id);
    await launcher.stop(chromium155.id);
    store.close();
    const webrtc = spawnedArgs[0]!.filter((arg) => /^--(force-webrtc-ip-handling-policy|fingerprint-webrtc-(ip|udp))=/.test(arg));
    return { asked, webrtc };
  };
  const policy = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
  expect(await launch("win32", "aliasmode", async () => "203.0.113.7"))
    .toEqual({ asked: [proxy], webrtc: [policy, "--fingerprint-webrtc-ip=203.0.113.7"] });
  expect((await launch("win32", "aliasmode", async () => "2001:db8::7")).webrtc)
    .toEqual([policy, "--fingerprint-webrtc-ip=2001:db8::7"]);
  // No answer, or a failed lookup, is asked once more; still none keeps the arguments as they were.
  expect(await launch("win32", "aliasmode", async () => null)).toEqual({ asked: [proxy, proxy], webrtc: [policy] });
  expect(await launch("win32", "aliasmode", () => Promise.reject(new Error("offline"))))
    .toEqual({ asked: [proxy, proxy], webrtc: [policy] });
  const answers = [null, "203.0.113.9"];
  expect(await launch("linux", "aliasmode", async () => answers.shift() ?? null))
    .toEqual({ asked: [proxy, proxy], webrtc: [policy, "--fingerprint-webrtc-ip=203.0.113.9"] });
  // Without a proxy WebRTC keeps the computer's own route and nothing is looked up.
  expect(await launch("win32", "aliasmode", async () => "203.0.113.7", null))
    .toEqual({ asked: [], webrtc: ["--force-webrtc-ip-handling-policy=default_public_interface_only"] });
  expect((await launch("linux", "aliasmode", async () => "203.0.113.7")).webrtc).toEqual([policy, "--fingerprint-webrtc-ip=203.0.113.7"]);
  expect(await launch("darwin", "aliasmode", async () => "203.0.113.7"))
    .toEqual({ asked: [proxy], webrtc: [policy, "--fingerprint-webrtc-ip=203.0.113.7"] });
  // CloakBrowser lacks the engine change. Its exit is asked for its timezone only, once.
  for (const [host, engine] of [["darwin", "cloakbrowser"], ["win32", "cloakbrowser"]] as const) {
    expect(await launch(host, engine, async () => "203.0.113.7")).toEqual({ asked: [proxy], webrtc: [policy] });
    expect(await launch(host, engine, async () => null)).toEqual({ asked: [proxy], webrtc: [policy] });
  }
});

test("every proxied Chromium launch takes the proxy exit's timezone, and no answer or a typed timezone keeps the saved one", async () => {
  const proxy = { type: "http" as const, host: "proxy.example", port: "8080", user: "", pass: "" };
  const launch = async (hostPlatform: NodeJS.Platform, engine: "aliasmode" | "cloakbrowser", exit: ExitLocation | null, timezoneManual = false) => {
    const store = new ProfileStore(":memory:");
    const chromium155 = {
      ...buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false), proxy, timezone: "Europe/London",
      ...(timezoneManual ? { timezoneManual: true } : {}),
    };
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    const f = fleet();
    const spawnedArgs: string[][] = [];
    const options = {
      hostPlatform,
      hostArch: hostPlatform === "darwin" ? "arm64" : "x64",
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      chromiumSandboxBlocked: () => false,
      captureFingerprint: async () => null,
      lookupExitLocation: async () => exit,
    };
    const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, options);
    const opened = await launcher.start(chromium155.id);
    const stored = store.getProfile(chromium155.id)!.timezone;
    // The launch identity was recorded with the saved timezone, so a restarted app reattaches.
    const restarted = newLauncher(store, f, spawnedArgs, undefined, undefined, options);
    expect(await restarted.start(chromium155.id)).toEqual({ ...opened, nativeSessionRestored: false, reattached: true });
    expect(spawnedArgs).toHaveLength(1);
    await restarted.stop(chromium155.id);
    store.close();
    return { stored, flags: spawnedArgs[0]!.filter((arg) => arg.startsWith("--fingerprint-timezone=")) };
  };
  const tokyo = { timezone: "Asia/Tokyo", country: "JP", ip: "203.0.113.7" };
  for (const [host, engine] of [["win32", "aliasmode"], ["darwin", "aliasmode"], ["win32", "cloakbrowser"], ["darwin", "cloakbrowser"]] as const) {
    expect(await launch(host, engine, tokyo)).toEqual({ stored: "Asia/Tokyo", flags: ["--fingerprint-timezone=Asia/Tokyo"] });
  }
  expect(await launch("win32", "aliasmode", null))
    .toEqual({ stored: "Europe/London", flags: ["--fingerprint-timezone=Europe/London"] });
  for (const engine of ["aliasmode", "cloakbrowser"] as const) {
    expect(await launch("win32", engine, tokyo, true))
      .toEqual({ stored: "Europe/London", flags: ["--fingerprint-timezone=Europe/London"] });
  }
});

test("a headed Chromium 155 window is kept on the profile's available screen until the browser stops", async () => {
  const watched = async (engine: "aliasmode" | "cloakbrowser", headless: boolean) => {
    const store = new ProfileStore(":memory:");
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode", screen: "1440x900" }, () => false);
    const { chromiumRuntime: _runtime, ...cloakbrowser } = chromium155;
    store.upsertProfile(engine === "aliasmode" ? chromium155 : cloakbrowser);
    const calls: Array<{ ws: string; area: unknown }> = [];
    let stops = 0;
    const launcher = newLauncher(store, fleet(), [], undefined, undefined, {
      headless,
      chromiumRuntimeRoot: "/fake/runtimes",
      ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
      captureFingerprint: async () => ({
        screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 852, availLeft: 0, availTop: 0, colorDepth: 24, dpr: 1 },
      }),
      watchWindowFit: (ws, area) => {
        calls.push({ ws, area });
        return { stop: () => { stops++; } };
      },
    });
    const { ws } = await launcher.start(chromium155.id);
    await launcher.stop(chromium155.id);
    store.close();
    return { calls, stops, ws };
  };
  const headed = await watched("aliasmode", false);
  expect(headed.calls).toEqual([{ ws: headed.ws, area: { left: 0, top: 0, width: 1440, height: 852 } }]);
  expect(headed.stops).toBe(1);
  expect((await watched("aliasmode", true)).calls).toEqual([]);
  expect((await watched("cloakbrowser", false)).calls).toEqual([]);
});

test("a Chromium 155 window that survives an app restart is watched again", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode", screen: "1440x900" }, () => false);
  store.upsertProfile(profile);
  const f = fleet();
  const options = (calls: Array<{ ws: string; area: unknown }>) => ({
    headless: false,
    chromiumRuntimeRoot: "/fake/runtimes",
    ensureAliasmodeChromium: async () => "/fake/runtimes/chromium-155/chrome.exe",
    captureFingerprint: async () => ({
      screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 852, availLeft: 0, availTop: 0, colorDepth: 24, dpr: 1 },
    }),
    watchWindowFit: (ws: string, area: unknown) => {
      calls.push({ ws, area });
      return { stop: () => {} };
    },
  });
  const before: Array<{ ws: string; area: unknown }> = [];
  const launcherA = newLauncher(store, f, [], undefined, undefined, options(before));
  await launcherA.start(profile.id);
  (launcherA as any).closeRelay(profile.id);

  const after: Array<{ ws: string; area: unknown }> = [];
  const launcherB = newLauncher(store, f, [], undefined, undefined, options(after));
  await launcherB.reconcileOrphans();
  const { ws } = await launcherB.start(profile.id);
  await launcherB.start(profile.id);
  for (let i = 0; i < 20 && after.length === 0; i++) await Bun.sleep(1);

  // The stored capture from the first launch still names the area above the taskbar.
  expect(after).toEqual([{ ws, area: { left: 0, top: 0, width: 1440, height: 852 } }]);
  await launcherB.stop(profile.id);
  store.close();
});

test("Chromium 155 beta download failure is a public preflight error", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  store.upsertProfile(profile);
  const spawnedArgs: string[][] = [];
  const launcher = newLauncher(store, fleet(), spawnedArgs, undefined, undefined, {
    ensureAliasmodeChromium: async () => { throw new Error("offline"); },
  });
  const error = await launcher.start(profile.id).catch((caught) => caught);
  expect(error).toEqual(new BrowserLaunchError("preflight", "chromium155_download"));
  expect(error.guidance).toContain("could not be downloaded");
  expect(spawnedArgs).toEqual([]);
  store.close();
});

test("the macOS app opens a CloakBrowser profile with the downloaded macOS build, never with Chromium 155", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  store.upsertProfile(profile);
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const binaries: string[] = [];
  let betaDownloads = 0;
  const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
    binaryPath: "",
    hostPlatform: "darwin",
    hostArch: "arm64",
    chromiumRuntimeRoot: "/fake/runtimes",
    ensureAliasmodeChromium: async () => { betaDownloads++; return "/unused"; },
    ensureDownloadedCloakBrowser: async (root) => `${root}/cloakbrowser-145/Chromium.app/Contents/MacOS/Chromium`,
    spawn: (bin, args) => {
      binaries.push(bin);
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
  });

  await launcher.start(profile.id);
  expect(binaries).toEqual(["/fake/runtimes/cloakbrowser-145/Chromium.app/Contents/MacOS/Chromium"]);
  expect(betaDownloads).toBe(0);
  // Without this flag macOS asks for the Keychain password when a second Chromium build starts.
  expect(spawnedArgs[0]).toContain("--use-mock-keychain");
  expect(await launcher.stop(profile.id)).toBe(true);
  store.close();
});

test("a failed CloakBrowser download is a public preflight error on every desktop system", async () => {
  for (const [hostPlatform, hostArch] of [["darwin", "arm64"], ["linux", "x64"], ["win32", "x64"]] as const) {
    const store = new ProfileStore(":memory:");
    const profile = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
    store.upsertProfile(profile);
    const launcher = new ProductionLauncher({
      store,
      binaryPath: "",
      dataRoot: testDataRoot(store),
      hostPlatform,
      hostArch,
      ensureDownloadedCloakBrowser: async () => { throw new Error("offline"); },
      spawn: () => { throw new Error("must not spawn"); },
    });
    const error = await launcher.start(profile.id).catch((caught) => caught);
    expect(error).toEqual(new BrowserLaunchError("preflight", "cloakbrowser_download"));
    expect(error.guidance).toContain("Check your internet connection");
    store.close();
  }
});

test("the Linux app opens a CloakBrowser profile with the downloaded Linux build and no desktop keyring", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  store.upsertProfile(profile);
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const binaries: string[] = [];
  const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
    binaryPath: "",
    hostPlatform: "linux",
    hostArch: "x64",
    chromiumRuntimeRoot: "/fake/runtimes",
    ensureDownloadedCloakBrowser: async (root) => `${root}/cloakbrowser-146/chrome`,
    spawn: (bin, args) => {
      binaries.push(bin);
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
  });

  await launcher.start(profile.id);
  expect(binaries).toEqual(["/fake/runtimes/cloakbrowser-146/chrome"]);
  expect(spawnedArgs[0]).toContain("--password-store=basic");
  expect(spawnedArgs[0]).not.toContain("--use-mock-keychain");
  expect(await launcher.stop(profile.id)).toBe(true);
  store.close();
});

test("the Windows app opens a CloakBrowser profile with the downloaded build and its pinned kernel hash", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  store.upsertProfile(profile);
  const f = fleet();
  const spawnedArgs: string[][] = [];
  const binaries: string[] = [];
  const launcher = newLauncher(store, f, spawnedArgs, undefined, undefined, {
    binaryPath: "",
    hostPlatform: "win32",
    hostArch: "x64",
    chromiumRuntimeRoot: "C:\\fake\\runtimes",
    ensureDownloadedCloakBrowser: async (root) => `${root}\\cloakbrowser-146.0.7680.177.5\\chrome.exe`,
    spawn: (bin, args) => {
      binaries.push(bin);
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
  });

  await launcher.start(profile.id);
  expect(binaries).toEqual(["C:\\fake\\runtimes\\cloakbrowser-146.0.7680.177.5\\chrome.exe"]);
  // The same executable the installer bundled before, so live browsers and personas stay valid.
  expect(store.getLaunch(profile.id)?.binarySha256).toBe("03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80");
  expect(spawnedArgs[0]).not.toContain("--use-mock-keychain");
  expect(spawnedArgs[0]).not.toContain("--password-store=basic");
  expect(await launcher.stop(profile.id)).toBe(true);
  store.close();
});

test("prefetch downloads each runtime and font pack that saved profiles need, and removes unpinned runtimes first", async () => {
  const store = new ProfileStore(":memory:");
  const root = join(tmpdir(), `aliasmode-prefetch-${crypto.randomUUID()}`);
  mkdirSync(join(root, "cloakbrowser-145.0.7632.109.2"), { recursive: true });
  mkdirSync(join(root, "chromium-155.0.8059.31-aliasmode.1"));
  const cloak = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  const beta = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const firefox = buildNewProfile({ engine: "firefox", platformOs: "macos" }, () => false);
  store.upsertProfile(cloak);
  // A browser that still runs from an older runtime keeps it.
  store.recordLaunch({
    profileId: cloak.id, pid: 1, debugPort: 9333, ws: "", startedAt: 1,
    binaryPath: join(root, "chromium-155.0.8059.31-aliasmode.1", "chrome.exe"),
  });
  const downloads: string[] = [];
  const fontPacks: string[] = [];
  let failCloakBrowser = true;
  const logs: string[] = [];
  const launcher = new ProductionLauncher({
    store,
    binaryPath: "",
    dataRoot: testDataRoot(store),
    chromiumRuntimeRoot: root,
    hostPlatform: "win32",
    hostArch: "x64",
    ensureDownloadedCloakBrowser: async () => {
      downloads.push("cloakbrowser");
      if (failCloakBrowser) throw new Error("offline");
      return "unused";
    },
    ensureAliasmodeChromium: async () => { downloads.push("chromium155"); return "unused"; },
    ensureFirefoxFontPack: async (_root, pack) => { fontPacks.push(pack.os); return "unused"; },
    log: (message) => logs.push(message),
    spawn: () => { throw new Error("must not spawn"); },
  });

  launcher.prefetchBrowserRuntimes([firefox]);
  expect(downloads).toEqual([]);
  expect(fontPacks).toEqual(["macos"]);
  expect(readdirSync(root)).toEqual(["chromium-155.0.8059.31-aliasmode.1"]);
  launcher.prefetchBrowserRuntimes([firefox, cloak, beta]);
  launcher.prefetchBrowserRuntimes([cloak, beta]);
  await Bun.sleep(0);
  expect(downloads).toEqual(["cloakbrowser", "chromium155"]);
  expect(logs).toEqual(["CloakBrowser download failed: offline"]);
  // A failed background download waits for the next open or app start instead of looping.
  failCloakBrowser = false;
  launcher.prefetchBrowserRuntimes([cloak]);
  expect(downloads).toEqual(["cloakbrowser", "chromium155"]);

  // A configured CloakBrowser binary needs no download.
  const configured = new ProductionLauncher({
    store, binaryPath: "C:\\cloak\\chrome.exe", dataRoot: testDataRoot(store), chromiumRuntimeRoot: root,
    hostPlatform: "win32", hostArch: "x64",
    ensureDownloadedCloakBrowser: async () => { downloads.push("configured"); return "unused"; },
    spawn: () => { throw new Error("must not spawn"); },
  });
  configured.prefetchBrowserRuntimes([cloak]);
  expect(downloads).toEqual(["cloakbrowser", "chromium155"]);
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("a Linux computer that blocks the Chrome sandbox gets a public preflight error before any download", async () => {
  const store = new ProfileStore(":memory:");
  const beta = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const cloak = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  store.upsertProfile(beta);
  store.upsertProfile(cloak);
  let downloads = 0;
  const launcher = new ProductionLauncher({
    store,
    binaryPath: "",
    dataRoot: testDataRoot(store),
    hostPlatform: "linux",
    hostArch: "x64",
    chromiumSandboxBlocked: () => true,
    ensureAliasmodeChromium: async () => { downloads++; return "/unused"; },
    ensureDownloadedCloakBrowser: async () => { downloads++; return "/unused"; },
    spawn: () => { throw new Error("must not spawn"); },
  });
  for (const id of [beta.id, cloak.id]) {
    const error = await launcher.start(id).catch((caught) => caught);
    expect(error).toEqual(new BrowserLaunchError("preflight", "chromium_sandbox"));
    expect(error.guidance).toContain("install command");
  }
  expect(downloads).toBe(0);
  store.close();
});

test("Chromium 155 refuses a macOS profile on Windows with a clear reason instead of crashing", async () => {
  const store = new ProfileStore(":memory:");
  const profile = { ...buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false), platformOs: "macos" as const };
  store.upsertProfile(profile);
  const launcher = new ProductionLauncher({
    store,
    dataRoot: testDataRoot(store),
    hostPlatform: "win32",
    hostArch: "x64",
    ensureAliasmodeChromium: async () => "/unused",
    spawn: () => { throw new Error("must not spawn"); },
  });
  const error = await launcher.start(profile.id).catch((failure) => failure);
  expect(error).toEqual(new BrowserLaunchError("preflight", "chromium155_macos_on_windows"));
  expect(error.guidance).toContain("macOS profile on Windows");
  store.close();
});

test("Chromium 155 beta is refused on unsupported hosts before any download", async () => {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  store.upsertProfile(profile);
  let downloads = 0;
  const launcher = new ProductionLauncher({
    store,
    dataRoot: testDataRoot(store),
    hostPlatform: "linux",
    hostArch: "arm64",
    ensureAliasmodeChromium: async () => { downloads++; return "/unused"; },
    spawn: () => { throw new Error("must not spawn"); },
  });
  await expect(launcher.start(profile.id)).rejects.toEqual(new BrowserLaunchError("preflight", "chromium155_host"));
  launcher.prefetchBrowserRuntimes([profile]);
  expect(downloads).toBe(0);
  store.close();
});

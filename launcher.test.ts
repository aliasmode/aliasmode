import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ProfileStore } from "./store.ts";
import {
  BrowserLaunchError,
  Launcher as ProductionLauncher,
  buildWindowLabel,
  collectLinuxProcessTree,
  createInFlightSnapshotReader,
  createFailureBackoffReader,
  defaultSpawn,
  hasUsableAuthToken,
  hasUsableTelegramCookie,
  isTelegramPlatform,
  matchOwnedBrowserPids,
  matchProfileDirHolderPids,
  parseTasklistImageNames,
  parseDarwinPsSnapshot,
  parseLinuxProcStat,
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
import { parseExport } from "./parse.ts";
import { SessionRestoreError } from "./session.ts";

const linuxTest = process.platform === "win32" ? test.skip : test;

/** Unit tests use fake executables, hosts, and CDP fleets. */
class Launcher extends ProductionLauncher {
  constructor(opts: ConstructorParameters<typeof ProductionLauncher>[0]) {
    super({
      // Production policy is exercised explicitly in dedicated gate tests below.
      unsafeDisableIdentityGates: true,
      findProfileDirHolderPids: async () => [],
      ...opts,
    });
  }
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
    return { ok, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }) };
  };
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
  return { aliveByPort, pidByPort, aliveByPid, killed, spawn, fetchFn, crash, killPid, isPidAlive, findOwnedBrowserPids };
}

function newLauncher(
  store: ProfileStore,
  f: ReturnType<typeof fleet>,
  spawnedArgs: string[][],
  killedPids?: number[],
  ensureSearchProvider?: SearchProviderEnsurer,
) {
  return new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
    portProbe: () => true,
    spawn: (bin, args) => {
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureSearchProvider,
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

test("after a restart, start() reattaches to the still-live browser instead of spawning a duplicate", async () => {
  const store = seeded();
  const f = fleet();

  // Manager run #1 launches the browser.
  const argsA: string[][] = [];
  const launcherA = newLauncher(store, f, argsA);
  const a = await launcherA.start("k1d0cd11", [], { sessionBaseVersion: 7 });
  expect(argsA.length).toBe(1);
  // Simulate the old manager dying: its relay listener disappears while the
  // browser process and durable launch row survive.
  (launcherA as any).closeRelay("k1d0cd11");

  // Manager "restarts": new Launcher, same on-disk store, empty in-memory procs.
  const argsB: string[][] = [];
  let searchProviderCalls = 0;
  const launcherB = newLauncher(store, f, argsB, undefined, async () => {
    searchProviderCalls++;
    return { status: "configured", engine: "DuckDuckGo" };
  });
  await launcherB.reconcileOrphans(); // browser still alive → row kept
  expect((launcherB as any).relays.size).toBe(0); // discovery never restores account networking
  const b = await launcherB.start("k1d0cd11", [], { sessionBaseVersion: -1 });

  expect(argsB.length).toBe(0); // did NOT spawn a second browser
  expect(b.port).toBe(a.port); // reused the same session/port
  expect(searchProviderCalls).toBe(0); // an already-running window is never touched
  expect(store.getLaunch("k1d0cd11")?.sessionBaseVersion).toBe(-1); // provisional before returning
  expect((launcherB as any).relays.has("k1d0cd11")).toBe(true); // restored only inside identity certification
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

test("a restart with a different launch mode stops the stale persona instead of certifying it", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  const launcherA = newLauncher(store, f, []);
  await launcherA.start("k1d0cd11");
  const launcherB = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
    headless: true,
    fetch: f.fetchFn,
    isPidAlive: f.isPidAlive,
    findOwnedBrowserPids: f.findOwnedBrowserPids,
    findProfileDirHolderPids: async () => [],
    killPid: async (pid) => f.killPid(pid),
    browserClose: async () => false,
  });

  await expect(launcherB.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
  expect(store.getLaunch("k1d0cd11")).toBeNull();
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
  await expect(launcherB.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
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

test("certifiedActive verifies a survivor once and stops it when the stored timezone changes", async () => {
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
  store.upsertProfile({ ...edited, timezone: "Europe/London" });
  expect(await launcher.certifiedActive("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
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
  const cacheDir = join(base, "Default", "Cache");
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
  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));

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

test("hasUsableAuthToken accepts a live/non-expiring token and rejects expired/missing", () => {
  const nowSec = Date.now() / 1000;
  expect(hasUsableAuthToken([{ name: "auth_token", value: "v", domain: ".x.com", path: "/", expires: nowSec + 99999 }])).toBe(true);
  expect(hasUsableAuthToken([{ name: "auth_token", value: "v", domain: ".x.com", path: "/" }])).toBe(true); // session cookie, no expiry
  expect(hasUsableAuthToken([{ name: "auth_token", value: "v", domain: ".x.com", path: "/", expires: nowSec - 10 }])).toBe(false); // expired
  expect(hasUsableAuthToken([{ name: "auth_token", value: "", domain: ".x.com", path: "/" }])).toBe(false); // empty value
  expect(hasUsableAuthToken([{ name: "ct0", value: "x", domain: ".x.com", path: "/" }])).toBe(false); // no auth_token
});

test("hasUsableTelegramCookie accepts current Telegram cookies and rejects expired/non-Telegram cookies", () => {
  const nowSec = Date.now() / 1000;
  expect(hasUsableTelegramCookie([{ name: "stel_token", value: "v", domain: "web.telegram.org", path: "/", expires: nowSec + 99999 }])).toBe(true);
  expect(hasUsableTelegramCookie([{ name: "stel_token", value: "v", domain: ".telegram.org", path: "/" }])).toBe(true);
  expect(hasUsableTelegramCookie([{ name: "stel_token", value: "v", domain: "web.telegram.org", path: "/", expires: nowSec - 10 }])).toBe(false);
  expect(hasUsableTelegramCookie([{ name: "auth_token", value: "v", domain: ".x.com", path: "/" }])).toBe(false);
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
    dataRoot: "/tmp/cloak-launcher-test",
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
    dataRoot: "/tmp/cloak-launcher-test",
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
  const make = (hostPlatform: NodeJS.Platform, hostArch: string) => new Launcher({
    store,
    binaryPath: "/fake",
    spawn: () => { spawned.push("spawn"); return { pid: 1, kill() {} }; },
    enforceHostCompatibility: true,
    hostPlatform,
    hostArch,
  });

  // Cross-OS desktop spoofing is allowed now, but a desktop browser still can't
  // coherently emulate a mobile persona, and an imported UA must name a
  // recognized desktop platform.
  store.upsertProfile({ ...base, proxy: null, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/146.0 Mobile Safari/537.36" });
  await expect(make("win32", "x64").start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
  store.upsertProfile({ ...base, proxy: null, ua: "not-a-real-user-agent" });
  await expect(make("darwin", "arm64").start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
  expect(spawned).toEqual([]);
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

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
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
  await expect(noPin.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));

  const mismatch = new ProductionLauncher({
    store,
    binaryPath: binary,
    expectedBinarySha256: "f".repeat(64),
    hostPlatform: "win32",
    hostArch: "x64",
    spawn: () => { spawns++; return { pid: 1, kill() {} }; },
  });
  await expect(mismatch.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
  expect(spawns).toBe(1);
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

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
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
  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
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
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
    portProbe: () => true,
    spawn: (bin, args) => {
      spawnedArgs.push(args);
      return f.spawn(bin, args);
    },
    fetch: f.fetchFn,
    ensureSearchProvider: async () => {
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
  store.close();
});

test("search provider failure never fails an otherwise healthy browser launch", async () => {
  const store = seeded();
  const f = fleet();
  const dataRoot = join(tmpdir(), `cloak-search-fail-${process.pid}`);
  const logs: string[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot,
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureSearchProvider: async () => { throw new Error("settings unavailable"); },
    ensureCookies: async () => ({ injected: false }),
    navigate: async () => {},
    labelWindow: async () => {},
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
    log: (message) => logs.push(message),
  });

  const launch = await launcher.start("k1d0cd11");

  expect(launch.ws).toContain("/devtools/browser/x");
  expect(logs.some((message) =>
    message.includes("search provider setup failed") && message.includes("continuing")
  )).toBe(true);

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
    dataRoot: "/tmp/cloak-launcher-test",
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
    dataRoot: "/tmp/cloak-launcher-test",
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

test("start with autoNavigate:false skips startup navigation (remote owns it)", async () => {
  const store = seeded();
  const p = store.getProfile("k1d0cd11")!;
  store.upsertProfile({ ...p, platform: "x.com" });
  const f = fleet();
  const events: string[] = [];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
    portProbe: () => true,
    spawn: f.spawn,
    fetch: f.fetchFn,
    ensureCookies: async () => ({ injected: true }),
    navigate: async (_ws, urls) => { events.push(`navigate:${urls.join(",")}`); },
    killPid: async () => {},
    browserClose: async () => false,
    cdpReadyTimeoutMs: 1000,
  });
  await launcher.start("k1d0cd11", [], { autoNavigate: false });
  expect(events).toEqual([]); // the launcher must not navigate; remote does it after writeSession
  store.close();
});

test("buildArgs omits --headless when headful, and adds it only when headless", () => {
  const store = seeded();
  const f = fleet();
  const profile = store.getProfile("k1d0cd11")!;

  const headful = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const argsHeadful = headful.buildArgs(profile, 9333, "/data", []);
  expect(argsHeadful.some((a) => a.startsWith("--headless"))).toBe(false); // raw chromium: any --headless = headless ON

  const headless = new Launcher({ store, binaryPath: "/fake", headless: true, spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const argsHeadless = headless.buildArgs(profile, 9333, "/data", []);
  expect(argsHeadless).toContain("--headless=new");
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
  expect(launcher.profileDeletionBlocked("k1d0cd11")).toBe(false);
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
  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
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

test("pageTargetFingerprint is generation-fenced and stable across target order", async () => {
  const store = seeded();
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9333, ws: "ws://x", startedAt: 1 });
  let targets = [
    { id: "b", type: "page", url: "https://example.com/b" },
    { id: "a", type: "page", url: "https://example.com/a" },
    { id: "worker", type: "service_worker", url: "https://example.com/sw.js" },
  ];
  const launcher = new Launcher({
    store,
    binaryPath: "/fake",
    fetch: async () => ({ ok: true, json: async () => targets }),
  });

  const first = await launcher.pageTargetFingerprint("k1d0cd11", { debugPort: 9333, startedAt: 1 });
  targets = [targets[1]!, targets[0]!];
  expect(await launcher.pageTargetFingerprint("k1d0cd11", { debugPort: 9333, startedAt: 1 })).toBe(first);
  targets[0] = { ...targets[0]!, url: "https://example.com/changed" };
  expect(await launcher.pageTargetFingerprint("k1d0cd11", { debugPort: 9333, startedAt: 1 })).not.toBe(first);
  expect(await launcher.pageTargetFingerprint("k1d0cd11", { debugPort: 9444, startedAt: 2 })).toBeNull();
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
  expect(existsSync(cacheDir)).toBe(false);
  expect(existsSync(scriptCache)).toBe(false);
  expect(existsSync(cacheStorage)).toBe(true);
  expect(existsSync(cookies)).toBe(true);
  expect(existsSync(localStorage)).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
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

  expect(failure).toEqual(new BrowserLaunchError("preflight"));
  const publicOutput = `${failure}\n${logs.join("\n")}`;
  for (const secret of [rawFailure, dataRoot, "k1d0cd11"]) {
    expect(publicOutput).not.toContain(secret);
  }

  rmSync(dataRoot, { recursive: true, force: true });
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
    dataRoot: "/tmp/cloak-launcher-test",
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
    dataRoot: "/tmp/cloak-launcher-test",
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
    dataRoot: "/tmp/cloak-launcher-test",
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

test("buildArgs disables background throttling so minimized/occluded windows keep running at full speed", () => {
  const store = seeded();
  const f = fleet();
  const profile = store.getProfile("k1d0cd11")!;
  const launcher = new Launcher({ store, binaryPath: "/fake", spawn: f.spawn, fetch: f.fetchFn, ensureCookies: async () => ({ injected: true }) });
  const args = launcher.buildArgs(profile, 9333, "/data", []);
  // The session launcher opens the window MINIMIZED (/MIN) so it doesn't steal focus.
  // Keep minimized windows responsive, but let Chromium exit when the user closes
  // the final visible window instead of retaining an invisible background process.
  expect(args).toContain("--disable-background-mode");
  expect(args).toContain("--disable-background-timer-throttling");
  expect(args).toContain("--disable-backgrounding-occluded-windows");
  expect(args).toContain("--disable-renderer-backgrounding");
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
    dataRoot: "/tmp/cloak-launcher-test",
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
    dataRoot: "/tmp/cloak-launcher-test",
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
  const killedPids: number[] = [];
  const order: string[] = [];
  let held = true;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
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
});

test("a fresh launch refuses to spawn while a leaked profile-dir holder survives", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  let spawned = false;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
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

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
  expect(spawned).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("a fresh launch refuses to spawn after an inconclusive profile-dir scan", async () => {
  const store = seeded();
  makeDirect(store);
  const f = fleet();
  let spawned = false;
  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloak",
    dataRoot: "/tmp/cloak-launcher-test",
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

  await expect(launcher.start("k1d0cd11")).rejects.toEqual(new BrowserLaunchError("preflight"));
  expect(spawned).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

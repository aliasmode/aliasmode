import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Launcher, BrowserLaunchError, type HostProcessSnapshot, type LauncherOptions } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });

function fixture(hostPlatform: NodeJS.Platform = "win32", hostArch = "x64") {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-firefox-launch-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProfileStore(":memory:");
  cleanup.push(() => store.close());
  const profile: Profile = {
    id: "firefox-one", accId: "", name: "Firefox profile", group: "", username: "", password: "", twofa: "",
    proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 1,
    cookies: [], seeded: false, engine: "firefox",
    firefox: { version: 1, runtimeVersion: "152.0.4-beta.30", config: { "navigator.userAgent": "Mozilla/5.0 Firefox/152.0" } },
  };
  store.upsertProfile(profile);
  const reservation = { endpoint: "http://127.0.0.1:41001", token: "a".repeat(64), generation: "11111111-1111-4111-8111-111111111111" };
  let browserAlive = false;
  let ownerAlive = false;
  let reachable = false;
  let launches = 0;
  let receivedConfig: unknown;
  let startupPreferences = "";
  let browserExecutable = "/fake/firefox.exe";
  let ownerExecutable = "node";
  const navigated: string[][] = [];
  const killed: number[] = [];
  const snapshots = (): HostProcessSnapshot => ({
    incomplete: false,
    records: [
      ...(browserAlive ? [{ pid: 202, parentPid: 201, processGroupId: 201, startTime: "202", executablePath: browserExecutable, argv: [browserExecutable, "-profile", join(root, profile.id), "-juggler-pipe"] }] : []),
      ...(ownerAlive ? [{ pid: 201, parentPid: 1, processGroupId: 201, startTime: "201", executablePath: ownerExecutable, argv: [ownerExecutable, "firefox-worker.mjs", `--aliasmode-firefox-owner=${reservation.generation}`] }] : []),
    ],
  });
  const options: LauncherOptions = {
    store, dataRoot: root, firefoxBinaryPath: "/fake/firefox.exe", unsafeDisableIdentityGates: true,
    enforceHostCompatibility: true, hostPlatform, hostArch, captureFingerprint: async () => null,
    navigate: async (_endpoint, urls) => { navigated.push([...urls]); }, ensureCookies: async () => ({ injected: false }),
    applySession: async () => {}, log: () => {},
    readProcessSnapshot: async () => snapshots(),
    isPidAlive: (pid) => pid === 201 ? ownerAlive : pid === 202 ? browserAlive : false,
    killPid: async (pid) => { killed.push(pid); if (pid === 201) ownerAlive = false; if (pid === 202) browserAlive = false; },
    firefoxRuntime: {
      reserve: async () => reservation,
      start: async (args, hooks) => {
        launches++;
        expect(store.getLaunch(profile.id)?.firefoxOwner?.generation).toBe(reservation.generation);
        receivedConfig = args.config;
        startupPreferences = readFileSync(join(args.userDataDir, "user.js"), "utf8");
        ownerAlive = true;
        await hooks?.onSpawn?.({ ...reservation, pid: 201, browserPid: 0 });
        browserAlive = true;
        reachable = true;
        const ready = { ...reservation, pid: 201, browserPid: 202 };
        await hooks?.onReady?.(ready);
        return ready;
      },
      call: async (_owner, operation) => {
        if (!reachable || !ownerAlive || !browserAlive) throw new Error("owner is unavailable");
        if (operation !== "status") return null as any;
        return {
          ...reservation, pid: 201, browserPid: 202, profileId: profile.id,
          directory: join(root, profile.id), executablePath: "/fake/firefox.exe",
          hasPages: true, pageTargets: [{ id: "1", url: "https://example.com/" }],
        } as any;
      },
      close: async () => { browserAlive = false; ownerAlive = false; reachable = false; },
    },
  };
  return {
    store, profile, options, killed, launcher: new Launcher(options),
    launches: () => launches, config: () => receivedConfig,
    startupPreferences: () => startupPreferences, navigated,
    setProcessPaths: (browser: string, owner: string) => {
      browserExecutable = browser;
      ownerExecutable = owner;
    },
    crashOwner: () => { ownerAlive = false; reachable = false; },
  };
}

test("Firefox launches one saved persona and retains ownership across manager restart", async () => {
  const f = fixture();
  const opened = await f.launcher.start(f.profile.id);
  expect(opened.ws.startsWith("firefox://")).toBe(true);
  expect(opened.ws).not.toContain("a".repeat(64));
  expect(f.config()).toEqual(f.profile.firefox!.config);
  expect(f.store.getLaunch(f.profile.id)?.engine).toBe("firefox");
  const restarted = new Launcher(f.options);
  expect(await restarted.start(f.profile.id)).toEqual({ ...opened, nativeSessionRestored: false });
  expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
  expect(f.launches()).toBe(1);
  expect(await restarted.stop(f.profile.id)).toBe(true);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("Firefox records and matches the managed Node owner after PATH changes", async () => {
  const f = fixture("linux", "x64");
  const startupNode = Bun.which("node");
  if (!startupNode) throw new Error("Node is unavailable for this test");
  const root = join(f.launcher.userDataDir(f.profile.id), "..");
  const managedDir = join(root, "managed-node");
  const managedNode = join(managedDir, "node");
  const firefox = join(root, "firefox");
  mkdirSync(managedDir, { recursive: true });
  copyFileSync(startupNode, managedNode);
  copyFileSync(startupNode, firefox);
  chmodSync(managedNode, 0o755);
  chmodSync(firefox, 0o755);
  f.setProcessPaths(firefox, managedNode);
  f.options.unsafeDisableIdentityGates = false;
  f.options.firefoxBinaryPath = firefox;
  f.options.expectedFirefoxBinarySha256 = createHash("sha256").update(readFileSync(firefox)).digest("hex");

  const previousPath = process.env.PATH;
  process.env.PATH = [managedDir, previousPath].filter(Boolean).join(delimiter);
  try {
    // Bun's implicit lookup keeps its startup PATH. The explicit lookup in
    // Launcher must instead select the newly managed executable.
    expect(realpathSync(Bun.which("node")!)).not.toBe(realpathSync(managedNode));
    const launcher = new Launcher(f.options);
    await launcher.start(f.profile.id);
    expect(f.store.getLaunch(f.profile.id)?.ownerBinaryPath).toBe(realpathSync(managedNode));
    expect(await launcher.stop(f.profile.id)).toBe(true);
    expect(f.store.getLaunch(f.profile.id)).toBeNull();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Firefox supports Darwin arm64 and Linux x64 personas without changing saved config", async () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"]] as const) {
    const f = fixture(platform, arch);
    const savedConfig = structuredClone(f.profile.firefox!);
    const opened = await f.launcher.start(f.profile.id);
    expect(f.config()).toEqual(savedConfig.config);
    expect(f.store.getLaunch(f.profile.id)?.firefoxOwner).toMatchObject({ pid: 201, browserPid: 202 });
    const restarted = new Launcher(f.options);
    expect(await restarted.start(f.profile.id)).toEqual({ ...opened, nativeSessionRestored: false });
    expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
    expect(f.launches()).toBe(1);
    expect(await restarted.stop(f.profile.id)).toBe(true);
    expect(f.store.getProfile(f.profile.id)?.firefox).toEqual(savedConfig);
  }
});

test("Firefox rejects unsupported host tuples without changing saved config", async () => {
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "arm64"]] as const) {
    const f = fixture(platform, arch);
    const savedConfig = structuredClone(f.profile.firefox!);
    await expect(f.launcher.start(f.profile.id)).rejects.toBeInstanceOf(BrowserLaunchError);
    expect(f.launches()).toBe(0);
    expect(f.store.getProfile(f.profile.id)?.firefox).toEqual(savedConfig);
  }
});

test("owner crash never permits duplicate Firefox and stop targets only exact processes", async () => {
  const f = fixture();
  await f.launcher.start(f.profile.id);
  f.crashOwner();
  const restarted = new Launcher(f.options);
  await expect(restarted.start(f.profile.id)).rejects.toBeInstanceOf(BrowserLaunchError);
  expect(f.launches()).toBe(1);
  expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
  expect(await restarted.stop(f.profile.id)).toBe(true);
  expect(f.killed).toEqual([202]);
});

test("Darwin and Linux Firefox ownership remains exact after an owner crash", async () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"]] as const) {
    const f = fixture(platform, arch);
    await f.launcher.start(f.profile.id);
    f.crashOwner();
    const restarted = new Launcher(f.options);
    await expect(restarted.start(f.profile.id)).rejects.toBeInstanceOf(BrowserLaunchError);
    expect(f.launches()).toBe(1);
    expect(await restarted.stop(f.profile.id)).toBe(true);
    expect(f.killed).toEqual([202]);
  }
});

test("Firefox enables native tab restore in the owned profile before spawn", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "opaque native session");
  writeFileSync(join(root, "user.js"), 'user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.startup.page", 1);\n');
  f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies: [], origins: [], tabs: ["https://old.example/"] }));
  const opened = await f.launcher.start(f.profile.id);
  expect(f.startupPreferences()).toBe('user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.startup.page", 3);\n');
  expect(opened.nativeSessionRestored).toBe(true);
  expect(f.navigated).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox disables native restore when the Cloud coordinator requests portable state", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "opaque native session");
  writeFileSync(join(root, "user.js"), 'user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.startup.page", 3);\n');
  const opened = await f.launcher.start(f.profile.id, [], { autoNavigate: false, restoreLastSession: false });
  expect(f.startupPreferences()).toBe('user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.startup.page", 0);\n');
  expect(opened.nativeSessionRestored).toBe(false);
  expect(f.navigated).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox disables native restore before applying a pending Cloud bundle", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "opaque native session");
  f.store.upsertProfiles([f.profile], new Map([[f.profile.id, JSON.stringify({ cookies: [], origins: [], tabs: [] })]]));
  const opened = await f.launcher.start(f.profile.id, [], { autoNavigate: false });
  expect(f.startupPreferences()).toBe('user_pref("browser.startup.page", 0);\n');
  expect(opened.nativeSessionRestored).toBe(false);
  expect(f.store.getPendingSessionBundle(f.profile.id)).toBeNull();
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox target probes ignore replaced launch generations", async () => {
  const f = fixture();
  await f.launcher.start(f.profile.id);
  const launch = f.store.getLaunch(f.profile.id)!;
  const call = f.options.firefoxRuntime!.call;
  f.options.firefoxRuntime!.call = async (...args) => {
    const result = await call<any>(...args);
    if (args[1] !== "status") return result;
    f.store.recordLaunch({ ...launch, startedAt: launch.startedAt + 1 });
    return { ...result, hasPages: false, pageTargets: [] };
  };
  expect(await f.launcher.pageTargetFingerprint(f.profile.id, launch)).toBeNull();
  f.store.recordLaunch(launch);
  expect(await f.launcher.hasPageTargets(f.profile.id)).toBe(true);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox rejects status from a different owner process", async () => {
  const f = fixture();
  const call = f.options.firefoxRuntime!.call;
  f.options.firefoxRuntime!.call = async (...args) => {
    const result = await call<any>(...args);
    return args[1] === "status" ? { ...result, pid: 999 } : result;
  };
  await expect(f.launcher.start(f.profile.id)).rejects.toBeInstanceOf(BrowserLaunchError);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("Firefox refuses unsupported saved runtime identities without regenerating them", async () => {
  const f = fixture();
  const profile = { ...f.profile, firefox: { ...f.profile.firefox!, runtimeVersion: "unsupported-runtime" } };
  f.store.upsertProfile(profile);
  await expect(f.launcher.start(profile.id)).rejects.toBeInstanceOf(BrowserLaunchError);
  expect(f.launches()).toBe(0);
  expect(f.store.getProfile(profile.id)?.firefox).toEqual(profile.firefox);
});

test("Firefox cache cleanup preserves native storage and lock files", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  for (const dir of ["cache2", "startupCache", "shader-cache", "storage/default"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "state"), "test data");
  }
  for (const file of ["cookies.sqlite", "prefs.js", "parent.lock", "sessionstore.jsonlz4"]) {
    writeFileSync(join(root, file), "test data");
  }
  await f.launcher.start(f.profile.id);
  expect(await f.launcher.clearCache(f.profile.id)).toEqual({ cleared: false });
  expect(existsSync(join(root, "cache2/state"))).toBe(true);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
  for (const dir of ["cache2", "startupCache", "shader-cache"]) expect(existsSync(join(root, dir))).toBe(false);
  for (const file of ["storage/default/state", "cookies.sqlite", "prefs.js", "parent.lock", "sessionstore.jsonlz4"]) {
    expect(existsSync(join(root, file))).toBe(true);
  }
});

test("Firefox rejects Chromium launch switches and stale stop generations", async () => {
  const f = fixture();
  await expect(f.launcher.start(f.profile.id, ["--disable-gpu-shader-disk-cache"])).rejects.toBeInstanceOf(BrowserLaunchError);
  expect(f.launches()).toBe(0);
  await f.launcher.start(f.profile.id);
  const launch = f.store.getLaunch(f.profile.id)!;
  expect(await f.launcher.stop(f.profile.id, { debugPort: launch.debugPort, startedAt: launch.startedAt - 1 })).toBe(false);
  expect(await f.launcher.active(f.profile.id)).toBe(true);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, BrowserLaunchError, type HostProcessSnapshot, type LauncherOptions } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });

function fixture() {
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
  let restoreLastSession: boolean | undefined;
  const navigated: string[][] = [];
  const killed: number[] = [];
  const snapshots = (): HostProcessSnapshot => ({
    incomplete: false,
    records: [
      ...(browserAlive ? [{ pid: 202, executablePath: "/fake/firefox.exe", argv: ["/fake/firefox.exe", "-profile", join(root, profile.id), "-juggler-pipe"] }] : []),
      ...(ownerAlive ? [{ pid: 201, executablePath: "node", argv: ["node", "firefox-worker.mjs", `--aliasmode-firefox-owner=${reservation.generation}`] }] : []),
    ],
  });
  const options: LauncherOptions = {
    store, dataRoot: root, firefoxBinaryPath: "/fake/firefox.exe", unsafeDisableIdentityGates: true,
    hostPlatform: "win32", hostArch: "x64", captureFingerprint: async () => null,
    navigate: async (_endpoint, urls) => { navigated.push([...urls]); }, ensureCookies: async () => ({ injected: false }), log: () => {},
    readProcessSnapshot: async () => snapshots(),
    isPidAlive: (pid) => pid === 201 ? ownerAlive : pid === 202 ? browserAlive : false,
    killPid: async (pid) => { killed.push(pid); if (pid === 201) ownerAlive = false; if (pid === 202) browserAlive = false; },
    firefoxRuntime: {
      reserve: async () => reservation,
      start: async (args, hooks) => {
        launches++;
        expect(store.getLaunch(profile.id)?.firefoxOwner?.generation).toBe(reservation.generation);
        receivedConfig = args.config;
        restoreLastSession = args.restoreLastSession;
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
    restoreLastSession: () => restoreLastSession, navigated,
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

test("Firefox preserves restored native tabs instead of reopening an older saved bundle", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "opaque native session");
  f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies: [], origins: [], tabs: ["https://old.example/"] }));
  const opened = await f.launcher.start(f.profile.id);
  expect(f.restoreLastSession()).toBe(true);
  expect(opened.nativeSessionRestored).toBe(true);
  expect(f.navigated).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox disables native restore when the Cloud coordinator requests portable state", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "opaque native session");
  const opened = await f.launcher.start(f.profile.id, [], { autoNavigate: false, restoreLastSession: false });
  expect(f.restoreLastSession()).toBe(false);
  expect(opened.nativeSessionRestored).toBe(false);
  expect(f.navigated).toEqual([]);
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

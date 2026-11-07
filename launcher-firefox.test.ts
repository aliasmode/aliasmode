import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { firefoxLaunchConfig, firefoxStartupPrefs, graphicsIdentity } from "./firefox-config.ts";
import { FIREFOX_FONT_PACKS, firefoxFontPackPrefs, type FirefoxFontPack } from "./firefox-fonts.ts";
import { Launcher, BrowserLaunchError, decodeMozLz4, type HostProcessSnapshot, type LauncherOptions } from "./launcher.ts";
import { FirefoxOwnerError } from "./firefox-runtime.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

const cleanup: Array<() => void> = [];
const LABEL = "Firefox profile · #1";
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
    firefox: { version: 1, runtimeVersion: "156.0.1-beta.36", config: { "navigator.userAgent": "Mozilla/5.0 Firefox/156.0" } },
  };
  store.upsertProfile(profile);
  const reservation = { endpoint: "http://127.0.0.1:41001", token: "a".repeat(64), generation: "11111111-1111-4111-8111-111111111111" };
  let browserAlive = false;
  let ownerAlive = false;
  let reachable = false;
  let hasPages = true;
  let snapshotIncomplete = false;
  let launches = 0;
  let receivedConfig: unknown;
  let receivedPrefs: unknown;
  let labeled = 0;
  let startupPreferences = "";
  let browserExecutable = "/fake/firefox.exe";
  let ownerExecutable = "node";
  const navigated: string[][] = [];
  const killed: number[] = [];
  const fontPacks: FirefoxFontPack[] = [];
  let fontPackFailure: Error | undefined;
  const snapshots = (): HostProcessSnapshot => ({
    incomplete: snapshotIncomplete,
    records: [
      ...(browserAlive ? [{ pid: 202, parentPid: 201, processGroupId: 201, startTime: "202", executablePath: browserExecutable, argv: [browserExecutable, "-profile", join(root, profile.id), "-juggler-pipe"] }] : []),
      ...(ownerAlive ? [{ pid: 201, parentPid: 1, processGroupId: 201, startTime: "201", executablePath: ownerExecutable, argv: [ownerExecutable, "firefox-worker.mjs", `--aliasmode-firefox-owner=${reservation.generation}`] }] : []),
    ],
  });
  const options: LauncherOptions = {
    store, dataRoot: root, chromiumRuntimeRoot: join(root, "runtimes"), firefoxBinaryPath: "/fake/firefox.exe", unsafeDisableIdentityGates: true,
    enforceHostCompatibility: true, hostPlatform, hostArch, captureFingerprint: async () => null,
    navigate: async (_endpoint, urls) => { navigated.push([...urls]); }, ensureCookies: async () => ({ injected: false }),
    addNativeSessionCookies: async () => ({ injected: false }),
    labelWindow: async () => { labeled++; },
    applySession: async () => {}, log: () => {},
    ensureFirefoxFontPack: async (packRoot, pack) => {
      fontPacks.push(pack);
      if (fontPackFailure) throw fontPackFailure;
      return join(packRoot, "firefox-fonts", pack.os, "fonts");
    },
    readProcessSnapshot: async () => snapshots(),
    isPidAlive: (pid) => pid === 201 ? ownerAlive : pid === 202 ? browserAlive : false,
    killPid: async (pid) => { killed.push(pid); if (pid === 201) ownerAlive = false; if (pid === 202) browserAlive = false; },
    firefoxRuntime: {
      reserve: async () => reservation,
      start: async (args, hooks) => {
        launches++;
        expect(store.getLaunch(profile.id)?.firefoxOwner?.generation).toBe(reservation.generation);
        receivedConfig = args.config;
        receivedPrefs = args.prefs;
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
          directory: join(root, profile.id), executablePath: browserExecutable,
          hasPages, pageTargets: hasPages ? [{ id: "1", url: "https://example.com/" }] : [],
        } as any;
      },
      close: async () => { browserAlive = false; ownerAlive = false; reachable = false; },
    },
  };
  return {
    store, profile: store.getProfile(profile.id)!, options, killed, launcher: new Launcher(options),
    launches: () => launches, config: () => receivedConfig, prefs: () => receivedPrefs, labeled: () => labeled,
    startupPreferences: () => startupPreferences, navigated, fontPacks,
    failFontPacks: (error?: Error) => { fontPackFailure = error; },
    setProcessPaths: (browser: string, owner: string) => {
      browserExecutable = browser;
      ownerExecutable = owner;
    },
    crashOwner: () => { ownerAlive = false; reachable = false; },
    closeNativeWindow: () => { hasPages = false; },
    setSnapshotIncomplete: (value: boolean) => { snapshotIncomplete = value; },
  };
}

test("Firefox launches one saved persona and retains ownership across manager restart", async () => {
  const f = fixture();
  const opened = await f.launcher.start(f.profile.id);
  expect(opened.ws.startsWith("firefox://")).toBe(true);
  expect(opened.ws).not.toContain("a".repeat(64));
  // The launch adds the per-profile seed, voices, devices and window label; the saved identity stays as it was.
  expect(f.config()).toEqual(firefoxLaunchConfig(f.profile, LABEL));
  expect(f.config()).toMatchObject({ "aliasmode:windowLabel": LABEL, "voices:blockIfNotDefined": true, "mediaDevices:enabled": true });
  expect(f.prefs()).toEqual(firefoxStartupPrefs(f.profile));
  expect(f.store.getProfile(f.profile.id)!.firefox!.config).not.toHaveProperty("audio:seed");
  // The engine shows the label in the native title, so no page script rewrites document.title.
  expect(f.labeled()).toBe(0);
  expect(f.store.getLaunch(f.profile.id)?.engine).toBe("firefox");
  const restarted = new Launcher(f.options);
  expect(await restarted.start(f.profile.id)).toEqual({ ...opened, nativeSessionRestored: false, reattached: true });
  expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
  expect(f.launches()).toBe(1);
  expect(await restarted.stop(f.profile.id)).toBe(true);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("Firefox sets cookies added while closed before its first page, and an edit while open waits for the next start", async () => {
  const f = fixture();
  const steps: string[] = [];
  f.store.addPendingCookies(f.profile.id, [{ name: "auth_token", value: "new", domain: ".x.com", path: "/", partitionKey: "https://x.com" }]);
  const launcher = new Launcher({
    ...f.options,
    setCookies: async (ws, cookies) => { steps.push(`cookies:${ws.slice(0, 10)}:${JSON.stringify(cookies)}`); },
    navigate: async (_ws, urls) => { steps.push(`navigate:${urls.join(",")}`); },
  });
  await launcher.start(f.profile.id, ["https://x.com/home"]);
  expect(steps).toEqual([
    `cookies:firefox://:${JSON.stringify([{ name: "auth_token", value: "new", domain: ".x.com", path: "/" }])}`,
    "navigate:https://x.com/home",
  ]);
  expect(f.store.getPendingCookies(f.profile.id)).toEqual([]);

  // A screen saved while open changes the saved config only; the browser keeps running.
  const saved = f.store.getProfile(f.profile.id)!;
  f.store.upsertProfile({ ...saved, name: "Renamed", screenWidth: 1366, screenHeight: 768 });
  expect(await launcher.certifiedActive(f.profile.id)).toBe(true);
  expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
  expect(f.launches()).toBe(1);
  expect(await launcher.stop(f.profile.id)).toBe(true);
});

test("a proxied Firefox launch gives the engine the proxy exit IP for WebRTC, and no answer after a second try keeps today's config", async () => {
  for (const exitIp of ["203.0.113.7", null]) {
    const f = fixture();
    const proxy = { type: "http" as const, host: "proxy.example", port: "8080", user: "", pass: "" };
    f.store.upsertProfile({ ...f.profile, proxy });
    const profile = f.store.getProfile(f.profile.id)!;
    const asked: unknown[] = [];
    const launcher = new Launcher({
      ...f.options,
      lookupExitLocation: async (spec) => { asked.push(spec); return exitIp ? { timezone: profile.timezone, ip: exitIp } : null; },
    });
    await launcher.start(profile.id);
    expect(asked).toEqual(exitIp ? [proxy] : [proxy, proxy]);
    expect(f.config()).toEqual(firefoxLaunchConfig(profile, LABEL, undefined, exitIp ?? undefined));
    expect((f.config() as Record<string, unknown>)["webrtc:ipv4"]).toBe(exitIp ?? undefined);
    expect(f.store.getProfile(profile.id)!.firefox!.config).not.toHaveProperty("webrtc:ipv4");
    expect(await launcher.stop(profile.id)).toBe(true);
  }
});

test("a proxied Firefox launch saves the proxy exit's timezone in its config, and no answer keeps the saved one", async () => {
  for (const exit of [{ timezone: "Asia/Tokyo", country: "JP", ip: "203.0.113.7" }, null]) {
    const f = fixture();
    const proxy = { type: "http" as const, host: "proxy.example", port: "8080", user: "", pass: "" };
    const firefox = { ...f.profile.firefox!, config: { ...f.profile.firefox!.config, timezone: "Europe/London" } };
    f.store.upsertProfile({ ...f.profile, proxy, timezone: "Europe/London", firefox });
    const options = { ...f.options, lookupExitLocation: async () => exit };
    const launcher = new Launcher(options);
    const opened = await launcher.start(f.profile.id);
    const timezone = exit?.timezone ?? "Europe/London";
    const saved = f.store.getProfile(f.profile.id)!;
    expect(saved.timezone).toBe(timezone);
    expect(saved.firefox!.config.timezone).toBe(timezone);
    expect((f.config() as Record<string, unknown>).timezone).toBe(timezone);
    // The launch identity was recorded with the saved timezone, so a restarted app reattaches.
    const restarted = new Launcher(options);
    expect(await restarted.start(f.profile.id)).toEqual({ ...opened, nativeSessionRestored: false, reattached: true });
    expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
    expect(f.launches()).toBe(1);
    expect(await restarted.stop(f.profile.id)).toBe(true);
  }
});

test.each([false, true])("legacy Firefox keeps its old digest until confirmed close (stale=%s)", async (stale) => {
  const f = fixture();
  const legacyConfig = { version: 1 as const, runtimeVersion: "156.0.1-beta.36", config: { "navigator.userAgent": "Mozilla/5.0 Firefox/156.0" } };
  (f.store as any).db.query("UPDATE profiles SET locale = '', firefox_config_json = ? WHERE id = ?")
    .run(JSON.stringify(legacyConfig), f.profile.id);
  const legacy = f.store.getProfile(f.profile.id)!;
  await f.launcher.start(legacy.id);
  const launch = f.store.getLaunch(legacy.id)!;
  const oldDigest = createHash("sha256").update(JSON.stringify({
    schema: 2, engine: "firefox", firefox: legacy.firefox,
    binarySha256: "0".repeat(64), host: ["win32", "x64"], headless: false,
    windowScale: [0.65, 0.9], ua: legacy.ua, platform: legacy.platform,
    proxy: null, webRtcPolicy: "default_public_interface_only", timezone: legacy.timezone,
    screen: [legacy.screenWidth, legacy.screenHeight], fingerprintSeed: legacy.fingerprintSeed, extensions: [],
  })).digest("hex");
  expect(launch.personaDigest).toBe(oldDigest);
  const restarted = new Launcher(f.options);
  if (stale) {
    await f.options.firefoxRuntime!.close(launch.firefoxOwner!);
  } else {
    await restarted.start(legacy.id);
    expect(f.launches()).toBe(1);
    expect(f.store.getProfile(legacy.id)!.locale).toBeUndefined();
    expect(f.store.getProfile(legacy.id)!.firefox).toEqual(legacyConfig);
    expect(await restarted.stop(legacy.id)).toBe(true);
  }
  await restarted.start(legacy.id);
  const completed = f.store.getProfile(legacy.id)!;
  expect(completed.locale).toBe("en-US");
  expect(completed.firefox!.config.fonts).toBeArray();
  expect(f.config()).toEqual(firefoxLaunchConfig(completed, LABEL));
  expect(f.store.getLaunch(legacy.id)!.personaDigest).not.toBe(oldDigest);
  expect(f.launches()).toBe(2);
  expect(await restarted.stop(legacy.id)).toBe(true);
});

test("Firefox uses its authenticated owner when an external close leaves the host scan inconclusive", async () => {
  const f = fixture("darwin", "arm64");
  await f.launcher.start(f.profile.id);
  const close = f.options.firefoxRuntime!.close;
  f.options.firefoxRuntime!.close = async (owner, options) => {
    await close(owner, options);
    f.setSnapshotIncomplete(false);
  };
  f.closeNativeWindow();
  f.setSnapshotIncomplete(true);

  expect(await f.launcher.stop(f.profile.id)).toBe(true);
  expect(f.killed).toEqual([]);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test.each(["stop", "reconcile", "reopen"])("Linux Firefox recovers native exit through %s without Chromium group proof", async (operation) => {
  const f = fixture("linux", "x64");
  await f.launcher.start(f.profile.id);
  const launch = f.store.getLaunch(f.profile.id)!;
  await f.options.firefoxRuntime!.close(launch.firefoxOwner!);
  if (operation === "stop") expect(await f.launcher.stop(f.profile.id)).toBe(true);
  if (operation === "reconcile") expect(await f.launcher.reconcileOrphan(f.profile.id, launch)).toBe("dead");
  await f.launcher.start(f.profile.id);
  expect(f.launches()).toBe(2);
  expect(f.killed).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Linux Firefox retains native-exit ownership while its process scan is incomplete", async () => {
  const f = fixture("linux", "x64");
  await f.launcher.start(f.profile.id);
  const launch = f.store.getLaunch(f.profile.id)!;
  await f.options.firefoxRuntime!.close(launch.firefoxOwner!);
  f.setSnapshotIncomplete(true);
  expect(await f.launcher.stop(f.profile.id)).toBe(false);
  expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
  expect(f.killed).toEqual([]);
  f.setSnapshotIncomplete(false);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox retains ownership when its host scan stays inconclusive after authenticated close", async () => {
  const f = fixture("darwin", "arm64");
  await f.launcher.start(f.profile.id);
  f.closeNativeWindow();
  f.setSnapshotIncomplete(true);
  const launcher = new Launcher({ ...f.options, teardownTimeoutMs: 0 });

  expect(await launcher.stop(f.profile.id)).toBe(false);
  expect(f.killed).toEqual([]);
  expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
});

test("Firefox does not close a mismatched owner when its host scan is inconclusive", async () => {
  const f = fixture("darwin", "arm64");
  await f.launcher.start(f.profile.id);
  f.closeNativeWindow();
  f.setSnapshotIncomplete(true);
  const call = f.options.firefoxRuntime!.call;
  f.options.firefoxRuntime!.call = async (...args) => {
    const status = await call<any>(...args);
    return args[1] === "status" ? { ...status, generation: "different-generation" } : status;
  };
  let closed = false;
  f.options.firefoxRuntime!.close = async () => { closed = true; };

  expect(await f.launcher.stop(f.profile.id)).toBe(false);
  expect(closed).toBe(false);
  expect(f.killed).toEqual([]);
  expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
});

test("Firefox records and matches the managed Node owner after PATH changes", async () => {
  const f = fixture("linux", "x64");
  const startupNode = Bun.which("node");
  if (!startupNode) throw new Error("Node is unavailable for this test");
  const root = join(f.launcher.userDataDir(f.profile.id), "..");
  const managedDir = join(root, "managed-node");
  const managedNode = join(managedDir, process.platform === "win32" ? "node.exe" : "node");
  const firefox = join(root, "firefox");
  mkdirSync(managedDir, { recursive: true });
  copyFileSync(startupNode, managedNode);
  copyFileSync(startupNode, firefox);
  chmodSync(managedNode, 0o755);
  chmodSync(firefox, 0o755);
  f.setProcessPaths(realpathSync(firefox), realpathSync(managedNode));
  f.options.unsafeDisableIdentityGates = false;
  f.options.firefoxBinaryPath = firefox;
  f.options.expectedFirefoxBinarySha256 = createHash("sha256").update(readFileSync(firefox)).digest("hex");

  const previousPath = process.env.PATH;
  process.env.PATH = [managedDir, previousPath].filter(Boolean).join(delimiter);
  try {
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

test("Firefox supports Darwin arm64, Darwin x64 and Linux x64 personas without changing saved config", async () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]] as const) {
    const f = fixture(platform, arch);
    const savedConfig = structuredClone(f.profile.firefox!);
    const opened = await f.launcher.start(f.profile.id);
    // A Windows persona on these computers reads the Windows font pack.
    expect(f.config()).toEqual(firefoxLaunchConfig(f.profile, LABEL, join(f.options.chromiumRuntimeRoot!, "firefox-fonts", "windows", "fonts")));
    expect(f.store.getLaunch(f.profile.id)?.firefoxOwner).toMatchObject({ pid: 201, browserPid: 202 });
    const restarted = new Launcher(f.options);
    expect(await restarted.start(f.profile.id)).toEqual({ ...opened, nativeSessionRestored: false, reattached: true });
    expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
    expect(f.launches()).toBe(1);
    expect(await restarted.stop(f.profile.id)).toBe(true);
    expect(f.store.getProfile(f.profile.id)?.firefox).toEqual(savedConfig);
  }
});

test("an Intel Mac asks its GPU vendor once for macOS profiles and shows a card of that vendor", async () => {
  const f = fixture("darwin", "x64");
  let asked = 0;
  const launcher = new Launcher({ ...f.options, macGraphicsVendor: async () => { asked++; return "amd"; } });
  await launcher.start(f.profile.id);
  // The fixture's profile is a Windows one: no question, and the config is unchanged.
  expect(asked).toBe(0);
  expect(await launcher.stop(f.profile.id)).toBe(true);
  const mac = { ...f.profile.firefox!.config, "navigator.platform": "MacIntel", ...graphicsIdentity("macos", 1) };
  f.store.upsertProfile({ ...f.profile, firefox: { ...f.profile.firefox!, config: mac } });
  const profile = f.store.getProfile(f.profile.id)!;
  await launcher.start(profile.id);
  expect(asked).toBe(1);
  expect(f.config()).toEqual(firefoxLaunchConfig(profile, LABEL, undefined, undefined, { vendor: "amd" }));
  expect((f.config() as Record<string, unknown>)["webGl:vendor"]).toBe("ATI Technologies Inc.");
  expect(await launcher.stop(profile.id)).toBe(true);
});

test("a Firefox window opens inside a display smaller than the profile's screen, and the saved screen stays", async () => {
  const f = fixture();
  const config = { ...f.profile.firefox!.config, "screen.width": 1920, "screen.height": 1080, "window.outerWidth": 1248, "window.outerHeight": 972 };
  f.store.upsertProfile({ ...f.profile, firefox: { ...f.profile.firefox!, config } });
  const profile = f.store.getProfile(f.profile.id)!;
  // 1366x768 at 100%, 1920x1080 at 125% and a 1440x900 Mac, each less its taskbar or menu bar and Dock.
  for (const [hostAvail, window] of [
    [{ width: 1366, height: 728 }, [1248, 728]], [{ width: 1536, height: 816 }, [1248, 816]], [{ width: 1440, height: 801 }, [1248, 801]],
  ] as const) {
    const launcher = new Launcher({ ...f.options, hostAvail });
    await launcher.start(profile.id);
    expect(f.config()).toEqual(firefoxLaunchConfig(profile, LABEL, undefined, undefined, undefined, hostAvail));
    expect(f.config()).toMatchObject({ "screen.width": 1920, "screen.height": 1080, "window.outerWidth": window[0], "window.outerHeight": window[1] });
    expect(await launcher.stop(profile.id)).toBe(true);
  }
  // A display that holds the screen leaves the launch as it was.
  const launcher = new Launcher({ ...f.options, hostAvail: { width: 2560, height: 1392 } });
  await launcher.start(profile.id);
  expect(f.config()).toEqual(firefoxLaunchConfig(profile, LABEL));
  expect(await launcher.stop(profile.id)).toBe(true);
  expect(f.store.getProfile(profile.id)!.firefox).toEqual(profile.firefox);
});

test("Firefox rejects unsupported host tuples without changing saved config", async () => {
  for (const [platform, arch] of [["linux", "arm64"], ["win32", "arm64"]] as const) {
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

test("Local capture retains unavailable tabs without reverting fresh storage", async () => {
  for (const tabs of [undefined, [], ["https://two.example/"]]) {
    const f = fixture();
    const savedTabs = ["https://one.example/", "https://two.example/", "https://one.example/"];
    f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies: [], origins: [], tabs: savedTabs }));
    const fresh = {
      cookies: [{ name: "session", value: "fresh", domain: "one.example", path: "/" }],
      origins: [{ origin: "https://one.example", localStorage: [{ name: "state", value: "fresh" }] }],
    };
    const launcher = new Launcher({ ...f.options, readSession: async () => JSON.stringify({ ...fresh, tabs }) });
    await launcher.start(f.profile.id);
    if (tabs === undefined) f.closeNativeWindow();
    expect(await launcher.captureLocalSession(f.profile.id)).toBe(true);
    expect(JSON.parse(f.store.getSessionBundle(f.profile.id)!)).toEqual({ ...fresh, tabs: tabs ?? savedTabs });
    expect(await launcher.stop(f.profile.id)).toBe(true);
  }
});

test("Mac reopens a closed window on its existing Firefox owner", async () => {
  const f = fixture("darwin", "arm64");
  const initial = await f.launcher.start(f.profile.id);
  const launch = f.store.getLaunch(f.profile.id)!;
  const tabs = ["https://new.example/", "https://new.example/"];
  writeFileSync(join(f.launcher.userDataDir(f.profile.id), "aliasmode-session-tabs.json"), JSON.stringify({
    generation: `${launch.debugPort}:${launch.startedAt}`, tabs,
  }));
  f.closeNativeWindow();
  expect(await f.launcher.start(f.profile.id)).toEqual({ ...initial, nativeSessionRestored: true, reattached: true });
  expect(f.navigated).toEqual([tabs]);
  expect(f.launches()).toBe(1);
  expect(f.killed).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("Mac reopens the latest native-close tabs instead of an older session", async () => {
  const f = fixture("darwin", "arm64");
  const root = f.launcher.userDataDir(f.profile.id);
  const tabs = ["https://new.example/", "https://second.example/", "https://new.example/"];
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "older native session");
  writeFileSync(join(root, "aliasmode-session-tabs.json"), JSON.stringify({ generation: "previous", tabs }));
  f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies: [], origins: [], tabs: ["https://old.example/"] }));
  await f.launcher.start(f.profile.id);
  expect(f.navigated).toEqual([tabs]);
  const launch = f.store.getLaunch(f.profile.id)!;
  expect(f.launcher.closedFirefoxTabs(f.profile.id, launch)).toBeUndefined();
  writeFileSync(join(root, "aliasmode-session-tabs.json"), JSON.stringify({ generation: `${launch.debugPort}:${launch.startedAt}`, tabs }));
  expect(f.launcher.closedFirefoxTabs(f.profile.id, launch)).toEqual(tabs);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("a saved tab that does not load never closes the Firefox the user already sees", async () => {
  const f = fixture("darwin", "arm64");
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "aliasmode-session-tabs.json"), JSON.stringify({ generation: "previous", tabs: ["https://slow.example/"] }));
  const launcher = new Launcher({ ...f.options, navigate: async () => { throw new Error("page.goto: Timeout 30000ms exceeded"); } });
  const opened = await launcher.start(f.profile.id);
  expect(opened.nativeSessionRestored).toBe(true);
  expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
  expect(f.killed).toEqual([]);
  expect(await launcher.active(f.profile.id)).toBe(true);
  expect(await launcher.stop(f.profile.id)).toBe(true);
});

test("a Firefox that does not start or answer says so instead of a bare preflight failure", async () => {
  for (const [error, failure] of [
    [new FirefoxOwnerError("runtime_unavailable", "Firefox owner failed before ready"), "process_spawn"],
    [new FirefoxOwnerError("timeout", "Firefox owner readiness timed out"), "cdp_readiness"],
  ] as const) {
    const f = fixture();
    const launcher = new Launcher({ ...f.options, firefoxRuntime: { ...f.options.firefoxRuntime!, start: async () => { throw error; } } });
    const rejected = await launcher.start(f.profile.id).catch((caught) => caught);
    expect(rejected).toBeInstanceOf(BrowserLaunchError);
    expect(rejected).toMatchObject({ failure, message: `browser_launch/${failure} (failed)` });
    expect(f.store.getLaunch(f.profile.id)).toBeNull();
  }
});

test("a refused Firefox start names its reason", async () => {
  const f = fixture();
  // The profile changes after the browser started (another writer, not this launch).
  const changing = new Launcher({ ...f.options, firefoxRuntime: { ...f.options.firefoxRuntime!, start: async (args, hooks) => {
    const ready = await f.options.firefoxRuntime!.start(args, hooks);
    f.store.upsertProfile({ ...f.store.getProfile(f.profile.id)!, name: "Renamed" });
    return ready;
  } } });
  const changed = await changing.start(f.profile.id).catch((caught) => caught);
  expect(changed).toMatchObject({ failure: "preflight", preflightReason: "profile_changed" });
  expect(changed.guidance).toContain("changed while it was opening");
  expect(f.store.getLaunch(f.profile.id)).toBeNull();

  const g = fixture();
  g.store.upsertProfile({ ...g.profile, cookies: [{ name: "a", value: "b", domain: ".x.com", path: "/" }] });
  const broken = new Launcher({ ...g.options, ensureCookies: async () => { throw new Error("internal failure"); } });
  const unexpected = await broken.start(g.profile.id).catch((caught) => caught);
  expect(unexpected).toMatchObject({ failure: "preflight", preflightReason: "unexpected" });
  expect(unexpected.guidance).toContain("rejected before launch");
});

test("Firefox enables native tab restore with session cookies in the owned profile before spawn", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), "opaque native session");
  writeFileSync(
    join(root, "user.js"),
    'user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.sessionstore.privacy_level", 2);\nuser_pref("browser.startup.page", 1);\n',
  );
  f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies: [], origins: [], tabs: ["https://old.example/"] }));
  const opened = await f.launcher.start(f.profile.id);
  expect(f.startupPreferences()).toBe(
    'user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.sessionstore.privacy_level", 0);\nuser_pref("browser.startup.page", 3);\n',
  );
  expect(opened.nativeSessionRestored).toBe(true);
  expect(f.navigated).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

/** A literal-only mozLz4 file, as Firefox reads it. */
function mozLz4(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(12);
  header.write("mozLz40\0", 0, "latin1");
  header.writeUInt32LE(data.length, 8);
  const extra: number[] = [];
  if (data.length >= 15) {
    let rest = data.length - 15;
    for (; rest >= 255; rest -= 255) extra.push(255);
    extra.push(rest);
  }
  return Buffer.concat([header, Buffer.from([Math.min(data.length, 15) << 4, ...extra]), data]);
}

test("mozLz4 decoding follows LZ4 back-references", () => {
  const header = Buffer.alloc(12);
  header.write("mozLz40\0", 0, "latin1");
  header.writeUInt32LE(12, 8);
  expect(decodeMozLz4(Buffer.concat([header, Buffer.from([0x35, 0x61, 0x62, 0x63, 3, 0])])).toString()).toBe("abcabcabcabc");
  expect(JSON.parse(decodeMozLz4(mozLz4({ windows: [] })).toString())).toEqual({ windows: [] });
});

test("Firefox reopens without native restore when the saved session would show no web page", async () => {
  // A script that closed every page ended Firefox through its last tab. Firefox would reopen that
  // window as an empty new-tab page, the owner never became ready, and every open failed.
  const lastTabClosed = { windows: [{ _maybeDontRestoreTabs: true, tabs: [{ entries: [{ url: "about:blank" }, { url: "https://example.com/" }], index: 2 }] }] };
  const newTabOnly = { windows: [{ tabs: [{ entries: [{ url: "chrome://browser/content/blanktab.html" }], index: 1 }] }] };
  for (const [file, session] of [
    ["sessionstore.jsonlz4", lastTabClosed],
    ["sessionstore-backups/recovery.jsonlz4", newTabOnly],
  ] as const) {
    const f = fixture();
    const root = f.launcher.userDataDir(f.profile.id);
    mkdirSync(join(root, "sessionstore-backups"), { recursive: true });
    writeFileSync(join(root, file), mozLz4(session));
    writeFileSync(join(root, "aliasmode-session-tabs.json"), JSON.stringify({ generation: "previous", tabs: ["https://www.wikipedia.org/"] }));
    await f.launcher.start(f.profile.id);
    expect(f.startupPreferences()).toBe('user_pref("browser.sessionstore.privacy_level", 0);\nuser_pref("browser.startup.page", 0);\n');
    expect(f.navigated).toEqual([["https://www.wikipedia.org/"]]);
    expect(await f.launcher.stop(f.profile.id)).toBe(true);
  }
});

// Firefox keeps session cookies (no expiry) only in its session file and restores them only with startup page 3.
test("Firefox restores session cookies from the newest session file when native restore is off", async () => {
  const sessionCookie = { host: "app.example", name: "sid", value: "newest", path: "/", httponly: true, sameSite: 1, originAttributes: { userContextId: 0, partitionKey: "" } };
  const cookies = [
    sessionCookie,
    { host: ".example.org", name: "pref", value: "1", secure: true, originAttributes: {} },
    { host: "app.example", name: "work", value: "container", originAttributes: { userContextId: 2 } },
    { host: "app.example", name: "chips", value: "partitioned", originAttributes: { partitionKey: "(https,other.example)" } },
  ];
  const expected = [
    { name: "sid", value: "newest", domain: "app.example", path: "/", httpOnly: true, sameSite: "Lax" },
    { name: "pref", value: "1", domain: ".example.org", path: "/", secure: true },
  ];
  // A Mac clean quit (tab file present) and a window that ended with its last tab both turn native restore off.
  for (const [host, session] of [
    ["darwin", { windows: [{ tabs: [{ entries: [{ url: "https://app.example/" }], index: 1 }] }], cookies }],
    ["win32", { windows: [{ _maybeDontRestoreTabs: true, tabs: [{ entries: [{ url: "https://app.example/" }], index: 1 }] }], cookies }],
  ] as const) {
    const f = fixture(host, host === "darwin" ? "arm64" : "x64");
    const root = f.launcher.userDataDir(f.profile.id);
    mkdirSync(join(root, "sessionstore-backups"), { recursive: true });
    writeFileSync(join(root, "sessionstore-backups/recovery.jsonlz4"), mozLz4({ ...session, cookies: [{ ...sessionCookie, value: "older" }] }));
    utimesSync(join(root, "sessionstore-backups/recovery.jsonlz4"), new Date(1_000_000), new Date(1_000_000));
    writeFileSync(join(root, "sessionstore.jsonlz4"), mozLz4(session));
    writeFileSync(join(root, "aliasmode-session-tabs.json"), JSON.stringify({ generation: "previous", tabs: ["https://app.example/"] }));
    const steps: unknown[] = [];
    const launcher = new Launcher({
      ...f.options,
      // Cloud mode turns ensureCookies off; the native session cookies still come back.
      ensureCookies: async () => ({ injected: false }),
      addNativeSessionCookies: async (_ws, added) => { steps.push(["cookies", added]); return { injected: true }; },
      navigate: async (_ws, urls) => { steps.push(["navigate", urls]); },
    });
    const opened = await launcher.start(f.profile.id);
    expect(f.startupPreferences()).toContain('user_pref("browser.startup.page", 0);');
    expect(steps).toEqual([["cookies", expected], ["navigate", ["https://app.example/"]]]);
    expect(opened.nativeSessionLoaded).toBe(true);
    expect(await launcher.stop(f.profile.id)).toBe(true);
  }
});

test("Firefox does not claim its session loaded when its session cookies could not be added", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), mozLz4({
    windows: [{ _maybeDontRestoreTabs: true, tabs: [{ entries: [{ url: "https://app.example/" }], index: 1 }] }],
    cookies: [{ host: "app.example", name: "sid", value: "lost", originAttributes: {} }],
  }));
  const launcher = new Launcher({ ...f.options, addNativeSessionCookies: async () => { throw new Error("cookie rejected"); } });
  // A Cloud open then writes its copy, which still has these cookies.
  expect((await launcher.start(f.profile.id, [], { autoNavigate: false })).nativeSessionLoaded).toBeUndefined();
  expect(await launcher.stop(f.profile.id)).toBe(true);
});

test("Firefox leaves session cookies to Firefox or the Cloud copy when it does not turn native restore off", async () => {
  const cookies = [{ host: "app.example", name: "sid", value: "native", originAttributes: {} }];
  for (const options of [{}, { restoreLastSession: false }]) {
    const f = fixture();
    const root = f.launcher.userDataDir(f.profile.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "sessionstore.jsonlz4"), mozLz4({
      windows: [{ tabs: [{ entries: [{ url: "https://app.example/" }], index: 1 }] }], cookies,
    }));
    const ensured: unknown[] = [];
    const launcher = new Launcher({ ...f.options, addNativeSessionCookies: async (_ws, added) => { ensured.push(added); return { injected: true }; } });
    const opened = await launcher.start(f.profile.id, [], { autoNavigate: false, ...options });
    expect(ensured).toEqual([]);
    // Startup page 3 loads this device's session; the Cloud coordinator's request for its copy does not.
    expect(opened.nativeSessionLoaded).toBe(options.restoreLastSession === false ? undefined : true);
    expect(await launcher.stop(f.profile.id)).toBe(true);
  }
});

test("Firefox natively restores a saved session with a web page", async () => {
  const f = fixture();
  const root = f.launcher.userDataDir(f.profile.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sessionstore.jsonlz4"), mozLz4({
    windows: [{ tabs: [{ entries: [{ url: "about:blank" }, { url: "https://example.com/" }], index: 2 }] }],
  }));
  const opened = await f.launcher.start(f.profile.id);
  expect(f.startupPreferences()).toBe('user_pref("browser.sessionstore.privacy_level", 0);\nuser_pref("browser.startup.page", 3);\n');
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
  expect(f.startupPreferences()).toBe(
    'user_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.sessionstore.privacy_level", 0);\nuser_pref("browser.startup.page", 0);\n',
  );
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
  expect(f.startupPreferences()).toBe('user_pref("browser.sessionstore.privacy_level", 0);\nuser_pref("browser.startup.page", 0);\n');
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
  // The post-stop cache delete runs on after stop() returns. Firefox's own startupCache stays, and
  // so does its site cache (cache2) under the 35 MB cap.
  await (f.launcher as any).cacheClears.get(f.profile.id);
  expect(existsSync(join(root, "shader-cache"))).toBe(false);
  for (const file of ["cache2/state", "startupCache/state", "storage/default/state", "cookies.sqlite", "prefs.js", "parent.lock", "sessionstore.jsonlz4"]) {
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

function macosPersona(f: ReturnType<typeof fixture>): Profile {
  const profile = {
    ...f.profile, platformOs: "macos",
    firefox: { ...f.profile.firefox!, config: { ...f.profile.firefox!.config, "navigator.platform": "MacIntel" } },
  };
  f.store.upsertProfile(profile);
  return f.store.getProfile(profile.id)!;
}

test("a Cloud Firefox launch on Windows and Linux keeps the browser after its last window; Local and macOS do not ask", async () => {
  for (const [platform, arch, keep, expected] of [
    ["win32", "x64", true, true], ["linux", "x64", true, true], ["darwin", "arm64", true, false], ["win32", "x64", false, false],
  ] as const) {
    const f = fixture(platform, arch);
    await f.launcher.start(f.profile.id, [], { keepAliveWithoutWindows: keep });
    expect((f.prefs() as Record<string, unknown>)["aliasmode.keepAliveWithoutWindows"] === true).toBe(expected);
    await f.launcher.stop(f.profile.id);
  }
});

test("a Firefox profile of this computer's own OS opens without a font pack", async () => {
  const f = fixture("win32", "x64");
  await f.launcher.start(f.profile.id);
  expect(f.fontPacks).toEqual([]);
  expect(f.config()).not.toHaveProperty("aliasmode:fontsDir");
  expect(f.prefs()).toEqual(firefoxStartupPrefs(f.profile, "win32", "x64"));
});

test("a Firefox profile of another OS opens with that OS's font pack", async () => {
  const f = fixture("win32", "x64");
  const profile = macosPersona(f);
  await f.launcher.start(profile.id);
  expect(f.fontPacks).toEqual([FIREFOX_FONT_PACKS.macos]);
  const fontsDir = join(f.options.chromiumRuntimeRoot!, "firefox-fonts", "macos", "fonts");
  expect(f.config()).toEqual(firefoxLaunchConfig(profile, LABEL, fontsDir));
  expect(f.config()).toMatchObject({ "aliasmode:fontsDir": fontsDir });
  expect(f.prefs()).toEqual({ ...firefoxStartupPrefs(profile, "win32", "x64"), ...firefoxFontPackPrefs(fontsDir, "win32") });
  // The profile gets the stock fonts of macOS, not the ones of this Windows computer.
  expect(f.prefs()).toMatchObject({ "font.name-list.emoji": "Apple Color Emoji", "font.name-list.serif.x-western": "Times, Times New Roman" });
  // The saved identity never stores the folder of this computer.
  expect(f.store.getProfile(profile.id)!.firefox!.config).not.toHaveProperty("aliasmode:fontsDir");
});

test("a Firefox launch has WebGPU where stock Firefox has it, with this computer's adapter only for a macOS profile on an Apple Silicon Mac", async () => {
  for (const [platform, arch, persona, enabled, blocked] of [
    ["darwin", "arm64", "macos", true, false], ["win32", "x64", "macos", false, true], ["darwin", "arm64", "windows", true, true],
  ] as const) {
    const f = fixture(platform, arch);
    const profile = persona === "macos" ? macosPersona(f) : f.profile;
    await f.launcher.start(profile.id);
    expect(f.prefs()).toMatchObject(firefoxStartupPrefs(profile, platform, arch));
    expect(f.prefs()).toMatchObject({ "dom.webgpu.enabled": enabled });
    expect(Object.hasOwn(f.prefs() as object, "gfx.blacklist.webgpu")).toBe(blocked);
  }
});

test("a Firefox profile of another OS does not open when its font pack cannot be installed", async () => {
  const f = fixture("darwin", "arm64");
  f.failFontPacks(new Error("network is unreachable"));
  const error = await f.launcher.start(f.profile.id).catch((caught) => caught);
  expect(error).toEqual(new BrowserLaunchError("preflight", "firefox_fonts_download"));
  expect((error as BrowserLaunchError).guidance).toContain("could not be downloaded");
  expect(f.fontPacks).toEqual([FIREFOX_FONT_PACKS.windows]);
  expect(f.launches()).toBe(0);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();

  f.failFontPacks(undefined);
  await f.launcher.start(f.profile.id);
  expect(f.launches()).toBe(1);
});

test("Firefox font packs are fetched in the background once per needed OS", async () => {
  const f = fixture("win32", "x64");
  const mac = macosPersona(f);
  const linux = { ...mac, id: "firefox-linux", platformOs: "linux" };
  const chromium = { ...mac, id: "chromium-mac", engine: "chromium" as const, firefox: undefined };
  f.failFontPacks(new Error("offline"));
  f.launcher.prefetchFirefoxFontPacks([f.profile, mac, { ...mac, id: "firefox-mac-2" }, linux, chromium]);
  await Bun.sleep(0);
  expect(f.fontPacks.map((pack) => pack.os)).toEqual(["macos", "linux"]);
  // A failed background download is not repeated in the background; opening the profile retries it.
  f.launcher.prefetchFirefoxFontPacks([mac]);
  expect(f.fontPacks).toHaveLength(2);
  f.failFontPacks(undefined);
  await f.launcher.start(mac.id);
  expect(f.fontPacks.map((pack) => pack.os)).toEqual(["macos", "linux", "macos"]);
  f.launcher.prefetchFirefoxFontPacks([mac]);
  expect(f.fontPacks).toHaveLength(4);
});

test("the first background fetch removes font packs that are no longer pinned", () => {
  const f = fixture("win32", "x64");
  const packs = join(f.options.chromiumRuntimeRoot!, "firefox-fonts");
  mkdirSync(join(packs, "macos-0000000000000000", "fonts"), { recursive: true });
  f.launcher.prefetchFirefoxFontPacks([]);
  expect(existsSync(join(packs, "macos-0000000000000000"))).toBe(false);
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CloudApiError } from "./cloud-client.ts";
import { CloudBrowserCoordinator, watchBrowserStorage } from "./cloud-browser.ts";
import type { OpenProfileResponse, PortableProfileV1 } from "./contracts/cloud-v1.ts";
import type { Profile } from "./types.ts";
import { BrowserLaunchError, Launcher as ProductionLauncher } from "./launcher.ts";
import { PendingSyncQueue } from "./pending-sync.ts";
import { PlaywrightWorkerError } from "./playwright-runtime.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { completeProfileFingerprint } from "./firefox-config.ts";
import { keepUnreadableOrigins, sessionBundleSignature, SessionRestoreError } from "./session.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

function payload(): PortableProfileV1 {
  return {
    schemaVersion: 1,
    profile: {
      id: "profile1",
      accId: "",
      name: "Profile",
      group: "",
      platform: "x.com",
      username: "user",
      password: "credential-secret-value",
      email: "",
      emailPassword: "",
      twofa: "",
      proxy: null,
      extensionAssignments: [],
      tags: [],
      ua: "ua",
      timezone: "UTC",
      screenWidth: 1920,
      screenHeight: 1080,
      fingerprintSeed: 1,
    },
    session: {
      cookies: [{ name: "auth_token", value: "session-secret-value", domain: ".x.com", path: "/" }],
    },
  };
}

function instagramSession(marker: string): PortableProfileV1["session"] {
  return {
    cookies: [{
      name: "sessionid",
      value: `fake-instagram-${marker}`,
      domain: ".instagram.com",
      path: "/",
    }],
    origins: [{
      origin: "https://www.instagram.com",
      localStorage: [{ name: "fake-auth-state", value: marker }],
    }],
    tabs: ["https://www.instagram.com/"],
  };
}

function setup(options: {
  stopResult?: boolean;
  activeResult?: boolean;
  hasPageTargets?: boolean;
  closeConflict?: boolean;
  closeTransportFailure?: boolean;
  navigateFailure?: boolean;
  restoreFailure?: unknown;
  startRetainedFailure?: boolean;
  startError?: unknown;
  verifyWebSockets?: string[];
  expectedHeadless?: boolean;
  nativeSessionAvailable?: boolean;
  nativeTabsRestored?: boolean;
  platform?: string;
  proxy?: PortableProfileV1["profile"]["proxy"];
  session?: PortableProfileV1["session"];
  accountId?: () => string;
  heartbeatMs?: number;
  storageCheckpoints?: boolean;
  checkpointDebounceMs?: number;
  checkpointMinIntervalMs?: number;
  cloudCheckpointIntervalMs?: number;
  cloudCheckpointSoonMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  watchPaths?: string[];
  watchPath?: (path: string, dirty: () => void) => { close(): void };
} = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const navigatedUrls: string[][] = [];
  const nativeNavigations: Array<{ urls: string[]; replacePages?: boolean }> = [];
  const navigateEndpoints: string[] = [];
  const restoreEndpoints: string[] = [];
  const captureSeeds: any[] = [];
  const startOptionsSeen: any[] = [];
  let cloudSessionSignature: string | null = null;
  const store = new ProfileStore(":memory:");
  const queuePath = join(mkdtempSync(join(tmpdir(), "aliasmode-cloud-browser-")), "pending.sqlite");
  const queue = new PendingSyncQueue(queuePath, new Uint8Array(32).fill(5));
  let closeCalls = 0;
  let abandonCalls = 0;
  let getProfileCalls = 0;
  let startCalls = 0;
  let startedProxy: unknown;
  let verifyCalls = 0;
  let reconcileHook: (() => void | Promise<void>) | undefined;
  let abandonHook: (() => void | Promise<void>) | undefined;
  let retainedStartFailure: unknown;
  const openedPayload = payload();
  openedPayload.profile.platform = options.platform ?? openedPayload.profile.platform;
  openedPayload.profile.proxy = options.proxy ?? null;
  if (options.session) openedPayload.session = options.session;
  const opened: OpenProfileResponse = {
    ok: true,
    registrationId: "registration1",
    baseVersion: 4,
    payload: openedPayload,
    activeOpens: [],
  };
  const imports: Array<{ destination: string; profiles: PortableProfileV1[] }> = [];
  const cloud = {
    async listProfiles() {
      events.push("cloud-list");
      return {
        ok: true as const,
        profiles: [{
          id: "profile1",
          name: "Profile",
          group: "",
          platform: "x.com",
          tags: [],
          version: 4,
          trashedAt: null,
          trashedBy: null,
          updatedAt: 1,
          activeOpens: [],
          permission: "edit" as const,
        }],
      };
    },
    // Serves the roster's background proxy-cache backfill. Deliberately not
    // recorded in `events`: the backfill is fire-and-forget, so its timing
    // must not disturb the exact lifecycle-event assertions.
    async getProfile(profileId: string) {
      getProfileCalls++;
      return {
        ok: true as const,
        profile: {
          id: profileId,
          name: "Profile",
          group: "",
          platform: "x.com",
          tags: [],
          version: 4,
          trashedAt: null,
          trashedBy: null,
          updatedAt: 1,
          activeOpens: [],
          permission: "edit" as const,
        },
        payload: openedPayload,
        payloadDigest: "digest",
      };
    },
    async createProfile(request: { payload: PortableProfileV1 }) {
      events.push("cloud-create");
      expect(request.payload.profile.id).toBe("profile1");
      return {
        ok: true as const,
        profile: { id: request.payload.profile.id },
        payloadDigest: "digest",
      };
    },
    async importProfiles(request: { destination: string; profiles: PortableProfileV1[] }) {
      events.push("cloud-import");
      imports.push(structuredClone(request));
      return {
        ok: true as const,
        imported: request.profiles.length,
        ids: request.profiles.map((item) => item.profile.id),
      };
    },
    async openProfile() {
      events.push("cloud-open");
      return opened;
    },
    async heartbeat() {
      events.push("heartbeat");
      return { ok: true as const, revoked: false as const, activeOpens: [] };
    },
    async closeOpen() {
      closeCalls++;
      events.push("cloud-close");
      if (options.closeTransportFailure) throw new Error("offline");
      return options.closeConflict
        ? {
            ok: false as const,
            error: { code: "version_conflict" as const, message: "stale", currentVersion: 5 },
          }
        : { ok: true as const, status: "accepted" as const, version: 5 };
    },
    async abandon() {
      abandonCalls++;
      events.push("abandon");
      await abandonHook?.();
      return { ok: true as const, status: "abandoned" as const };
    },
  };
  const launcher = {
    matchesCloudSession(_profileId: string, signature: string) {
      return cloudSessionSignature === signature;
    },
    recordCloudSession(_profileId: string, signature: string | null) {
      cloudSessionSignature = signature;
    },
    failedStartGeneration(error: unknown) {
      return error === retainedStartFailure
        ? { debugPort: 9222, startedAt: 1000 }
        : undefined;
    },
    async start(profileId: string, args: string[], startOptions: any) {
      startCalls++;
      events.push("start");
      startedProxy = store.getProfile(profileId)?.proxy;
      expect(args).toEqual(["--window-size=1200,800"]);
      startOptionsSeen.push(startOptions);
      expect(startOptions).toMatchObject({
        autoNavigate: false,
        restoreLocalSession: false,
        sessionBaseVersion: -1,
        keepAliveWithoutWindows: true,
      });
      expect(startOptions.headless).toBe(options.expectedHeadless);
      expect(queue.getOpen(profileId, "account1")?.phase).toBe("opening");
      if (options.startError) throw options.startError;
      store.recordLaunch({
        profileId,
        pid: 10,
        debugPort: 9222,
        ws: "ws://browser",
        startedAt: 1000,
        sessionBaseVersion: startOptions.sessionBaseVersion,
      });
      if (options.startRetainedFailure && startCalls === 1) {
        retainedStartFailure = new Error("stale browser retained");
        throw retainedStartFailure;
      }
      return {
        ws: "ws://browser", port: 9222,
        nativeSessionRestored: !!startOptions.restoreLastSession && !!options.nativeSessionAvailable &&
          options.nativeTabsRestored !== false,
        nativeSessionLoaded: !!startOptions.restoreLastSession && !!options.nativeSessionAvailable,
      };
    },
    async navigate(_ws: string, urls: string[], replacePages?: boolean) {
      events.push("navigate");
      nativeNavigations.push({ urls: [...urls], ...(replacePages === undefined ? {} : { replacePages }) });
    },
    async stop(profileId: string) {
      events.push("stop");
      if (options.stopResult === false) return false;
      store.clearLaunch(profileId);
      return true;
    },
    async hasPageTargets() { return options.hasPageTargets ?? true; },
    async reconcileOrphan(profileId: string, expected: { debugPort: number; startedAt: number }) {
      events.push("reconcile");
      await reconcileHook?.();
      const launch = store.getLaunch(profileId);
      if (!launch) return "dead" as const;
      return launch.debugPort === expected.debugPort && launch.startedAt === expected.startedAt
        ? "alive" as const
        : "generation_changed" as const;
    },
    browserStorageWatchPaths() { return options.watchPaths ?? []; },
    async active() { return options.activeResult ?? true; },
    async verifyRunningIdentity(profileId: string) {
      verifyCalls++;
      const ws = options.verifyWebSockets?.[verifyCalls - 1];
      const launch = store.getLaunch(profileId);
      if (ws && launch) store.recordLaunch({ ...launch, ws });
    },
  };
  const coordinator = new CloudBrowserCoordinator({
    cloud: cloud as any,
    launcher: launcher as any,
    store,
    queue: () => queue,
    accountId: options.accountId ?? (() => "account1"),
    deviceId: () => "device1",
    heartbeatMs: options.heartbeatMs ?? 0,
    storageCheckpoints: options.storageCheckpoints ?? false,
    checkpointDebounceMs: options.checkpointDebounceMs,
    checkpointMinIntervalMs: options.checkpointMinIntervalMs,
    cloudCheckpointIntervalMs: options.cloudCheckpointIntervalMs,
    cloudCheckpointSoonMs: options.cloudCheckpointSoonMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    watchPath: options.watchPath,
    log(message) {
      logs.push(message);
    },
    async readSession(endpoint: string, captureSeed: unknown) {
      expect(endpoint).toBe("ws://browser");
      captureSeeds.push(captureSeed);
      events.push("capture");
      return JSON.stringify({ ...payload().session, origins: [] });
    },
    async applySession(endpoint: string, _bundle: string, urls: readonly string[]) {
      const expectedEndpoint = options.verifyWebSockets?.[0] ?? "ws://browser";
      expect(endpoint).toBe(expectedEndpoint);
      restoreEndpoints.push(endpoint);
      events.push("restore");
      navigatedUrls.push([...urls]);
      navigateEndpoints.push(endpoint);
      if (options.navigateFailure) throw new SessionRestoreError("navigation", "failed");
      if (options.restoreFailure) throw options.restoreFailure;
      expect(queue.getOpen("profile1", "account1")?.phase).toBe("restoring");
      expect(store.getLaunch("profile1")?.sessionBaseVersion).toBe(-1);
    },
  });
  return {
    coordinator,
    events,
    imports,
    logs,
    navigatedUrls,
    nativeNavigations,
    navigateEndpoints,
    restoreEndpoints,
    captureSeeds,
    startOptionsSeen,
    store,
    queue,
    closeCalls: () => closeCalls,
    abandonCalls: () => abandonCalls,
    getProfileCalls: () => getProfileCalls,
    startCalls: () => startCalls,
    startedProxy: () => startedProxy,
    verifyCalls: () => verifyCalls,
    setReconcileHook(hook: () => void | Promise<void>) {
      reconcileHook = hook;
    },
    setAbandonHook(hook: () => void | Promise<void>) {
      abandonHook = hook;
    },
  };
}

/** The roster reconciles closed browsers beside its Cloud fetch; wait for that too. */
async function rosterReconciled(coordinator: CloudBrowserCoordinator) {
  const roster = await coordinator.listRoster();
  await (coordinator as any).rosterReconcile;
  return roster;
}

const VALID_DESKTOP_UA ="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const TEST_BINARY = "approved test browser binary";
const TEST_BINARY_SHA256 = createHash("sha256").update(TEST_BINARY).digest("hex");

type CloudTestEngine = "chromium" | "firefox" | "chromium155";

function productionCloudPayload(engine: CloudTestEngine, profileId: string): OpenProfileResponse["payload"] {
  const base = payload();
  base.profile.id = profileId;
  base.profile.ua = VALID_DESKTOP_UA;
  if (engine === "chromium") return base;
  if (engine === "chromium155") {
    return { schemaVersion: 3, profile: { ...base.profile, chromiumRuntime: "aliasmode" }, session: base.session };
  }
  return {
    schemaVersion: 2,
    profile: {
      ...base.profile,
      engine: "firefox",
      firefox: {
        version: 1,
        runtimeVersion: "156.0.1-beta.36",
        config: { "navigator.userAgent": "Mozilla/5.0 Firefox/156.0", timezone: "UTC" },
      },
    },
    session: base.session,
  };
}

async function runProductionCloudPreflight(
  engine: CloudTestEngine,
  pin: string,
  profileId = "profile1",
  root = mkdtempSync(join(tmpdir(), "aliasmode-cloud-production-launch-")),
): Promise<{ result: Awaited<ReturnType<CloudBrowserCoordinator["open"]>>; status: number; boundaryCalls: number; cleanup(removeRoot?: boolean): void }> {
  const binary = join(root, "approved-browser");
  writeFileSync(binary, TEST_BINARY);
  const store = new ProfileStore(":memory:");
  const queue = new PendingSyncQueue(join(root, "pending.sqlite"), new Uint8Array(32).fill(9));
  const opened: OpenProfileResponse = {
    ok: true, registrationId: "registration1", baseVersion: 1,
    payload: productionCloudPayload(engine, profileId), activeOpens: [],
  };
  let boundaryCalls = 0;
  const failAtNativeBoundary = () => {
    boundaryCalls++;
    throw new BrowserLaunchError("process_spawn");
  };
  const launcher = new ProductionLauncher({
    store,
    binaryPath: binary,
    firefoxBinaryPath: binary,
    expectedBinarySha256: engine === "chromium" ? pin : TEST_BINARY_SHA256,
    expectedFirefoxBinarySha256: engine === "firefox" ? pin : TEST_BINARY_SHA256,
    dataRoot: join(root, "profiles"),
    // Linux on ARM has no Chromium 155 build, so that payload must stop at the host preflight.
    hostPlatform: engine === "chromium155" ? "linux" : "darwin",
    hostArch: "arm64",
    spawn: failAtNativeBoundary,
    // A Windows persona on this macOS host reads the Windows font pack; no download here.
    ensureFirefoxFontPack: async (packRoot, pack) => join(packRoot, pack.os),
    firefoxRuntime: {
      reserve: async () => failAtNativeBoundary(),
      start: async () => { throw new Error("Firefox owner start should not run"); },
      call: async () => { throw new Error("Firefox owner call should not run"); },
      close: async () => {},
    },
    findProfileDirHolderPids: async () => [],
  });
  const coordinator = new CloudBrowserCoordinator({
    cloud: {
      async openProfile() { return opened; },
      async heartbeat() { return { ok: true as const, revoked: false as const, activeOpens: [] }; },
      async abandon() { return { ok: true as const, status: "abandoned" as const }; },
      async closeOpen() { return { ok: true as const, status: "accepted" as const, version: 2 }; },
    } as any,
    launcher,
    store,
    queue: () => queue,
    accountId: () => "account1",
    deviceId: () => "device1",
    heartbeatMs: 0,
    storageCheckpoints: false,
    readSession: async () => JSON.stringify({ cookies: [] }),
    applySession: async () => {},
  });
  const response = await handleUiRequest(
    new Request(`http://x/ui/api/profiles/${profileId}/open`, { method: "POST" }),
    launcher,
    store,
    null,
    { cloudBrowser: coordinator },
  );
  if (!response) throw new Error("dashboard Cloud open route did not respond");
  const result = await response.json() as Awaited<ReturnType<CloudBrowserCoordinator["open"]>>;
  return {
    result,
    status: response.status,
    boundaryCalls,
    cleanup(removeRoot = true) {
      queue.close();
      store.close();
      if (removeRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}

test("dashboard Cloud preflight distinguishes missing engine pins before native boundaries", async () => {
  for (const [engine, reason] of [
    ["chromium", "chromium_setup"],
    ["firefox", "firefox_setup"],
  ] as const) {
    const missing = await runProductionCloudPreflight(engine, "");
    try {
      expect(missing.status).toBe(500);
      expect(missing.result.ok).toBe(false);
      expect(missing.result.error).toContain("browser_launch/preflight");
      const guidance = new BrowserLaunchError("preflight", reason).guidance;
      expect(missing.result.error).toContain(guidance!);
      expect(missing.boundaryCalls).toBe(0);
    } finally {
      missing.cleanup();
    }

    const approved = await runProductionCloudPreflight(engine, TEST_BINARY_SHA256);
    try {
      expect(approved.status).toBe(500);
      expect(approved.result).toMatchObject({ ok: false, error: expect.stringContaining("browser_launch/process_spawn") });
      expect(approved.boundaryCalls).toBe(engine === "chromium" ? 2 : 1);
    } finally {
      approved.cleanup();
    }
  }
}, 30_000);

test("Cloud opens a Chromium 155 beta payload on the beta runtime, never CloakBrowser", async () => {
  // The Linux ARM host proves routing: CloakBrowser would reach the spawn boundary,
  // while the beta runtime stops at its host preflight.
  const beta = await runProductionCloudPreflight("chromium155", TEST_BINARY_SHA256);
  try {
    expect(beta.status).toBe(500);
    expect(beta.result.error).toContain(new BrowserLaunchError("preflight", "chromium155_host").guidance!);
    expect(beta.boundaryCalls).toBe(0);
  } finally {
    beta.cleanup();
  }
});

test("legacy Chromium and native Firefox Cloud profiles preflight independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloud-two-engine-"));
  try {
    const legacyChromium = await runProductionCloudPreflight(
      "chromium", TEST_BINARY_SHA256, "legacy-chromium", root,
    );
    try {
      expect(legacyChromium.status).toBe(500);
      expect(legacyChromium.result).toMatchObject({ error: expect.stringContaining("browser_launch/process_spawn") });
      expect(legacyChromium.boundaryCalls).toBe(2);
    } finally {
      legacyChromium.cleanup(false);
    }
    const nativeFirefox = await runProductionCloudPreflight(
      "firefox", TEST_BINARY_SHA256, "native-firefox", root,
    );
    try {
      expect(nativeFirefox.status).toBe(500);
      expect(nativeFirefox.result).toMatchObject({ error: expect.stringContaining("browser_launch/process_spawn") });
      expect(nativeFirefox.boundaryCalls).toBe(1);
    } finally {
      nativeFirefox.cleanup(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Firefox Cloud checkpoints preserve V2 through offline close", async () => {
  const state = setup({ closeTransportFailure: true });
  const options = (state.coordinator as any).options;
  const legacy = payload();
  const firefoxPayload = {
    ...legacy,
    schemaVersion: 2,
    profile: {
      ...legacy.profile,
      engine: "firefox",
      firefox: { version: 1, runtimeVersion: "156.0.1-beta.36", config: { timezone: "UTC" } },
    },
  };
  options.cloud.openProfile = async () => ({
    ok: true, registrationId: "registration1", baseVersion: 4,
    payload: firefoxPayload, activeOpens: [],
  });
  const start = options.launcher.start;
  const endpoint = "firefox://127.0.0.1:9222/generation";
  options.launcher.start = async (...args: unknown[]) => {
    const result = await start(...args);
    state.store.recordLaunch({ ...state.store.getLaunch("profile1")!, engine: "firefox", ws: endpoint });
    return { ...result, ws: endpoint };
  };
  options.applySession = async (ws: string) => { expect(ws).toBe(endpoint); };
  const session = { ...legacy.session, tabs: ["https://x.com/messages"], origins: [] };
  options.readSession = async (ws: string) => { expect(ws).toBe(endpoint); return JSON.stringify(session); };
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    const roster = await state.coordinator.listRoster();
    expect(roster.profiles[0]?.engine).toBe("firefox");
    expect(roster.profiles[0]).not.toHaveProperty("debugPort");
    const migrated = state.store.getProfile("profile1")!;
    expect(migrated.locale).toBe("en-US");
    expect(migrated.firefox!.config.fonts).toBeArray();
    const openingCheckpoint = state.queue.get(state.queue.list("account1")[0]!.id, "account1")!;
    expect(openingCheckpoint.payload.profile).toEqual(encodePortableProfile(migrated).profile);
    expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });
    const pending = state.queue.get(state.queue.list("account1")[0]!.id, "account1")!;
    expect(pending.readyToSubmit).toBe(true);
    expect(pending.payload.schemaVersion).toBe(2);
    expect(pending.payload.profile).toEqual(encodePortableProfile(migrated).profile);
    expect(pending.payload.session).toEqual(session);
  } finally {
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud browser creates a portable profile without a local-only fallback", async () => {
  const state = setup();
  const prefetched: string[][] = [];
  (state.coordinator as any).options.launcher.prefetchBrowserRuntimes = (profiles: Profile[]) => {
    prefetched.push(profiles.map((profile) => profile.id));
  };
  const profile = decodePortableProfile(payload()).profile;
  expect(await state.coordinator.create(profile)).toEqual({ id: "profile1" });
  expect(state.events).toEqual(["cloud-create"]);
  expect(state.store.getProfile("profile1")).toBeNull();
  // The browser download starts at creation, not at the first open.
  expect(prefetched).toEqual([["profile1"]]);
  state.queue.close();
  state.store.close();
});
test("Cloud browser imports one encoded batch without populating the Local store", async () => {
  const state = setup();
  const prefetched: string[][] = [];
  (state.coordinator as any).options.launcher.prefetchBrowserRuntimes = (profiles: Profile[]) => {
    prefetched.push(profiles.map((profile) => profile.id));
  };
  const first = decodePortableProfile(payload()).profile;
  first.group = "Sales";
  const second = structuredClone(first);
  second.id = "profile2";
  second.name = "Second";

  const sessionBundle = JSON.stringify({
    cookies: first.cookies,
    origins: [{ origin: "https://x.com", localStorage: [{ name: "device", value: "portable-device" }] }],
    tabs: ["https://x.com/messages"],
  });
  expect(await state.coordinator.importProfiles("Sales", [{ ...first, sessionBundle }, second])).toEqual({
    ok: true,
    imported: 2,
    ids: ["profile1", "profile2"],
  });
  expect(state.events).toEqual(["cloud-import"]);
  expect(state.imports).toHaveLength(1);
  expect(prefetched).toEqual([["profile1", "profile2"]]);
  expect(state.imports[0]!.destination).toBe("Sales");
  expect(JSON.parse(decodePortableProfile(state.imports[0]!.profiles[0]!).sessionBundle)).toMatchObject(JSON.parse(sessionBundle));
  expect(state.imports[0]!.profiles.map((item) => decodePortableProfile(item).profile)).toEqual([first, second].map(completeProfileFingerprint));
  expect(state.store.getProfile("profile1")).toBeNull();
  expect(state.store.getProfile("profile2")).toBeNull();
  state.queue.close();
  state.store.close();
});


test("Cloud browser forwards the typed headless launch option", async () => {
  const state = setup({ expectedHeadless: true });

  expect((await state.coordinator.open(
    "profile1",
    ["--window-size=1200,800"],
    { headless: true },
  )).ok).toBe(true);

  state.queue.close();
  state.store.close();
});

test("Cloud browser passes the authenticated proxy to Launcher without exposing it", async () => {
  const proxy = {
    type: "socks5" as const,
    host: "proxy-secret-host.invalid",
    port: "1080",
    user: "proxy-secret-user",
    pass: "proxy-secret-pass",
  };
  const state = setup({ proxy });

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.startedProxy()).toEqual(proxy);
  expect(state.restoreEndpoints).toEqual(["ws://browser"]);
  const publicState = JSON.stringify({ logs: state.logs, diagnostics: state.coordinator.diagnostics() });
  for (const secret of [proxy.host, proxy.user, proxy.pass]) expect(publicState).not.toContain(secret);

  state.queue.close();
  state.store.close();
});


for (const stalledStage of ["opening", "restoring"] as const) {
  test(`Cloud renews its lease during slow ${stalledStage}`, async () => {
    const timers = new Set<() => void>();
    const state = setup({
      heartbeatMs: 60_000,
      setIntervalFn(fn) { timers.add(fn); return fn; },
      clearIntervalFn(handle) { timers.delete(handle as () => void); },
    });
    const options = (state.coordinator as any).options;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let now = 0;
    let lastHeartbeat = 0;
    let renewals = 0;
    options.cloud.heartbeat = async () => {
      if (now - lastHeartbeat >= 120_000) throw new CloudApiError("expired", "version_conflict", 409);
      lastHeartbeat = now;
      renewals++;
      return { ok: true, revoked: false, activeOpens: [] };
    };
    const owner = stalledStage === "opening" ? options.launcher : options;
    const method = stalledStage === "opening" ? "start" : "applySession";
    const original = owner[method];
    owner[method] = async (...args: unknown[]) => {
      entered();
      await gate;
      return original(...args);
    };
    const opening = state.coordinator.open("profile1", ["--window-size=1200,800"]);
    try {
      await ready;
      expect(state.queue.getOpen("profile1", "account1")?.phase).toBe(stalledStage);
      for (now = 60_000; now <= 180_000; now += 60_000) {
        for (const tick of timers) tick();
        await Bun.sleep(0);
      }
      expect(renewals).toBe(3);
      expect(state.events).not.toContain("capture");
      expect(state.events).not.toContain("stop");
      release();
      expect((await opening).ok).toBe(true);
      expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
    } finally {
      release();
      await opening;
      await state.coordinator.releaseAll(true);
      state.queue.close();
      state.store.close();
    }
  });

  test(`Cloud does not report a successful open after access ends during ${stalledStage}`, async () => {
    const state = setup({ heartbeatMs: 60_000, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
    const options = (state.coordinator as any).options;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const owner = stalledStage === "opening" ? options.launcher : options;
    const method = stalledStage === "opening" ? "start" : "applySession";
    const original = owner[method];
    owner[method] = async (...args: unknown[]) => {
      entered();
      await gate;
      return original(...args);
    };
    options.cloud.heartbeat = async () => { throw new CloudApiError("expired", "version_conflict", 409); };
    const opening = state.coordinator.open("profile1", ["--window-size=1200,800"]);
    let heartbeat: Promise<void> | undefined;
    try {
      await ready;
      heartbeat = state.coordinator.heartbeatOnce("profile1");
      await Bun.sleep(0);
      expect(state.events).not.toContain("stop");
      release();
      expect((await opening).ok).toBe(false);
      await heartbeat;
      expect(state.coordinator.diagnostics().some((event) => event.type === "open_running")).toBe(false);
      expect(state.store.getLaunch("profile1")).toBeNull();
      expect(state.queue.getOpen("profile1", "account1")).toBeNull();
      expect(state.closeCalls()).toBe(0);
      expect(state.abandonCalls()).toBe(1);
      expect((state.coordinator as any).timers.size).toBe(0);
    } finally {
      release();
      await opening;
      await heartbeat;
      await state.coordinator.releaseAll(true);
      state.queue.close();
      state.store.close();
    }
  });
}

test("Cloud waits for an in-flight startup renewal before reporting success", async () => {
  const state = setup({ heartbeatMs: 60_000, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
  const options = (state.coordinator as any).options;
  let rejectRenewal!: (error: Error) => void;
  let heartbeat: Promise<void> | undefined;
  options.cloud.heartbeat = () => new Promise((_resolve, reject) => { rejectRenewal = reject; });
  options.applySession = async () => {
    heartbeat = state.coordinator.heartbeatOnce("profile1");
    await Bun.sleep(0);
  };
  const opening = state.coordinator.open("profile1", ["--window-size=1200,800"]);
  let settled = false;
  void opening.then(() => { settled = true; });
  try {
    for (let i = 0; i < 50 && !rejectRenewal; i++) await Bun.sleep(1);
    expect(rejectRenewal).toBeDefined();
    await Bun.sleep(5);
    expect(settled).toBe(false);
    rejectRenewal(new CloudApiError("revoked", "device_revoked", 403));
    expect((await opening).ok).toBe(false);
    await heartbeat;
    expect(state.store.getLaunch("profile1")).toBeNull();
    expect((state.coordinator as any).startupLeases.size).toBe(0);
  } finally {
    rejectRenewal?.(new CloudApiError("revoked", "device_revoked", 403));
    await opening;
    await heartbeat;
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud open replaces a cached timezone with an explicitly cleared value", async () => {
  const state = setup();
  state.store.upsertProfile(decodePortableProfile(payload()).profile);
  const cloud = (state.coordinator as any).options.cloud;
  const openProfile = cloud.openProfile.bind(cloud);
  cloud.openProfile = async (...args: unknown[]) => {
    const opened = await openProfile(...args);
    opened.payload.profile.timezone = "";
    opened.payload.profile.platformOs = "macos";
    return opened;
  };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.store.getProfile("profile1")).toMatchObject({ timezone: "", platformOs: "macos" });
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("the first Cloud checkpoint carries the timezone the launch took from the proxy exit", async () => {
  const state = setup();
  const launcher = (state.coordinator as any).options.launcher;
  const start = launcher.start.bind(launcher);
  // The launcher saves the proxy exit's timezone before the browser starts.
  launcher.start = async (profileId: string, ...rest: unknown[]) => {
    state.store.setTimezone(profileId, "Asia/Tokyo");
    return start(profileId, ...rest);
  };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const [checkpoint] = state.queue.list("account1");
  expect(state.queue.get(checkpoint!.id, "account1")!.payload.profile.timezone).toBe("Asia/Tokyo");
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud browser restores the session and navigates in one attach", async () => {
  const state = setup();
  const result = await state.coordinator.open("profile1", [
    "--window-size=1200,800",
    "https://x.com/messages",
  ]);
  expect(result).toMatchObject({ ok: true, ws: "ws://browser", port: 9222 });
  expect(state.events).toEqual(["cloud-open", "start", "restore"]);
  expect(state.verifyCalls()).toBe(2);
  expect(state.navigatedUrls).toEqual([["https://x.com/messages"]]);
  expect(state.navigateEndpoints).toEqual(["ws://browser"]);
  expect(state.coordinator.diagnostics().map((event) => event.type)).toEqual([
    "open_started",
    "cloud_registered",
    "browser_started",
    "session_restore_started",
    "session_restore_completed",
    "open_running",
  ]);
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration1",
    expectedVersion: 4,
    phase: "running",
    debugPort: 9222,
    startedAt: 1000,
  });
  state.queue.close();
  state.store.close();
});

test("Cloud browser keeps saved tabs before explicit startup URLs", async () => {
  const session = {
    ...payload().session,
    tabs: ["https://saved.example/one", "https://saved.example/one"],
  };
  const state = setup({ session });

  expect((await state.coordinator.open("profile1", [
    "--window-size=1200,800",
    "https://explicit.example/two",
  ])).ok).toBe(true);
  // applySession prepends the bundle tabs and receives only additional URLs.
  expect(state.navigatedUrls).toEqual([["https://explicit.example/two"]]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser suppresses the platform home when the bundle has saved tabs", async () => {
  const state = setup({
    session: {
      ...payload().session,
      tabs: ["https://saved.example/account"],
    },
  });

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.navigatedUrls).toEqual([[]]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser reopens a saved session that holds a nameless cookie", async () => {
  // `document.cookie = "value"` makes a cookie with an empty name. The browser
  // reports it, the checkpoint saves it, and the next open must restore it.
  const nameless = { name: "", value: "nameless-value", domain: "site.example", path: "/" };
  const state = setup();
  const options = (state.coordinator as any).options;
  let savedPayload = payload();
  options.readSession = async () => JSON.stringify({
    ...payload().session, cookies: [...payload().session.cookies, nameless], origins: [], tabs: [],
  });
  options.cloud.closeOpen = async (_id: string, request: { payload: PortableProfileV1 }) => {
    savedPayload = structuredClone(request.payload);
    return { ok: true, status: "accepted", version: 5 };
  };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(savedPayload.session.cookies).toContainEqual(nameless);

  options.cloud.openProfile = async () => ({
    ok: true, registrationId: "registration2", baseVersion: 5, payload: savedPayload, activeOpens: [],
  });
  const restored: string[] = [];
  options.applySession = async (_ws: string, bundle: string) => { restored.push(bundle); };
  const reopened = new CloudBrowserCoordinator(options);
  expect(await reopened.open("profile1", ["--window-size=1200,800"])).toMatchObject({ ok: true });
  expect(JSON.parse(restored[0]!).cookies).toContainEqual(nameless);
  await reopened.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud browser reports a payload it cannot store as invalid_payload and logs why", async () => {
  const state = setup({
    session: { cookies: [{ name: "token", value: "session-secret-value", domain: "", path: "/" }] },
  });

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

  expect(result).toEqual({ ok: false, error: "Cloud profile open failed at payload_restore (invalid_payload)" });
  expect(state.logs).toContain(
    "profile1: Cloud open failed at payload_restore (invalid_payload, Error): profile cookie 0 requires non-empty domain and path",
  );
  expect(JSON.stringify(state.logs)).not.toContain("session-secret-value");
  expect(state.events).not.toContain("start");
  expect(state.abandonCalls()).toBe(1);
  state.queue.close();
  state.store.close();
});

test("Cloud browser keeps the platform home fallback for legacy bundles", async () => {
  const state = setup();

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.navigatedUrls).toEqual([["https://x.com/home"]]);
  state.queue.close();
  state.store.close();
});

for (const closeMethod of ["managed", "window"] as const) {
  test(`Cloud ${closeMethod} close reopens the native session without replacing its tabs`, async () => {
    const state = setup({ nativeSessionAvailable: true });
    const options = (state.coordinator as any).options;
    const tabs = ["https://duckduckgo.com/", "https://saved.example/two", "https://saved.example/two"];
    let savedPayload = payload();
    options.readSession = async () => JSON.stringify({ ...payload().session, origins: [], tabs });
    options.cloud.closeOpen = async (_id: string, request: { payload: PortableProfileV1 }) => {
      savedPayload = structuredClone(request.payload);
      return { ok: true, status: "accepted", version: 5 };
    };
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    expect(state.startOptionsSeen[0].restoreLastSession).toBe(false);
    if (closeMethod === "managed") {
      expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
      expect(savedPayload.session.tabs).toEqual(tabs);
    } else {
      // Browser X happens before any heartbeat capture. Chromium has newer tabs
      // than this opening checkpoint, which must not replace the native session.
      state.setReconcileHook(() => state.store.clearLaunch("profile1"));
      await rosterReconciled(state.coordinator);
      expect(state.events).not.toContain("capture");
      expect(savedPayload.session.tabs).toBeUndefined();
      state.setReconcileHook(() => {});
    }
    options.cloud.openProfile = async () => ({
      ok: true, registrationId: "registration2", baseVersion: 5,
      payload: savedPayload, activeOpens: [],
    });
    // A new coordinator represents an app restart; the launcher owns the stamp.
    const reopened = new CloudBrowserCoordinator(options);
    state.restoreEndpoints.length = 0;
    state.navigatedUrls.length = 0;
    expect((await reopened.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    expect(state.startOptionsSeen.at(-1)).toMatchObject({ restoreLastSession: true, resetStorage: false });
    expect(state.restoreEndpoints).toEqual([]);
    expect(state.navigatedUrls).toEqual([]);
    await reopened.close("profile1");
    state.queue.close();
    state.store.close();
  });
}

for (const reason of ["missing files", "newer Cloud session", "newer Cloud session and a start URL"] as const) {
  test(`Cloud native restore falls back to portable state for ${reason}`, async () => {
    const state = setup({ nativeSessionAvailable: reason !== "missing files" });
    const options = (state.coordinator as any).options;
    const original = payload();
    options.launcher.recordCloudSession("profile1", sessionBundleSignature(JSON.stringify(original.session)));
    const authoritative = structuredClone(original);
    if (reason !== "missing files") {
      authoritative.session.tabs = ["https://new.example/", "https://new.example/"];
      options.cloud.openProfile = async () => ({
        ok: true, registrationId: "registration1", baseVersion: 6,
        payload: authoritative, activeOpens: [],
      });
    }
    let restored: unknown;
    let restoredUrls: readonly string[] = [];
    options.applySession = async (_endpoint: string, bundle: string, urls: readonly string[]) => {
      restored = JSON.parse(bundle);
      restoredUrls = urls;
    };
    const args = ["--window-size=1200,800"];
    if (reason === "newer Cloud session and a start URL") args.push("https://explicit.example/");
    expect((await state.coordinator.open("profile1", args)).ok).toBe(true);
    expect(state.startOptionsSeen[0].restoreLastSession).toBe(reason === "missing files");
    expect(restored).toEqual(authoritative.session);
    if (reason === "newer Cloud session and a start URL") expect(restoredUrls).toEqual(["https://explicit.example/"]);
    expect(state.nativeNavigations).toEqual([]);
    await state.coordinator.close("profile1");
    state.queue.close();
    state.store.close();
  });
}

test("Cloud native restore keeps this device's cookies when Chromium shows no restored page", async () => {
  const state = setup({ nativeSessionAvailable: true, nativeTabsRestored: false });
  const options = (state.coordinator as any).options;
  const original = payload();
  options.launcher.recordCloudSession("profile1", sessionBundleSignature(JSON.stringify(original.session)));
  let restored: unknown;
  options.applySession = async (_endpoint: string, bundle: string) => { restored = JSON.parse(bundle); };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.startOptionsSeen[0]).toMatchObject({ restoreLastSession: true, resetStorage: false });
  expect(restored).toBeUndefined();
  expect(state.nativeNavigations).toEqual([{ urls: ["https://x.com/home"], replacePages: true }]);
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud open with a start URL and no restored page opens saved tabs and the URL over this device's cookies", async () => {
  const session = { ...payload().session, tabs: ["https://x.com/messages"] };
  const state = setup({ nativeSessionAvailable: true, nativeTabsRestored: false, session });
  const options = (state.coordinator as any).options;
  options.launcher.recordCloudSession("profile1", sessionBundleSignature(JSON.stringify(session)));
  let restored: unknown;
  options.applySession = async (_endpoint: string, bundle: string) => { restored = JSON.parse(bundle); };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800", "https://explicit.example/"])).ok).toBe(true);
  expect(restored).toBeUndefined();
  expect(state.nativeNavigations).toEqual([
    { urls: ["https://x.com/messages", "https://explicit.example/"], replacePages: true },
  ]);
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

// Local API and MCP opens pass a start URL. It must not swap this device's newer session for the Cloud copy.
test("Cloud open with a start URL keeps this device's session and opens the URL beside it", async () => {
  const state = setup({ nativeSessionAvailable: true });
  const options = (state.coordinator as any).options;
  options.launcher.recordCloudSession("profile1", sessionBundleSignature(JSON.stringify(payload().session)));
  let restored: unknown;
  options.applySession = async (_endpoint: string, bundle: string) => { restored = JSON.parse(bundle); };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800", "https://explicit.example/"])).ok).toBe(true);
  expect(state.startOptionsSeen[0]).toMatchObject({ restoreLastSession: true, resetStorage: false });
  expect(restored).toBeUndefined();
  expect(state.nativeNavigations).toEqual([{ urls: ["https://explicit.example/"] }]);
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud open with a start URL reports a failed page open but keeps the session", async () => {
  const state = setup({ nativeSessionAvailable: true });
  const options = (state.coordinator as any).options;
  options.launcher.recordCloudSession("profile1", sessionBundleSignature(JSON.stringify(payload().session)));
  options.launcher.navigate = async () => { throw new Error("page did not load"); };
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800", "https://explicit.example/"]);
  expect(result.ok).toBe(true);
  expect(result.warning).toContain("startup navigation failed");
  expect(state.events).not.toContain("restore");
  // The next open must still trust this device's session.
  expect(options.launcher.matchesCloudSession("profile1", sessionBundleSignature(JSON.stringify(payload().session)))).toBe(true);
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

for (const readable of [true, false]) {
  test(`Cloud native restore ${readable ? "reuses a readable" : "skips another Windows account's"} cookie key`, async () => {
    const state = setup({ nativeSessionAvailable: true });
    const logs: string[] = [];
    const options = { ...(state.coordinator as any).options, log: (message: string) => logs.push(message) };
    options.launcher.nativeSessionReadable = async () => readable;
    const original = payload();
    options.launcher.recordCloudSession("profile1", sessionBundleSignature(JSON.stringify(original.session)));
    let restored: unknown;
    options.applySession = async (_endpoint: string, bundle: string) => { restored = JSON.parse(bundle); };
    const coordinator = new CloudBrowserCoordinator(options);
    expect((await coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    expect(state.startOptionsSeen[0].restoreLastSession).toBe(readable);
    expect(restored).toEqual(readable ? undefined : original.session);
    expect(logs.some((message) => message.includes("another Windows account"))).toBe(!readable);
    await coordinator.close("profile1");
    state.queue.close();
    state.store.close();
  });
}

test("Cloud failed portable restore cannot leave a trusted native-session stamp", async () => {
  const state = setup({ restoreFailure: new Error("restore failed") });
  const options = (state.coordinator as any).options;
  const signature = sessionBundleSignature(JSON.stringify(payload().session));
  options.launcher.recordCloudSession("profile1", signature);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(false);
  expect(options.launcher.matchesCloudSession("profile1", signature)).toBe(false);
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud marker write failures do not stop a restored browser or prevent close", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  options.launcher.recordCloudSession = (_profileId: string, signature: string | null) => {
    if (signature !== null) throw new Error("marker is locked");
  };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.events).not.toContain("stop");
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  state.queue.close();
  state.store.close();
});

test("Cloud refuses to replace disk state when its old marker cannot be invalidated", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  options.launcher.recordCloudSession = () => { throw new Error("marker is locked"); };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(false);
  expect(state.startCalls()).toBe(0);
  expect(state.restoreEndpoints).toEqual([]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser uses the endpoint from exact identity verification", async () => {
  const state = setup({
    verifyWebSockets: ["ws://verified-before-restore", "ws://verified-before-restore"],
  });

  const result = await state.coordinator.open("profile1", [
    "--window-size=1200,800",
    "https://x.com/messages",
  ]);

  expect(result).toMatchObject({
    ok: true,
    ws: "ws://verified-before-restore",
    port: 9222,
  });
  expect(state.restoreEndpoints).toEqual(["ws://verified-before-restore"]);
  expect(state.navigateEndpoints).toEqual(["ws://verified-before-restore"]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser rejects a replacement endpoint after session mutation", async () => {
  const state = setup({
    verifyWebSockets: ["ws://restored-browser", "ws://replacement-browser"],
  });

  const result = await state.coordinator.open("profile1", [
    "--window-size=1200,800",
    "https://x.com/messages",
  ]);

  expect(result).toEqual({
    ok: false,
    error: "Cloud profile open failed at session_restore (transport_error)",
  });
  expect(state.restoreEndpoints).toEqual(["ws://restored-browser"]);
  expect(state.navigateEndpoints).toEqual(["ws://restored-browser"]);
  expect(state.abandonCalls()).toBe(1);
  expect(state.store.getLaunch("profile1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud browser stops retained launch ownership and retries once", async () => {
  const state = setup({ startRetainedFailure: true });

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

  expect(result).toMatchObject({ ok: true, ws: "ws://browser", port: 9222 });
  expect(state.events).toEqual(["cloud-open", "start", "stop", "start", "restore"]);
  expect(state.abandonCalls()).toBe(0);
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
  state.queue.close();
  state.store.close();
});

test("Cloud failed-open cleanup never stops a replacement", async () => {
  const state = setup();
  const launcher = (state.coordinator as any).options.launcher;
  const failed = new Error("retained start failed");
  let stoppedGeneration: number | undefined;
  launcher.start = async (profileId: string) => {
    state.store.recordLaunch({
      profileId,
      pid: 10,
      debugPort: 9222,
      ws: "ws://failed",
      startedAt: 1000,
    });
    state.store.recordLaunch({
      profileId,
      pid: 11,
      debugPort: 9333,
      ws: "ws://replacement",
      startedAt: 2000,
    });
    throw failed;
  };
  launcher.failedStartGeneration = (error: unknown) => error === failed
    ? { debugPort: 9222, startedAt: 1000 }
    : undefined;
  launcher.stop = async (
    profileId: string,
    expected?: { debugPort: number; startedAt: number },
  ) => {
    const current = state.store.getLaunch(profileId)!;
    if (
      expected &&
      (current.debugPort !== expected.debugPort || current.startedAt !== expected.startedAt)
    ) return false;
    stoppedGeneration = current.startedAt;
    state.store.clearLaunch(profileId);
    return true;
  };

  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "Cloud profile open failed at browser_launch/preflight (failed)",
  });
  expect(stoppedGeneration).toBeUndefined();
  expect(state.store.getLaunch("profile1")).toMatchObject({
    debugPort: 9333,
    startedAt: 2000,
  });
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    phase: "restoring",
    debugPort: 9222,
    startedAt: 1000,
    cleanupMode: "abandon",
  });
  state.queue.close();
  state.store.close();
});


test("Cloud browser stays open when startup navigation fails", async () => {
  const state = setup({ navigateFailure: true });
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result).toMatchObject({
    ok: true,
    warning: "Profile opened, but startup navigation failed. Open the site manually.",
  });
  expect(state.events).toEqual(["cloud-open", "start", "restore"]);
  expect(state.logs).toContain(
    "profile1: Cloud startup navigation failed (failed); continuing",
  );
  expect(JSON.stringify({ result, logs: state.logs })).not.toContain("navigation secret");
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.store.getLaunch("profile1")?.sessionBaseVersion).toBe(4);
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud browser retains a verified launch when worker restore fails", async () => {
  const state = setup({ restoreFailure: new Error("worker failed") });
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result).toEqual({
    ok: false,
    error: "Cloud profile open failed at session_restore (transport_error); browser left open",
  });
  expect(state.events).toEqual(["cloud-open", "start", "restore"]);
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("restoring");
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.abandonCalls()).toBe(0);
  expect(state.coordinator.diagnostics().map((event) => event.type).slice(-2)).toEqual([
    "open_failed",
    "cleanup_retained",
  ]);

  state.events.length = 0;
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(state.events).toEqual(["reconcile", "stop", "abandon"]);
  expect(state.closeCalls()).toBe(0);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud close does not stop a replacement for a retained restoring browser", async () => {
  const state = setup({ restoreFailure: new Error("worker failed") });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(false);
  state.store.recordLaunch({
    profileId: "profile1",
    pid: 11,
    debugPort: 9333,
    ws: "ws://replacement",
    startedAt: 2000,
  });
  state.events.length = 0;

  expect(await state.coordinator.close("profile1")).toEqual({
    closed: false,
    reason: "teardown_unconfirmed",
  });

  expect(state.events).toEqual([]);
  expect(state.store.getLaunch("profile1")).toMatchObject({ debugPort: 9333, startedAt: 2000 });
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("restoring");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat never auto-closes a retained restoring browser", async () => {
  const state = setup({
    restoreFailure: new Error("worker failed"),
    activeResult: false,
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(false);
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["heartbeat", "reconcile"]);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("restoring");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat releases a retained restoring registration after manual browser X", async () => {
  const state = setup({ restoreFailure: new Error("worker failed") });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(false);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["heartbeat", "reconcile", "abandon"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.coordinator.diagnostics().map((event) => event.type)).toContain("manual_stop_detected");
  state.queue.close();
  state.store.close();
});

test("terminal running heartbeat stops a browser whose capture fails and parks its last checkpoint", async () => {
  const state = setup({
    heartbeatMs: 60_000,
    closeConflict: true,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  const options = (state.coordinator as any).options;
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    options.cloud.heartbeat = async () => { throw new CloudApiError("stale", "version_conflict", 409); };
    options.cloud.openProfile = async () => { throw new CloudApiError("open elsewhere", "profile_open", 409); };
    let captures = 0;
    options.readSession = async () => { captures++; throw new Error("capture failed"); };

    await state.coordinator.heartbeatOnce("profile1");

    // One retry, then the browser stops; another device's newer copy is not overwritten.
    expect(captures).toBe(2);
    expect(state.store.getLaunch("profile1")).toBeNull();
    expect((state.coordinator as any).timers.has("profile1")).toBe(false);
    expect(state.queue.getOpen("profile1", "account1")).toBeNull();
    expect(state.queue.list("account1")).toMatchObject([{ readyToSubmit: true, status: "conflict" }]);
    const parked = state.queue.get(state.queue.list("account1")[0]!.id, "account1")!;
    expect(parked.payload.session.cookies).toEqual(payload().session.cookies);
    expect(state.abandonCalls()).toBe(0);
    // The parked-session notice covers this profile, not "not saved to Cloud yet".
    const [roster] = (await rosterReconciled(state.coordinator)).profiles;
    expect(roster?.parkedSession).toBeDefined();
    expect(roster?.cloudUnsavedSince).toBeUndefined();
  } finally {
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud keeps a running browser open when its lease lapses during laptop sleep", async () => {
  const state = setup({ heartbeatMs: 60_000, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
  const cloud = (state.coordinator as any).options.cloud;
  // Cloud's rule: a heartbeat gap longer than the 120 s lease abandons the registration.
  let now = 0;
  const lastHeartbeat = new Map<string, number>([["registration1", 0]]);
  const renewed: string[] = [];
  cloud.heartbeat = async (registrationId: string) => {
    renewed.push(registrationId);
    if (now - lastHeartbeat.get(registrationId)! > 120_000) {
      lastHeartbeat.set(registrationId, -Infinity);
      throw new CloudApiError("The open registration expired.", "version_conflict", 409);
    }
    lastHeartbeat.set(registrationId, now);
    return { ok: true, revoked: false, activeOpens: [] };
  };
  const closed: string[] = [];
  cloud.closeOpen = async (registrationId: string, request: { expectedVersion: number }) => {
    closed.push(registrationId);
    return { ok: true, status: "accepted", version: request.expectedVersion + 1 };
  };
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    cloud.openProfile = async () => {
      lastHeartbeat.set("registration2", now);
      return freshOpen("registration2");
    };
    now = 60_000;
    await state.coordinator.heartbeatOnce("profile1");
    const checkpoint = state.queue.list("account1");
    expect(checkpoint).toMatchObject([{ readyToSubmit: false }]);
    const savedBeforeSleep = state.queue.get(checkpoint[0]!.id, "account1")!.payload;

    now += 30 * 60_000; // lid closed for 30 minutes
    await state.coordinator.heartbeatOnce("profile1");
    expect(state.events).not.toContain("stop");
    expect(state.store.getLaunch("profile1")).not.toBeNull();
    expect(state.queue.getOpen("profile1", "account1")).toMatchObject({ registrationId: "registration2", phase: "running" });
    expect((state.coordinator as any).timers.has("profile1")).toBe(true);
    const [moved] = state.queue.list("account1");
    expect(state.queue.get(moved!.id, "account1")).toMatchObject({
      registrationId: "registration2",
      readyToSubmit: false,
      payload: savedBeforeSleep,
    });

    now += 60_000;
    await state.coordinator.heartbeatOnce("profile1");
    expect(renewed).toEqual(["registration1", "registration1", "registration2"]);
    expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
    expect(closed).toEqual(["registration2"]);
    expect(state.abandonCalls()).toBe(0);
  } finally {
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud retries a lapsed lease while the network is not back after a wake", async () => {
  const state = setup({ heartbeatMs: 60_000, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
  const cloud = (state.coordinator as any).options.cloud;
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    cloud.heartbeat = async () => { throw new CloudApiError("The open registration expired.", "version_conflict", 409); };
    cloud.openProfile = async () => { throw new TypeError("fetch failed"); };

    await state.coordinator.heartbeatOnce("profile1");
    expect(state.events).not.toContain("stop");
    expect(state.queue.getOpen("profile1", "account1")).toMatchObject({ registrationId: "registration1", phase: "running" });
    expect((state.coordinator as any).timers.has("profile1")).toBe(true);

    cloud.openProfile = async () => freshOpen("registration2");
    await state.coordinator.heartbeatOnce("profile1");
    expect(state.events).not.toContain("stop");
    expect(state.queue.getOpen("profile1", "account1")).toMatchObject({ registrationId: "registration2", phase: "running" });
  } finally {
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test.each([
  ["another device holds the profile", async () => { throw new CloudApiError("open elsewhere", "profile_open", 409); }, 0],
  ["someone else saved the profile", async () => freshOpen("registration2", 5), 1],
] as const)("Cloud closes a browser whose lease lapsed when %s", async (_case, reopen, abandons) => {
  const state = setup({ closeConflict: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const cloud = (state.coordinator as any).options.cloud;
  cloud.heartbeat = async () => { throw new CloudApiError("The open registration expired.", "version_conflict", 409); };
  cloud.openProfile = reopen;

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toContain("stop");
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.abandonCalls()).toBe(abandons);
  state.queue.close();
  state.store.close();
});

test.each([
  ["cookies", undefined, "cookies"],
  ["worker_timeout", undefined, "worker_timeout"],
  ["private worker stage", undefined, "unknown"],
  [undefined, "empty_stdout", "empty_stdout"],
  [undefined, "private response detail", "unknown"],
])("Cloud capture diagnostics allowlist stage %s / %s", async (operation, responseCategory, stage) => {
  const state = setup({ heartbeatMs: 60_000, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
  const options = (state.coordinator as any).options;
  const readSession = options.readSession;
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    options.readSession = async () => {
      throw new PlaywrightWorkerError("timeout", "private worker detail", {
        operation, responseCategory: responseCategory as any,
      });
    };
    expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete", captureFailed: true });
    expect(state.logs.some((line) => line.includes(`Cloud session capture failed (timeout, PlaywrightWorkerError, stage=${stage}, elapsedMs=`))).toBe(true);
    expect(JSON.stringify(state.logs)).not.toContain("private");
    // A timed-out capture is not retried, so a close stays within one worker time limit.
    expect(state.logs.filter((line) => line.includes("stage=")).length).toBe(1);
    expect(state.store.getLaunch("profile1")).toBeNull();
    expect((state.coordinator as any).timers.has("profile1")).toBe(false);
    expect(state.closeCalls()).toBe(1);
    expect(state.abandonCalls()).toBe(0);
  } finally {
    options.readSession = readSession;
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("terminal restoring heartbeat retries an uncertain stop", async () => {
  const state = setup({ restoreFailure: new Error("worker failed"), stopResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(false);
  state.events.length = 0;
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("revoked", "device_revoked", 403);
  };

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["reconcile", "stop"]);
  expect(state.queue.getOpen("profile1", "account1")?.cleanupMode).toBe("abandon");
  (state.coordinator as any).options.launcher.stop = async (profileId: string) => {
    state.events.push("stop-retry");
    state.store.clearLaunch(profileId);
    return true;
  };

  await state.coordinator.retryPending();

  expect(state.events.slice(-2)).toEqual(["stop-retry", "abandon"]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud roster reconciles a manually closed browser from its latest checkpoint", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: false,
  }]);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  await rosterReconciled(state.coordinator);

  expect(state.events.filter((event) => event !== "cloud-list")).toEqual(["reconcile", "cloud-close"]);
  expect(state.events).toContain("cloud-list");
  expect((await state.coordinator.listRoster()).profiles[0]?.running).toBe(false);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.closeCalls()).toBe(1);
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

const notBlocked = <T>(work: Promise<T>) =>
  Promise.race([work, Bun.sleep(1_000).then(() => "blocked" as const)]);

test("Cloud roster returns while a closed browser's session upload is still pending", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  const closeOpen = options.cloud.closeOpen;
  let finishUpload: (() => void) | undefined;
  options.cloud.closeOpen = async (...args: unknown[]) => {
    await new Promise<void>((resolve) => { finishUpload = resolve; });
    return closeOpen(...args);
  };
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  const first = state.coordinator.listRoster();
  while (!finishUpload) await Bun.sleep(1);
  expect(await notBlocked(first)).not.toBe("blocked");
  const during = await notBlocked(state.coordinator.listRoster());
  expect(during).not.toBe("blocked");
  expect(during !== "blocked" && during.profiles[0]).toMatchObject({ running: false, lockedBy: null });
  // The finalized session stays queued until Cloud accepts it.
  expect(state.queue.list("account1")).toMatchObject([{ profileId: "profile1", readyToSubmit: true }]);

  finishUpload();
  await (state.coordinator as any).rosterReconcile;
  expect(state.closeCalls()).toBe(1);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
  state.store.close();
});

test("Cloud roster is not held by a slow close of an open browser", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  const readSession = options.readSession;
  let finishCapture: (() => void) | undefined;
  options.readSession = async (...args: unknown[]) => {
    await new Promise<void>((resolve) => { finishCapture = resolve; });
    return readSession(...args);
  };

  const closing = state.coordinator.close("profile1");
  while (!finishCapture) await Bun.sleep(1);
  expect(await notBlocked(state.coordinator.listRoster())).not.toBe("blocked");

  finishCapture();
  expect(await closing).toEqual({ closed: true, sync: "complete" });
  await (state.coordinator as any).rosterReconcile;
  expect(state.closeCalls()).toBe(1);
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
  state.store.close();
});

test("Cloud roster polls cannot accelerate the closed-window confirmation", async () => {
  const state = setup({ hasPageTargets: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  await state.coordinator.checkWindowsOnce("profile1");
  await state.coordinator.checkWindowsOnce("profile1");
  const firstRoster = await rosterReconciled(state.coordinator);
  const secondRoster = await rosterReconciled(state.coordinator);

  expect([...state.events].sort()).toEqual(["cloud-list", "cloud-list", "reconcile", "reconcile"]);
  expect(firstRoster.profiles[0]?.running).toBe(true);
  expect(secondRoster.profiles[0]?.running).toBe(true);
  expect(state.queue.getOpen("profile1", "account1")).not.toBeNull();

  await state.coordinator.checkWindowsOnce("profile1");
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud roster backfills the proxy cache for profiles this device never opened", async () => {
  const state = setup({ proxy: { type: "http", host: "203.0.113.9", port: "8080", user: "u", pass: "p" } });

  // First poll: cache miss — the roster returns immediately and the decrypt
  // runs in the background.
  const first = await state.coordinator.listRoster();
  expect(first.profiles[0]?.proxy).toBeNull();
  await (state.coordinator as any).proxyBackfillTask;
  expect(state.getProfileCalls()).toBe(1);

  // Second poll: the cached decrypted profile now carries the proxy, redacted
  // to host:port, and the matching version suppresses any refetch.
  const second = await state.coordinator.listRoster();
  expect(second.profiles[0]?.proxy).toBe("203.0.113.9:8080");
  await (state.coordinator as any).proxyBackfillTask;
  expect(state.getProfileCalls()).toBe(1);

  state.queue.close();
  state.store.close();
});

test("a live profile edit forces the next checkpoint to re-encode the payload", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const saved = () => state.coordinator.diagnostics().filter((event) => event.type === "checkpoint_saved").length;

  await state.coordinator.heartbeatOnce("profile1");
  const baseline = saved();
  // Same session content again: the signature skips it as unchanged.
  await state.coordinator.heartbeatOnce("profile1");
  expect(saved()).toBe(baseline);

  // A metadata edit changes no session bytes, so without the invalidation the
  // capture above would keep skipping and the edit would only sync by luck.
  state.coordinator.noteProfileEdited("profile1");
  await state.coordinator.heartbeatOnce("profile1");
  expect(saved()).toBe(baseline + 1);

  state.queue.close();
  state.store.close();
});

test("a live profile edit cannot commit behind an in-flight close", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const original = state.store.getProfile("profile1")!;
  let captureStarted!: () => void;
  let releaseCapture!: () => void;
  const captureReady = new Promise<void>((resolve) => { captureStarted = resolve; });
  const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
  (state.coordinator as any).options.readSession = async () => {
    captureStarted();
    await captureGate;
    return JSON.stringify({ ...payload().session, origins: [] });
  };

  const closing = state.coordinator.close("profile1");
  let committing: Promise<boolean> | undefined;
  await captureReady;
  try {
    expect(state.coordinator.canEditLive("profile1")).toBe(false);
    committing = state.coordinator.commitLiveEdit({ ...original, name: "Too late" });
    let committed = false;
    void committing.then(() => { committed = true; });
    await Bun.sleep(0);
    expect(committed).toBe(false);

    releaseCapture();
    expect(await closing).toEqual({ closed: true, sync: "complete" });
    expect(await committing).toBe(false);
    expect(state.store.getProfile("profile1")?.name).toBe(original.name);
  } finally {
    releaseCapture();
    await Promise.allSettled([closing, ...(committing ? [committing] : [])]);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud close reconciles a manually closed browser before session capture", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });

  expect(state.events).toEqual(["reconcile", "cloud-close"]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.closeCalls()).toBe(1);
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll reconciles a manually closed browser", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  expect(await state.coordinator.releaseAll()).toBe(true);

  expect(state.events).toEqual(["reconcile", "cloud-close"]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.closeCalls()).toBe(1);
  state.queue.close();
  state.store.close();
});

test("Cloud roster reconciliation does not release a replacement registration", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => {
    state.store.clearLaunch("profile1");
    state.queue.removeOpen("profile1", "account1");
    state.queue.recordOpen({
      accountId: "account1",
      profileId: "profile1",
      registrationId: "replacement-registration",
      expectedVersion: 5,
    });
    state.store.recordLaunch({
      profileId: "profile1",
      pid: 11,
      debugPort: 9333,
      ws: "ws://replacement",
      startedAt: 2000,
    });
  });

  await rosterReconciled(state.coordinator);

  expect([...state.events].sort()).toEqual(["cloud-list", "reconcile"]);
  expect(state.queue.getOpen("profile1", "account1")?.registrationId).toBe("replacement-registration");
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud stopped checkpoint finalization cannot delete a replacement registration", async () => {
  const state = setup({ closeTransportFailure: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));
  (state.coordinator as any).options.cloud.closeOpen = async () => {
    state.events.push("cloud-close");
    state.queue.removeOpen("profile1", "account1");
    state.queue.recordOpen({
      accountId: "account1",
      profileId: "profile1",
      registrationId: "replacement-registration",
      expectedVersion: 5,
    });
    throw new Error("offline");
  };

  await rosterReconciled(state.coordinator);

  expect(state.queue.getOpen("profile1", "account1")?.registrationId).toBe("replacement-registration");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat retains an exactly alive browser after a transient active probe miss", async () => {
  const state = setup({ activeResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toContain("reconcile");
  expect(state.events).toContain("heartbeat");
  expect(state.events).not.toContain("stop");
  expect(state.events).not.toContain("cloud-close");
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).not.toBeNull();
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat records confirmed browser death", async () => {
  const state = setup({ activeResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.coordinator.diagnostics().map((event) => event.type)).toContain("browser_death_confirmed");
  state.queue.close();
  state.store.close();
});

test("Cloud saves and stops a browser after its last window closed", async () => {
  const state = setup({ hasPageTargets: false });
  const options = (state.coordinator as any).options;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const fresh = { name: "auth_token", value: "fresh-login", domain: ".x.com", path: "/" };
  const readSession = options.readSession;
  options.readSession = async (...args: unknown[]) => {
    await readSession(...args);
    return JSON.stringify({ cookies: [fresh], origins: [] });
  };
  let closedSession: any;
  const closeOpen = options.cloud.closeOpen;
  options.cloud.closeOpen = async (registrationId: string, request: any) => {
    closedSession = request.payload.session;
    return closeOpen(registrationId, request);
  };
  state.events.length = 0;

  await state.coordinator.checkWindowsOnce("profile1");
  await state.coordinator.checkWindowsOnce("profile1");
  expect(state.events).toEqual([]);
  expect(state.store.getLaunch("profile1")).not.toBeNull();

  await state.coordinator.checkWindowsOnce("profile1");

  expect(state.events).toEqual(["reconcile", "capture", "stop", "cloud-close"]);
  expect(closedSession.cookies).toEqual([fresh]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.coordinator.diagnostics().map((event) => event.type)).toEqual(
    expect.arrayContaining(["no_page_observed", "no_page_close_requested", "session_synced"]),
  );
  state.queue.close();
  state.store.close();
});

test("Cloud stops a windowless browser at once when its capture fails and keeps the last checkpoint", async () => {
  const state = setup({ hasPageTargets: false });
  const options = (state.coordinator as any).options;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const checkpoint = { name: "auth_token", value: "checkpoint", domain: ".x.com", path: "/" };
  options.readSession = async () => JSON.stringify({ cookies: [checkpoint], origins: [] });
  await state.coordinator.heartbeatOnce("profile1");
  options.readSession = async () => {
    state.events.push("capture");
    throw new PlaywrightWorkerError("timeout", "capture timed out");
  };
  let closedSession: any;
  const closeOpen = options.cloud.closeOpen;
  options.cloud.closeOpen = async (registrationId: string, request: any) => {
    closedSession = request.payload.session;
    return closeOpen(registrationId, request);
  };
  state.events.length = 0;

  for (let check = 0; check < 3; check++) await state.coordinator.checkWindowsOnce("profile1");

  expect(state.events).toEqual(["reconcile", "capture", "stop", "cloud-close"]);
  expect(closedSession.cookies).toEqual([checkpoint]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.logs).toContain("profile1: Cloud capture failed; stopped the browser and kept the last saved copy");
  state.queue.close();
  state.store.close();
});

test("Cloud leaves a browser open when its capture fails after a page came back", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  const observations = [false, false, false, true];
  options.launcher.hasPageTargets = async () => observations.shift() ?? true;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  options.readSession = async () => {
    state.events.push("capture");
    throw new PlaywrightWorkerError("timeout", "capture timed out");
  };
  state.events.length = 0;

  for (let check = 0; check < 3; check++) await state.coordinator.checkWindowsOnce("profile1");

  expect(state.events).toEqual(["reconcile", "capture"]);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")?.cleanupMode).toBeUndefined();
  state.queue.close();
  state.store.close();
});

test("Cloud keeps the browser of a script that closes every page and opens a new one", async () => {
  const state = setup();
  const observations = [false, false, true, false, false, true];
  (state.coordinator as any).options.launcher.hasPageTargets = async () => observations.shift()!;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  for (let check = 0; check < 6; check++) await state.coordinator.checkWindowsOnce("profile1");

  expect(state.events).toEqual([]);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).not.toBeNull();
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud window checks leave the app's Close alone", async () => {
  const state = setup({ hasPageTargets: false });
  const options = (state.coordinator as any).options;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const readSession = options.readSession;
  let finishCapture: (() => void) | undefined;
  options.readSession = async (...args: unknown[]) => {
    await new Promise<void>((resolve) => { finishCapture = resolve; });
    return readSession(...args);
  };
  state.events.length = 0;

  const closing = state.coordinator.close("profile1");
  while (!finishCapture) await Bun.sleep(1);
  for (let check = 0; check < 3; check++) await state.coordinator.checkWindowsOnce("profile1");
  finishCapture();

  expect(await closing).toEqual({ closed: true, sync: "complete" });
  expect(state.events).toEqual(["reconcile", "capture", "stop", "cloud-close"]);
  expect(state.coordinator.diagnostics().map((event) => event.type)).not.toContain("no_page_close_requested");
  state.queue.close();
  state.store.close();
});

test("Cloud production timers arm the heartbeat, the window check and the storage watch", async () => {
  const state = setup();
  const intervals: number[] = [];
  const watched: string[] = [];
  const options = {
    ...(state.coordinator as any).options,
    heartbeatMs: 60_000,
    storageCheckpoints: undefined,
    setIntervalFn: (_fn: () => void, ms: number) => {
      intervals.push(ms);
      return intervals.length;
    },
    clearIntervalFn: () => {},
    watchPath: (path: string) => { watched.push(path); return { close() {} }; },
  };
  options.launcher.browserStorageWatchPaths = () => ["local-storage"];
  const coordinator = new CloudBrowserCoordinator(options);

  expect((await coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(intervals).toEqual([60_000, 5_000]);
  expect(watched).toEqual(["local-storage"]);

  await coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud storage writes checkpoint the open tabs once per debounce and at most once per interval", async () => {
  const storageDirty: Array<() => void> = [];
  let watcherCloses = 0;
  const state = setup({
    session: {
      cookies: [],
      origins: [
        { origin: "https://closed.example", localStorage: [{ name: "token", value: "saved" }] },
        { origin: "https://web.telegram.org", localStorage: [{ name: "dc", value: "1" }] },
      ],
    },
    storageCheckpoints: true,
    checkpointDebounceMs: 30,
    checkpointMinIntervalMs: 400,
    watchPaths: ["local-storage", "indexed-db"],
    watchPath: (_path: string, onDirty: () => void) => {
      storageDirty.push(onDirty);
      return { close() { watcherCloses++; } };
    },
  });
  let login = 0;
  const options = (state.coordinator as any).options;
  options.readSession = async (_endpoint: string, seed: unknown) => {
    state.events.push("capture");
    state.captureSeeds.push(seed);
    return JSON.stringify({
      cookies: [],
      origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "account1", value: `login-${++login}` }] }],
      tabs: ["https://web.telegram.org/k/"],
    });
  };
  const checkpoint = () => state.queue.get(state.queue.list("account1")[0]!.id, "account1")!.payload.session;
  const captures = () => state.events.filter((event) => event === "capture").length;
  const waitForCaptures = async (count: number) => {
    for (let attempt = 0; attempt < 200 && captures() < count; attempt++) await Bun.sleep(5);
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(storageDirty).toHaveLength(2);
  state.captureSeeds.length = 0;
  for (const dirty of storageDirty) dirty();
  await Bun.sleep(10);
  expect(captures()).toBe(0);
  await waitForCaptures(1);
  expect(captures()).toBe(1);
  // Only open tabs are read; every other origin keeps its saved storage.
  expect(state.captureSeeds).toEqual([{
    origins: [],
    openTabsOnly: true,
    saved: [
      { origin: "https://closed.example", localStorage: [{ name: "token", value: "saved" }] },
      { origin: "https://web.telegram.org", localStorage: [{ name: "dc", value: "1" }] },
    ],
  }]);
  expect(checkpoint().origins).toEqual([
    { origin: "https://closed.example", localStorage: [{ name: "token", value: "saved" }] },
    { origin: "https://web.telegram.org", localStorage: [{ name: "account1", value: "login-1" }] },
  ]);
  expect(state.events).not.toContain("heartbeat");
  expect(state.events).not.toContain("cloud-close");

  const burstAt = Date.now();
  for (let burst = 0; burst < 5; burst++) {
    storageDirty.at(-1)!();
    await Bun.sleep(5);
  }
  await Bun.sleep(60);
  expect(captures()).toBe(1);
  await waitForCaptures(2);
  expect(captures()).toBe(2);
  expect(Date.now() - burstAt).toBeGreaterThanOrEqual(300);
  await Bun.sleep(450);
  expect(captures()).toBe(2);
  expect(checkpoint().origins?.[1]).toEqual({ origin: "https://web.telegram.org", localStorage: [{ name: "account1", value: "login-2" }] });

  await state.coordinator.close("profile1");
  expect(watcherCloses).toBe(storageDirty.length);
  const capturesAfterClose = captures();
  storageDirty[0]!();
  await Bun.sleep(60);
  expect(captures()).toBe(capturesAfterClose);
  state.queue.close();
  state.store.close();
});

test("Cloud dirty monitor retires capture-generated callbacks and rearms fresh storage watchers", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let captures = 0;
  let finishFirst!: () => void;
  const firstCapture = new Promise<void>((resolve) => { finishFirst = resolve; });
  const options = (state.coordinator as any).options;
  (state.coordinator as any).storageCheckpoints = true;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.watchPath = (_path: string, onDirty: () => void) => {
    storageDirty.push(onDirty);
    return { close() {} };
  };
  options.setIntervalFn = () => ({ unref() {} });
  options.clearIntervalFn = () => {};
  options.readSession = async () => {
    captures++;
    const bundle = JSON.stringify({
      cookies: [{ name: "auth_token", value: `capture-${captures}`, domain: ".x.com", path: "/" }],
      origins: [],
    });
    if (captures === 1) await firstCapture;
    return bundle;
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).startDirtyMonitor("profile1");
  await Bun.sleep(0);
  const retired = storageDirty[0]!;
  retired();
  for (let attempt = 0; attempt < 20 && captures === 0; attempt++) await Bun.sleep(1);
  expect(captures).toBe(1);

  retired();
  finishFirst();
  await Bun.sleep(20);
  expect(captures).toBe(1);
  expect(storageDirty).toHaveLength(2);

  storageDirty[1]!();
  await Bun.sleep(20);
  expect(captures).toBe(2);

  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("capture-generated storage events do not create an unchanged-checkpoint loop", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let captures = 0;
  const options = (state.coordinator as any).options;
  (state.coordinator as any).storageCheckpoints = true;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.watchPath = (_path: string, onDirty: () => void) => {
    storageDirty.push(onDirty);
    return { close() {} };
  };
  options.setIntervalFn = () => ({ unref() {} });
  options.clearIntervalFn = () => {};
  options.readSession = async () => {
    captures++;
    storageDirty.at(-1)!();
    return JSON.stringify({ ...payload().session, origins: [] });
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).startDirtyMonitor("profile1");
  await Bun.sleep(0);
  storageDirty[0]!();
  await Bun.sleep(30);

  expect(captures).toBe(1);
  expect(storageDirty).toHaveLength(2);
  await Bun.sleep(20);
  expect(captures).toBe(1);

  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat skips the full capture while storage watchers are live, except every tenth beat", async () => {
  const state = setup();
  let captures = 0;
  const options = (state.coordinator as any).options;
  (state.coordinator as any).storageCheckpoints = true;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.watchPath = () => ({ close() {} });
  options.setIntervalFn = () => ({ unref() {} });
  options.clearIntervalFn = () => {};
  options.readSession = async () => {
    captures++;
    return JSON.stringify({ ...payload().session, origins: [] });
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).startDirtyMonitor("profile1");
  const before = captures;
  for (let beat = 1; beat <= 9; beat++) await state.coordinator.heartbeatOnce("profile1");
  expect(captures).toBe(before);
  await state.coordinator.heartbeatOnce("profile1");
  expect(captures).toBe(before + 1);

  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat retires its capture watcher generation before reading storage", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let captures = 0;
  const options = (state.coordinator as any).options;
  (state.coordinator as any).storageCheckpoints = true;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.watchPath = (_path: string, onDirty: () => void) => {
    storageDirty.push(onDirty);
    return { close() {} };
  };
  options.setIntervalFn = () => ({ unref() {} });
  options.clearIntervalFn = () => {};
  options.readSession = async () => {
    captures++;
    storageDirty.at(-1)!();
    return JSON.stringify({ ...payload().session, origins: [] });
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).startDirtyMonitor("profile1");
  await Bun.sleep(0);
  // With live watchers only every tenth heartbeat runs a full capture; make this one it.
  (state.coordinator as any).dirtyMonitors.get("profile1").heartbeats = 9;

  await state.coordinator.heartbeatOnce("profile1");
  await Bun.sleep(20);

  expect(captures).toBe(1);
  expect(storageDirty).toHaveLength(2);
  storageDirty[1]!();
  await Bun.sleep(20);
  expect(captures).toBe(2);

  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud dirty monitor latches one live edit while a capture is running", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let finishFirst!: () => void;
  const firstCapture = new Promise<void>((resolve) => { finishFirst = resolve; });
  let captures = 0;
  const options = (state.coordinator as any).options;
  (state.coordinator as any).storageCheckpoints = true;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.watchPath = (_path: string, onDirty: () => void) => {
    storageDirty.push(onDirty);
    return { close() {} };
  };
  options.readSession = async () => {
    captures++;
    if (captures === 1) await firstCapture;
    return JSON.stringify({
      cookies: [{ name: "auth_token", value: `capture-${captures}`, domain: ".x.com", path: "/" }],
      origins: [],
    });
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).startDirtyMonitor("profile1");
  await Bun.sleep(0);
  storageDirty[0]!();
  await Bun.sleep(5);
  expect(captures).toBe(1);
  state.coordinator.noteProfileEdited("profile1");
  state.coordinator.noteProfileEdited("profile1");
  finishFirst();
  for (let attempt = 0; attempt < 100 && captures < 2; attempt++) {
    await Bun.sleep(5);
  }
  expect(captures).toBe(2);

  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud checkpoint probes every origin from the durable open bundle", async () => {
  const state = setup({
    session: {
      cookies: [],
      origins: [{
        origin: "https://closed.example",
        localStorage: [{ name: "token", value: "prior-value" }],
      }],
      telegramClient: "k",
    },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  await state.coordinator.heartbeatOnce("profile1");

  // The saved storage goes with the seed, so an origin that the worker cannot read keeps it.
  expect(state.captureSeeds.at(-1)).toEqual({
    origins: ["https://closed.example"],
    telegramClient: "k",
    saved: [{ origin: "https://closed.example", localStorage: [{ name: "token", value: "prior-value" }] }],
  });
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud storage checkpoints preserve ordered duplicate tabs through manual browser death", async () => {
  const storageDirty: Array<() => void> = [];
  const state = setup({
    session: {
      ...payload().session,
      origins: [{ origin: "https://x.com", localStorage: [] }],
      tabs: ["https://initial.example/"],
    },
    heartbeatMs: 60_000,
    storageCheckpoints: true,
    checkpointDebounceMs: 0,
    checkpointMinIntervalMs: 0,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
    watchPaths: ["browser-storage"],
    watchPath(_path, dirty) {
      storageDirty.push(dirty);
      return { close() {} };
    },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  let tabs = ["https://same.example/a", "https://same.example/a"];
  let captures = 0;
  const options = (state.coordinator as any).options;
  options.readSession = async () => {
    captures++;
    return JSON.stringify({
      cookies: payload().session.cookies,
      origins: [{ origin: "https://x.com", localStorage: [] }],
      tabs,
    });
  };
  const waitForTabs = async (expected: string[]) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const summary = state.queue.list("account1")[0];
      const captured = summary ? state.queue.get(summary.id, "account1") : null;
      if (JSON.stringify(captured?.payload.session.tabs) === JSON.stringify(expected)) return;
      await Bun.sleep(5);
    }
    const summary = state.queue.list("account1")[0];
    expect(summary).toBeDefined();
    expect(summary && state.queue.get(summary.id, "account1")?.payload.session.tabs).toEqual(expected);
  };

  storageDirty.at(-1)!();
  await waitForTabs(tabs);

  tabs = ["https://same.example/b", "https://same.example/a", "https://same.example/b"];
  storageDirty.at(-1)!();
  await waitForTabs(tabs);

  tabs = ["https://same.example/a", "https://same.example/a"];
  storageDirty.at(-1)!();
  await waitForTabs(tabs);
  expect(captures).toBe(3);

  let submitted: PortableProfileV1 | undefined;
  const originalClose = options.cloud.closeOpen;
  options.cloud.closeOpen = async (registrationId: string, request: { payload: PortableProfileV1 }) => {
    submitted = structuredClone(request.payload);
    return originalClose(registrationId, request);
  };
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  await rosterReconciled(state.coordinator);

  expect(submitted?.session.tabs).toEqual([
    "https://same.example/a",
    "https://same.example/a",
  ]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();

  options.cloud.openProfile = async () => ({
    ok: true,
    registrationId: "registration2",
    baseVersion: 5,
    payload: submitted!,
    activeOpens: [],
  });
  state.setReconcileHook(() => {});
  state.navigatedUrls.length = 0;

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.navigatedUrls).toEqual([[]]);

  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat remains a checkpoint fallback when storage watching is unavailable", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  (state.coordinator as any).storageCheckpoints = true;
  options.launcher.browserStorageWatchPaths = () => ["missing-storage"];
  options.watchPath = () => { throw new Error("unavailable"); };
  options.setIntervalFn = () => ({ unref() {} });
  options.clearIntervalFn = () => {};

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const baselineId = state.queue.list("account1")[0]?.id;
  expect(state.coordinator.diagnostics().some((event) => event.type === "dirty_monitor_unavailable")).toBe(true);
  options.readSession = async () => JSON.stringify({
    cookies: [{ name: "auth_token", value: "heartbeat-change", domain: ".x.com", path: "/" }],
    origins: [],
  });

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.queue.list("account1")[0]?.id).not.toBe(baselineId);
  await state.coordinator.close("profile1");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat keeps the existing checkpoint when the session is unchanged", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const baselineId = state.queue.list("account1")[0]?.id;
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");

  const refreshed = state.queue.list("account1");
  expect(state.events).toEqual(["heartbeat", "capture"]);
  expect(refreshed).toHaveLength(1);
  expect(refreshed[0]?.id).toBe(baselineId);
  expect(refreshed[0]?.readyToSubmit).toBe(false);
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat keeps the last checkpoint when a fresh capture is invalid", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const baselineId = state.queue.list("account1")[0]?.id;
  (state.coordinator as any).options.readSession = async () => "{}";

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.queue.list("account1")[0]?.id).toBe(baselineId);
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("checkpoint_invalid");
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat refreshes its checkpoint during a Cloud outage", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const baselineId = state.queue.list("account1")[0]?.id;
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    state.events.push("heartbeat");
    throw new Error("offline");
  };
  (state.coordinator as any).options.readSession = async () => {
    state.events.push("capture");
    return JSON.stringify({
      cookies: [{ name: "auth_token", value: "changed", domain: ".x.com", path: "/" }],
      origins: [],
    });
  };
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["heartbeat", "capture"]);
  expect(state.queue.list("account1")[0]?.id).not.toBe(baselineId);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud close preserves unavailable tabs but accepts intentional tab changes", async () => {
  const originalTabs = ["https://one.example/", "https://two.example/", "https://one.example/"];
  for (const capturedTabs of [undefined, ["https://two.example/"], []]) {
    const state = setup({ session: { cookies: [], origins: [], tabs: originalTabs } });
    const options = (state.coordinator as any).options;
    try {
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      options.launcher.hasPageTargets = async () => capturedTabs !== undefined;
      const fresh = {
        cookies: [{ name: "session", value: "fresh", domain: "one.example", path: "/" }],
        origins: [{ origin: "https://one.example", localStorage: [{ name: "state", value: "fresh" }] }],
      };
      options.readSession = async () => JSON.stringify({ ...fresh, ...(capturedTabs === undefined ? {} : { tabs: capturedTabs }) });
      const expectedTabs = capturedTabs ?? originalTabs;
      await state.coordinator.heartbeatOnce("profile1");
      const checkpoint = state.queue.list("account1")[0]!;
      expect(state.queue.get(checkpoint.id, "account1")?.payload.session).toEqual({ ...fresh, tabs: expectedTabs });
      options.launcher.hasPageTargets = async () => false;
      options.readSession = async () => JSON.stringify(fresh);
      let closedSession: any;
      const closeOpen = options.cloud.closeOpen;
      options.cloud.closeOpen = async (registrationId: string, request: any) => {
        closedSession = request.payload.session;
        return closeOpen(registrationId, request);
      };
      expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
      expect(closedSession).toEqual({ ...fresh, tabs: expectedTabs });
      const openProfile = options.cloud.openProfile;
      options.cloud.openProfile = async () => {
        const opened = await openProfile();
        return { ...opened, payload: { ...opened.payload, session: closedSession } };
      };
      let restoredSession: any;
      options.applySession = async (_endpoint: string, bundle: string) => { restoredSession = JSON.parse(bundle); };
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      expect(restoredSession.tabs).toEqual(expectedTabs);
      await state.coordinator.close("profile1");
    } finally {
      state.queue.close();
      state.store.close();
    }
  }
});

test("Cloud uses immediate native-close tabs before or after Firefox exits", async () => {
  for (const exited of [false, true]) {
    const session = { ...payload().session, origins: [], tabs: ["https://older.example/"] };
    const state = setup({ session, nativeSessionAvailable: true });
    const options = (state.coordinator as any).options;
    try {
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      const launch = state.store.getLaunch("profile1")!;
      const tabs = ["https://new.example/", "https://two.example/", "https://new.example/"];
      options.launcher.closedFirefoxTabs = (profileId: string, generation: any) => {
        expect(profileId).toBe("profile1");
        expect(generation).toMatchObject({ debugPort: launch.debugPort, startedAt: launch.startedAt });
        return tabs;
      };
      options.launcher.hasPageTargets = async () => false;
      options.readSession = async () => JSON.stringify({ cookies: session.cookies, origins: [] });
      let submitted: PortableProfileV1 | undefined;
      const closeOpen = options.cloud.closeOpen;
      options.cloud.closeOpen = async (registrationId: string, request: { payload: PortableProfileV1 }) => {
        submitted = request.payload;
        return closeOpen(registrationId, request);
      };
      if (exited) {
        state.setReconcileHook(() => state.store.clearLaunch("profile1"));
        await rosterReconciled(state.coordinator);
      } else {
        await state.coordinator.heartbeatOnce("profile1");
        await state.coordinator.close("profile1");
      }
      expect(submitted?.session).toEqual({ ...session, tabs });
      expect(options.launcher.matchesCloudSession("profile1", sessionBundleSignature(JSON.stringify(submitted!.session)))).toBe(true);
      expect(state.queue.getOpen("profile1", "account1")).toBeNull();
      state.setReconcileHook(() => {});
      options.cloud.openProfile = async () => ({
        ok: true, registrationId: "registration2", baseVersion: 5, payload: submitted!, activeOpens: [],
      });
      const restores = state.restoreEndpoints.length;
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      expect(state.restoreEndpoints).toHaveLength(restores);
      expect(state.startOptionsSeen.at(-1).resetStorage).toBe(false);
      await state.coordinator.close("profile1");
    } finally {
      state.queue.close();
      state.store.close();
    }
  }
});

test("Cloud browser durably captures before confirmed stop and CAS close", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  const originalStop = (state.coordinator as any).options.launcher.stop;
  const originalClose = (state.coordinator as any).options.cloud.closeOpen;
  (state.coordinator as any).options.cloud.closeOpen = async (...args: unknown[]) => {
    expect(state.queue.getOpen("profile1", "account1")).toBeNull();
    expect(state.queue.list("account1")).toMatchObject([{
      profileId: "profile1",
      readyToSubmit: true,
    }]);
    return originalClose(...args);
  };
  (state.coordinator as any).options.launcher.stop = async (profileId: string) => {
    expect(state.queue.list("account1")).toMatchObject([{
      profileId: "profile1",
      readyToSubmit: false,
    }]);
    return originalStop(profileId);
  };

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(state.events).toEqual(["reconcile", "capture", "stop", "cloud-close"]);
  expect(state.closeCalls()).toBe(1);
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.coordinator.diagnostics().map((event) => event.type).slice(-5)).toEqual([
    "close_started",
    "checkpoint_unchanged",
    "session_captured",
    "browser_stopped",
    "session_synced",
  ]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser never submits a capture before browser teardown is confirmed", async () => {
  const state = setup({ stopResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({
    closed: false,
    reason: "teardown_unconfirmed",
  });
  expect(state.closeCalls()).toBe(0);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: false,
    status: "pending",
  }]);
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("browser_teardown_unconfirmed");
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll finishes retained cleanup without recapturing", async () => {
  const state = setup({ closeConflict: true, stopResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("stale", "version_conflict", 409);
  };
  (state.coordinator as any).options.cloud.openProfile = async () => {
    throw new CloudApiError("open elsewhere", "profile_open", 409);
  };

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events.filter((event) => event === "capture")).toHaveLength(1);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration1",
    cleanupMode: "sync",
  });
  expect(state.queue.list("account1")).toMatchObject([{
    readyToSubmit: false,
    status: "pending",
  }]);

  (state.coordinator as any).options.launcher.stop = async (profileId: string) => {
    state.events.push("stop-retry");
    state.store.clearLaunch(profileId);
    return true;
  };

  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(state.events.filter((event) => event === "capture")).toHaveLength(1);
  expect(state.events).toContain("stop-retry");
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.listOpens("account1")).toEqual([]);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "conflict",
  }]);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll never submits retained cleanup after an account change", async () => {
  let accountId = "account1";
  const state = setup({
    accountId: () => accountId,
    stopResult: false,
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({
    closed: false,
    reason: "teardown_unconfirmed",
  });
  (state.coordinator as any).options.launcher.stop = async (profileId: string) => {
    accountId = "account2";
    state.store.clearLaunch(profileId);
    return true;
  };

  expect(await state.coordinator.releaseAll()).toBe(false);
  expect(state.closeCalls()).toBe(0);
  expect(state.queue.listOpens("account1")).toEqual([]);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "pending",
  }]);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll never stops a replacement during retained cleanup", async () => {
  const state = setup({ stopResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({
    closed: false,
    reason: "teardown_unconfirmed",
  });
  let stoppedGeneration: number | undefined;
  (state.coordinator as any).options.launcher.stop = async (
    profileId: string,
    expected?: { debugPort: number; startedAt: number },
  ) => {
    state.store.recordLaunch({
      profileId,
      pid: 11,
      debugPort: 9333,
      ws: "ws://replacement",
      startedAt: 2000,
    });
    const current = state.store.getLaunch(profileId)!;
    if (
      expected &&
      (current.debugPort !== expected.debugPort || current.startedAt !== expected.startedAt)
    ) return false;
    stoppedGeneration = current.startedAt;
    state.store.clearLaunch(profileId);
    return true;
  };

  expect(await state.coordinator.releaseAll()).toBe(false);
  expect(stoppedGeneration).toBeUndefined();
  expect(state.store.getLaunch("profile1")).toMatchObject({
    debugPort: 9333,
    startedAt: 2000,
  });
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration1",
    cleanupMode: "sync",
  });
  expect(state.queue.list("account1")).toMatchObject([{
    readyToSubmit: false,
  }]);
  state.queue.close();
  state.store.close();
});

test("Cloud close never stops a replacement after capture", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  let stoppedGeneration: number | undefined;
  (state.coordinator as any).options.launcher.stop = async (
    profileId: string,
    expected?: { debugPort: number; startedAt: number },
  ) => {
    state.store.recordLaunch({
      profileId,
      pid: 11,
      debugPort: 9333,
      ws: "ws://replacement",
      startedAt: 2000,
    });
    const current = state.store.getLaunch(profileId)!;
    if (
      expected &&
      (current.debugPort !== expected.debugPort || current.startedAt !== expected.startedAt)
    ) return false;
    stoppedGeneration = current.startedAt;
    state.store.clearLaunch(profileId);
    return true;
  };

  expect(await state.coordinator.close("profile1")).toEqual({
    closed: false,
    reason: "teardown_unconfirmed",
  });
  expect(stoppedGeneration).toBeUndefined();
  expect(state.store.getLaunch("profile1")).toMatchObject({
    debugPort: 9333,
    startedAt: 2000,
  });
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration1",
    cleanupMode: "sync",
  });
  expect(state.queue.list("account1")).toMatchObject([{
    readyToSubmit: false,
  }]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser reopens the latest Cloud state while preserving a stale CAS close", async () => {
  const state = setup({ closeConflict: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "conflict" });
  expect(state.closeCalls()).toBe(1);
  const conflict = state.queue.list("account1")[0];
  expect(conflict).toMatchObject({
    profileId: "profile1",
    expectedVersion: 4,
    readyToSubmit: true,
    status: "conflict",
  });
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();

  const latest = payload();
  latest.session.cookies[0]!.value = "latest-cloud-session";
  const options = (state.coordinator as any).options;
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    return {
      ok: true,
      registrationId: "registration2",
      baseVersion: 5,
      payload: latest,
      activeOpens: [],
    };
  };
  let restoredSession: any;
  options.applySession = async (_endpoint: string, bundle: string) => {
    state.events.push("restore");
    restoredSession = JSON.parse(bundle);
  };
  options.cloud.closeOpen = async (registrationId: string, request: { expectedVersion: number }) => {
    state.events.push("cloud-close");
    expect(registrationId).toBe("registration2");
    expect(request.expectedVersion).toBe(5);
    return { ok: true, status: "accepted", version: 6 };
  };

  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toMatchObject({
    ok: true,
    warning: "Opened the current Cloud copy. This device's last session for this profile was not saved because " +
      "Cloud rejected it; that session remains encrypted on this device.",
  });
  expect(restoredSession.cookies[0]?.value).toBe("latest-cloud-session");
  expect(state.queue.get(conflict!.id, "account1")?.status).toBe("conflict");
  expect(state.queue.list("account1")).toHaveLength(2);

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(state.queue.list("account1")).toEqual([conflict!]);
  expect(state.queue.get(conflict!.id, "account1")?.status).toBe("conflict");
  state.queue.close();
  state.store.close();
});

/** Cloud rejects registration1 only because its lease expired: the version is still 4. */
function expireFirstLease(state: ReturnType<typeof setup>, resaveOpen: () => Promise<OpenProfileResponse>) {
  const options = (state.coordinator as any).options;
  const closed: string[] = [];
  options.cloud.closeOpen = async (registrationId: string, request: { expectedVersion: number }) => {
    closed.push(registrationId);
    if (registrationId === "registration1") {
      return {
        ok: false,
        error: { code: "version_conflict", message: "The open registration expired.", currentVersion: 4 },
      };
    }
    return { ok: true, status: "accepted", version: request.expectedVersion + 1 };
  };
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    return resaveOpen();
  };
  return closed;
}

function freshOpen(registrationId: string, baseVersion = 4): OpenProfileResponse {
  return { ok: true, registrationId, baseVersion, payload: payload(), activeOpens: [] };
}

test("Cloud browser saves a lease-expired close through a fresh registration", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const closed = expireFirstLease(state, async () => freshOpen("registration2"));

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(closed).toEqual(["registration1", "registration2"]);
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser keeps a lease-expired session instead of reopening the older Cloud copy", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  let heldElsewhere = true;
  let registrations = 1;
  const closed = expireFirstLease(state, async () => {
    if (heldElsewhere) throw new CloudApiError("open elsewhere", "profile_open", 409);
    return freshOpen(`registration${++registrations}`, registrations === 2 ? 4 : 5);
  });

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });
  expect(state.queue.list("account1")).toMatchObject([{ status: "conflict", error: "lease_expired" }]);

  const restoresBefore = state.events.filter((event) => event === "restore").length;
  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "This profile's last session from this device is still being saved to Cloud. Try again shortly.",
  });
  expect(state.events.filter((event) => event === "restore")).toHaveLength(restoresBefore);

  heldElsewhere = false;
  const reopened = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(reopened).toMatchObject({ ok: true });
  expect((reopened as { warning?: string }).warning).toBeUndefined();
  expect(closed).toEqual(["registration1", "registration2"]);
  // Only the new open's baseline checkpoint remains, on top of the resaved version.
  expect(state.queue.list("account1")).toMatchObject([
    { expectedVersion: 5, readyToSubmit: false, status: "pending" },
  ]);
  state.queue.close();
  state.store.close();
});

test("Cloud close diagnostics retain unsynchronized transport failures", async () => {
  const state = setup({ closeTransportFailure: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });

  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "retrying",
  }]);
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("cleanup_retained");
  state.queue.close();
  state.store.close();
});

test("Instagram authentication survives Cloud close and reopen", async () => {
  const state = setup({
    platform: "instagram.com",
    session: { cookies: [], origins: [] },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  const captured = instagramSession("round-trip");
  options.readSession = async () => {
    state.events.push("capture");
    return JSON.stringify(captured);
  };
  const originalStop = options.launcher.stop;
  options.launcher.stop = async (profileId: string) => {
    const summary = state.queue.list("account1").find((item) => item.profileId === profileId)!;
    const checkpoint = state.queue.get(summary.id, "account1")!;
    expect(checkpoint.readyToSubmit).toBe(false);
    expect(checkpoint.payload.session).toEqual(captured);
    return originalStop(profileId);
  };
  let acceptedPayload: PortableProfileV1 | undefined;
  options.cloud.closeOpen = async (
    registrationId: string,
    request: { expectedVersion: number; payload: PortableProfileV1 },
  ) => {
    state.events.push("cloud-close");
    expect(registrationId).toBe("registration1");
    expect(request.expectedVersion).toBe(4);
    acceptedPayload = structuredClone(request.payload);
    return { ok: true, status: "accepted", version: 5 };
  };

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(acceptedPayload?.session).toEqual(captured);

  options.cloud.openProfile = async () => ({
    ok: true,
    registrationId: "registration2",
    baseVersion: 5,
    payload: structuredClone(acceptedPayload!),
    activeOpens: [],
  });
  let restored: PortableProfileV1["session"] | undefined;
  options.applySession = async (_endpoint: string, bundle: string) => {
    restored = JSON.parse(bundle);
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(restored).toEqual(captured);
  expect(restored?.cookies).toContainEqual(expect.objectContaining({
    name: "sessionid",
    domain: ".instagram.com",
  }));
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Instagram checkpoint survives a failed Cloud close until retry", async () => {
  const state = setup({
    platform: "instagram.com",
    session: { cookies: [], origins: [] },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  const captured = instagramSession("retry");
  options.readSession = async () => JSON.stringify(captured);
  const requests: PortableProfileV1[] = [];
  let acceptClose = false;
  let acceptedPayload: PortableProfileV1 | undefined;
  options.cloud.closeOpen = async (
    _registrationId: string,
    request: { payload: PortableProfileV1 },
  ) => {
    requests.push(structuredClone(request.payload));
    if (!acceptClose) throw new Error("offline");
    acceptedPayload = structuredClone(request.payload);
    return { ok: true, status: "accepted", version: 5 };
  };

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });
  const summary = state.queue.list("account1")[0]!;
  expect(summary).toMatchObject({ readyToSubmit: true, status: "retrying" });
  expect(state.queue.get(summary.id, "account1")?.payload.session).toEqual(captured);

  let cloudOpenCalls = 0;
  options.cloud.openProfile = async () => {
    cloudOpenCalls++;
    return {
      ok: true,
      registrationId: "registration2",
      baseVersion: 4,
      payload: payload(),
      activeOpens: [],
    };
  };
  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "Pending Cloud synchronization must be resolved before reopening",
  });
  expect(cloudOpenCalls).toBe(0);
  expect(state.queue.get(summary.id, "account1")?.payload.session).toEqual(captured);

  acceptClose = true;
  await state.coordinator.retryPending();
  expect(state.queue.list("account1")).toEqual([]);
  const firstRequest = requests[0]!;
  expect(requests.slice(0, 3)).toEqual([firstRequest, firstRequest, firstRequest]);

  options.cloud.openProfile = async () => {
    cloudOpenCalls++;
    return {
      ok: true,
      registrationId: "registration2",
      baseVersion: 5,
      payload: structuredClone(acceptedPayload!),
      activeOpens: [],
    };
  };
  let restored: PortableProfileV1["session"] | undefined;
  options.applySession = async (_endpoint: string, bundle: string) => {
    restored = JSON.parse(bundle);
  };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(cloudOpenCalls).toBe(1);
  expect(restored).toEqual(captured);
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud close starts pending retry and permits sign-out after confirmed teardown", async () => {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const state = setup({
    closeTransportFailure: true,
    heartbeatMs: 60_000,
    setIntervalFn(fn) {
      const timer = ++nextTimer;
      timers.set(timer, fn);
      return timer;
    },
    clearIntervalFn(handle) {
      timers.delete(handle as number);
    },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });

  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.listOpens("account1")).toEqual([]);
  expect(timers.size).toBe(1);
  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "retrying",
  }]);
  expect(timers.size).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll rejects an unready checkpoint without confirmed teardown", async () => {
  const state = setup();
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 4,
    payload: payload(),
    readyToSubmit: false,
  });

  expect(await state.coordinator.releaseAll()).toBe(false);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: false,
  }]);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll retries a pending-only close after recovery", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  let recovered = false;
  options.cloud.closeOpen = async () => {
    if (!recovered) throw new Error("offline");
    return { ok: true, status: "accepted", version: 5 };
  };
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });

  recovered = true;
  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll succeeds when a close retry drains its early failure", async () => {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const state = setup({
    heartbeatMs: 60_000,
    setIntervalFn(fn) {
      const timer = ++nextTimer;
      timers.set(timer, fn);
      return timer;
    },
    clearIntervalFn(handle) {
      timers.delete(handle as number);
    },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  let attempts = 0;
  options.cloud.closeOpen = async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    return { ok: true, status: "accepted", version: 5 };
  };

  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(attempts).toBe(2);
  expect(state.queue.list("account1")).toEqual([]);
  expect(timers.size).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll permits sign-out after a conflicted confirmed close", async () => {
  const state = setup({ closeConflict: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "conflict" });

  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.listOpens("account1")).toEqual([]);
  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "conflict",
  }]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser refuses reopen while an older close remains unsynchronized", async () => {
  const state = setup({ closeTransportFailure: true });
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "older-registration",
    expectedVersion: 3,
    payload: payload(),
  });
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result).toEqual({
    ok: false,
    error: "Pending Cloud synchronization must be resolved before reopening",
  });
  expect(state.events).toEqual(["cloud-close"]);
  expect(state.queue.list("account1")[0]).toMatchObject({ status: "retrying" });
  state.queue.close();
  state.store.close();
});

test("Cloud browser ignores only its new registration in legacy active-open warnings", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    return {
      ok: true,
      registrationId: "registration2",
      baseVersion: 4,
      payload: payload(),
      activeOpens: [{
        registrationId: "registration2",
        accountId: "account1",
        memberEmail: "member@example.com",
        deviceId: "device1",
        deviceLabel: "This PC",
        openedAt: 1,
        heartbeatAt: 2,
      }],
    };
  };

  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toMatchObject({
    ok: true,
    port: 9222,
  });
  expect(state.events).toEqual(["cloud-open", "start", "restore"]);
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  state.queue.close();
  state.store.close();
});

test("Cloud roster excludes only the exact local registration", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  options.cloud.listProfiles = async () => ({
    ok: true,
    profiles: [{
      id: "profile1",
      name: "Profile",
      group: "",
      platform: "x.com",
      tags: [],
      version: 4,
      trashedAt: null,
      trashedBy: null,
      updatedAt: 1,
      permission: "edit",
      activeOpens: [
        {
          registrationId: "registration1",
          accountId: "account1",
          memberEmail: "member@example.com",
          deviceId: "device1",
          deviceLabel: "This PC",
          openedAt: 1,
          heartbeatAt: 2,
        },
        {
          registrationId: "registration-other",
          accountId: "account1",
          memberEmail: "member@example.com",
          deviceId: "device1",
          deviceLabel: "This PC",
          openedAt: 1,
          heartbeatAt: 2,
        },
      ],
    }],
  });

  const roster = await state.coordinator.listRoster();

  expect(roster.profiles[0]?.lockedBy).toBe("1 other session(s)");
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  state.queue.close();
  state.store.close();
});

test("Cloud roster excludes the exact registration retained for pending sync", async () => {
  const state = setup({ closeTransportFailure: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });
  const options = (state.coordinator as any).options;
  options.cloud.listProfiles = async () => ({
    ok: true,
    profiles: [{
      id: "profile1",
      name: "Profile",
      group: "",
      platform: "x.com",
      tags: [],
      version: 4,
      trashedAt: null,
      trashedBy: null,
      updatedAt: 1,
      permission: "edit",
      activeOpens: [{
        registrationId: "registration1",
        accountId: "account1",
        memberEmail: "member@example.com",
        deviceId: "device1",
        deviceLabel: "This PC",
        openedAt: 1,
        heartbeatAt: 2,
      }],
    }],
  });

  const roster = await state.coordinator.listRoster();

  expect(roster.profiles[0]?.lockedBy).toBeNull();

  // The upload can finish while a slow roster is still downloading. Cloud built
  // that reply before the close, so it still lists this device's registration.
  const listProfiles = options.cloud.listProfiles;
  options.cloud.listProfiles = async () => {
    for (const pending of state.queue.list("account1")) state.queue.remove(pending.id, "account1");
    return listProfiles();
  };
  const afterUpload = await state.coordinator.listRoster();

  expect(afterUpload.profiles[0]?.lockedBy).toBeNull();
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud browser rejects a legacy concurrent-open response before launch", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    return {
      ok: true,
      registrationId: "registration2",
      baseVersion: 4,
      payload: payload(),
      activeOpens: [{
        registrationId: "registration1",
        accountId: "account1",
        memberEmail: "member@example.com",
        deviceId: "device2",
        deviceLabel: "Other PC",
        openedAt: 1,
        heartbeatAt: 2,
      }],
    };
  };

  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "This Cloud profile is open in another session. Close it there, or try again shortly if that browser already closed.",
  });
  expect(state.events).toEqual(["cloud-open", "abandon"]);
  expect(state.startCalls()).toBe(0);
  expect(state.restoreEndpoints).toEqual([]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
  state.store.close();
});

test("Cloud browser retains durable cleanup when legacy concurrent-open abandon fails", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    return {
      ok: true,
      registrationId: "registration2",
      baseVersion: 4,
      payload: payload(),
      activeOpens: [{
        registrationId: "registration1",
        accountId: "account1",
        memberEmail: "member@example.com",
        deviceId: "device2",
        deviceLabel: "Other PC",
        openedAt: 1,
        heartbeatAt: 2,
      }],
    };
  };
  state.setAbandonHook(() => { throw new Error("offline"); });

  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "This Cloud profile is open in another session. Close it there, or try again shortly if that browser already closed.",
  });
  expect(state.events).toEqual(["cloud-open", "abandon"]);
  expect(state.startCalls()).toBe(0);
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration2",
    cleanupMode: "abandon",
  });
  expect(await state.coordinator.releaseAll()).toBe(false);
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration2",
    cleanupMode: "abandon",
  });
  state.queue.close();
  state.store.close();
});

test("Cloud browser reports an exclusive-open rejection without local lifecycle state", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    throw new CloudApiError("already open", "profile_open", 409);
  };

  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "This Cloud profile is open in another session. Close it there, or try again shortly if that browser already closed.",
  });
  expect(state.events).toEqual(["cloud-open"]);
  expect(state.startCalls()).toBe(0);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
  state.store.close();
});

for (const checkpoint of ["saved", "missing", "offline", "conflict"] as const) {
  test(`Cloud authentication resumes a confirmed-dead browser with ${checkpoint} checkpoint`, async () => {
    const state = setup({ closeTransportFailure: checkpoint === "offline", closeConflict: checkpoint === "conflict" });
    try {
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      const options = (state.coordinator as any).options;
      options.launcher.verifyRunningIdentity = async () => { throw new Error("browser exited"); };
      state.setReconcileHook(() => state.store.clearLaunch("profile1"));
      if (checkpoint === "missing") state.queue.removeUnreadyCaptures("profile1", "account1", "registration1");
      const before = state.queue.list("account1")[0];
      const recovered = new CloudBrowserCoordinator(options);
      state.events.length = 0;

      await recovered.resumeAfterAuthentication();

      expect(state.events).toContain("reconcile");
      expect(state.events).not.toContain("capture");
      expect(state.events).not.toContain("stop");
      expect(state.store.getLaunch("profile1")).toBeNull();
      expect(state.queue.getOpen("profile1", "account1")).toBeNull();
      expect(state.abandonCalls()).toBe(checkpoint === "missing" ? 1 : 0);
      if (checkpoint === "offline" || checkpoint === "conflict") {
        expect(state.queue.list("account1")).toMatchObject([{
          id: before!.id, readyToSubmit: true,
          status: checkpoint === "offline" ? "retrying" : "conflict",
        }]);
        expect(state.queue.get(before!.id, "account1")?.payload.session).toEqual(payload().session);
      } else {
        expect(state.queue.list("account1")).toEqual([]);
      }
    } finally {
      state.queue.close();
      state.store.close();
    }
  });
}

for (const cleanupMode of ["discard", "abandon", "sync"] as const) {
  test(`Cloud authentication preserves ${cleanupMode} cleanup after browser death`, async () => {
    const state = setup();
    try {
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      const options = (state.coordinator as any).options;
      options.launcher.verifyRunningIdentity = async () => { throw new Error("browser exited"); };
      state.setReconcileHook(() => state.store.clearLaunch("profile1"));
      (state.coordinator as any).stopHeartbeatAndWait = async () => {
        expect(state.queue.setOpenCleanup("profile1", "account1", "registration1", cleanupMode)).toBe(true);
      };
      const pending = state.queue.list("account1");
      state.events.length = 0;

      await state.coordinator.resumeAfterAuthentication();

      expect(state.queue.getOpen("profile1", "account1")?.cleanupMode).toBe(cleanupMode);
      expect(state.queue.list("account1")).toEqual(pending);
      expect(state.closeCalls()).toBe(0);
      expect(state.abandonCalls()).toBe(0);
      expect(state.events).not.toContain("capture");
      expect(state.events).not.toContain("stop");
    } finally {
      state.queue.close();
      state.store.close();
    }
  });
}

for (const failure of ["identity", "capture", "reconciliation"] as const) {
  test(`Cloud authentication retains an uncertain survivor after ${failure} failure`, async () => {
    const state = setup({ activeResult: false });
    try {
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      const options = (state.coordinator as any).options;
      if (failure !== "capture") options.launcher.verifyRunningIdentity = async () => { throw new Error("identity unavailable"); };
      if (failure === "capture") options.readSession = async () => { throw new Error("capture unavailable"); };
      if (failure === "reconciliation") state.setReconcileHook(() => { throw new Error("process probe unavailable"); });
      const before = state.queue.list("account1");
      state.events.length = 0;

      await state.coordinator.resumeAfterAuthentication();

      expect(state.events).not.toContain("stop");
      expect(state.closeCalls()).toBe(0);
      expect(state.abandonCalls()).toBe(0);
      expect(state.store.getLaunch("profile1")).not.toBeNull();
      expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
      expect(state.queue.list("account1")).toEqual(before);
    } finally {
      state.queue.close();
      state.store.close();
    }
  });
}

test("Cloud authentication isolates an uncertain profile and later recovers confirmed death", async () => {
  const state = setup();
  const resumed: string[] = [];
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    state.store.upsertProfile({ ...state.store.getProfile("profile1")!, id: "profile2" });
    state.store.recordLaunch({ ...state.store.getLaunch("profile1")!, profileId: "profile2", debugPort: 9333, startedAt: 2000 });
    state.queue.recordOpen({ accountId: "account1", profileId: "profile2", registrationId: "registration2", expectedVersion: 4 });
    state.queue.updateOpen("profile2", "account1", "running", { debugPort: 9333, startedAt: 2000 });
    expect(state.queue.listOpens("account1").map(open => open.profileId)).toEqual(["profile1", "profile2"]);
    const options = (state.coordinator as any).options;
    options.launcher.verifyRunningIdentity = async (id: string) => {
      if (id === "profile1") throw new Error("ownership unavailable");
    };
    (state.coordinator as any).startHeartbeat = (id: string) => { resumed.push(id); };
    const launch = state.store.getLaunch("profile1");
    const pending = state.queue.list("account1");
    state.events.length = 0;

    await state.coordinator.resumeAfterAuthentication();

    expect(resumed).toEqual(["profile2"]);
    expect(state.store.getLaunch("profile1")).toEqual(launch);
    expect(state.queue.list("account1")).toEqual(pending);
    expect(state.closeCalls()).toBe(0);
    expect(state.abandonCalls()).toBe(0);
    expect((await state.coordinator.open("profile1")).ok).toBe(false);
    expect(state.events).not.toContain("cloud-open");
    expect(state.events).not.toContain("start");
    expect(state.events).not.toContain("capture");
    expect(state.events).not.toContain("stop");

    state.setReconcileHook(() => state.store.clearLaunch("profile1"));
    await rosterReconciled(state.coordinator);

    expect(state.queue.getOpen("profile1", "account1")).toBeNull();
    expect(state.queue.list("account1")).toEqual([]);
    expect(state.closeCalls()).toBe(1);
    expect(state.abandonCalls()).toBe(0);
    expect(state.queue.getOpen("profile2", "account1")?.registrationId).toBe("registration2");
    expect(state.events).not.toContain("capture");
    expect(state.events).not.toContain("stop");
  } finally {
    state.queue.close();
    state.store.close();
  }
});

for (const changed of ["registration", "launch", "authentication"] as const) {
  test(`Cloud authentication does not finalize a survivor after ${changed} changes during reconciliation`, async () => {
    let current = true;
    const state = setup();
    try {
      expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
      const options = (state.coordinator as any).options;
      options.launcher.verifyRunningIdentity = async () => { throw new Error("browser unavailable"); };
      options.launcher.reconcileOrphan = async (_id: string, expected: { debugPort: number; startedAt: number }) => {
        expect(expected).toEqual({ debugPort: 9222, startedAt: 1000 });
        state.store.clearLaunch("profile1");
        if (changed === "registration") {
          state.queue.removeOpen("profile1", "account1");
          state.queue.recordOpen({ accountId: "account1", profileId: "profile1", registrationId: "replacement", expectedVersion: 5 });
        } else if (changed === "launch") {
          state.store.recordLaunch({ profileId: "profile1", pid: 11, debugPort: 9333, ws: "ws://replacement", startedAt: 2000 });
        } else {
          current = false;
        }
        return "dead";
      };
      const pending = state.queue.list("account1");
      await state.coordinator.resumeAfterAuthentication(() => current);

      expect(state.closeCalls()).toBe(0);
      expect(state.abandonCalls()).toBe(0);
      expect(state.events).not.toContain("capture");
      expect(state.events).not.toContain("stop");
      expect(state.queue.list("account1")).toEqual(pending);
      expect(state.queue.getOpen("profile1", "account1")?.registrationId).toBe(changed === "registration" ? "replacement" : "registration1");
      if (changed === "launch") expect(state.store.getLaunch("profile1")?.startedAt).toBe(2000);
    } finally {
      state.queue.close();
      state.store.close();
    }
  });
}

test("Cloud authentication secures a previous account browser before legal acceptance", async () => {
  const state = setup();
  state.store.upsertProfile(decodePortableProfile(payload()).profile);
  state.store.recordLaunch({
    profileId: "profile1",
    pid: 10,
    debugPort: 9222,
    ws: "ws://browser",
    startedAt: 1_000,
    sessionBaseVersion: 4,
  });
  state.queue.recordOpen({
    accountId: "previous-account",
    profileId: "profile1",
    registrationId: "previous-registration",
    expectedVersion: 4,
  });
  state.queue.updateOpen("profile1", "previous-account", "running", {
    debugPort: 9222,
    startedAt: 1_000,
  });

  await state.coordinator.secureAfterAuthentication();

  expect(state.events).toEqual(["capture", "stop"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "previous-account")).toBeNull();
  expect(state.queue.list("previous-account")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "pending",
  }]);
  expect(state.closeCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud authentication abandons a stopped previous-account restore", async () => {
  const state = setup();
  state.store.recordLaunch({
    profileId: "profile1",
    pid: 10,
    debugPort: 9222,
    ws: "ws://browser",
    startedAt: 1_000,
    sessionBaseVersion: -1,
  });
  state.queue.recordOpen({
    accountId: "previous-account",
    profileId: "profile1",
    registrationId: "previous-registration",
    expectedVersion: 4,
  });
  state.queue.updateOpen("profile1", "previous-account", "restoring", {
    debugPort: 9222,
    startedAt: 1_000,
  });

  await state.coordinator.secureAfterAuthentication();

  expect(state.events).toEqual(["stop", "abandon"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "previous-account")).toBeNull();
  expect(state.abandonCalls()).toBe(1);
  state.queue.close();
  state.store.close();
});

test("Cloud authentication retries a failed previous-account restore abandon", async () => {
  const state = setup();
  state.store.recordLaunch({
    profileId: "profile1",
    pid: 10,
    debugPort: 9222,
    ws: "ws://browser",
    startedAt: 1_000,
    sessionBaseVersion: -1,
  });
  state.queue.recordOpen({
    accountId: "previous-account",
    profileId: "profile1",
    registrationId: "previous-registration",
    expectedVersion: 4,
  });
  state.queue.updateOpen("profile1", "previous-account", "restoring", {
    debugPort: 9222,
    startedAt: 1_000,
  });
  let attempts = 0;
  state.setAbandonHook(() => {
    if (++attempts === 1) throw new Error("offline");
  });

  await expect(state.coordinator.secureAfterAuthentication()).rejects.toThrow("could not be stopped");
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "previous-account")?.phase).toBe("restoring");

  await state.coordinator.secureAfterAuthentication();
  expect(state.queue.getOpen("profile1", "previous-account")).toBeNull();
  expect(state.abandonCalls()).toBe(2);
  state.queue.close();
  state.store.close();
});

test("Cloud authentication replaces checkpoint monitors after an account switch", async () => {
  let accountId = "account1";
  let nextTimer = 0;
  const activeTimers = new Set<number>();
  const dirtyCallbacks: Array<() => void> = [];
  let watcherCloses = 0;
  const state = setup({
    accountId: () => accountId,
    heartbeatMs: 60_000,
    storageCheckpoints: true,
    checkpointDebounceMs: 0,
    checkpointMinIntervalMs: 0,
    watchPaths: ["browser-storage"],
    setIntervalFn() {
      const timer = ++nextTimer;
      activeTimers.add(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      activeTimers.delete(timer as number);
    },
    watchPath(_path, dirty) {
      dirtyCallbacks.push(dirty);
      return { close() { watcherCloses++; } };
    },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const internals = state.coordinator as any;
  const firstMonitor = internals.dirtyMonitors.get("profile1");
  const firstTimers: number[] = internals.timers.get("profile1");
  expect(firstMonitor).toBeDefined();
  expect([...activeTimers]).toEqual(firstTimers);

  accountId = "account2";
  await state.coordinator.secureAfterAuthentication();

  expect(internals.dirtyMonitors.has("profile1")).toBe(false);
  expect(internals.timers.has("profile1")).toBe(false);
  expect(activeTimers.size).toBe(0);
  expect(watcherCloses).toBe(1);

  accountId = "account1";
  await state.coordinator.resumeAfterAuthentication();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const secondMonitor = internals.dirtyMonitors.get("profile1");
  const secondTimers: number[] = internals.timers.get("profile1");
  expect(secondMonitor).toBeDefined();
  expect(secondMonitor).not.toBe(firstMonitor);
  expect(secondTimers).toHaveLength(2);
  expect(secondTimers.every((timer) => activeTimers.has(timer) && !firstTimers.includes(timer))).toBe(true);

  const capturesBeforeDirtySignal = state.events.filter((event) => event === "capture").length;
  dirtyCallbacks[0]!();
  await Bun.sleep(10);
  expect(state.events.filter((event) => event === "capture")).toHaveLength(capturesBeforeDirtySignal);
  dirtyCallbacks[1]!();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (state.events.filter((event) => event === "capture").length > capturesBeforeDirtySignal) break;
    await Bun.sleep(5);
  }
  expect(state.events.filter((event) => event === "capture")).toHaveLength(capturesBeforeDirtySignal + 1);

  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll refuses to forget running browsers without restored account context", async () => {
  let accountId: string | undefined = "account1";
  const state = setup({ accountId: () => accountId as string });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  accountId = undefined;

  expect(await state.coordinator.releaseAll()).toBe(false);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.listOpens("account1")).toHaveLength(1);

  accountId = "account1";
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("cancelled Cloud authentication resume admits no later pending close", async () => {
  const state = setup();
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 4,
    payload: payload(),
  });
  await Bun.sleep(2);
  const secondPayload = payload();
  secondPayload.profile.id = "profile2";
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile2",
    registrationId: "registration2",
    expectedVersion: 4,
    payload: secondPayload,
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let finishFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { finishFirst = resolve; });
  const seen: string[] = [];
  const internals = state.coordinator as any;
  internals.options.cloud.closeOpen = async (registrationId: string) => {
    seen.push(registrationId);
    if (registrationId === "registration1") {
      markFirstStarted();
      await firstPending;
    }
    return { ok: true as const, status: "accepted" as const, version: 5 };
  };
  let current = true;

  const resuming = state.coordinator.resumeAfterAuthentication(() => current);
  await firstStarted;
  current = false;
  finishFirst();
  await resuming;

  expect(seen).toEqual(["registration1"]);
  expect(state.queue.list("account1")).toHaveLength(1);
  expect(state.queue.list("account1")[0]?.profileId).toBe("profile2");
  expect(internals.draining).toBe(true);
  state.queue.close();
  state.store.close();
});

test("cancelled Cloud authentication resume keeps lifecycle admission closed", async () => {
  const state = setup({ heartbeatMs: 60_000 });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const internals = state.coordinator as any;
  internals.stopHeartbeat("profile1");

  let markProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
  let finishProbe!: () => void;
  const probePending = new Promise<void>((resolve) => { finishProbe = resolve; });
  internals.options.launcher.active = async () => {
    markProbeStarted();
    await probePending;
    return true;
  };
  let current = true;
  const eventsBeforeResume = state.events.length;

  const resuming = state.coordinator.resumeAfterAuthentication(() => current);
  await probeStarted;
  current = false;
  finishProbe();
  await resuming;

  expect(internals.draining).toBe(true);
  expect(internals.timers.has("profile1")).toBe(false);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.listOpens("account1")).toHaveLength(1);
  expect(state.events.slice(eventsBeforeResume)).not.toContain("capture");
  expect(state.events.slice(eventsBeforeResume)).not.toContain("stop");

  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud sign-out drain remains reusable after the next sign-in", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(state.queue.listOpens("account1")).toEqual([]);
  await state.coordinator.resumeAfterAuthentication();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.queue.close();
  state.store.close();
});

test("Cloud pending close retries only after same-account reauthentication", async () => {
  let accountId = "account1";
  const state = setup({
    accountId: () => accountId,
    closeTransportFailure: true,
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "pending" });
  expect(await state.coordinator.releaseAll()).toBe(true);
  expect(state.queue.list("account1")).toHaveLength(1);

  let submissions = 0;
  (state.coordinator as any).options.cloud.closeOpen = async () => {
    submissions++;
    return { ok: true, status: "accepted", version: 5 };
  };
  accountId = "account2";
  await state.coordinator.resumeAfterAuthentication();
  expect(submissions).toBe(0);
  expect(state.queue.list("account1")).toHaveLength(1);

  accountId = "account1";
  await state.coordinator.resumeAfterAuthentication();
  expect(submissions).toBe(1);
  expect(state.queue.list("account1")).toEqual([]);
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("failed Cloud sign-out drain keeps the current account usable", async () => {
  const state = setup({ stopResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.releaseAll()).toBe(false);
  state.queue.removeUnreadyCaptures("profile1", "account1", "registration1");
  state.queue.removeOpenRegistration("profile1", "account1", "registration1");
  state.store.clearLaunch("profile1");

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.queue.close();
  state.store.close();
});

test("Cloud drain waits for an already admitted open", async () => {
  const state = setup();
  let resolveOpen!: (value: OpenProfileResponse) => void;
  const gate = new Promise<OpenProfileResponse>((resolve) => { resolveOpen = resolve; });
  (state.coordinator as any).options.cloud.openProfile = () => gate;
  const opening = state.coordinator.open("profile1", ["--window-size=1200,800"]);
  const draining = state.coordinator.releaseAll();
  resolveOpen({
    ok: true,
    registrationId: "registration1",
    baseVersion: 4,
    payload: payload(),
    activeOpens: [],
  });
  expect((await opening).ok).toBe(true);
  expect(await draining).toBe(true);
  expect(state.queue.listOpens("account1")).toEqual([]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("folder access revocation stops without capturing or submitting", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("denied", "folder_access_denied", 403);
  };

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["reconcile", "stop"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.closeCalls()).toBe(0);
  expect(state.abandonCalls()).toBe(0);
  const diagnostics = state.coordinator.diagnostics().map((event) => event.type);
  expect(diagnostics).toContain("heartbeat_terminal_access_ended");
  expect(diagnostics).toContain("access_ended");
  state.queue.close();
  state.store.close();
});

test("folder access revocation retries retained teardown without submitting", async () => {
  const state = setup({ stopResult: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("denied", "folder_access_denied", 403);
  };

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")?.cleanupMode).toBe("discard");
  expect(state.queue.list("account1")).toHaveLength(1);
  expect(state.closeCalls()).toBe(0);
  expect(state.abandonCalls()).toBe(0);

  (state.coordinator as any).options.launcher.stop = async (profileId: string) => {
    state.events.push("stop-retry");
    state.store.clearLaunch(profileId);
    return true;
  };
  await state.coordinator.retryPending();

  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.closeCalls()).toBe(0);
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("terminal Cloud heartbeat errors capture and stop the browser", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("revoked", "device_revoked", 403);
  };
  (state.coordinator as any).options.cloud.closeOpen = async () => {
    throw new CloudApiError("revoked", "device_revoked", 403);
  };
  await state.coordinator.heartbeatOnce("profile1");
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "conflict",
    error: "device_revoked",
  }]);
  expect(state.coordinator.diagnostics().map((event) => event.type)).toEqual(
    expect.arrayContaining(["heartbeat_terminal_access_ended", "session_sync_conflict"]),
  );
  state.queue.close();
  state.store.close();
});

test("version-conflict heartbeat records the terminal conflict class", async () => {
  const state = setup({ closeConflict: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("stale", "version_conflict", 409);
  };
  (state.coordinator as any).options.cloud.openProfile = async () => {
    throw new CloudApiError("open elsewhere", "profile_open", 409);
  };

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.coordinator.diagnostics().map((event) => event.type)).toContain(
    "heartbeat_terminal_conflict",
  );
  state.queue.close();
  state.store.close();
});

test("terminal heartbeat reconciles confirmed browser death before capture", async () => {
  const state = setup({ closeConflict: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));
  (state.coordinator as any).options.cloud.heartbeat = async () => {
    throw new CloudApiError("stale", "version_conflict", 409);
  };

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["reconcile", "cloud-close"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")[0]).toMatchObject({ status: "conflict" });
  expect(state.coordinator.diagnostics().map((event) => event.type)).toContain(
    "browser_death_confirmed",
  );
  state.queue.close();
  state.store.close();
});

test("Cloud browser reports fixed safe browser launch operations", async () => {
  const operations = [
    "preflight",
    "mode_conflict",
    "binary_verification",
    "profile_directory",
    "relay_setup",
    "process_spawn",
    "cdp_readiness",
  ] as const;

  for (const operation of operations) {
    const state = setup({ startError: new BrowserLaunchError(operation) });
    const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

    expect(result).toEqual({
      ok: false,
      error: `Cloud profile open failed at browser_launch/${operation} (failed)`,
    });
    expect(state.coordinator.diagnostics().map((event) => event.type).slice(-2)).toEqual([
      `browser_launch_${operation}_failed`,
      "open_failed",
    ]);
    const publicState = JSON.stringify({ result, logs: state.logs, diagnostics: state.coordinator.diagnostics() });
    for (const secret of [
      "credential-secret-value",
      "session-secret-value",
      "proxy-secret-value",
      "https://secret.invalid",
    ]) {
      expect(publicState).not.toContain(secret);
    }
    expect(state.abandonCalls()).toBe(1);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud browser normalizes an untyped launcher adapter failure", async () => {
  const rawFailure = "sentinel launcher adapter failure";
  const state = setup({ startError: new Error(rawFailure) });

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

  expect(result).toEqual({
    ok: false,
    error: "Cloud profile open failed at browser_launch/preflight (failed)",
  });
  expect(state.coordinator.diagnostics().map((event) => event.type).slice(-2)).toEqual([
    "browser_launch_preflight_failed",
    "open_failed",
  ]);
  expect(JSON.stringify({ result, logs: state.logs, diagnostics: state.coordinator.diagnostics() })).not.toContain(rawFailure);
  state.queue.close();
  state.store.close();
});

test("Cloud browser reports the exact safe session restore operation", async () => {
  const state = setup();
  (state.coordinator as any).options.applySession = async () => {
    throw new SessionRestoreError("cookie_clear", "failed");
  };

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

  expect(result).toMatchObject({
    ok: false,
    error: "Cloud profile open failed at session_restore/cookie_clear (failed); browser left open",
  });
  expect(state.logs.filter((l) => l.includes("Cloud open failed"))).toEqual([
    "profile1: Cloud open failed at session_restore/cookie_clear (failed, SessionRestoreError)",
  ]);
  expect(state.coordinator.diagnostics().map((event) => event.type).slice(-3)).toEqual([
    "session_restore_cookie_clear_failed",
    "open_failed",
    "cleanup_retained",
  ]);
  const diagnostics = JSON.stringify(state.coordinator.diagnostics());
  for (const secret of [
    "profile1",
    "account1",
    "device1",
    "registration1",
    "ws://browser",
    "credential-secret-value",
    "session-secret-value",
  ]) {
    expect(diagnostics).not.toContain(secret);
  }
  expect(state.abandonCalls()).toBe(0);
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("restoring");
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud roster stays available without claiming an unreadable pending registration", async () => {
  const state = setup();
  try {
    const id = state.queue.enqueue({
      accountId: "account1", profileId: "profile1", registrationId: "unreadable-registration",
      expectedVersion: 2, payload: payload(),
    });
    (state.queue as any).db.query("UPDATE pending_closes SET ciphertext = zeroblob(3) WHERE id = ?").run(id);
    const cloud = (state.coordinator as any).options.cloud;
    const originalList = cloud.listProfiles;
    cloud.listProfiles = async () => {
      const response = await originalList();
      response.profiles.push({ ...response.profiles[0], id: "profile2", activeOpens: [] });
      response.profiles[0].activeOpens = [{ registrationId: "unreadable-registration" }];
      return response;
    };
    const roster = await state.coordinator.listRoster();
    expect(roster.profiles).toMatchObject([
      { id: "profile1", lockedBy: "1 other session(s)" },
      { id: "profile2", lockedBy: null },
    ]);
    expect(state.queue.list("account1")).toMatchObject([{ id, status: "pending", error: null }]);
    expect(() => state.queue.get(id, "account1")).toThrow();
    expect(state.queue.listOpens("account1")).toEqual([]);
    expect(state.startCalls()).toBe(0);
  } finally {
    state.queue.close();
    state.store.close();
  }
});

test("Cloud browser isolates an unreadable pending close without reopening its profile", async () => {
  const state = setup();
  try {
    const id = state.queue.enqueue({
      accountId: "account1", profileId: "profile2", registrationId: "unreadable-registration",
      expectedVersion: 2, payload: { ...payload(), profile: { ...payload().profile, id: "profile2" } },
    });
    (state.queue as any).db.query("UPDATE pending_closes SET ciphertext = zeroblob(3) WHERE id = ?").run(id);
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    expect(state.startCalls()).toBe(1);
    expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
      registrationId: "registration1", phase: "running",
    });
    expect(await state.coordinator.open("profile2", [])).toMatchObject({
      ok: false, error: "Pending Cloud synchronization must be resolved before reopening",
    });
    expect(state.startCalls()).toBe(1);
    expect(state.events.filter((event) => event === "cloud-open")).toHaveLength(1);
    expect(state.queue.getOpen("profile2", "account1")).toBeNull();
    const pending = state.queue.list("account1");
    expect(pending.find((entry) => entry.id === id)).toMatchObject({
      profileId: "profile2", status: "retrying", error: "local_read_failed",
    });
    expect(pending.find((entry) => entry.profileId === "profile1")).toMatchObject({
      status: "pending", readyToSubmit: false,
    });
    expect(() => state.queue.get(id, "account1")).toThrow();
  } finally {
    if (state.startCalls() > 0) await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud browser logs the local queue error behind a pending_sync open failure", async () => {
  const state = setup();
  const queue = (state.coordinator as any).options.queue();
  queue.list = () => { throw new Error("Unsupported state or unable to authenticate data"); };
  const result = await state.coordinator.open("profile1", []);
  expect(result).toMatchObject({
    ok: false,
    error: "Cloud profile open failed at pending_sync (transport_error)",
  });
  expect(state.logs.filter((l) => l.includes("Cloud open failed"))).toEqual([
    "profile1: Cloud open failed at pending_sync (transport_error, Error): Unsupported state or unable to authenticate data",
  ]);
  state.store.close();
});

test("Cloud browser reports a safe restore stage and retains the verified browser", async () => {
  const state = setup();
  (state.coordinator as any).options.applySession = async () => { throw new Error("secret restore detail"); };
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result).toMatchObject({
    ok: false,
    error: "Cloud profile open failed at session_restore (transport_error); browser left open",
  });
  expect(state.logs.filter((l) => l.includes("Cloud open failed"))).toEqual([
    "profile1: Cloud open failed at session_restore (transport_error, Error)",
  ]);
  expect(JSON.stringify({ result, logs: state.logs })).not.toContain("secret restore detail");
  expect(state.abandonCalls()).toBe(0);
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("restoring");
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud browser logs the launcher identity check behind a session_restore failure", async () => {
  const state = setup();
  (state.coordinator as any).options.launcher.verifyRunningIdentity = async () => {
    if (state.startCalls() === 0) return;
    throw new Error("cannot verify survivor profile1: browser identity/CDP is unavailable");
  };
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result).toMatchObject({ ok: false, error: "Cloud profile open failed at session_restore (transport_error)" });
  expect(state.logs.filter((l) => l.includes("Cloud open failed"))).toEqual([
    "profile1: Cloud open failed at session_restore (transport_error, Error): " +
      "cannot verify survivor profile1: browser identity/CDP is unavailable",
  ]);
  state.queue.close();
  state.store.close();
});

test("Cloud lease renewal continues while checkpoint capture is blocked", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  let captureStarted!: () => void;
  let releaseCapture!: () => void;
  const started = new Promise<void>((resolve) => { captureStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseCapture = resolve; });
  (state.coordinator as any).options.readSession = async () => {
    state.events.push("capture");
    captureStarted();
    await blocked;
    return JSON.stringify({ ...payload().session, origins: [] });
  };
  state.events.length = 0;

  const first = state.coordinator.heartbeatOnce("profile1");
  await started;
  const second = state.coordinator.heartbeatOnce("profile1");
  try {
    await Bun.sleep(0);
    expect(state.events.filter((event) => event === "heartbeat")).toHaveLength(2);
    expect(state.events.filter((event) => event === "capture")).toHaveLength(1);
  } finally {
    releaseCapture();
    await Promise.allSettled([first, second]);
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("Cloud close renews its lease through capture and confirmed teardown", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  let captureStarted!: () => void;
  let releaseCapture!: () => void;
  let stopStarted!: () => void;
  let releaseStop!: () => void;
  const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const captureReady = new Promise<void>((resolve) => { captureStarted = resolve; });
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const stopReady = new Promise<void>((resolve) => { stopStarted = resolve; });
  const options = (state.coordinator as any).options;
  options.readSession = async () => {
    state.events.push("capture");
    captureStarted();
    await captureGate;
    return JSON.stringify({ ...payload().session, origins: [] });
  };
  options.launcher.stop = async (profileId: string) => {
    state.events.push("stop");
    stopStarted();
    await stopGate;
    state.store.clearLaunch(profileId);
    return true;
  };
  state.events.length = 0;

  const closing = state.coordinator.close("profile1");
  await captureReady;
  const duringCapture = state.coordinator.heartbeatOnce("profile1");
  let duringStop: Promise<void> | undefined;
  try {
    await Bun.sleep(0);
    expect(state.events.filter((event) => event === "heartbeat")).toHaveLength(1);

    releaseCapture();
    await stopReady;
    duringStop = state.coordinator.heartbeatOnce("profile1");
    await Bun.sleep(0);
    expect(state.events.filter((event) => event === "heartbeat")).toHaveLength(2);
    expect(state.events).not.toContain("cloud-close");

    releaseStop();
    expect(await closing).toEqual({ closed: true, sync: "complete" });
    await Promise.all([duringCapture, duringStop]);
    expect(state.events.at(-1)).toBe("cloud-close");
  } finally {
    releaseCapture();
    releaseStop();
    await Promise.allSettled([closing, duringCapture, ...(duringStop ? [duringStop] : [])]);
    state.queue.close();
    state.store.close();
  }
});

/** Park a session Cloud refused for a real version change, as a lost session is. */
async function parkRejectedSession(state: ReturnType<typeof setup>) {
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const options = (state.coordinator as any).options;
  options.readSession = async () => JSON.stringify({
    cookies: [{ name: "auth_token", value: "rescued-session", domain: ".x.com", path: "/" }],
    origins: [],
  });
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "conflict" });
  const parked = state.queue.list("account1")[0]!;
  expect(parked).toMatchObject({ status: "conflict", expectedVersion: 4 });
  return parked;
}

/** Cloud moved to version 5 while this device held the refused session. */
function cloudMovedOn(state: ReturnType<typeof setup>) {
  const options = (state.coordinator as any).options;
  const current = payload();
  current.profile.name = "Renamed in Cloud";
  current.session.cookies[0]!.value = "current-cloud-session";
  const saved: PortableProfileV1[] = [];
  options.cloud.openProfile = async () => {
    state.events.push("cloud-open");
    return { ok: true, registrationId: "registration2", baseVersion: 5, payload: current, activeOpens: [] };
  };
  options.cloud.closeOpen = async (registrationId: string, request: { expectedVersion: number; payload: PortableProfileV1 }) => {
    expect(registrationId).toBe("registration2");
    expect(request.expectedVersion).toBe(5);
    saved.push(structuredClone(request.payload));
    return { ok: true, status: "accepted", version: 6 };
  };
  return saved;
}

test("Cloud browser restores a parked session onto the current Cloud copy", async () => {
  const state = setup({ closeConflict: true });
  const parked = await parkRejectedSession(state);
  const saved = cloudMovedOn(state);

  expect(await state.coordinator.restoreParkedSession("profile1")).toEqual({ ok: true, version: 6 });
  expect(saved).toHaveLength(1);
  expect(saved[0]!.session.cookies[0]!.value).toBe("rescued-session");
  // Everything else stays as Cloud has it now.
  expect(saved[0]!.profile.name).toBe("Renamed in Cloud");
  expect(state.queue.get(parked.id, "account1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud browser keeps a parked session when the restore is refused", async () => {
  const state = setup({ closeConflict: true });
  const parked = await parkRejectedSession(state);
  const options = (state.coordinator as any).options;
  options.cloud.openProfile = async () => {
    throw new CloudApiError("open elsewhere", "profile_open", 409);
  };

  expect(await state.coordinator.restoreParkedSession("profile1")).toMatchObject({ ok: false });
  expect(state.queue.get(parked.id, "account1")?.status).toBe("conflict");
  state.queue.close();
  state.store.close();
});

test("Cloud browser refuses to restore a parked session while the profile is open", async () => {
  const state = setup({ closeConflict: true });
  const parked = await parkRejectedSession(state);
  cloudMovedOn(state);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  expect(await state.coordinator.restoreParkedSession("profile1")).toEqual({
    ok: false,
    error: "Close this profile's browser before restoring a saved session.",
  });
  expect(state.queue.get(parked.id, "account1")?.status).toBe("conflict");
  state.queue.close();
  state.store.close();
});

test("Cloud roster reports a parked session for recovery", async () => {
  const state = setup({ closeConflict: true });
  const parked = await parkRejectedSession(state);
  const roster = await state.coordinator.listRoster();
  expect(roster.profiles[0]).toMatchObject({
    id: "profile1",
    parkedSession: { savedAt: parked.createdAt },
  });
  state.queue.close();
  state.store.close();
});

test("Cloud releaseAll closes several profiles at once", async () => {
  const state = setup();
  const ids = ["profile1", "profile2", "profile3", "profile4", "profile5", "profile6"];
  for (const profileId of ids) {
    state.queue.recordOpen({
      accountId: "account1",
      profileId,
      registrationId: `registration-${profileId}`,
      expectedVersion: 4,
    });
  }
  let inFlight = 0;
  let peak = 0;
  const closed: string[] = [];
  (state.coordinator as any).close = async (profileId: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(5);
    state.queue.removeOpen(profileId, "account1");
    closed.push(profileId);
    inFlight--;
    return { closed: true, sync: "complete" };
  };

  expect(await state.coordinator.releaseAll(true)).toBe(true);
  expect(closed.sort()).toEqual([...ids].sort());
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  state.queue.close();
  state.store.close();
});

test("Chromium's own network state files do not mark a Cloud profile dirty; cookies and site storage do", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-storage-watch-"));
  const network = join(root, "Default", "Network");
  const localStorage = join(root, "Default", "Local Storage", "leveldb");
  const changes: string[] = [];
  const watchers = [
    watchBrowserStorage(network, () => changes.push("network")),
    watchBrowserStorage(localStorage, () => changes.push("local-storage")),
  ];
  const settle = async (expected: number) => {
    for (let i = 0; i < 50 && changes.length < expected; i++) await Bun.sleep(20);
    await Bun.sleep(150);
  };
  try {
    mkdirSync(join(network, "nested"), { recursive: true });
    for (const file of ["Network Persistent State", "Reporting and NEL", "Reporting and NEL-journal", "TransportSecurity"]) {
      writeFileSync(join(network, file), "state");
    }
    await settle(0);
    expect(changes).toEqual([]);
    writeFileSync(join(network, "Cookies-journal"), "cookie");
    await settle(1);
    expect(changes.length).toBeGreaterThan(0);
    expect(new Set(changes)).toEqual(new Set(["network"]));
    changes.length = 0;
    writeFileSync(join(localStorage, "000003.log"), "entry");
    await settle(1);
    expect(new Set(changes)).toEqual(new Set(["local-storage"]));
  } finally {
    for (const watcher of watchers) watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A Cloud checkpoint endpoint that saves each upload on top of the version it holds. */
function liveCheckpoints(state: ReturnType<typeof setup>, version = 4) {
  const uploads: Array<{ registrationId: string; expectedVersion: number; cookie: string }> = [];
  let held = version;
  (state.coordinator as any).options.cloud.checkpointOpen = async (
    registrationId: string,
    request: { expectedVersion: number; payload: PortableProfileV1 },
  ) => {
    uploads.push({
      registrationId,
      expectedVersion: request.expectedVersion,
      cookie: request.payload.session.cookies[0]?.value ?? "",
    });
    if (request.expectedVersion < held) return { ok: true, status: "behind", version: held };
    held++;
    return { ok: true, status: "saved", version: held };
  };
  return uploads;
}

/** `login` is the X auth cookie; `other` changes a cookie that is not a login. */
function changeSession(state: ReturnType<typeof setup>, login: string, other = "") {
  (state.coordinator as any).options.readSession = async () => {
    state.events.push("capture");
    return JSON.stringify({
      cookies: [
        { name: "auth_token", value: login, domain: ".x.com", path: "/" },
        ...(other ? [{ name: "guest_id", value: other, domain: ".x.com", path: "/" }] : []),
      ],
      origins: [],
    });
  };
}

function recordCloses(state: ReturnType<typeof setup>) {
  const closes: number[] = [];
  (state.coordinator as any).options.cloud.closeOpen = async (_registrationId: string, request: { expectedVersion: number }) => {
    closes.push(request.expectedVersion);
    return { ok: true, status: "accepted", version: request.expectedVersion + 1 };
  };
  return closes;
}

function openCheckpoint(state: ReturnType<typeof setup>) {
  const [summary] = state.queue.list("account1");
  return summary ? state.queue.get(summary.id, "account1") : null;
}

test("Cloud saves a changed checkpoint of an open profile and closes on top of it", async () => {
  const state = setup();
  const uploads = liveCheckpoints(state);
  const closes = recordCloses(state);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  await state.coordinator.heartbeatOnce("profile1");
  expect(uploads).toEqual([]);

  changeSession(state, "logged-in");
  await state.coordinator.heartbeatOnce("profile1");
  expect(uploads).toEqual([{ registrationId: "registration1", expectedVersion: 4, cookie: "logged-in" }]);
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({ registrationId: "registration1", expectedVersion: 5 });
  expect(openCheckpoint(state)).toMatchObject({ expectedVersion: 5, cloudVersion: 5, readyToSubmit: false });
  expect(state.coordinator.diagnostics().some((event) => event.type === "checkpoint_uploaded")).toBe(true);

  await state.coordinator.heartbeatOnce("profile1");
  changeSession(state, "logged-in", "visited");
  await state.coordinator.heartbeatOnce("profile1");
  // Changed again, but not a login, and the next periodic save is not due yet.
  expect(uploads).toHaveLength(1);
  expect(openCheckpoint(state)).toMatchObject({
    expectedVersion: 5,
    payload: { session: { cookies: [{ value: "logged-in" }, { value: "visited" }] } },
  });
  expect(openCheckpoint(state)?.cloudVersion).toBeUndefined();

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(closes).toEqual([5]);
  state.queue.close();
  state.store.close();
});

test("a login seen by the storage watcher is saved to Cloud soon; other changes wait for the interval", async () => {
  const storageDirty: Array<() => void> = [];
  const state = setup({
    storageCheckpoints: true,
    checkpointDebounceMs: 5,
    checkpointMinIntervalMs: 0,
    cloudCheckpointIntervalMs: 60 * 60_000,
    cloudCheckpointSoonMs: 0,
    watchPaths: ["Network"],
    watchPath: (_path: string, onDirty: () => void) => {
      storageDirty.push(onDirty);
      return { close() {} };
    },
  });
  const uploads = liveCheckpoints(state);
  const waitForUploads = async (count: number) => {
    for (let attempt = 0; attempt < 200 && uploads.length < count; attempt++) await Bun.sleep(5);
  };
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    changeSession(state, "login");
    storageDirty[0]!();
    await waitForUploads(1);
    expect(uploads.map((upload) => upload.cookie)).toEqual(["login"]);

    changeSession(state, "login", "browsing");
    storageDirty.at(-1)!();
    await Bun.sleep(60);
    await state.coordinator.heartbeatOnce("profile1");
    expect(state.queue.get(state.queue.list("account1")[0]!.id, "account1")?.payload.session.cookies[1]?.value).toBe("browsing");
    expect(uploads).toHaveLength(1);

    changeSession(state, "second-login");
    // Each capture rearms the storage watchers; only the newest callback is live.
    storageDirty.at(-1)!();
    await waitForUploads(2);
    expect(uploads.map((upload) => [upload.cookie, upload.expectedVersion])).toEqual([["login", 4], ["second-login", 5]]);
  } finally {
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("a lost checkpoint reply is adopted from Cloud and the session saved on top of it", async () => {
  const state = setup();
  const calls: number[] = [];
  (state.coordinator as any).options.cloud.checkpointOpen = async (_registrationId: string, request: { expectedVersion: number }) => {
    calls.push(request.expectedVersion);
    return request.expectedVersion < 6
      ? { ok: true, status: "behind", version: 6 }
      : { ok: true, status: "saved", version: 7 };
  };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  changeSession(state, "logged-in");
  await state.coordinator.heartbeatOnce("profile1");

  expect(calls).toEqual([4, 6]);
  expect(state.queue.getOpen("profile1", "account1")?.expectedVersion).toBe(7);
  expect(openCheckpoint(state)).toMatchObject({ expectedVersion: 7, cloudVersion: 7 });
  state.queue.close();
  state.store.close();
});

test("a Cloud service without live checkpoints keeps saving the session at close", async () => {
  const state = setup({ cloudCheckpointIntervalMs: 0, cloudCheckpointSoonMs: 0 });
  let calls = 0;
  (state.coordinator as any).options.cloud.checkpointOpen = async () => {
    calls++;
    throw new CloudApiError("The route does not exist.", "profile_not_found", 404);
  };
  const closes = recordCloses(state);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  changeSession(state, "first");
  await state.coordinator.heartbeatOnce("profile1");
  changeSession(state, "second");
  await state.coordinator.heartbeatOnce("profile1");

  expect(calls).toBe(1);
  expect((await rosterReconciled(state.coordinator)).profiles[0]?.cloudUnsavedSince).toBeUndefined();
  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });
  expect(closes).toEqual([4]);
  state.queue.close();
  state.store.close();
});

test("the roster says an open profile is not saved to Cloud yet while uploads keep failing", async () => {
  const state = setup({ cloudCheckpointIntervalMs: 0, cloudCheckpointSoonMs: 0 });
  let offline = true;
  let calls = 0;
  (state.coordinator as any).options.cloud.checkpointOpen = async (_registrationId: string, request: { expectedVersion: number }) => {
    calls++;
    if (offline) throw new TypeError("fetch failed");
    return { ok: true, status: "saved", version: request.expectedVersion + 1 };
  };
  const unsavedSince = async () => (await rosterReconciled(state.coordinator)).profiles[0]?.cloudUnsavedSince;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  changeSession(state, "logged-in");

  await state.coordinator.heartbeatOnce("profile1");
  expect(await unsavedSince()).toBeUndefined();
  // The session did not change again, but Cloud still lacks it.
  await state.coordinator.heartbeatOnce("profile1");
  expect(calls).toBe(2);
  expect(typeof await unsavedSince()).toBe("number");

  offline = false;
  await state.coordinator.heartbeatOnce("profile1");
  expect(calls).toBe(3);
  expect(await unsavedSince()).toBeUndefined();
  state.queue.close();
  state.store.close();
});

test("a lapsed lease adopts the version this registration saved before its reply was lost", async () => {
  const state = setup();
  const cloud = (state.coordinator as any).options.cloud;
  // Cloud saved the checkpoint as version 5, but its reply never arrived.
  cloud.checkpointOpen = async () => { throw new TypeError("fetch failed"); };
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  changeSession(state, "logged-in");
  await state.coordinator.heartbeatOnce("profile1");
  expect(state.queue.getOpen("profile1", "account1")?.expectedVersion).toBe(4);

  cloud.heartbeat = async () => { throw new CloudApiError("The open registration expired.", "version_conflict", 409, 5); };
  cloud.openProfile = async () => freshOpen("registration2", 5);
  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).not.toContain("stop");
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration2",
    expectedVersion: 5,
    phase: "running",
  });
  expect(openCheckpoint(state)).toMatchObject({
    registrationId: "registration2",
    expectedVersion: 5,
    payload: { session: { cookies: [{ value: "logged-in" }] } },
  });
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("opening a profile another device left open says its last changes may be missing", async () => {
  const state = setup();
  const cloud = (state.coordinator as any).options.cloud;
  const openProfile = cloud.openProfile;
  cloud.openProfile = async () => ({
    ...(await openProfile()),
    lapsedOpens: [{
      registrationId: "registration0",
      accountId: "account1",
      memberEmail: "member@example.test",
      deviceId: "device2",
      deviceLabel: "Office PC",
      openedAt: 1,
      heartbeatAt: 2,
      checkpointAt: 3,
    }],
  });

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result.ok).toBe(true);
  expect(result.warning).toContain("Office PC did not close this profile.");
  state.queue.close();
  state.store.close();
});

/** Record the payload of each close that reaches Cloud. */
function recordClosedPayloads(state: ReturnType<typeof setup>) {
  const closed: PortableProfileV1[] = [];
  const cloud = (state.coordinator as any).options.cloud;
  const closeOpen = cloud.closeOpen;
  cloud.closeOpen = async (registrationId: string, request: { payload: PortableProfileV1 }) => {
    closed.push(request.payload);
    return closeOpen(registrationId, request);
  };
  return closed;
}

test.each([
  ["a site cannot be read", (options: any) => {
    options.readSession = async () => {
      throw new PlaywrightWorkerError("operation_failed", "capture failed", { operation: "origin_storage", outcome: "failed" });
    };
  }, "operation_failed", 2],
  ["the session is too large for the worker", (options: any) => {
    options.readSession = async () => {
      throw new PlaywrightWorkerError("invalid_response", "too large", { responseCategory: "stdout_overflow" });
    };
  }, "invalid_response", 2],
  ["the worker crashes", (options: any) => {
    options.readSession = async () => {
      throw new PlaywrightWorkerError("runtime_unavailable", "no output", { responseCategory: "empty_stdout" });
    };
  }, "runtime_unavailable", 2],
  // The literal "(failed)" users saw: the relay of a running profile could not be restored.
  ["the running browser cannot be verified", (options: any) => {
    options.launcher.verifyRunningIdentity = async () => { throw new BrowserLaunchError("relay_setup"); };
  }, "failed", 0],
] as const)("Cloud close stops the browser with the last checkpoint when %s", async (_case, fail, code, reads) => {
  const state = setup();
  const options = (state.coordinator as any).options;
  const closed = recordClosedPayloads(state);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  changeSession(state, "checkpoint");
  await state.coordinator.heartbeatOnce("profile1");
  fail(options);
  const read = options.readSession;
  let attempts = 0;
  options.readSession = async (...args: unknown[]) => { attempts++; return read(...args); };

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete", captureFailed: true });

  expect(attempts).toBe(reads);
  expect(state.events).toContain("stop");
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  // Cloud gets the last checkpoint, and this device's newer state on disk stays tied to it.
  expect(closed.map((saved) => saved.session.cookies[0]?.value)).toEqual(["checkpoint"]);
  const { sessionBundle } = decodePortableProfile(closed[0]!);
  expect(options.launcher.matchesCloudSession("profile1", sessionBundleSignature(sessionBundle))).toBe(true);
  expect(state.logs).toContain(`profile1: Cloud session capture failed (${code}); stopping the browser with the last saved copy`);
  expect(typeof (await rosterReconciled(state.coordinator)).profiles[0]?.cloudUnsavedSince).toBe("number");
  state.queue.close();
  state.store.close();
});

test("Cloud close retries a failed capture once and saves the fresh session", async () => {
  const state = setup();
  const options = (state.coordinator as any).options;
  const closed = recordClosedPayloads(state);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  let reads = 0;
  options.readSession = async () => {
    if (++reads === 1) throw new PlaywrightWorkerError("operation_failed", "first read failed", { operation: "cookies" });
    return JSON.stringify({ cookies: [{ name: "auth_token", value: "fresh", domain: ".x.com", path: "/" }], origins: [] });
  };

  expect(await state.coordinator.close("profile1")).toEqual({ closed: true, sync: "complete" });

  expect(reads).toBe(2);
  expect(closed.map((saved) => saved.session.cookies[0]?.value)).toEqual(["fresh"]);
  expect((await rosterReconciled(state.coordinator)).profiles[0]?.cloudUnsavedSince).toBeUndefined();
  state.queue.close();
  state.store.close();
});

test("after a close without its final capture, the next open restores this device's session and saves it to Cloud", async () => {
  const state = setup({ nativeSessionAvailable: true });
  const options = (state.coordinator as any).options;
  const closed: PortableProfileV1[] = [];
  options.cloud.closeOpen = async (_registrationId: string, request: { payload: PortableProfileV1 }) => {
    closed.push(request.payload);
    return { ok: true, status: "accepted", version: 5 };
  };
  const unsavedSince = async () => (await rosterReconciled(state.coordinator)).profiles[0]?.cloudUnsavedSince;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  changeSession(state, "checkpoint");
  await state.coordinator.heartbeatOnce("profile1");
  options.readSession = async () => { throw new PlaywrightWorkerError("timeout", "capture timed out"); };
  expect(await state.coordinator.close("profile1")).toMatchObject({ closed: true, captureFailed: true });
  expect(typeof await unsavedSince()).toBe("number");

  // Cloud holds the last checkpoint now; the newer state stayed on this device's disk.
  options.cloud.openProfile = async () => ({
    ok: true, registrationId: "registration2", baseVersion: 5, payload: closed[0], activeOpens: [],
  });
  const uploads = liveCheckpoints(state, 5);
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.startOptionsSeen.at(-1)).toMatchObject({ restoreLastSession: true, resetStorage: false });
  expect(typeof await unsavedSince()).toBe("number");

  changeSession(state, "newer");
  await state.coordinator.heartbeatOnce("profile1");

  expect(uploads.map((upload) => upload.cookie)).toEqual(["newer"]);
  expect(await unsavedSince()).toBeUndefined();
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud close leaves the browser open only when it has no checkpoint to finish with", async () => {
  const state = setup({ heartbeatMs: 60_000, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
  const options = (state.coordinator as any).options;
  try {
    expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
    state.queue.removeUnreadyCaptures("profile1", "account1", "registration1");
    options.readSession = async () => { throw new PlaywrightWorkerError("timeout", "capture timed out"); };

    await expect(state.coordinator.close("profile1")).rejects.toThrow(
      "Could not save this profile's session, so its browser stays open. Try closing it again.",
    );

    expect(state.logs).toContain("profile1: Cloud session capture failed (timeout); browser left open");
    expect(state.store.getLaunch("profile1")).not.toBeNull();
    expect(state.queue.getOpen("profile1", "account1")?.cleanupMode).toBeUndefined();
    expect((state.coordinator as any).timers.has("profile1")).toBe(true);
    expect(state.closeCalls()).toBe(0);
    expect(state.abandonCalls()).toBe(0);
  } finally {
    await state.coordinator.releaseAll(true);
    state.queue.close();
    state.store.close();
  }
});

test("a Cloud capture keeps the checkpoint storage of an origin the worker could not read", async () => {
  const state = setup({
    session: {
      cookies: [],
      origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "\"saved\"" }] }],
    },
  });
  const options = (state.coordinator as any).options;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  // As readSessionInSubprocess does with the worker's list of unreadable origins.
  options.readSession = async (_endpoint: string, seed: { saved?: any[] }) => keepUnreadableOrigins(JSON.stringify({
    cookies: [{ name: "auth_token", value: "fresh", domain: ".x.com", path: "/" }],
    origins: [],
    unreadableOrigins: ["https://web.telegram.org"],
  }), seed.saved);

  await state.coordinator.heartbeatOnce("profile1");

  const checkpoint = state.queue.get(state.queue.list("account1")[0]!.id, "account1")!.payload.session;
  expect(checkpoint.cookies.map((cookie) => cookie.value)).toEqual(["fresh"]);
  expect(checkpoint.origins).toEqual([
    { origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "\"saved\"" }] },
  ]);
  state.queue.close();
  state.store.close();
});

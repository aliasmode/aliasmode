import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudApiError } from "./cloud-client.ts";
import { CloudBrowserCoordinator, observeBrowserTargets } from "./cloud-browser.ts";
import type { OpenProfileResponse, PortableProfileV1 } from "./contracts/cloud-v1.ts";
import { BrowserLaunchError } from "./launcher.ts";
import { PendingSyncQueue } from "./pending-sync.ts";
import { decodePortableProfile } from "./portable-profile.ts";
import { SessionRestoreError } from "./session.ts";
import { ProfileStore } from "./store.ts";

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
  platform?: string;
  proxy?: PortableProfileV1["profile"]["proxy"];
  session?: PortableProfileV1["session"];
  accountId?: () => string;
  heartbeatMs?: number;
  dirtyMonitorMs?: number;
  checkpointDebounceMs?: number;
  checkpointMinIntervalMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  watchPaths?: string[];
  watchPath?: (path: string, dirty: () => void) => { close(): void };
  observeTargets?: (endpoint: string, onTarget: (origin: string | null) => void) => { close(): void };
} = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const navigatedUrls: string[][] = [];
  const navigateEndpoints: string[] = [];
  const restoreEndpoints: string[] = [];
  const captureSeeds: any[] = [];
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
    async start(profileId: string, args: string[], startOptions: any) {
      startCalls++;
      events.push("start");
      startedProxy = store.getProfile(profileId)?.proxy;
      expect(args).toEqual(["--window-size=1200,800"]);
      expect(startOptions).toMatchObject({
        autoNavigate: false,
        restoreLastSession: false,
        sessionBaseVersion: -1,
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
        throw new Error("stale browser retained");
      }
      return { ws: "ws://browser", port: 9222 };
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
    async pageTargetFingerprint() { return "[]"; },
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
    dirtyMonitorMs: options.dirtyMonitorMs ?? 0,
    checkpointDebounceMs: options.checkpointDebounceMs,
    checkpointMinIntervalMs: options.checkpointMinIntervalMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    watchPath: options.watchPath,
    observeTargets: options.observeTargets ?? (() => ({ close() {} })),
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
    navigateEndpoints,
    restoreEndpoints,
    captureSeeds,
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

test("Cloud browser creates a portable profile without a local-only fallback", async () => {
  const state = setup();
  const profile = decodePortableProfile(payload()).profile;
  expect(await state.coordinator.create(profile)).toEqual({ id: "profile1" });
  expect(state.events).toEqual(["cloud-create"]);
  expect(state.store.getProfile("profile1")).toBeNull();
  state.queue.close();
  state.store.close();
});
test("Cloud browser imports one encoded batch without populating the Local store", async () => {
  const state = setup();
  const first = decodePortableProfile(payload()).profile;
  first.group = "Sales";
  const second = structuredClone(first);
  second.id = "profile2";
  second.name = "Second";

  expect(await state.coordinator.importProfiles("Sales", [first, second])).toEqual({
    ok: true,
    imported: 2,
    ids: ["profile1", "profile2"],
  });
  expect(state.events).toEqual(["cloud-import"]);
  expect(state.imports).toHaveLength(1);
  expect(state.imports[0]!.destination).toBe("Sales");
  expect(state.imports[0]!.profiles.map((item) => decodePortableProfile(item).profile)).toEqual([first, second]);
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

test("Cloud browser keeps the platform home fallback for legacy bundles", async () => {
  const state = setup();

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(state.navigatedUrls).toEqual([["https://x.com/home"]]);
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

  const roster = await state.coordinator.listRoster();

  expect(state.events).toEqual(["reconcile", "cloud-close", "cloud-list"]);
  expect(roster.profiles[0]?.running).toBe(false);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.closeCalls()).toBe(1);
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud roster polls cannot accelerate the heartbeat no-page confirmation", async () => {
  const state = setup({ hasPageTargets: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");
  expect(state.events).toEqual(["heartbeat", "capture"]);
  state.events.length = 0;

  const firstRoster = await state.coordinator.listRoster();
  const secondRoster = await state.coordinator.listRoster();

  expect(state.events).toEqual(["reconcile", "cloud-list", "reconcile", "cloud-list"]);
  expect(firstRoster.profiles[0]?.running).toBe(true);
  expect(secondRoster.profiles[0]?.running).toBe(true);
  expect(state.queue.getOpen("profile1", "account1")).not.toBeNull();

  await state.coordinator.heartbeatOnce("profile1");
  await Bun.sleep(0);
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

  await state.coordinator.listRoster();

  expect(state.events).toEqual(["reconcile", "cloud-list"]);
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

  await state.coordinator.listRoster();

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

test("Cloud heartbeat requires two consecutive no-page observations before closing", async () => {
  const state = setup({ hasPageTargets: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");

  expect(state.events).toEqual(["heartbeat", "capture"]);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).not.toBeNull();

  await state.coordinator.heartbeatOnce("profile1");
  await Bun.sleep(0);

  expect(state.events.slice(-4)).toEqual(["reconcile", "capture", "stop", "cloud-close"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.coordinator.diagnostics().map((event) => event.type)).toEqual(
    expect.arrayContaining(["no_page_observed", "no_page_close_requested"]),
  );
  state.queue.close();
  state.store.close();
});

test("Cloud heartbeat resets no-page confirmation after a visible page returns", async () => {
  const state = setup();
  const observations = [false, true, false];
  (state.coordinator as any).options.launcher.hasPageTargets = async () => observations.shift()!;
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");
  await state.coordinator.heartbeatOnce("profile1");
  await state.coordinator.heartbeatOnce("profile1");
  await Bun.sleep(0);

  expect(state.events.filter((event) => event === "cloud-close")).toEqual([]);
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).not.toBeNull();
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud target observer reports page creates, navigations, and destruction", () => {
  const originalWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static latest: FakeWebSocket;
    readonly listeners = new Map<string, Set<(event: any) => void>>();
    readonly sent: string[] = [];
    closed = false;

    constructor(readonly endpoint: string) {
      FakeWebSocket.latest = this;
    }

    addEventListener(type: string, listener: (event: any) => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: any) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    send(message: string) { this.sent.push(message); }
    close() { this.closed = true; }
    emit(type: string, event: any) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  try {
    (globalThis as any).WebSocket = FakeWebSocket;
    const events: Array<string | null> = [];
    const observer = observeBrowserTargets("ws://browser", (origin) => events.push(origin));
    const socket = FakeWebSocket.latest!;
    socket.emit("open", {});
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([{
      id: 1,
      method: "Target.setDiscoverTargets",
      params: { discover: true },
    }]);

    const emitMessage = (message: unknown) => socket.emit("message", { data: JSON.stringify(message) });
    emitMessage({ method: "Target.targetCreated", params: { targetInfo: {
      targetId: "page-1", type: "page", url: "https://x.com/home",
    } } });
    emitMessage({ method: "Target.targetInfoChanged", params: { targetInfo: {
      targetId: "page-1", type: "page", url: "https://x.com/messages",
    } } });
    emitMessage({ method: "Target.targetCreated", params: { targetInfo: {
      targetId: "internal", type: "page", url: "chrome://ungoogled-first-run/",
    } } });
    emitMessage({ method: "Target.targetCreated", params: { targetInfo: {
      targetId: "worker", type: "service_worker", url: "https://x.com/sw.js",
    } } });
    emitMessage({ method: "Target.targetDestroyed", params: { targetId: "worker" } });
    emitMessage({ method: "Target.targetDestroyed", params: { targetId: "internal" } });
    emitMessage({ method: "Target.targetDestroyed", params: { targetId: "page-1" } });

    expect(events).toEqual([
      "https://x.com",
      "https://x.com",
      null,
      null,
      null,
    ]);
    observer.close();
    expect(socket.closed).toBe(true);
    emitMessage({ method: "Target.targetCreated", params: { targetInfo: {
      targetId: "late", type: "page", url: "https://late.example/",
    } } });
    expect(events).toHaveLength(5);
  } finally {
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("Cloud dirty monitor coalesces storage changes and captures target changes without Cloud calls", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let pollTargets!: () => void;
  let fingerprint = "targets:1";
  let watcherCloses = 0;
  let sessionValue = "storage-change";
  const options = (state.coordinator as any).options;
  (state.coordinator as any).dirtyMonitorMs = 10;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies", "local-storage", "indexed-db"];
  options.launcher.pageTargetFingerprint = async () => fingerprint;
  options.watchPath = (_path: string, onDirty: () => void) => {
    storageDirty.push(onDirty);
    return { close() { watcherCloses++; } };
  };
  options.setIntervalFn = (fn: () => void) => {
    pollTargets = fn;
    return { unref() {} };
  };
  options.clearIntervalFn = () => {};
  options.readSession = async () => {
    state.events.push("capture");
    return JSON.stringify({
      cookies: [{ name: "auth_token", value: sessionValue, domain: ".x.com", path: "/" }],
      origins: [],
    });
  };

  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const initialId = state.queue.list("account1")[0]?.id;
  state.events.length = 0;
  (state.coordinator as any).startDirtyMonitor("profile1");
  await Bun.sleep(0);

  expect(storageDirty).toHaveLength(3);
  for (const dirty of storageDirty) dirty();
  await Bun.sleep(15);
  const storageId = state.queue.list("account1")[0]?.id;
  expect(state.events).toEqual(["capture"]);
  expect(storageId).not.toBe(initialId);
  expect(state.events).not.toContain("heartbeat");
  expect(state.events).not.toContain("cloud-close");

  sessionValue = "target-change";
  fingerprint = "targets:2";
  pollTargets();
  await Bun.sleep(15);
  expect(state.events).toEqual(["capture", "capture"]);
  expect(state.queue.list("account1")[0]?.id).not.toBe(storageId);

  await state.coordinator.close("profile1");
  expect(watcherCloses).toBe(storageDirty.length);
  const capturesAfterClose = state.events.filter((event) => event === "capture").length;
  storageDirty[0]!();
  pollTargets();
  await Bun.sleep(5);
  expect(state.events.filter((event) => event === "capture")).toHaveLength(capturesAfterClose);
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
  (state.coordinator as any).dirtyMonitorMs = 10;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.launcher.pageTargetFingerprint = async () => "targets";
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
  (state.coordinator as any).dirtyMonitorMs = 10;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.launcher.pageTargetFingerprint = async () => "targets";
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

test("Cloud heartbeat retires its capture watcher generation before reading storage", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let captures = 0;
  const options = (state.coordinator as any).options;
  (state.coordinator as any).dirtyMonitorMs = 10;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => ["cookies"];
  options.launcher.pageTargetFingerprint = async () => "targets";
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

test("Cloud dirty monitor latches one target change while a capture is running", async () => {
  const state = setup();
  let onTarget!: (origin: string | null) => void;
  let finishFirst!: () => void;
  const firstCapture = new Promise<void>((resolve) => { finishFirst = resolve; });
  let captures = 0;
  const options = (state.coordinator as any).options;
  (state.coordinator as any).dirtyMonitorMs = 10;
  (state.coordinator as any).checkpointDebounceMs = 1;
  (state.coordinator as any).checkpointMinIntervalMs = 0;
  options.launcher.browserStorageWatchPaths = () => [];
  options.launcher.pageTargetFingerprint = async () => "targets";
  options.observeTargets = (_endpoint: string, target: (origin: string | null) => void) => {
    onTarget = target;
    return { close() {} };
  };
  options.setIntervalFn = () => ({ unref() {} });
  options.clearIntervalFn = () => {};
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
  onTarget("https://first.example");
  await Bun.sleep(5);
  expect(captures).toBe(1);
  onTarget("https://second.example");
  onTarget("https://second.example");
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

  expect(state.captureSeeds.at(-1)).toEqual({
    origins: ["https://closed.example"],
    telegramClient: "k",
  });
  await state.coordinator.releaseAll(true);
  state.queue.close();
  state.store.close();
});

test("Cloud target observation checkpoints destruction and repeated same-origin events", async () => {
  let onTarget!: (origin: string | null) => void;
  let observerCloses = 0;
  const state = setup({
    session: {
      cookies: [],
      origins: [{
        origin: "https://closed.example",
        localStorage: [{ name: "token", value: "prior-value" }],
      }],
    },
    heartbeatMs: 60_000,
    dirtyMonitorMs: 2_000,
    checkpointDebounceMs: 0,
    checkpointMinIntervalMs: 0,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
    observeTargets(_endpoint, target) {
      onTarget = target;
      return { close() { observerCloses++; } };
    },
  });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  const emitAndWait = async (origin: string | null, count: number) => {
    onTarget(origin);
    for (let attempt = 0; attempt < 20 && state.captureSeeds.length < count; attempt++) {
      await Bun.sleep(5);
    }
    expect(state.captureSeeds).toHaveLength(count);
  };

  await emitAndWait(null, 1);
  expect(state.captureSeeds.at(-1)).toEqual({ origins: ["https://closed.example"] });

  await emitAndWait("https://closed.example", 2);
  expect(state.captureSeeds.at(-1)).toEqual({ origins: ["https://closed.example"] });

  await emitAndWait("https://new.example", 3);
  expect(state.captureSeeds.at(-1)).toEqual({
    origins: ["https://closed.example", "https://new.example"],
  });

  await emitAndWait("https://new.example", 4);
  await state.coordinator.releaseAll(true);
  expect(observerCloses).toBe(1);
  state.queue.close();
  state.store.close();
});

test("Cloud target checkpoints preserve ordered duplicate tabs through manual browser death", async () => {
  let onTarget!: (origin: string | null) => void;
  const state = setup({
    session: {
      ...payload().session,
      origins: [{ origin: "https://x.com", localStorage: [] }],
      tabs: ["https://initial.example/"],
    },
    heartbeatMs: 60_000,
    dirtyMonitorMs: 2_000,
    checkpointDebounceMs: 0,
    checkpointMinIntervalMs: 0,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
    observeTargets(_endpoint, target) {
      onTarget = target;
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

  onTarget("https://x.com");
  await waitForTabs(tabs);

  tabs = ["https://same.example/b", "https://same.example/a", "https://same.example/b"];
  onTarget("https://x.com");
  await waitForTabs(tabs);

  tabs = ["https://same.example/a", "https://same.example/a"];
  onTarget(null);
  await waitForTabs(tabs);
  expect(captures).toBe(3);

  let submitted: PortableProfileV1 | undefined;
  const originalClose = options.cloud.closeOpen;
  options.cloud.closeOpen = async (registrationId: string, request: { payload: PortableProfileV1 }) => {
    submitted = structuredClone(request.payload);
    return originalClose(registrationId, request);
  };
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  await state.coordinator.listRoster();

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
  (state.coordinator as any).dirtyMonitorMs = 10;
  options.launcher.browserStorageWatchPaths = () => ["missing-storage"];
  options.launcher.pageTargetFingerprint = async () => "targets";
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
    warning: "Opened the latest Cloud state. An older conflicting snapshot remains encrypted on this device.",
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
    dirtyMonitorMs: 2_000,
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
  const firstHeartbeat = internals.timers.get("profile1");
  expect(firstMonitor).toBeDefined();
  expect(activeTimers.has(firstHeartbeat)).toBe(true);

  accountId = "account2";
  await state.coordinator.secureAfterAuthentication();

  expect(internals.dirtyMonitors.has("profile1")).toBe(false);
  expect(internals.timers.has("profile1")).toBe(false);
  expect(activeTimers.has(firstMonitor.pollTimer)).toBe(false);
  expect(activeTimers.has(firstHeartbeat)).toBe(false);
  expect(watcherCloses).toBe(1);

  accountId = "account1";
  await state.coordinator.resumeAfterAuthentication();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  const secondMonitor = internals.dirtyMonitors.get("profile1");
  const secondHeartbeat = internals.timers.get("profile1");
  expect(secondMonitor).toBeDefined();
  expect(secondMonitor).not.toBe(firstMonitor);
  expect(secondHeartbeat).not.toBe(firstHeartbeat);
  expect(activeTimers.has(secondMonitor.pollTimer)).toBe(true);
  expect(activeTimers.has(secondHeartbeat)).toBe(true);

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

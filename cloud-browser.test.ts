import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudApiError } from "./cloud-client.ts";
import { CloudBrowserCoordinator } from "./cloud-browser.ts";
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
  let startCalls = 0;
  let startedProxy: unknown;
  let verifyCalls = 0;
  let reconcileHook: (() => void | Promise<void>) | undefined;
  let abandonHook: (() => void | Promise<void>) | undefined;
  const openedPayload = payload();
  openedPayload.profile.proxy = options.proxy ?? null;
  if (options.session) openedPayload.session = options.session;
  const opened: OpenProfileResponse = {
    ok: true,
    registrationId: "registration1",
    baseVersion: 4,
    payload: openedPayload,
    activeOpens: [],
  };
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
    async createProfile(request: { payload: PortableProfileV1 }) {
      events.push("cloud-create");
      expect(request.payload.profile.id).toBe("profile1");
      return {
        ok: true as const,
        profile: { id: request.payload.profile.id },
        payloadDigest: "digest",
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
      expect(startOptions).toMatchObject({ autoNavigate: false, sessionBaseVersion: -1 });
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
    logs,
    navigatedUrls,
    navigateEndpoints,
    restoreEndpoints,
    captureSeeds,
    store,
    queue,
    closeCalls: () => closeCalls,
    abandonCalls: () => abandonCalls,
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
  expect(await state.coordinator.close("profile1")).toBe(true);
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

  expect(await state.coordinator.close("profile1")).toBe(false);

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

  expect(state.events).toEqual(["reconcile", "heartbeat"]);
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

  expect(state.events).toEqual(["reconcile", "abandon"]);
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

test("Cloud roster captures and closes a surviving browser with no page targets", async () => {
  const state = setup({ hasPageTargets: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  const roster = await state.coordinator.listRoster();

  expect(state.events).toEqual(["reconcile", "reconcile", "capture", "stop", "cloud-close", "cloud-list"]);
  expect(roster.profiles[0]?.running).toBe(false);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud close reconciles a manually closed browser before session capture", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  state.setReconcileHook(() => state.store.clearLaunch("profile1"));

  expect(await state.coordinator.close("profile1")).toBe(true);

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

test("Cloud heartbeat captures and closes a background-only browser", async () => {
  const state = setup({ hasPageTargets: false });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;

  await state.coordinator.heartbeatOnce("profile1");
  await Bun.sleep(0);

  expect(state.events).toEqual(["reconcile", "capture", "stop", "cloud-close"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  state.queue.close();
  state.store.close();
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

  for (const dirty of storageDirty) dirty();
  await Bun.sleep(15);
  const storageId = state.queue.list("account1")[0]?.id;
  expect(storageDirty).toHaveLength(3);
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
  expect(watcherCloses).toBe(3);
  const capturesAfterClose = state.events.filter((event) => event === "capture").length;
  storageDirty[0]!();
  pollTargets();
  await Bun.sleep(5);
  expect(state.events.filter((event) => event === "capture")).toHaveLength(capturesAfterClose);
  state.queue.close();
  state.store.close();
});

test("Cloud dirty monitor latches one follow-up capture while a capture is running", async () => {
  const state = setup();
  const storageDirty: Array<() => void> = [];
  let finishFirst!: () => void;
  const firstCapture = new Promise<void>((resolve) => { finishFirst = resolve; });
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
  storageDirty[0]!();
  storageDirty[0]!();
  finishFirst();
  await Bun.sleep(20);
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

test("Cloud target observation retains a new origin after its tab closes", async () => {
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

  onTarget("https://new.example");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (state.captureSeeds.length) break;
    await Bun.sleep(5);
  }

  expect(state.captureSeeds.at(-1)).toEqual({
    origins: ["https://closed.example", "https://new.example"],
  });
  await state.coordinator.releaseAll(true);
  expect(observerCloses).toBe(1);
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

  expect(await state.coordinator.close("profile1")).toBe(true);
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
  expect(await state.coordinator.close("profile1")).toBe(false);
  expect(state.closeCalls()).toBe(0);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: false,
    status: "pending",
  }]);
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("cleanup_retained");
  state.queue.close();
  state.store.close();
});

test("Cloud browser keeps stale CAS closes terminal", async () => {
  const state = setup({ closeConflict: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  expect(await state.coordinator.close("profile1")).toBe(false);
  expect(state.closeCalls()).toBe(1);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "conflict",
  }]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("cleanup_retained");
  expect(await state.coordinator.open("profile1", ["--window-size=1200,800"])).toEqual({
    ok: false,
    error: "Pending Cloud synchronization must be resolved before reopening",
  });
  expect(state.events.filter((event) => event === "cloud-open")).toHaveLength(1);
  state.queue.close();
  state.store.close();
});

test("Cloud close diagnostics retain unsynchronized transport failures", async () => {
  const state = setup({ closeTransportFailure: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  expect(await state.coordinator.close("profile1")).toBe(false);

  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "retrying",
  }]);
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("cleanup_retained");
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

  expect(state.events).toEqual(["stop"]);
  expect(state.store.getLaunch("profile1")).toBeNull();
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.closeCalls()).toBe(0);
  expect(state.abandonCalls()).toBe(0);
  expect(state.coordinator.diagnostics().map((event) => event.type)).toContain("access_ended");
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

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
  closeConflict?: boolean;
  closeTransportFailure?: boolean;
  navigateFailure?: boolean;
  startRetainedFailure?: boolean;
  startError?: BrowserLaunchError;
  verifyWebSockets?: string[];
  proxy?: PortableProfileV1["profile"]["proxy"];
} = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const navigatedUrls: string[][] = [];
  const navigateEndpoints: string[] = [];
  const restoreEndpoints: string[] = [];
  const store = new ProfileStore(":memory:");
  const queuePath = join(mkdtempSync(join(tmpdir(), "aliasmode-cloud-browser-")), "pending.sqlite");
  const queue = new PendingSyncQueue(queuePath, new Uint8Array(32).fill(5));
  let closeCalls = 0;
  let abandonCalls = 0;
  let startCalls = 0;
  let startedProxy: unknown;
  let verifyCalls = 0;
  const openedPayload = payload();
  openedPayload.profile.proxy = options.proxy ?? null;
  const opened: OpenProfileResponse = {
    ok: true,
    registrationId: "registration1",
    baseVersion: 4,
    payload: openedPayload,
    activeOpens: [],
  };
  const cloud = {
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
    async active() { return true; },
    async navigate(endpoint: string, urls: string[]) {
      events.push("navigate");
      navigateEndpoints.push(endpoint);
      if (options.navigateFailure) throw new Error("navigation secret");
      navigatedUrls.push(urls);
      expect(queue.getOpen("profile1", "account1")?.phase).toBe("running");
      expect(store.getLaunch("profile1")?.sessionBaseVersion).toBe(4);
    },
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
    accountId: () => "account1",
    deviceId: () => "device1",
    heartbeatMs: 0,
    log(message) {
      logs.push(message);
    },
    async readSession(endpoint: string) {
      expect(endpoint).toBe("ws://browser");
      events.push("capture");
      return JSON.stringify(payload().session);
    },
    async writeSession(endpoint: string) {
      const expectedEndpoint = options.verifyWebSockets?.[0] ?? "ws://browser";
      expect(endpoint).toBe(expectedEndpoint);
      restoreEndpoints.push(endpoint);
      events.push("restore");
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
    store,
    queue,
    closeCalls: () => closeCalls,
    abandonCalls: () => abandonCalls,
    startedProxy: () => startedProxy,
    verifyCalls: () => verifyCalls,
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
  const publicState = JSON.stringify({ logs: state.logs, diagnostics: state.coordinator.diagnostics() });
  for (const secret of [proxy.host, proxy.user, proxy.pass]) expect(publicState).not.toContain(secret);

  state.queue.close();
  state.store.close();
});

test("Cloud browser restores the authoritative session before navigation", async () => {
  const state = setup();
  const result = await state.coordinator.open("profile1", [
    "--window-size=1200,800",
    "https://x.com/messages",
  ]);
  expect(result).toMatchObject({ ok: true, ws: "ws://browser", port: 9222 });
  expect(state.events).toEqual(["cloud-open", "start", "restore", "navigate"]);
  expect(state.verifyCalls()).toBe(2);
  expect(state.navigatedUrls).toEqual([["https://x.com/messages"]]);
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
  expect(state.navigateEndpoints).toEqual([]);
  expect(state.abandonCalls()).toBe(1);
  expect(state.store.getLaunch("profile1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud browser stops retained launch ownership and retries once", async () => {
  const state = setup({ startRetainedFailure: true });

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

  expect(result).toMatchObject({ ok: true, ws: "ws://browser", port: 9222 });
  expect(state.events).toEqual(["cloud-open", "start", "stop", "start", "restore", "navigate"]);
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
  expect(state.events).toEqual(["cloud-open", "start", "restore", "navigate"]);
  expect(state.logs).toEqual([
    "profile1: Cloud startup navigation failed (transport_error, Error); continuing",
  ]);
  expect(JSON.stringify({ result, logs: state.logs })).not.toContain("navigation secret");
  expect(state.queue.getOpen("profile1", "account1")?.phase).toBe("running");
  expect(state.store.getLaunch("profile1")).not.toBeNull();
  expect(state.abandonCalls()).toBe(0);
  state.queue.close();
  state.store.close();
});

test("Cloud browser durably captures before confirmed stop and CAS close", async () => {
  const state = setup();
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);
  state.events.length = 0;
  const originalStop = (state.coordinator as any).options.launcher.stop;
  (state.coordinator as any).options.launcher.stop = async (profileId: string) => {
    expect(state.queue.list("account1")).toMatchObject([{
      profileId: "profile1",
      readyToSubmit: false,
    }]);
    return originalStop(profileId);
  };

  expect(await state.coordinator.close("profile1")).toBe(true);
  expect(state.events).toEqual(["capture", "stop", "cloud-close"]);
  expect(state.closeCalls()).toBe(1);
  expect(state.queue.list("account1")).toEqual([]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.coordinator.diagnostics().map((event) => event.type).slice(-4)).toEqual([
    "close_started",
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
  expect(await state.coordinator.close("profile1")).toBe(true);
  expect(state.closeCalls()).toBe(1);
  expect(state.queue.list("account1")).toMatchObject([{
    profileId: "profile1",
    readyToSubmit: true,
    status: "conflict",
  }]);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.coordinator.diagnostics().at(-1)?.type).toBe("cleanup_retained");
  state.queue.close();
  state.store.close();
});

test("Cloud close diagnostics retain unsynchronized transport failures", async () => {
  const state = setup({ closeTransportFailure: true });
  expect((await state.coordinator.open("profile1", ["--window-size=1200,800"])).ok).toBe(true);

  expect(await state.coordinator.close("profile1")).toBe(true);

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
    error: "Pending Cloud synchronization must finish before reopening",
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
    "relay_setup",
    "process_spawn",
    "cdp_readiness",
    "proxy_egress",
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

test("Cloud browser reports the exact safe session restore operation", async () => {
  const state = setup();
  (state.coordinator as any).options.writeSession = async () => {
    throw new SessionRestoreError("cookie_clear", "failed");
  };

  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);

  expect(result).toMatchObject({
    ok: false,
    error: "Cloud profile open failed at session_restore/cookie_clear (failed)",
  });
  expect(state.logs).toEqual([
    "profile1: Cloud open failed at session_restore/cookie_clear (failed, SessionRestoreError)",
  ]);
  expect(state.coordinator.diagnostics().map((event) => event.type).slice(-2)).toEqual([
    "session_restore_cookie_clear_failed",
    "open_failed",
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
  expect(state.abandonCalls()).toBe(1);
  expect(state.store.getLaunch("profile1")).toBeNull();
  state.queue.close();
  state.store.close();
});

test("Cloud browser reports a safe restore stage and abandons after teardown", async () => {
  const state = setup();
  (state.coordinator as any).options.writeSession = async () => { throw new Error("secret restore detail"); };
  const result = await state.coordinator.open("profile1", ["--window-size=1200,800"]);
  expect(result).toMatchObject({
    ok: false,
    error: "Cloud profile open failed at session_restore (transport_error)",
  });
  expect(state.logs).toEqual([
    "profile1: Cloud open failed at session_restore (transport_error, Error)",
  ]);
  expect(JSON.stringify({ result, logs: state.logs })).not.toContain("secret restore detail");
  expect(state.abandonCalls()).toBe(1);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.store.getLaunch("profile1")).toBeNull();
  state.queue.close();
  state.store.close();
});

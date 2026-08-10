import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudApiError } from "./cloud-client.ts";
import { CloudBrowserCoordinator } from "./cloud-browser.ts";
import type { OpenProfileResponse, PortableProfileV1 } from "./contracts/cloud-v1.ts";
import { PendingSyncQueue } from "./pending-sync.ts";
import { decodePortableProfile } from "./portable-profile.ts";
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
      password: "password",
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
      cookies: [{ name: "auth_token", value: "cookie", domain: ".x.com", path: "/" }],
    },
  };
}

function setup(options: {
  stopResult?: boolean;
  closeConflict?: boolean;
  closeTransportFailure?: boolean;
  navigateFailure?: boolean;
  startRetainedFailure?: boolean;
} = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const navigatedUrls: string[][] = [];
  const store = new ProfileStore(":memory:");
  const queuePath = join(mkdtempSync(join(tmpdir(), "aliasmode-cloud-browser-")), "pending.sqlite");
  const queue = new PendingSyncQueue(queuePath, new Uint8Array(32).fill(5));
  let closeCalls = 0;
  let abandonCalls = 0;
  let startCalls = 0;
  let verifyCalls = 0;
  const opened: OpenProfileResponse = {
    ok: true,
    registrationId: "registration1",
    baseVersion: 4,
    payload: payload(),
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
      expect(args).toEqual(["--window-size=1200,800"]);
      expect(startOptions).toMatchObject({ autoNavigate: false, sessionBaseVersion: -1 });
      expect(queue.getOpen(profileId, "account1")?.phase).toBe("opening");
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
    async navigate(_ws: string, urls: string[]) {
      events.push("navigate");
      if (options.navigateFailure) throw new Error("navigation secret");
      navigatedUrls.push(urls);
      expect(queue.getOpen("profile1", "account1")?.phase).toBe("running");
      expect(store.getLaunch("profile1")?.sessionBaseVersion).toBe(4);
    },
    async verifyRunningIdentity() { verifyCalls++; },
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
      expect(endpoint).toBe("ws://browser");
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
    store,
    queue,
    closeCalls: () => closeCalls,
    abandonCalls: () => abandonCalls,
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

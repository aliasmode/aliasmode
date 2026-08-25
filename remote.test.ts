import { test, expect } from "bun:test";
import { ProfileStore } from "./store.ts";
import { parseExport } from "./parse.ts";
import { HubOwnershipLostError } from "./hub-client.ts";
import { RemoteCoordinator, type RemoteDeps } from "./remote.ts";

const SAMPLE = `id=k1d0cd11
name=sophia
group=va1
cookie=[{"name":"auth_token","value":"orig","domain":".x.com","path":"/","expires":4070908800}]
proxytype=http
proxy=1.2.3.4:8080:u:p
resolution=1680*1050
******************`;

/** Minimal in-memory hub with just the methods the coordinator uses. */
function fakeHub(seed = true) {
  const profile = parseExport(SAMPLE).profiles[0]!;
  const locks = new Map<string, string>();
  const sessions = new Map<string, string>();
  const versionOf = new Map<string, number>();
  const calls: string[] = [];
  // A stored session has version >= 1; a directly-seeded sessions.set() (no version tracked) reads as v1.
  const curVersion = (id: string) => versionOf.get(id) ?? (sessions.has(id) ? 1 : 0);
  return {
    locks,
    sessions,
    versionOf,
    calls,
    owner: "me",
    async getRoster() {
      return [{
        id: profile.id,
        name: profile.name,
        group: profile.group,
        platform: profile.platform ?? "",
        tags: profile.tags ?? [],
        proxy: profile.proxy ? `${profile.proxy.host}:${profile.proxy.port}` : null,
        timezone: profile.timezone,
        cookieCount: profile.cookies.length,
        seeded: profile.seeded,
        screen: `${profile.screenWidth}x${profile.screenHeight}`,
        lockedBy: locks.get(profile.id) ?? null,
        hasSession: sessions.has(profile.id),
      }];
    },
    async getProfile(_id: string) { return { ...profile }; }, // fresh copy per call, like the real HubClient
    async saveProfile() {},
    async claim(id: string) {
      const cur = locks.get(id);
      if (cur && cur !== "me") return { ok: false as const, lockedBy: cur };
      locks.set(id, "me");
      calls.push(`claim:${id}`);
      return { ok: true as const };
    },
    async renew(id: string) { calls.push(`renew:${id}`); return locks.get(id) === "me"; },
    async release(id: string) { locks.delete(id); calls.push(`release:${id}`); },
    async getSession(id: string) { return sessions.has(id) ? { profileId: id, bundle: sessions.get(id)!, version: curVersion(id), updatedAt: 0, updatedBy: "" } : null; },
    async putSession(id: string, bundle: string, baseVersion?: number) {
      const cur = curVersion(id);
      if (baseVersion !== undefined && baseVersion !== cur) return { version: cur, conflict: true };
      sessions.set(id, bundle);
      const v = cur + 1;
      versionOf.set(id, v);
      calls.push(`putSession:${id}`);
      return { version: v, conflict: false };
    },
    async importFiles() { return { files: 0, profiles: 0 }; },
    async move() { return 0; },
    async createProfile() { return { id: "new" }; },
    async renameProfile(id: string, name: string) { profile.name = name; calls.push(`rename:${id}:${name}`); },
    async deleteProfiles() { return { deleted: 0, locked: [] as string[] }; },
    _hold(id: string, who: string) { locks.set(id, who); },
  };
}

function harness(
  hub = fakeHub(),
  readSession: () => Promise<string> = async () => '{"cookies":[{"name":"auth_token","value":"rotated","domain":".x.com","path":"/"}],"origins":[]}',
  writeSession?: RemoteDeps["writeSession"],
) {
  const store = new ProfileStore(":memory:");
  const launched: string[] = [];
  const startedArgs: string[][] = [];
  const startedOptions: any[] = [];
  const injected: string[] = [];
  const navigated: string[][] = [];
  const replacedPages: boolean[] = [];
  const events: string[] = [];
  let active = true; // short CDP probe result
  let processAlive = true; // exact executable/port/user-data reconciliation
  const launcher = {
    async start(id: string, args: string[] = [], opts: any = {}) {
      startedArgs.push(args);
      startedOptions.push(opts);
      const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1, sessionBaseVersion: opts.sessionBaseVersion };
      store.recordLaunch(info);
      launched.push(id);
      events.push("start");
      return { ws: info.ws, port: info.debugPort };
    },
    async stop(id: string) { store.clearLaunch(id); events.push("stop"); return true; },
    async active(_id: string) { return active; },
    async reconcileOrphan(id: string, expected: { debugPort: number; startedAt: number }) {
      const launch = store.getLaunch(id);
      if (!launch) return "dead" as const;
      if (launch.debugPort !== expected.debugPort || launch.startedAt !== expected.startedAt) return "generation_changed" as const;
      if (processAlive) return "alive" as const;
      store.clearLaunch(id);
      return "dead" as const;
    },
    async navigate(_ws: string, urls: string[], replacePages = false) {
      navigated.push(urls);
      replacedPages.push(replacePages);
      events.push("navigate");
    },
  };
  const deps: RemoteDeps = {
    hub,
    launcher,
    store,
    readSession,
    writeSession: writeSession ?? (async (_ws, bundle) => { injected.push(bundle); events.push("writeSession"); }),
    heartbeatMs: 0, // no auto timer in tests
  };
  return {
    coord: new RemoteCoordinator(deps), store, launched, startedArgs, startedOptions, injected, navigated, replacedPages, events, hub,
    setAlive(value: boolean) { active = value; processAlive = value; },
    setActiveProbe(value: boolean) { active = value; },
  };
}

test("open claims the lock, launches, and injects the hub session", async () => {
  const h = harness();
  h.hub.sessions.set("k1d0cd11", '{"cookies":[{"name":"auth_token","value":"hub","domain":".x.com","path":"/"}]}');
  const r = await h.coord.open("k1d0cd11");
  expect(r.ok).toBe(true);
  expect(r.ws).toBe("ws://x/k1d0cd11");
  expect(h.launched).toEqual(["k1d0cd11"]);
  expect(h.injected[0]).toContain('"value":"hub"'); // the hub's session, not the original
  expect(h.store.getLaunch("k1d0cd11")!.sessionBaseVersion).toBe(1);
});

test("open falls back to the profile's original cookies when the hub has no session", async () => {
  const h = harness();
  const r = await h.coord.open("k1d0cd11");
  expect(r.ok).toBe(true);
  expect(h.injected[0]).toContain('"value":"orig"'); // first migration
});

test("open seeds the remote session before navigating startup URLs", async () => {
  const h = harness();
  h.hub.sessions.set("k1d0cd11", '{"cookies":[{"name":"auth_token","value":"hub","domain":".x.com","path":"/"}]}');
  const r = await h.coord.open("k1d0cd11", ["--start-maximized", "https://x.com/home"]);
  expect(r.ok).toBe(true);
  expect(h.startedArgs[0]).toEqual(["--start-maximized"]); // URL withheld from Chromium argv
  expect(h.startedOptions[0]).toMatchObject({ autoNavigate: false, restoreLastSession: false });
  expect(h.injected[0]).toContain('"value":"hub"');
  expect(h.navigated).toEqual([["https://x.com/home"]]);
  expect(h.replacedPages).toEqual([true]);
  expect(h.events).toEqual(["start", "writeSession", "navigate"]);
});

test("open replaces stale pages with saved tabs followed by explicit URLs", async () => {
  const hub = fakeHub();
  let writeOptions: { authoritative?: boolean } | undefined;
  const h = harness(hub, undefined, async (_ws, _bundle, options) => { writeOptions = options; });
  h.hub.sessions.set("k1d0cd11", JSON.stringify({
    cookies: [],
    origins: [],
    tabs: [
      "https://saved.example/one",
      "https://saved.example/one",
      "https://saved.example/two",
    ],
  }));

  expect((await h.coord.open("k1d0cd11", ["https://explicit.example/three"])).ok).toBe(true);
  expect(writeOptions).toEqual({ authoritative: true });
  expect(h.navigated).toEqual([[
    "https://saved.example/one",
    "https://saved.example/one",
    "https://saved.example/two",
    "https://explicit.example/three",
  ]]);
  expect(h.replacedPages).toEqual([true]);
});

test("open falls back to the platform home page (after the session) when no URL is passed", async () => {
  const hub = fakeHub();
  const original = hub.getProfile;
  hub.getProfile = async () => ({ ...(await original("k1d0cd11")), platform: "x.com" });
  const h = harness(hub);
  const r = await h.coord.open("k1d0cd11");
  expect(r.ok).toBe(true);
  expect(h.startedArgs[0]).toEqual([]); // nothing forwarded to Chromium argv
  expect(h.navigated).toEqual([["https://x.com/home"]]);
  expect(h.events).toEqual(["start", "writeSession", "navigate"]); // home opened only after writeSession
});

test("open warns but launches when someone else holds the writer lease", async () => {
  const hub = fakeHub();
  hub._hold("k1d0cd11", "ben");
  const h = harness(hub);
  const r = await h.coord.open("k1d0cd11");
  expect(r.ok).toBe(true);
  expect(r.lockedBy).toBe("ben");
  expect(r.warning).toContain("ben");
  expect(r.warning).toContain("session sync is disabled");
  expect(h.launched).toEqual(["k1d0cd11"]);
  expect(h.injected[0]).toContain('"value":"orig"');
  expect(hub.locks.get("k1d0cd11")).toBe("ben");
  expect(hub.calls).toEqual([]);
});

test("open continues advisory when writer claim transport fails", async () => {
  const hub = fakeHub();
  hub.claim = async () => { throw new Error("claim timeout"); };
  const h = harness(hub);

  const r = await h.coord.open("k1d0cd11");

  expect(r.ok).toBe(true);
  expect(r.warning).toContain("ownership could not be confirmed");
  expect(h.launched).toEqual(["k1d0cd11"]);
  expect(h.injected[0]).toContain('"value":"orig"');
  expect(hub.calls).toEqual([]);
});

test("reopen after writer lease loss stays local and becomes advisory", async () => {
  const hub = fakeHub();
  const h = harness(hub);
  expect((await h.coord.open("k1d0cd11")).ok).toBe(true);
  hub._hold("k1d0cd11", "ben");
  h.events.length = 0;
  hub.calls.length = 0;

  const reopened = await h.coord.open("k1d0cd11");

  expect(reopened.ok).toBe(true);
  expect(reopened.lockedBy).toBe("ben");
  expect(reopened.warning).toContain("session sync is disabled");
  expect(h.events).not.toContain("stop");
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hub.locks.get("k1d0cd11")).toBe("ben");
  expect(hub.calls).toEqual([]);
});

test("open failure keeps the hub lock when launcher retains an unconfirmed local browser", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        store.recordLaunch({ profileId: id, pid: 8123, debugPort: 9333, ws: "ws://stale", startedAt: 1 });
        throw new Error("owned process alive but CDP unavailable; stop and retry");
      },
      async stop() { return false; },
      async active() { return false; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const result = await coord.open("k1d0cd11");
  expect(result.ok).toBe(false);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  store.close();
});

test("failed open transfers one stalled stop into retained cleanup", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const intervals: Array<() => void> = [];
  let stopCalls = 0;
  let finishStop!: (stopped: boolean) => void;
  const blockedStop = new Promise<boolean>((resolve) => { finishStop = resolve; });
  const never = new Promise<string>(() => {});
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        store.recordLaunch({ profileId: id, pid: 8123, debugPort: 9333, ws: "ws://stale", startedAt: 1 });
        throw new Error("proxy verification failed");
      },
      async stop(id: string) {
        stopCalls++;
        const stopped = await blockedStop;
        if (stopped) store.clearLaunch(id);
        return stopped;
      },
      async active() { return true; },
      async navigate() {},
      async diagnoseCdp() { return never; },
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    retainedCleanupAttemptMs: 5,
    retainedCleanupRetryMs: 100,
    retainedCleanupRenewMs: 100,
    setIntervalFn: (fn) => { intervals.push(fn); return intervals.length; },
    clearIntervalFn: () => {},
  });

  const result = await Promise.race([
    coord.open("k1d0cd11"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("open remained stuck")), 250)),
  ]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("proxy verification failed");
  expect(coord.lifecycleState("k1d0cd11")).toBe("stopping");
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  expect(stopCalls).toBe(1);

  intervals[0]!();
  await Bun.sleep(0);
  expect(stopCalls).toBe(1);

  finishStop(true);
  for (let i = 0; i < 10 && coord.lifecycleState("k1d0cd11"); i++) await Bun.sleep(0);
  expect(coord.lifecycleState("k1d0cd11")).toBeNull();
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  expect(stopCalls).toBe(1);
  store.close();
});

test("failed open keeps cleanup unconfirmed when browser stop succeeds but hub release fails", async () => {
  const hub = fakeHub();
  let releaseCalls = 0;
  hub.getSession = async () => { throw new Error("session offline"); };
  hub.release = async () => {
    releaseCalls++;
    throw new Error("release offline");
  };
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { throw new Error("must not launch"); },
      async stop() { return true; },
      async active() { return false; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    retainedCleanupRetryMs: 1,
    retainedCleanupRenewMs: 1,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const result = await coord.open("k1d0cd11");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("session offline");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(releaseCalls).toBeGreaterThanOrEqual(2); // direct release plus retained-cleanup retry
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  await expect(coord.releaseAll()).rejects.toThrow("shutdown");
  store.close();
});

test("retained cleanup completes when failed release no longer owns the writer lease", async () => {
  const hub = fakeHub();
  hub.getSession = async () => { throw new Error("session offline"); };
  hub.release = async () => { throw new Error("lease fence required"); };
  let renews = 0;
  hub.renew = async () => ++renews === 1;
  const h = harness(hub);

  expect((await h.coord.open("k1d0cd11")).ok).toBe(false);
  for (let i = 0; i < 10 && renews < 2; i++) await Bun.sleep(0);

  expect(renews).toBeGreaterThanOrEqual(2);
  await expect(h.coord.releaseAll()).resolves.toBe(true);
  h.store.close();
});

test("force remains a compatibility no-op for advisory launches", async () => {
  const hub = fakeHub();
  hub._hold("k1d0cd11", "ben");
  const h = harness(hub);
  const r = await h.coord.open("k1d0cd11", [], true);
  expect(r.ok).toBe(true);
  expect(r.warning).toContain("session sync is disabled");
  expect(r.lockedBy).toBe("ben");
  expect(h.launched).toEqual(["k1d0cd11"]);
  expect(hub.locks.get("k1d0cd11")).toBe("ben");
});

test("failed close renews beyond the lease and retries stop single-flight until confirmed release", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let now = 1_000;
  let stopCalls = 0;
  let releaseBlockedStop!: (stopped: boolean) => void;
  const blockedStop = new Promise<boolean>((resolve) => { releaseBlockedStop = resolve; });
  const intervals: Array<() => void> = [];
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) {
        stopCalls++;
        if (stopCalls === 1) return false; // close() reports failure promptly
        if (stopCalls === 2) return blockedStop; // retained attempt exceeds its observation bound
        store.clearLaunch(id);
        return true;
      },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    leaseMs: 90,
    nowMs: () => now,
    retainedCleanupRetryMs: 30,
    retainedCleanupRenewMs: 25,
    retainedCleanupAttemptMs: 5,
    setIntervalFn: (fn) => { intervals.push(fn); return intervals.length; },
    clearIntervalFn: () => {},
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  expect(await coord.close("k1d0cd11")).toBe(false);
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 8)); // cleanup attempt 2 timed out, but remains in flight
  expect(stopCalls).toBe(2);

  // Advance and tick for longer than the nominal lease. Renewal continues, but
  // no third stop overlaps the still-unsettled second attempt.
  for (let i = 0; i < 4; i++) {
    now += 30;
    intervals[0]!();
    await Promise.resolve();
  }
  expect(now - 1_000).toBeGreaterThan(90);
  expect(stopCalls).toBe(2);
  expect(hub.calls.filter((call) => call === "renew:k1d0cd11").length).toBeGreaterThanOrEqual(4);
  expect(hub.locks.get("k1d0cd11")).toBe("me");

  releaseBlockedStop(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  now += 30;
  intervals[0]!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stopCalls).toBe(3);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  store.close();
});

test("retained cleanup blocks reopen until its owner-scoped hub release settles", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let stopCalls = 0;
  let releaseEntered!: () => void;
  let finishRelease!: () => void;
  const releaseStarted = new Promise<void>((resolve) => { releaseEntered = resolve; });
  const releaseBlocked = new Promise<void>((resolve) => { finishRelease = resolve; });
  const originalRelease = hub.release.bind(hub);
  hub.release = async (id: string) => {
    releaseEntered();
    await releaseBlocked;
    await originalRelease(id);
  };
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) {
        stopCalls++;
        if (stopCalls === 1) return false;
        store.clearLaunch(id);
        return true;
      },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    retainedCleanupRetryMs: 1,
    retainedCleanupRenewMs: 1,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  expect(await coord.close("k1d0cd11")).toBe(false);
  await releaseStarted;

  const blockedOpen = await coord.open("k1d0cd11");
  expect(blockedOpen.ok).toBe(false);
  expect(blockedOpen.error).toContain("cleanup is still in progress");

  finishRelease();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reopened = await coord.open("k1d0cd11");
  expect(reopened.ok).toBe(true);
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  store.close();
});

test("close reads the session back, pushes it, stops, and releases", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  expect(await h.coord.close("k1d0cd11")).toBe(true);
  expect(h.hub.sessions.get("k1d0cd11")).toContain('"value":"rotated"'); // saved for the next opener
  expect(h.store.getLaunch("k1d0cd11")).toBeNull(); // stopped
  expect(h.hub.locks.has("k1d0cd11")).toBe(false); // released

  const hubCalls = [...h.hub.calls];
  expect(await h.coord.close("k1d0cd11")).toBe(true);
  expect(h.hub.calls).toEqual(hubCalls);
  expect(h.events.filter((event) => event === "stop")).toHaveLength(2);
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
});

test("fast Telegram checkpoint saves a new login before a native browser-window close", async () => {
  const telegramA = JSON.stringify({
    cookies: [], telegramClient: "a",
    origins: [{
      origin: "https://web.telegram.org",
      localStorage: [{ name: "account1", value: JSON.stringify({ dcId: 2, dc2_auth_key: "NEW-AUTH", userId: "42" }) }],
    }],
  });
  const h = harness(fakeHub(), async () => telegramA);
  await h.coord.open("k1d0cd11"); // hub starts with no Telegram session

  await h.coord.sessionSyncOnce("k1d0cd11", "ws://x/k1d0cd11"); // the production 3-second checkpoint
  expect(h.hub.sessions.get("k1d0cd11")).toBe(telegramA);
  expect(h.hub.calls.filter((call) => call === "putSession:k1d0cd11")).toHaveLength(1);

  // Clicking the browser's own X leaves nothing to harvest afterward. The next heartbeat only cleans
  // up the lock, but the checkpointed auth is already durable for device B.
  h.setAlive(false);
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.sessions.get("k1d0cd11")).toBe(telegramA);
  expect(h.hub.locks.has("k1d0cd11")).toBe(false);
});

test("fast Telegram checkpoint ignores unchanged auth instead of churning hub versions", async () => {
  const telegramK = JSON.stringify({
    cookies: [], telegramClient: "k",
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "SAME" }] }],
  });
  const h = harness(fakeHub(), async () => telegramK);
  await h.coord.open("k1d0cd11");
  await h.coord.sessionSyncOnce("k1d0cd11", "ws://x/k1d0cd11");
  await h.coord.sessionSyncOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls.filter((call) => call === "putSession:k1d0cd11")).toHaveLength(1);
});

test("Telegram checkpoint and heartbeat serialize their hub writes and advance the CAS base", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let putCalls = 0;
  let activePuts = 0;
  let maxActivePuts = 0;
  let firstPutEntered!: () => void;
  let releaseFirstPut!: () => void;
  const firstEntered = new Promise<void>((resolve) => { firstPutEntered = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
  const originalPut = hub.putSession.bind(hub);
  hub.putSession = async (...args: Parameters<typeof originalPut>) => {
    putCalls++;
    activePuts++;
    maxActivePuts = Math.max(maxActivePuts, activePuts);
    if (putCalls === 1) {
      firstPutEntered();
      await firstBlocked;
    }
    try {
      return await originalPut(...args);
    } finally {
      activePuts--;
    }
  };
  const telegram = JSON.stringify({
    cookies: [], telegramClient: "a",
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "AUTH" }] }],
  });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => telegram,
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  const checkpoint = coord.sessionSyncOnce("k1d0cd11", "ws://x/k1d0cd11");
  await firstEntered;
  const heartbeat = coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  await Promise.resolve();
  expect(putCalls).toBe(1);

  releaseFirstPut();
  await Promise.all([checkpoint, heartbeat]);
  expect(putCalls).toBe(2);
  expect(maxActivePuts).toBe(1);
  expect(hub.versionOf.get("k1d0cd11")).toBe(2);
  store.close();
});

test("a cleared Telegram checkpoint callback cannot adopt the reopened generation", async () => {
  const hub = fakeHub();
  const getProfile = hub.getProfile;
  hub.getProfile = async (id: string) => ({ ...(await getProfile(id)), platform: "telegram.org" });
  const store = new ProfileStore(":memory:");
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const sessionReads: string[] = [];
  let starts = 0;
  const telegram = JSON.stringify({
    cookies: [], telegramClient: "a",
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "AUTH" }] }],
  });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        starts++;
        const launch = { profileId: id, pid: starts, debugPort: 9000 + starts, ws: `ws://x/${starts}`, startedAt: starts };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async (ws) => { sessionReads.push(ws); return telegram; },
    writeSession: async () => {},
    heartbeatMs: 1_000,
    sessionSyncMs: 10,
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearIntervalFn: () => {},
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  const oldCheckpoint = intervals.find((entry) => entry.ms === 10)!.fn;
  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  const checkpoints = intervals.filter((entry) => entry.ms === 10);

  oldCheckpoint();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sessionReads).toEqual([]);

  checkpoints[1]!.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sessionReads).toEqual(["ws://x/2"]);
  store.close();
});

test("browser-gone heartbeat retains the lock until an in-flight Telegram PUT drains without self-deadlock", async () => {
  const hub = fakeHub();
  const getProfile = hub.getProfile;
  hub.getProfile = async (id: string) => ({ ...(await getProfile(id)), platform: "telegram.org" });
  const store = new ProfileStore(":memory:");
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  let alive = true;
  let stopCalls = 0;
  let stopEntered!: () => void;
  const stopped = new Promise<void>((resolve) => { stopEntered = resolve; });
  let putEntered!: () => void;
  let releasePut!: () => void;
  const entered = new Promise<void>((resolve) => { putEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releasePut = resolve; });
  const originalPut = hub.putSession.bind(hub);
  hub.putSession = async (...args: Parameters<typeof originalPut>) => {
    putEntered();
    await blocked;
    return originalPut(...args);
  };
  const telegram = JSON.stringify({
    cookies: [], telegramClient: "k",
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "AUTH" }] }],
  });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) {
        stopCalls++;
        store.clearLaunch(id);
        stopEntered();
        return true;
      },
      async active() { return alive; },
      async reconcileOrphan(id: string) {
        if (alive) return "alive" as const;
        store.clearLaunch(id);
        return "dead" as const;
      },
      async navigate() {},
    },
    store,
    readSession: async () => telegram,
    writeSession: async () => {},
    heartbeatMs: 1_000,
    sessionSyncMs: 10,
    retainedCleanupRetryMs: 1,
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearIntervalFn: () => {},
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  intervals.find((entry) => entry.ms === 10)!.fn();
  await entered;
  alive = false;
  intervals.find((entry) => entry.ms === 1_000)!.fn();
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  expect(hub.calls).not.toContain("release:k1d0cd11");

  releasePut();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stopCalls).toBeGreaterThanOrEqual(2);
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  store.close();
});

test("Telegram handoff reopens the same Web K client recorded in the hub bundle", async () => {
  const hub = fakeHub();
  const getProfile = hub.getProfile;
  hub.getProfile = async (id: string) => ({ ...(await getProfile(id)), platform: "telegram.org" });
  hub.sessions.set("k1d0cd11", JSON.stringify({
    cookies: [], telegramClient: "k",
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "AUTH" }] }],
  }));
  const h = harness(hub);
  expect((await h.coord.open("k1d0cd11")).ok).toBe(true);
  expect(h.navigated).toEqual([["https://web.telegram.org/k/"]]);
});

test("remote Telegram handoff defaults to Web A when an older bundle has no client metadata", async () => {
  const hub = fakeHub();
  const getProfile = hub.getProfile;
  hub.getProfile = async (id: string) => ({ ...(await getProfile(id)), platform: "telegram.org" });
  hub.sessions.set("k1d0cd11", JSON.stringify({
    cookies: [],
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "AUTH" }] }],
  }));
  const h = harness(hub);

  expect((await h.coord.open("k1d0cd11")).ok).toBe(true);
  expect(h.navigated).toEqual([["https://web.telegram.org/a/"]]);
});

test("managed Close keeps the browser and lock when the final session upload fails", async () => {
  const hub = fakeHub();
  hub.putSession = async () => { throw new Error("hub offline"); };
  const h = harness(hub);
  await h.coord.open("k1d0cd11");

  await expect(h.coord.close("k1d0cd11")).rejects.toThrow("browser left open");
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.locks.get("k1d0cd11")).toBe("me");
});

test("managed Close keeps the browser and lock when the final CDP read fails", async () => {
  const h = harness(fakeHub(), async () => { throw new Error("CDP disconnected"); });
  await h.coord.open("k1d0cd11");

  await expect(h.coord.close("k1d0cd11")).rejects.toThrow("browser left open");
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.locks.get("k1d0cd11")).toBe("me");
});

test("managed Close completes when the hub deliberately skips the final snapshot", async () => {
  const hub = fakeHub();
  hub.putSession = async () => ({ version: 0, conflict: false, skipped: "kept better logged-in session" });
  const h = harness(hub);
  await h.coord.open("k1d0cd11");

  await h.coord.close("k1d0cd11");

  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
  expect(h.hub.locks.has("k1d0cd11")).toBe(false);
});

test("managed Close completes on a version conflict because the hub already has a fresher bundle", async () => {
  const hub = fakeHub();
  const h = harness(hub);
  await h.coord.open("k1d0cd11"); // opened from v0
  hub.sessions.set("k1d0cd11", '{"cookies":[{"name":"auth_token","value":"FRESHER"}]}');
  hub.versionOf.set("k1d0cd11", 1);

  await h.coord.close("k1d0cd11");

  expect(hub.sessions.get("k1d0cd11")).toContain("FRESHER");
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.locks.has("k1d0cd11")).toBe(false);
});

test("fast session checkpoint timer is armed only for Telegram profiles", async () => {
  const openWithPlatform = async (platform: string, bundle?: string) => {
    const hub = fakeHub();
    const getProfile = hub.getProfile;
    hub.getProfile = async (id: string) => ({ ...(await getProfile(id)), platform });
    if (bundle) hub.sessions.set("k1d0cd11", bundle);
    const store = new ProfileStore(":memory:");
    const intervals: number[] = [];
    const coord = new RemoteCoordinator({
      hub,
      launcher: {
        async start(id: string) {
          const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
          store.recordLaunch(launch);
          return { ws: launch.ws, port: launch.debugPort };
        },
        async stop(id: string) { store.clearLaunch(id); return true; },
        async active() { return true; },
        async navigate() {},
      },
      store,
      readSession: async () => '{"cookies":[],"origins":[]}',
      writeSession: async () => {},
      heartbeatMs: 120_000,
      sessionSyncMs: 3_000,
      setIntervalFn: (_fn, ms) => { intervals.push(ms); return intervals.length; },
      clearIntervalFn: () => {},
    });
    await coord.open("k1d0cd11");
    store.close();
    return intervals;
  };

  expect(await openWithPlatform("x.com")).toEqual([120_000]);
  expect(await openWithPlatform("linkedin.com")).toEqual([120_000]);
  expect(await openWithPlatform("web.telegram.org")).toEqual([3_000, 120_000]);
  expect(await openWithPlatform("", JSON.stringify({
    cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "theme", value: "dark" }] }],
  }))).toEqual([3_000, 120_000]);
});

test("a failed launch attempts stop even without a durable row before releasing", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let stopCalled = false;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { throw new Error("spawn failed"); },
      async stop() { stopCalled = true; return true; },
      async active() { return false; },
      async navigate() {},
      async diagnoseCdp() { return "no launch record"; },
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });
  const r = await coord.open("k1d0cd11");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("spawn failed");
  expect(r.error).not.toContain("cdp:");
  expect(stopCalled).toBe(true);
  expect(hub.locks.has("k1d0cd11")).toBe(false); // lock released on failure
});

test("open aborts (no launch, no inject) when the hub session fetch errors — never replays stale cookies", async () => {
  const hub = fakeHub();
  hub.getSession = async () => {
    throw new Error("hub unreachable");
  };
  const h = harness(hub);
  const r = await h.coord.open("k1d0cd11");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("hub unreachable");
  expect(h.launched).toEqual([]); // never launched a browser
  expect(h.injected).toEqual([]); // never injected the profile's frozen import cookies over a live login
  expect(hub.locks.has("k1d0cd11")).toBe(false); // lock released, not stranded
});

test("open fails closed and stops the local browser when session restore fails", async () => {
  const h = harness(fakeHub(), undefined, async () => { throw new Error("origin restore failed"); });
  const r = await h.coord.open("k1d0cd11");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("origin restore failed");
  expect(h.events).toContain("stop");
  expect(h.events).not.toContain("navigate");
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
  expect(h.hub.locks.has("k1d0cd11")).toBe(false);
});

test("restore failure with unconfirmed stop retains the browser and hub lock", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop() { return false; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => { throw new Error("origin restore failed"); },
    heartbeatMs: 0,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const result = await coord.open("k1d0cd11");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("origin restore failed");
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  expect((await coord.open("k1d0cd11")).error).toContain("cleanup is still in progress");
  store.close();
});

test("heartbeat downgrades to advisory after the last confirmed writer lease expires", async () => {
  let clock = 1_000_000;
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const stopped: string[] = [];
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) {
        store.clearLaunch(id);
        stopped.push(id);
        return true;
      },
      async active() {
        return true;
      },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    leaseMs: 300_000,
    nowMs: () => clock,
  });
  await coord.open("k1d0cd11"); // baselines lastBeatAt at clock = 1_000_000
  expect(hub.locks.get("k1d0cd11")).toBe("me");

  clock += 400_000; // machine slept ~6.7 min, past the 5-min lease
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");

  expect(stopped).toEqual([]);
  expect(hub.locks.has("k1d0cd11")).toBe(true); // never release a possibly-new writer lease
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  hub.calls.length = 0;
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hub.calls).toEqual([]); // advisory instances no longer renew or push
});

test("heartbeat skips its push (no revert) when the hub session advanced past our base version", async () => {
  const hub = fakeHub();
  const h = harness(hub);
  await h.coord.open("k1d0cd11"); // no hub session yet → base v0
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11"); // pushes our session → hub v1, base → 1
  expect(hub.sessions.get("k1d0cd11")).toContain('"value":"rotated"');

  // Another operator wrote a newer session in the background (hub jumps to v2).
  hub.sessions.set("k1d0cd11", '{"cookies":[{"name":"auth_token","value":"newer"}]}');
  hub.versionOf.set("k1d0cd11", 2);

  // Our next push is based on v1 → version conflict → must leave the newer session untouched.
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hub.sessions.get("k1d0cd11")).toContain('"value":"newer"'); // not reverted to our stale "rotated"
});

test("heartbeat downgrades immediately when session PUT loses writer ownership", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.hub.putSession = async () => { throw new HubOwnershipLostError("lease fence mismatch"); };
  h.hub.calls.length = 0;

  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");

  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.calls).toEqual(["renew:k1d0cd11"]);
  h.hub.calls.length = 0;
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls).toEqual([]);
});

test("close stops locally when session PUT loses writer ownership", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.hub.putSession = async () => { throw new HubOwnershipLostError("lease fence mismatch"); };
  h.hub.calls.length = 0;

  expect(await h.coord.close("k1d0cd11")).toBe(true);

  expect(h.hub.calls).toEqual(["renew:k1d0cd11"]);
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
});

test("heartbeatOnce renews the lease and pushes the current session", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls).toContain("renew:k1d0cd11");
  expect(h.hub.sessions.get("k1d0cd11")).toContain('"value":"rotated"');
  expect(h.store.getLaunch("k1d0cd11")!.sessionBaseVersion).toBe(1);
});

test("scheduled heartbeats are single-flight when a prior tick stalls", async () => {
  const hub = fakeHub();
  let tick: (() => void) | undefined;
  let renewCalls = 0;
  let releaseRenew!: () => void;
  let renewEntered!: () => void;
  const renewBlocked = new Promise<void>((resolve) => { releaseRenew = resolve; });
  const renewStarted = new Promise<void>((resolve) => { renewEntered = resolve; });
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 1_000,
    setIntervalFn: (fn) => { tick = fn; return 1; },
    clearIntervalFn: () => {},
  });

  await coord.open("k1d0cd11");
  hub.renew = async () => {
    renewCalls++;
    renewEntered();
    await renewBlocked;
    return true;
  };
  tick!();
  await renewStarted;
  tick!();
  await Promise.resolve();
  expect(renewCalls).toBe(1);

  releaseRenew();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tick!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(renewCalls).toBe(2);
  store.close();
});

test("a timed-out session read cannot permanently stall lease heartbeats or multiply readers", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let readCalls = 0;
  let finishFirstRead!: (bundle: string) => void;
  const firstRead = new Promise<string>((resolve) => { finishFirstRead = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => {
      readCalls++;
      if (readCalls === 1) return firstRead;
      return '{"cookies":[{"name":"auth_token","value":"RECOVERED","domain":".x.com","path":"/"}],"origins":[]}';
    },
    writeSession: async () => {},
    heartbeatMs: 0,
    sessionReadTimeoutMs: 5,
  });

  await coord.open("k1d0cd11");
  const renewsBefore = hub.calls.filter((call) => call === "renew:k1d0cd11").length;

  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hub.calls.filter((call) => call === "renew:k1d0cd11").length).toBe(renewsBefore + 2);
  expect(readCalls).toBe(1);
  expect(coord.memoryAttribution()).toMatchObject({
    sessionCapturesStarted: 1,
    sessionCapturesSettled: 0,
    sessionCaptureErrors: 0,
    pendingSessionReads: 1,
  });

  finishFirstRead('{"cookies":[],"origins":[]}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(readCalls).toBe(2);
  expect(hub.sessions.get("k1d0cd11")).toContain("RECOVERED");
  expect(coord.memoryAttribution()).toMatchObject({
    sessionCapturesStarted: 2,
    sessionCapturesSettled: 2,
    sessionCaptureErrors: 0,
    pendingSessionReads: 0,
  });
  store.close();
});

test("Telegram checkpoint and heartbeat share the same bounded session reader", async () => {
  const hub = fakeHub();
  hub.sessions.set("k1d0cd11", JSON.stringify({
    cookies: [],
    origins: [{
      origin: "https://web.telegram.org",
      localStorage: [{ name: "dc1_auth_key", value: "seed" }],
    }],
  }));
  hub.versionOf.set("k1d0cd11", 1);
  const store = new ProfileStore(":memory:");
  let readCalls = 0;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => {
      readCalls++;
      return new Promise<string>(() => {});
    },
    writeSession: async () => {},
    heartbeatMs: 0,
    sessionSyncMs: 0,
    sessionReadTimeoutMs: 5,
  });

  await coord.open("k1d0cd11");
  await expect(coord.sessionSyncOnce("k1d0cd11", "ws://x/k1d0cd11")).rejects.toThrow("exceeded 5ms");
  const renewsBefore = hub.calls.filter((call) => call === "renew:k1d0cd11").length;
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hub.calls.filter((call) => call === "renew:k1d0cd11").length).toBe(renewsBefore + 1);
  expect(readCalls).toBe(1);
  store.close();
});

test("a stuck reader blocks live-browser reopen but not a new generation after confirmed stop", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let alive = true;
  let starts = 0;
  let readCalls = 0;
  let finishOldRead!: (bundle: string) => void;
  let finishNewRead!: (bundle: string) => void;
  const oldRead = new Promise<string>((resolve) => { finishOldRead = resolve; });
  const newRead = new Promise<string>((resolve) => { finishNewRead = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        starts++;
        alive = true;
        const launch = {
          profileId: id,
          pid: starts,
          debugPort: 9000 + starts,
          ws: `ws://x/${id}/${starts}`,
          startedAt: starts,
        };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) {
        alive = false;
        store.clearLaunch(id);
        return true;
      },
      async active() { return alive; },
      async reconcileOrphan(id: string) {
        if (alive) return "alive" as const;
        store.clearLaunch(id);
        return "dead" as const;
      },
      async navigate() {},
    },
    store,
    readSession: async () => {
      readCalls++;
      if (readCalls === 1) return oldRead;
      if (readCalls === 2) return newRead;
      return '{"cookies":[{"name":"auth_token","value":"NEW_GENERATION","domain":".x.com","path":"/"}],"origins":[]}';
    },
    writeSession: async () => {},
    heartbeatMs: 0,
    sessionReadTimeoutMs: 5,
  });

  const first = await coord.open("k1d0cd11");
  expect(first.ok).toBe(true);
  await coord.heartbeatOnce("k1d0cd11", first.ws!);
  const refused = await coord.open("k1d0cd11");
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain("session capture is still running");
  expect(starts).toBe(1);

  alive = false;
  await coord.heartbeatOnce("k1d0cd11", first.ws!);
  const reopened = await coord.open("k1d0cd11");
  expect(reopened.ok).toBe(true);
  expect(starts).toBe(2);
  await coord.heartbeatOnce("k1d0cd11", reopened.ws!);
  finishOldRead('{"cookies":[{"name":"auth_token","value":"STALE_OLD","domain":".x.com","path":"/"}],"origins":[]}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coord.heartbeatOnce("k1d0cd11", reopened.ws!);
  expect(readCalls).toBe(2);
  finishNewRead('{"cookies":[{"name":"auth_token","value":"TIMED_OUT_NEW","domain":".x.com","path":"/"}],"origins":[]}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coord.heartbeatOnce("k1d0cd11", reopened.ws!);
  expect(readCalls).toBe(3);
  expect(hub.sessions.get("k1d0cd11")).toContain("NEW_GENERATION");
  expect(hub.sessions.get("k1d0cd11")).not.toContain("STALE_OLD");
  expect(hub.sessions.get("k1d0cd11")).not.toContain("TIMED_OUT_NEW");
  store.close();
});

test("reopen drains an old heartbeat put before reading and injecting the authoritative session", async () => {
  const hub = fakeHub();
  const ticks: Array<() => void> = [];
  const events: string[] = [];
  let putEntered!: () => void;
  let releasePut!: () => void;
  const entered = new Promise<void>((resolve) => { putEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releasePut = resolve; });
  const originalPut = hub.putSession.bind(hub);
  hub.putSession = async (...args: Parameters<typeof originalPut>) => {
    events.push("put:entered");
    putEntered();
    await blocked;
    const result = await originalPut(...args);
    events.push("put:settled");
    return result;
  };
  const originalGet = hub.getSession.bind(hub);
  let getCalls = 0;
  hub.getSession = async (id: string) => {
    getCalls++;
    events.push(`get:${getCalls}`);
    return originalGet(id);
  };

  const store = new ProfileStore(":memory:");
  const injected: string[] = [];
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[{"name":"auth_token","value":"OLD_TICK","domain":".x.com","path":"/"}],"origins":[]}',
    writeSession: async (_ws, bundle) => { injected.push(bundle); events.push(`inject:${injected.length}`); },
    heartbeatMs: 1_000,
    heartbeatDrainMs: 1_000,
    setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; },
    clearIntervalFn: () => {},
  });

  await coord.open("k1d0cd11");
  ticks[0]!();
  await entered; // old generation is already inside the non-cancellable hub write

  const reopening = coord.open("k1d0cd11");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getCalls).toBe(1); // reopen has not read a session after the blocked write
  expect(injected.length).toBe(1); // nor injected a bundle into the browser

  releasePut();
  expect((await reopening).ok).toBe(true);
  expect(getCalls).toBe(2);
  expect(events.indexOf("put:settled")).toBeLessThan(events.indexOf("get:2"));
  expect(events.indexOf("get:2")).toBeLessThan(events.indexOf("inject:2"));
  expect(injected[1]).toContain("OLD_TICK"); // committed before read, never after it
  store.close();
});

test("reopen becomes advisory when a fresh writer claim fails after heartbeat drain", async () => {
  const hub = fakeHub();
  const ticks: Array<() => void> = [];
  let putEntered!: () => void;
  let releasePut!: () => void;
  const entered = new Promise<void>((resolve) => { putEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releasePut = resolve; });
  const originalPut = hub.putSession.bind(hub);
  hub.putSession = async (...args: Parameters<typeof originalPut>) => {
    putEntered();
    await blocked;
    return originalPut(...args);
  };
  const originalClaim = hub.claim.bind(hub);
  let claimCalls = 0;
  hub.claim = async (id: string) => {
    claimCalls++;
    if (claimCalls === 2) throw new Error("claim offline");
    return originalClaim(id);
  };

  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop() { return false; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[{"name":"auth_token","value":"OLD_TICK","domain":".x.com","path":"/"}],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 1_000,
    heartbeatDrainMs: 1_000,
    retainedCleanupRetryMs: 1,
    retainedCleanupRenewMs: 1,
    setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; },
    clearIntervalFn: () => {},
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  ticks[0]!();
  await entered;

  const reopening = coord.open("k1d0cd11");
  await Promise.resolve();
  expect(claimCalls).toBe(1); // claim waits until the old session write has drained
  releasePut();

  const result = await reopening;
  expect(result.ok).toBe(true);
  expect(result.warning).toContain("session sync is disabled");
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  const renewsAfterOpen = hub.calls.filter((call) => call === "renew:k1d0cd11").length;
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hub.calls.filter((call) => call === "renew:k1d0cd11")).toHaveLength(renewsAfterOpen);
  store.close();
});

test("reopen fails closed on heartbeat-drain timeout and keeps the lock behind the unresolved write", async () => {
  const hub = fakeHub();
  const ticks: Array<() => void> = [];
  let putEntered!: () => void;
  const entered = new Promise<void>((resolve) => { putEntered = resolve; });
  hub.putSession = async () => {
    putEntered();
    await new Promise<void>(() => {}); // deliberately never settles
    return { version: 1, conflict: false };
  };
  let getCalls = 0;
  const originalGet = hub.getSession.bind(hub);
  hub.getSession = async (id: string) => { getCalls++; return originalGet(id); };
  let injections = 0;
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop() { return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => { injections++; },
    heartbeatMs: 1_000,
    heartbeatDrainMs: 5,
    setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; },
    clearIntervalFn: () => {},
  });

  await coord.open("k1d0cd11");
  ticks[0]!();
  await entered;
  const result = await coord.open("k1d0cd11");

  expect(result.ok).toBe(false);
  expect(result.error).toContain("did not drain");
  expect(getCalls).toBe(1);
  expect(injections).toBe(1);
  expect(hub.locks.get("k1d0cd11")).toBe("me"); // cleanup cannot release ahead of old put
  store.close();
});

test("RemoteCoordinator relays health snapshots through its existing hub client", async () => {
  let relayed: unknown;
  const hub = {
    ...fakeHub(),
    async publishAutomationHealthSnapshot(profiles: unknown) {
      relayed = profiles;
      return { profiles: 1, alive: 0, suspended: 1 };
    },
  };
  const h = harness(hub);
  expect(await h.coord.publishAutomationHealthSnapshot([
    { profileId: "k1d0cd11", suspended: true },
  ])).toEqual({ profiles: 1, alive: 0, suspended: 1 });
  expect(relayed).toEqual([{ profileId: "k1d0cd11", suspended: true }]);
});

test("listProfiles does not release my lock while open is still launching", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let startEntered!: () => void;
  let finishStart!: () => void;
  const entered = new Promise<void>((resolve) => { startEntered = resolve; });
  const finish = new Promise<void>((resolve) => { finishStart = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        startEntered();
        await finish;
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const opening = coord.open("k1d0cd11");
  await entered;
  expect(hub.locks.get("k1d0cd11")).toBe("me");

  const roster = await coord.listProfiles();
  expect(roster[0]!.lockedBy).toBe("me");
  expect(hub.locks.get("k1d0cd11")).toBe("me");

  finishStart();
  expect((await opening).ok).toBe(true);
  expect(hub.locks.get("k1d0cd11")).toBe("me");
});

test("close waits for an in-flight open() before touching the lock", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let startEntered!: () => void;
  let finishStart!: () => void;
  const entered = new Promise<void>((resolve) => { startEntered = resolve; });
  const finish = new Promise<void>((resolve) => { finishStart = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        startEntered();
        await finish;
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const opening = coord.open("k1d0cd11");
  await entered; // open() is mid-launch: lock claimed, launch row not recorded yet

  const closing = coord.close("k1d0cd11"); // races the in-flight open()
  finishStart(); // let open() finish
  await opening;
  await closing;

  // close() must wait for open() to settle before acting, so it sees the real
  // post-open state and cleanly closes it — not a stale "nothing running" snapshot
  // that would release the lock out from under the now-live browser.
  expect(hub.locks.has("k1d0cd11")).toBe(false); // released, not left dangling
  expect(store.getLaunch("k1d0cd11")).toBeNull(); // actually stopped
});

test("open waits for an in-flight close before claiming and launching the replacement", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let starts = 0;
  let stopEntered!: () => void;
  let finishStop!: () => void;
  const entered = new Promise<void>((resolve) => { stopEntered = resolve; });
  const blockedStop = new Promise<void>((resolve) => { finishStop = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        starts++;
        const info = { profileId: id, pid: starts, debugPort: 9000 + starts, ws: `ws://x/${starts}`, startedAt: starts };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) {
        stopEntered();
        await blockedStop;
        store.clearLaunch(id);
        return true;
      },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  const closing = coord.close("k1d0cd11");
  await entered;
  const reopening = coord.open("k1d0cd11");
  await Promise.resolve();
  expect(starts).toBe(1);

  finishStop();
  expect(await closing).toBe(true);
  expect((await reopening).ok).toBe(true);
  expect(starts).toBe(2);
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  expect(store.getLaunch("k1d0cd11")?.ws).toBe("ws://x/2");
  store.close();
});

test("heartbeatOnce keeps the browser and renews after a transient active probe miss", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.events.length = 0;
  h.hub.calls.length = 0;
  h.setActiveProbe(false);

  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");

  expect(h.events).not.toContain("stop");
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.calls).toContain("renew:k1d0cd11");
  expect(h.hub.calls.some((call) => call === "release:k1d0cd11")).toBe(false);
  h.store.close();
});

test("heartbeat stops renewing when a legacy launcher cannot reconcile a missed probe", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.events.length = 0;
  h.hub.calls.length = 0;
  h.setActiveProbe(false);
  (h.coord as any).d.launcher.reconcileOrphan = undefined;

  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");

  expect(h.events).not.toContain("stop");
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.calls).not.toContain("renew:k1d0cd11");
  expect(h.hub.calls).not.toContain("release:k1d0cd11");
  h.store.close();
});

test("heartbeatOnce frees the lock when the browser is gone (no renew)", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  const renewsBefore = h.hub.calls.filter((call) => call === "renew:k1d0cd11").length;
  h.setAlive(false); // browser crashed; manager still alive
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls.filter((call) => call === "renew:k1d0cd11").length).toBe(renewsBefore); // dead browser → no new renew
  expect(h.hub.locks.has("k1d0cd11")).toBe(false); // lock freed for others
  expect(h.store.getLaunch("k1d0cd11")).toBeNull(); // launch row cleared
});

test("heartbeat teardown remains visible as stopping until a deferred stop settles", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1 });
  let stopEntered!: () => void;
  const entered = new Promise<void>((resolve) => { stopEntered = resolve; });
  let finishStop!: () => void;
  const blockedStop = new Promise<void>((resolve) => { finishStop = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { return { ws: "ws", port: 1 }; },
      async stop(id: string) {
        stopEntered();
        await blockedStop;
        store.clearLaunch(id);
        return true;
      },
      async active() { return false; },
      async reconcileOrphan(id: string) { store.clearLaunch(id); return "dead" as const; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const heartbeat = coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  await entered;
  expect(coord.lifecycleState("k1d0cd11")).toBe("stopping");
  finishStop();
  await heartbeat;
  expect(coord.lifecycleState("k1d0cd11")).toBeNull();
  store.close();
});

test("createProfile delegates to the hub", async () => {
  const h = harness();
  const r = await h.coord.createProfile({ name: "x" });
  expect(r.id).toBe("new"); // routed to the central hub, not created locally
});

test("renameProfile delegates to the hub", async () => {
  const h = harness();
  await h.coord.renameProfile("k1d0cd11", "confirmed_username");
  expect(h.hub.calls).toContain("rename:k1d0cd11:confirmed_username");
  expect((await h.hub.getRoster())[0]!.name).toBe("confirmed_username");
});

test("reclaimSurvivors stops and releases a survivor when the hub advanced past its persisted base", async () => {
  const hub = fakeHub(); // owner "me"
  hub.getSession = async (id: string) => ({ profileId: id, bundle: '{"cookies":[{"name":"auth_token","value":"NEWER"}]}', version: 8, updatedAt: 0, updatedBy: "other-op" });
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 7 });
  let stopped = false;
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop(id: string) { stopped = true; store.clearLaunch(id); return true; }, async active() { return true; }, async navigate() {} },
    store, readSession: async () => '{"cookies":[{"name":"auth_token","value":"STALE","domain":".x.com","path":"/"}],"origins":[]}', writeSession: async () => {}, heartbeatMs: 0,
  });
  await coord.reclaimSurvivors();
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(stopped).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.calls).toContain("release:k1d0cd11");
  expect(hub.calls.some((c) => c.startsWith("putSession"))).toBe(false);
});

test("reclaimSurvivors stops an unstamped browser rejected by identity verification", async () => {
  const hub = fakeHub();
  let sessionReads = 0;
  hub.getSession = async () => { sessionReads++; return null; };
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x", startedAt: 1 });
  const logs: string[] = [];
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { throw new Error("survivor start compatibility path was used"); },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { throw new Error("raw active exposed an unstamped survivor"); },
      async navigate() {},
      async verifyRunningIdentity() {
        throw new Error("safe search setup was not attempted");
      },
    },
    store,
    readSession: async () => { throw new Error("must not read browser session"); },
    writeSession: async () => {},
    heartbeatMs: 0,
    log: (message) => logs.push(message),
  });

  await coord.reclaimSurvivors();

  expect(sessionReads).toBe(0);
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(logs.some((message) => message.includes("safe search setup was not attempted"))).toBe(true);
  store.close();
});

test("reclaimSurvivors does not infer staleness from updatedBy when the persisted base matches", async () => {
  const hub = fakeHub(); // owner "me"
  hub.getSession = async (id: string) => ({ profileId: id, bundle: '{"cookies":[{"name":"auth_token","value":"BASE"}]}', version: 7, updatedAt: 0, updatedBy: "other-op" });
  let pushedBase: number | undefined = -1;
  hub.putSession = async (_id: string, _bundle: string, base?: number) => { pushedBase = base; return { version: 8, conflict: false }; };
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 7 });
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop() { return true; }, async active() { return true; }, async navigate() {} },
    store, readSession: async () => '{"cookies":[{"name":"auth_token","value":"ROTATED","domain":".x.com","path":"/"}],"origins":[]}', writeSession: async () => {}, heartbeatMs: 0,
  });
  await coord.reclaimSurvivors();
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(pushedBase).toBe(7); // updatedBy is just the base author; matching version is safe to save from
});

test("reclaimSurvivors stops an old launch row with no base when the hub already has a session", async () => {
  const hub = fakeHub(); // owner "me"
  hub.getSession = async (id: string) => ({ profileId: id, bundle: "{}", version: 3, updatedAt: 0, updatedBy: "me" });
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1 });
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop(id: string) { store.clearLaunch(id); return true; }, async active() { return true; }, async navigate() {} },
    store, readSession: async () => '{"cookies":[],"origins":[]}', writeSession: async () => {}, heartbeatMs: 0,
  });
  await coord.reclaimSurvivors();
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.calls).toContain("release:k1d0cd11");
  expect(hub.calls.some((c) => c.startsWith("putSession"))).toBe(false);
});

test("reclaimSurvivors seeds the CAS base and DOES push when the reattached survivor's base matches the hub", async () => {
  const hub = fakeHub(); // owner "me"
  hub.getSession = async (id: string) => ({ profileId: id, bundle: "{}", version: 3, updatedAt: 0, updatedBy: "me" });
  let pushedBase: number | undefined = -1;
  hub.putSession = async (_id: string, _bundle: string, base?: number) => { pushedBase = base; return { version: (base ?? 0) + 1, conflict: false }; };
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 3 });
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop() { return true; }, async active() { return true; }, async navigate() {} },
    store, readSession: async () => '{"cookies":[],"origins":[]}', writeSession: async () => {}, heartbeatMs: 0,
  });
  await coord.reclaimSurvivors();
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(pushedBase).toBe(3); // seeded from the hub — CAS active (not undefined/last-writer-wins)
});

test("reclaimSurvivors arms heartbeat only after survivor session state is seeded", async () => {
  const hub = fakeHub(); // owner "me"
  let releaseGetSession!: () => void;
  let getSessionStarted!: () => void;
  const getSessionBlocked = new Promise<void>((resolve) => { releaseGetSession = resolve; });
  const getSessionEntered = new Promise<void>((resolve) => { getSessionStarted = resolve; });
  hub.getSession = async (id: string) => {
    getSessionStarted();
    await getSessionBlocked;
    return { profileId: id, bundle: "{}", version: 3, updatedAt: 0, updatedBy: "me" };
  };
  let pushedBase: unknown = "unset";
  hub.putSession = async (_id: string, _bundle: string, base?: number) => {
    pushedBase = base;
    return { version: 4, conflict: false };
  };
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 3 });
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop() { return true; }, async active() { return true; }, async navigate() {} },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 1,
    setIntervalFn: (fn) => {
      fn(); // fire immediately; if heartbeat was armed too early this would push before getSession returns
      return 1;
    },
    clearIntervalFn: () => {},
  });

  const reclaiming = coord.reclaimSurvivors();
  await getSessionEntered;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pushedBase).toBe("unset"); // no heartbeat push while getSession is still seeding state

  releaseGetSession();
  await reclaiming;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pushedBase).toBe(3);
});

test("reclaimSurvivors treats a hub version BELOW the persisted base (regression) as stale", async () => {
  const hub = fakeHub();
  hub.getSession = async (id: string) => ({ profileId: id, bundle: "{}", version: 5, updatedAt: 0, updatedBy: "me" });
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 7 });
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop(id: string) { store.clearLaunch(id); return true; }, async active() { return true; }, async navigate() {} },
    store, readSession: async () => '{"cookies":[{"name":"auth_token","value":"STALE","domain":".x.com","path":"/"}],"origins":[]}', writeSession: async () => {}, heartbeatMs: 0,
  });
  await coord.reclaimSurvivors();
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.calls).toContain("release:k1d0cd11");
  expect(hub.calls.some((c) => c.startsWith("putSession"))).toBe(false);
});

test("reclaimSurvivors blocks pushes when the hub session version read throws (transient hub error)", async () => {
  const hub = fakeHub();
  hub.getSession = async () => { throw new Error("ETIMEDOUT"); };
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 7 });
  const coord = new RemoteCoordinator({
    hub,
    launcher: { async start() { return { ws: "ws", port: 1 }; }, async stop() { return true; }, async active() { return true; }, async navigate() {} },
    store, readSession: async () => '{"cookies":[{"name":"auth_token","value":"STALE","domain":".x.com","path":"/"}],"origins":[]}', writeSession: async () => {}, heartbeatMs: 0,
  });
  await coord.reclaimSurvivors(); // couldn't read the version → base unknown → must not push
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hub.calls.some((c) => c.startsWith("putSession"))).toBe(false);
});

test("a stale survivor is stopped and released before explicit open restores the authoritative session", async () => {
  const hub = fakeHub();
  // Survivor opened at base v1; hub advanced to v2 while we were down.
  hub.sessions.set("k1d0cd11", '{"cookies":[{"name":"auth_token","value":"HUB2","domain":".x.com","path":"/"}]}');
  hub.versionOf.set("k1d0cd11", 2);
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1, sessionBaseVersion: 1 });

  const events: string[] = [];
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) { store.recordLaunch({ profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1, sessionBaseVersion: 2 }); return { ws: `ws://x/${id}`, port: 9000 }; },
      async stop(id: string) { events.push("stop"); store.clearLaunch(id); return true; }, async active() { return true; }, async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[{"name":"auth_token","value":"STALE1","domain":".x.com","path":"/"}],"origins":[]}',
    writeSession: async () => { events.push("writeSession"); },
    heartbeatMs: 0,
  });

  await coord.reclaimSurvivors();
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.calls).toContain("release:k1d0cd11");
  await coord.open("k1d0cd11");

  const stop = events.indexOf("stop");
  const write = events.indexOf("writeSession");
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(write).toBeGreaterThanOrEqual(0);
  expect(stop).toBeLessThan(write);
});

test("reclaimSurvivors keeps a verified browser advisory when the hub is unreachable", async () => {
  const hub = fakeHub();
  hub.claim = async () => { throw new Error("ECONNREFUSED"); };
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x", startedAt: 1 });
  let stopped = false;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { return { ws: "ws://x", port: 9000 }; },
      async stop(id: string) { stopped = true; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });
  await coord.reclaimSurvivors();
  expect(stopped).toBe(false);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  hub.calls.length = 0;
  await coord.heartbeatOnce("k1d0cd11", "ws://x");
  expect(hub.calls).toEqual([]);
});

test("heartbeatOnce downgrades to advisory when another worker owns the writer lease", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.hub.calls.length = 0;
  h.hub.locks.set("k1d0cd11", "ben");
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.calls).toEqual(["renew:k1d0cd11"]);

  h.hub.calls.length = 0;
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls).toEqual([]);
});

test("heartbeatOnce makes a missing writer lease advisory without reclaiming", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.hub.calls.length = 0;
  h.hub.locks.delete("k1d0cd11");

  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");

  expect(h.hub.locks.has("k1d0cd11")).toBe(false);
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(h.hub.calls).toEqual(["renew:k1d0cd11"]);
  h.hub.calls.length = 0;
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls).toEqual([]);
});

test("explicit reopen can claim a free writer lease after advisory downgrade", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.hub.locks.delete("k1d0cd11");
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.locks.has("k1d0cd11")).toBe(false);

  expect((await h.coord.open("k1d0cd11")).ok).toBe(true);
  expect(h.hub.locks.get("k1d0cd11")).toBe("me");
  h.hub.calls.length = 0;
  await h.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(h.hub.calls).toContain("putSession:k1d0cd11");
});

test("close after writer lease loss stops locally without reclaiming", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  h.hub.locks.delete("k1d0cd11");
  h.hub.calls.length = 0;

  expect(await h.coord.close("k1d0cd11")).toBe(true);

  expect(h.hub.calls).toEqual(["renew:k1d0cd11"]);
  expect(h.hub.locks.has("k1d0cd11")).toBe(false);
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
});

test("heartbeatOnce yields to a concurrent close that starts while renew is in flight", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });
  await coord.open("k1d0cd11");

  const originalRenew = hub.renew.bind(hub);
  let renewEntered!: () => void;
  let releaseRenew!: () => void;
  const entered = new Promise<void>((resolve) => { renewEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseRenew = resolve; });
  let blockFirst = true;
  hub.renew = async (id: string) => {
    if (blockFirst) {
      blockFirst = false;
      renewEntered();
      await blocked;
    }
    return originalRenew(id);
  };

  const heartbeat = coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  await entered;
  const closing = coord.close("k1d0cd11");
  releaseRenew();
  await Promise.all([heartbeat, closing]);
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
});

test("open downgrades to advisory on writer renew transport failure", async () => {
  const hub = fakeHub();
  hub.renew = async () => { throw new Error("hub sick"); };
  const logs: string[] = [];
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop() { return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    log: (m: string) => logs.push(m),
  });
  const opened = await coord.open("k1d0cd11");
  expect(opened.ok).toBe(true);
  expect(opened.warning).toContain("session sync is disabled");
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(logs.some((m) => m.includes("hub sick"))).toBe(true);
});

test("releaseAll cleanly closes each held profile (save + stop + release)", async () => {
  const h = harness();
  await h.coord.open("k1d0cd11");
  expect(await h.coord.releaseAll()).toBe(true);
  expect(h.hub.sessions.get("k1d0cd11")).toContain('"value":"rotated"'); // saved
  expect(h.store.getLaunch("k1d0cd11")).toBeNull(); // stopped, not left running
  expect(h.hub.locks.has("k1d0cd11")).toBe(false); // released
  expect((await h.coord.open("k1d0cd11")).error).toContain("shutting down");
});

test("releaseAll reports unconfirmed shutdown cleanup", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string) {
        const launch = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1 };
        store.recordLaunch(launch);
        return { ws: launch.ws, port: launch.debugPort };
      },
      async stop() { return false; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  await expect(coord.releaseAll()).rejects.toThrow("shutdown");
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hub.locks.get("k1d0cd11")).toBe("me");
  store.close();
});

test("reclaimSurvivors restores a free writer and keeps a taken profile advisory", async () => {
  // Survivor that's still free on the hub → reclaim + keep running.
  const hubA = fakeHub();
  const hA = harness(hubA);
  hA.store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1 });
  await hA.coord.reclaimSurvivors();
  expect(hubA.locks.get("k1d0cd11")).toBe("me"); // reclaimed
  expect(hA.store.getLaunch("k1d0cd11")).not.toBeNull(); // still running

  // Survivor with another writer during the dark window → verify and retain locally as advisory.
  const hubB = fakeHub();
  hubB._hold("k1d0cd11", "ben");
  const hB = harness(hubB);
  hB.store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x/k1d0cd11", startedAt: 1 });
  await hB.coord.reclaimSurvivors();
  expect(hB.store.getLaunch("k1d0cd11")).not.toBeNull();
  expect(hubB.locks.get("k1d0cd11")).toBe("ben");
  hubB.calls.length = 0;
  await hB.coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(hubB.calls).toEqual([]);
});

test("getProfiles fetches every selected id from the hub, in order (bounded fan-out)", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`); // > one batch, to exercise the loop
  const seen: string[] = [];
  const hub = fakeHub();
  const base = parseExport(SAMPLE).profiles[0]!;
  hub.getProfile = async (id: string) => { seen.push(id); return { ...base, id }; };
  const h = harness(hub);

  const profiles = await h.coord.getProfiles(ids);

  expect(profiles.map((p) => p.id)).toEqual(ids); // order preserved across batches
  expect([...seen].sort()).toEqual([...ids].sort()); // every id fetched exactly once
});

test("getProfiles overlays the hub's roamed session cookies for the .txt export", async () => {
  const hub = fakeHub(); // the roster profile carries the stale import cookie "orig"
  // The account has since roamed; the hub session holds the current login.
  hub.sessions.set("k1d0cd11", JSON.stringify({ cookies: [{ name: "auth_token", value: "roamed", domain: ".x.com", path: "/" }] }));
  const h = harness(hub);

  const [withCookies] = await h.coord.getProfiles(["k1d0cd11"], true);
  expect(withCookies!.cookies.map((c) => c.value)).toEqual(["roamed"]); // hub session, not the import cookie

  // CSV path (withCookies=false) omits cookies entirely, so it must not pay for a
  // session fetch — the profile's import cookies pass through untouched.
  const [csv] = await h.coord.getProfiles(["k1d0cd11"], false);
  expect(csv!.cookies.map((c) => c.value)).toEqual(["orig"]);
});

test("concurrent opens coalesce within one lifecycle generation", async () => {
  let finishRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { finishRestore = resolve; });
  const h = harness(fakeHub(), undefined, async (_ws, bundle) => {
    h.injected.push(bundle);
    await restoreGate;
  });

  const first = h.coord.open("k1d0cd11");
  const second = h.coord.open("k1d0cd11");
  for (let i = 0; i < 20 && h.launched.length === 0; i++) await Bun.sleep(0);
  finishRestore();
  const [a, b] = await Promise.all([first, second]);

  expect(a).toEqual(b);
  expect(h.launched).toEqual(["k1d0cd11"]);
  expect(h.injected).toHaveLength(1);
  expect(h.hub.calls.filter((call) => call === "claim:k1d0cd11")).toHaveLength(1);
  h.store.close();
});

test("remote launch lineage remains provisional until restore and ownership checks finish", async () => {
  let restoreStarted!: () => void;
  let finishRestore!: () => void;
  const started = new Promise<void>((resolve) => { restoreStarted = resolve; });
  const finish = new Promise<void>((resolve) => { finishRestore = resolve; });
  const h = harness(fakeHub(), undefined, async () => {
    restoreStarted();
    await finish;
  });

  const opening = h.coord.open("k1d0cd11");
  await started;
  expect(h.store.getLaunch("k1d0cd11")!.sessionBaseVersion).toBe(-1);
  finishRestore();
  expect((await opening).ok).toBe(true);
  expect(h.store.getLaunch("k1d0cd11")!.sessionBaseVersion).toBe(0);
  h.store.close();
});

test("open downgrades to advisory when writer ownership is lost during restore", async () => {
  const beforeHub = fakeHub();
  beforeHub.renew = async (id: string) => {
    beforeHub._hold(id, "ben");
    return false;
  };
  const before = harness(beforeHub);
  const lostBefore = await before.coord.open("k1d0cd11");
  expect(lostBefore.ok).toBe(true);
  expect(lostBefore.warning).toContain("session sync is disabled");
  expect(before.injected).toHaveLength(1);
  expect(before.events).not.toContain("stop");

  const afterHub = fakeHub();
  let renews = 0;
  afterHub.renew = async (id: string) => {
    renews++;
    if (renews === 1) return true;
    afterHub._hold(id, "ben");
    return false;
  };
  const after = harness(afterHub);
  const lostAfter = await after.coord.open("k1d0cd11", ["https://x.com/home"]);
  expect(lostAfter.ok).toBe(true);
  expect(lostAfter.warning).toContain("session sync is disabled");
  expect(after.injected).toHaveLength(1);
  expect(after.navigated).toEqual([["https://x.com/home"]]);
  expect(after.events).not.toContain("stop");
  before.store.close();
  after.store.close();
});

test("close never checkpoints or releases after another operator owns the lock", async () => {
  const h = harness();
  expect((await h.coord.open("k1d0cd11")).ok).toBe(true);
  h.hub.calls.length = 0;
  h.hub.locks.set("k1d0cd11", "ben");

  expect(await h.coord.close("k1d0cd11")).toBe(true);
  expect(h.hub.calls).not.toContain("putSession:k1d0cd11");
  expect(h.hub.calls).not.toContain("release:k1d0cd11");
  expect(h.hub.locks.get("k1d0cd11")).toBe("ben");
  h.store.close();
});

test("repeated renew transport errors downgrade after the last confirmed writer lease expires", async () => {
  let clock = 10_000;
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let stops = 0;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string, _args: string[], opts: { sessionBaseVersion?: number }) {
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1, sessionBaseVersion: opts.sessionBaseVersion };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { stops++; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    leaseMs: 1_000,
    nowMs: () => clock,
  });
  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  hub.renew = async () => { throw new Error("hub offline"); };

  clock += 600;
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(stops).toBe(0);
  clock += 500;
  await coord.heartbeatOnce("k1d0cd11", "ws://x/k1d0cd11");
  expect(stops).toBe(0);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();
  store.close();
});

test("open behind close creates a new generation and concurrent closes coalesce", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let firstStartEntered!: () => void;
  let finishFirstStart!: () => void;
  let secondStartEntered!: () => void;
  let finishSecondStart!: () => void;
  const starting = new Promise<void>((resolve) => { firstStartEntered = resolve; });
  const startGate = new Promise<void>((resolve) => { finishFirstStart = resolve; });
  const secondStarting = new Promise<void>((resolve) => { secondStartEntered = resolve; });
  const secondStartGate = new Promise<void>((resolve) => { finishSecondStart = resolve; });
  let starts = 0;
  let stops = 0;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string, _args: string[], opts: { sessionBaseVersion?: number }) {
        starts++;
        if (starts === 1) { firstStartEntered(); await startGate; }
        if (starts === 2) { secondStartEntered(); await secondStartGate; }
        const info = { profileId: id, pid: starts, debugPort: 9000, ws: `ws://x/${id}/${starts}`, startedAt: starts, sessionBaseVersion: opts.sessionBaseVersion };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { stops++; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const open1 = coord.open("k1d0cd11");
  await starting;
  const close1 = coord.close("k1d0cd11");
  const close2 = coord.close("k1d0cd11");
  const open2 = coord.open("k1d0cd11");
  finishFirstStart();
  expect((await open1).ok).toBe(true);
  await Promise.all([close1, close2]);
  await secondStarting;
  const open3 = coord.open("k1d0cd11"); // close has settled, but this is still the same reopen generation
  finishSecondStart();
  const [second, third] = await Promise.all([open2, open3]);
  expect(second).toEqual(third);
  expect(second.ok).toBe(true);
  expect(starts).toBe(2);
  expect(stops).toBe(1);
  expect(store.getLaunch("k1d0cd11")?.ws).toBe("ws://x/k1d0cd11/2");
  store.close();
});

test("a close admitted after a queued reopen tears down that reopened generation", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let firstStartEntered!: () => void;
  let finishFirstStart!: () => void;
  let secondStartEntered!: () => void;
  let finishSecondStart!: () => void;
  const firstStarting = new Promise<void>((resolve) => { firstStartEntered = resolve; });
  const firstStartGate = new Promise<void>((resolve) => { finishFirstStart = resolve; });
  const secondStarting = new Promise<void>((resolve) => { secondStartEntered = resolve; });
  const secondStartGate = new Promise<void>((resolve) => { finishSecondStart = resolve; });
  let starts = 0;
  let stops = 0;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string, _args: string[], opts: { sessionBaseVersion?: number }) {
        starts++;
        if (starts === 1) { firstStartEntered(); await firstStartGate; }
        if (starts === 2) { secondStartEntered(); await secondStartGate; }
        const info = {
          profileId: id,
          pid: starts,
          debugPort: 9000 + starts,
          ws: `ws://x/${id}/${starts}`,
          startedAt: starts,
          sessionBaseVersion: opts.sessionBaseVersion,
        };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { stops++; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const open1 = coord.open("k1d0cd11");
  await firstStarting;
  const close1 = coord.close("k1d0cd11");
  const open2 = coord.open("k1d0cd11");
  let close2Settled = false;
  const close2 = coord.close("k1d0cd11").finally(() => { close2Settled = true; });

  finishFirstStart();
  expect((await open1).ok).toBe(true);
  expect(await close1).toBe(true);
  await secondStarting;
  expect(close2Settled).toBe(false);

  finishSecondStart();
  expect((await open2).ok).toBe(true);
  expect(await close2).toBe(true);
  expect(starts).toBe(2);
  expect(stops).toBe(2);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  store.close();
});

test("cleared heartbeat callback cannot run under the reopened generation", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  const callbacks: Array<() => void> = [];
  const launcher = {
    async start(id: string, _args: string[], opts: { sessionBaseVersion?: number }) {
      const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1, sessionBaseVersion: opts.sessionBaseVersion };
      store.recordLaunch(info);
      return { ws: info.ws, port: info.debugPort };
    },
    async stop(id: string) { store.clearLaunch(id); return true; },
    async active() { return true; },
    async navigate() {},
  };
  const coord = new RemoteCoordinator({
    hub,
    launcher,
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 1_000,
    setIntervalFn: (fn) => { callbacks.push(fn); return callbacks.length; },
    clearIntervalFn: () => {},
  });
  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  const oldTick = callbacks[0]!;
  expect((await coord.open("k1d0cd11")).ok).toBe(true);
  hub.calls.length = 0;
  oldTick();
  await Promise.resolve();
  expect(hub.calls).toEqual([]);
  store.close();
});

test("provisional survivor is stopped before claim and certified survivor uses refreshed websocket", async () => {
  const pendingHub = fakeHub();
  const pendingStore = new ProfileStore(":memory:");
  pendingStore.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://pending", startedAt: 1, sessionBaseVersion: -1 });
  const pending = new RemoteCoordinator({
    hub: pendingHub,
    launcher: {
      async start() { return { ws: "ws://pending", port: 9000 }; },
      async stop(id: string) { pendingStore.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store: pendingStore,
    readSession: async () => { throw new Error("provisional survivor must never be read"); },
    writeSession: async () => {},
    heartbeatMs: 0,
  });
  await pending.reclaimSurvivors();
  expect(pendingHub.calls).not.toContain("claim:k1d0cd11");
  expect(pendingStore.getLaunch("k1d0cd11")).toBeNull();

  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://stale", startedAt: 1, sessionBaseVersion: 0 });
  const readFrom: string[] = [];
  const events: string[] = [];
  const originalClaim = hub.claim.bind(hub);
  hub.claim = async (id: string) => { events.push("claim"); return originalClaim(id); };
  const certified = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { throw new Error("explicit survivor verification should be used"); },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { throw new Error("raw active must not expose a survivor"); },
      async navigate() {},
      async verifyRunningIdentity(id: string) {
        events.push("verify");
        store.recordLaunch({ ...store.getLaunch(id)!, ws: "ws://refreshed" });
      },
    },
    store,
    readSession: async (ws) => { readFrom.push(ws); return '{"cookies":[],"origins":[]}'; },
    writeSession: async () => {},
    heartbeatMs: 0,
  });
  await certified.reclaimSurvivors();
  await certified.heartbeatOnce("k1d0cd11", "ws://stale");
  expect(events.slice(0, 2)).toEqual(["claim", "verify"]);
  expect(readFrom).toContain("ws://refreshed");
  pendingStore.close();
  store.close();
});

test("denied survivor stays advisory and closes without touching another writer's lease", async () => {
  const hub = fakeHub();
  hub._hold("k1d0cd11", "ben");
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x", startedAt: 1, sessionBaseVersion: 0 });
  let verified = 0;
  let stopped = 0;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { throw new Error("survivor should be verified, not relaunched"); },
      async stop(id: string) { stopped++; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
      async verifyRunningIdentity() { verified++; },
    },
    store,
    readSession: async () => { throw new Error("advisory survivor must never be captured"); },
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  await coord.reclaimSurvivors();
  expect(verified).toBe(1);
  expect(stopped).toBe(0);
  expect(store.getLaunch("k1d0cd11")).not.toBeNull();

  hub.calls.length = 0;
  expect(await coord.close("k1d0cd11")).toBe(true);
  expect(hub.calls).toEqual([]);
  expect(hub.locks.get("k1d0cd11")).toBe("ben");
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("releaseAll waits for an admitted open and closes its late launch", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let startEntered!: () => void;
  let finishStart!: () => void;
  const starting = new Promise<void>((resolve) => { startEntered = resolve; });
  const startGate = new Promise<void>((resolve) => { finishStart = resolve; });
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string, _args: string[], opts: { sessionBaseVersion?: number }) {
        startEntered();
        await startGate;
        const info = { profileId: id, pid: 1, debugPort: 9000, ws: `ws://x/${id}`, startedAt: 1, sessionBaseVersion: opts.sessionBaseVersion };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const opening = coord.open("k1d0cd11");
  await starting;
  const shutdown = coord.releaseAll();
  finishStart();
  expect((await opening).ok).toBe(true);
  expect(await shutdown).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  store.close();
});

test("releaseAll queues a final close behind an admitted reopen", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  let firstStartEntered!: () => void;
  let finishFirstStart!: () => void;
  let secondStartEntered!: () => void;
  let finishSecondStart!: () => void;
  const firstStarting = new Promise<void>((resolve) => { firstStartEntered = resolve; });
  const firstStartGate = new Promise<void>((resolve) => { finishFirstStart = resolve; });
  const secondStarting = new Promise<void>((resolve) => { secondStartEntered = resolve; });
  const secondStartGate = new Promise<void>((resolve) => { finishSecondStart = resolve; });
  let starts = 0;
  let stops = 0;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start(id: string, _args: string[], opts: { sessionBaseVersion?: number }) {
        starts++;
        if (starts === 1) { firstStartEntered(); await firstStartGate; }
        if (starts === 2) { secondStartEntered(); await secondStartGate; }
        const info = {
          profileId: id,
          pid: starts,
          debugPort: 9000 + starts,
          ws: `ws://x/${id}/${starts}`,
          startedAt: starts,
          sessionBaseVersion: opts.sessionBaseVersion,
        };
        store.recordLaunch(info);
        return { ws: info.ws, port: info.debugPort };
      },
      async stop(id: string) { stops++; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
  });

  const open1 = coord.open("k1d0cd11");
  await firstStarting;
  const close1 = coord.close("k1d0cd11");
  const open2 = coord.open("k1d0cd11");
  let shutdownSettled = false;
  const shutdown = coord.releaseAll().finally(() => { shutdownSettled = true; });

  finishFirstStart();
  expect((await open1).ok).toBe(true);
  expect(await close1).toBe(true);
  await secondStarting;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(shutdownSettled).toBe(false);

  finishSecondStart();
  expect((await open2).ok).toBe(true);
  expect(await shutdown).toBe(true);
  expect(starts).toBe(2);
  expect(stops).toBe(2);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  expect(hub.locks.has("k1d0cd11")).toBe(false);
  store.close();
});

test("releaseAll failure propagates and a later cleanup pass is retryable", async () => {
  const hub = fakeHub();
  const store = new ProfileStore(":memory:");
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9000, ws: "ws://x", startedAt: 1 });
  let failStop = true;
  let retryTick: (() => void) | undefined;
  const coord = new RemoteCoordinator({
    hub,
    launcher: {
      async start() { return { ws: "ws://x", port: 9000 }; },
      async stop(id: string) { if (failStop) return false; store.clearLaunch(id); return true; },
      async active() { return true; },
      async navigate() {},
    },
    store,
    readSession: async () => '{"cookies":[],"origins":[]}',
    writeSession: async () => {},
    heartbeatMs: 0,
    retainedCleanupRetryMs: 1,
    setIntervalFn: (fn) => { retryTick = fn; return 1; },
    clearIntervalFn: () => {},
  });

  await expect(coord.releaseAll()).rejects.toThrow("failed to close remote profiles during shutdown");
  failStop = false;
  await Bun.sleep(2);
  retryTick!();
  await Bun.sleep(5);
  expect(await coord.releaseAll()).toBe(true);
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

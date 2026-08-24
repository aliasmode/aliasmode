import { expect, test } from "bun:test";
import {
  cloudRuntimeConfiguration,
  createCloudCrossDeviceFixtureHandler,
  createCloudRestoreFixtureHandler,
  dispatchReadSessionWorker,
  drainRemoteShutdown,
  exerciseCloudLauncherSmoke,
  exerciseWindowsWindowAcceptance,
  lifecycleAdmissionOptionsFromEnv,
  mapWindowsNativeWindowCandidates,
  OFFICIAL_CLOUD_ANON_KEY,
  OFFICIAL_CLOUD_URL,
  parseCloudRestoreFixtureOptions,
  RemoteShutdownTimeoutError,
  runCloudCrossDeviceAcceptance,
  runCompiledSidecarSmoke,
  runCloakpitImportCommand,
  selectedCloudUrl,
} from "./cli.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { statePaths } from "./paths.ts";

const cloudMode = {
  version: 1 as const,
  mode: "cloud" as const,
  localAnalytics: false,
};

const localMode = {
  version: 1 as const,
  mode: "local" as const,
  localAnalytics: false,
};

async function removeTemporaryRoot(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EBUSY" || attempt === 10) throw error;
      Bun.gc(true);
      await Bun.sleep(100);
    }
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("test loopback port is unavailable");
  return address.port;
}

test("migration-only command dispatches directly and reports required restrictions", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cli-import-"));
  const calls: unknown[][] = [];
  const result = await runCloakpitImportCommand([
    "--source", "C:\\Cloakpit",
    "--state-root", root,
    "--cloakpit-profile-root", "D:\\LegacyProfiles",
  ], async (...args) => {
    calls.push(args);
    return { status: "migrated", profileCount: 2 };
  });
  expect(calls).toEqual([["C:\\Cloakpit", statePaths(root), { profileRoot: "D:\\LegacyProfiles" }]]);
  expect(result.ok).toBe(true);
  expect(result.message).toContain("DPAPI");
  expect(result.message).toContain("persona fields are preserved");
  expect(result.message).toContain("runtime or browser differences");
});

test("internal migration command exits before normal startup creates state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-cli-import-main-"));
  const destination = join(parent, "destination");
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "cli.ts"),
    "__import-cloakpit",
    "--source", join(parent, "missing"),
    "--state-root", destination,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  expect(existsSync(destination)).toBe(false);
});

test("compiled sidecar smoke restores before navigation and capture", async () => {
  const events: string[] = [];
  await runCompiledSidecarSmoke("http://127.0.0.1:9222", {
    async writeSession(endpoint, bundle) {
      events.push(`write:${endpoint}`);
      expect(JSON.parse(bundle)).toEqual({
        cookies: [{
          name: "aliasmode_smoke",
          value: "live",
          domain: ".x.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        }],
        origins: [{
          origin: "https://web.telegram.org",
          localStorage: [{ name: "aliasmode_smoke", value: "live" }],
        }],
      });
    },
    async assertAlive(endpoint) {
      events.push(`alive:${endpoint}`);
    },
    async webSocketEndpoint(endpoint) {
      events.push(`resolve:${endpoint}`);
      return "ws://127.0.0.1:9222/devtools/browser/current";
    },
    async navigate(endpoint) {
      events.push(`navigate:${endpoint}`);
    },
    async readSession(endpoint) {
      events.push(`read:${endpoint}`);
      return JSON.stringify({ cookies: [{ name: "aliasmode_smoke", value: "live" }] });
    },
  });
  expect(events).toEqual([
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "resolve:http://127.0.0.1:9222",
    "write:ws://127.0.0.1:9222/devtools/browser/current",
    "alive:http://127.0.0.1:9222",
    "navigate:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "read:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
  ]);
});

test("Cloud launcher smoke requires fresh and repeated cached opens to stay alive and close cleanly", async () => {
  const events: string[] = [];
  let running = false;
  let launch: object | null = null;
  let opens = 0;
  const coordinator = {
    async open(profileId: string, launchArgs: string[]) {
      opens++;
      events.push(`open:${opens}:${profileId}:${launchArgs.join(",")}`);
      running = true;
      launch = { profileId };
      return { ok: true, ws: `ws://smoke/${opens}`, port: 9200 + opens };
    },
    async close(profileId: string) {
      events.push(`close:${opens}:${profileId}`);
      running = false;
      launch = null;
      return true;
    },
    async releaseAll() { return true; },
  };
  const launcher = {
    async active(profileId: string) {
      events.push(`active:${opens}:${profileId}:${running}`);
      return running;
    },
    async stop() { return true; },
  };
  const store = { getLaunch: () => launch };

  await exerciseCloudLauncherSmoke(
    { coordinator, launcher, store } as any,
    "profile-smoke",
    ["http://cloud-open.invalid/ok"],
  );

  expect(events).toEqual([
    "open:1:profile-smoke:http://cloud-open.invalid/ok",
    "active:1:profile-smoke:true",
    "close:1:profile-smoke",
    "active:1:profile-smoke:false",
    "open:2:profile-smoke:http://cloud-open.invalid/ok",
    "active:2:profile-smoke:true",
    "close:2:profile-smoke",
    "active:2:profile-smoke:false",
    "open:3:profile-smoke:http://cloud-open.invalid/ok",
    "active:3:profile-smoke:true",
    "close:3:profile-smoke",
    "active:3:profile-smoke:false",
  ]);
});

test("Windows native window candidates map only one distinct HWND per profile", () => {
  expect(mapWindowsNativeWindowCandidates(["first", "second"], [
    { profileId: "unrelated", hwnd: 99, minimized: false, visible: true },
    { profileId: "first", hwnd: 101, minimized: true, visible: true },
    { profileId: "second", hwnd: 202, minimized: false, visible: true },
  ])).toEqual({
    first: { hwnd: 101, minimized: true, visible: true },
    second: { hwnd: 202, minimized: false, visible: true },
  });

  for (const candidates of [
    [{ profileId: "first", hwnd: 101, minimized: false, visible: true }],
    [
      { profileId: "first", hwnd: 101, minimized: false, visible: true },
      { profileId: "first", hwnd: 102, minimized: false, visible: true },
      { profileId: "second", hwnd: 202, minimized: false, visible: true },
    ],
    [
      { profileId: "first", hwnd: 101, minimized: false, visible: true },
      { profileId: "second", hwnd: 101, minimized: false, visible: true },
    ],
  ]) {
    expect(mapWindowsNativeWindowCandidates(["first", "second"], candidates)).toEqual({});
  }
});

test("Windows window acceptance preserves native minimize state and selects only one distinct HWND", async () => {
  const events: string[] = [];
  const windows = {
    first: { hwnd: 101, minimized: false, visible: true },
    second: { hwnd: 202, minimized: false, visible: true },
  };
  let foregroundHwnd = windows.second.hwnd;
  let pageTargets = ["page-1"];

  await exerciseWindowsWindowAcceptance({
    profileIds: ["first", "second"],
    async open(profileId) { events.push(`open:${profileId}`); },
    async close(profileId) { events.push(`close:${profileId}`); },
    async nativeWindows() {
      return {
        foregroundHwnd,
        windows: {
          first: { ...windows.first },
          second: { ...windows.second },
        },
      };
    },
    async minimize(profileId) {
      events.push(`minimize:${profileId}`);
      windows[profileId as keyof typeof windows].minimized = true;
    },
    async pageTargetIds(profileId) {
      events.push(`targets:${profileId}:${pageTargets.join(",")}`);
      return [...pageTargets];
    },
    async runProfileCardObserved(profileId) {
      events.push(`profile-card:${profileId}`);
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async runBackgroundPageObserved(profileId) {
      events.push(`background-page:${profileId}`);
      return {
        createdPageTargetIds: ["temporary-page"],
        destroyedPageTargetIds: ["temporary-page"],
        nativeWindowStayedMinimized: true,
      };
    },
    async runSessionCaptureObserved(profileId) {
      events.push(`session-capture:${profileId}`);
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async bringToFront(profileId) {
      events.push(`raise:${profileId}`);
      windows[profileId as keyof typeof windows].minimized = false;
      foregroundHwnd = windows[profileId as keyof typeof windows].hwnd;
    },
  });

  expect(events).toEqual([
    "open:first",
    "open:second",
    "targets:first:page-1",
    "targets:second:page-1",
    "minimize:first",
    "targets:first:page-1",
    "profile-card:first",
    "targets:first:page-1",
    "background-page:first",
    "targets:first:page-1",
    "session-capture:first",
    "targets:first:page-1",
    "raise:first",
    "raise:second",
    "close:second",
    "close:first",
  ]);
  expect(pageTargets).toEqual(["page-1"]);
});

test("Windows window acceptance rejects a missing initial page before native polling", async () => {
  const events: string[] = [];
  await expect(exerciseWindowsWindowAcceptance({
    profileIds: ["first", "second"],
    async open(profileId) { events.push(`open:${profileId}`); },
    async close(profileId) { events.push(`close:${profileId}`); },
    async nativeWindows() {
      events.push("native-windows");
      return { foregroundHwnd: 0, windows: {} };
    },
    async minimize() {},
    async pageTargetIds(profileId) {
      events.push(`targets:${profileId}`);
      return profileId === "first" ? ["page-1"] : [];
    },
    async runProfileCardObserved() {
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async runBackgroundPageObserved() {
      return {
        createdPageTargetIds: ["temporary-page"],
        destroyedPageTargetIds: ["temporary-page"],
        nativeWindowStayedMinimized: true,
      };
    },
    async runSessionCaptureObserved() {
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async bringToFront() {},
  })).rejects.toThrow("managed CloakBrowser did not expose initial page targets");
  expect(events).toEqual([
    "open:first",
    "open:second",
    "targets:first",
    "targets:second",
    "close:second",
    "close:first",
  ]);
});

test("Windows window acceptance rejects a profile-card page target and still closes both browsers", async () => {
  const closed: string[] = [];
  let pageTargets = ["page-1"];
  await expect(exerciseWindowsWindowAcceptance({
    profileIds: ["first", "second"],
    async open() {},
    async close(profileId) { closed.push(profileId); },
    async nativeWindows() {
      return {
        foregroundHwnd: 202,
        windows: {
          first: { hwnd: 101, minimized: true, visible: true },
          second: { hwnd: 202, minimized: false, visible: true },
        },
      };
    },
    async minimize() {},
    async pageTargetIds() { return [...pageTargets]; },
    async runProfileCardObserved() {
      pageTargets = ["page-2"];
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async runBackgroundPageObserved() {
      return {
        createdPageTargetIds: ["temporary-page"],
        destroyedPageTargetIds: ["temporary-page"],
        nativeWindowStayedMinimized: true,
      };
    },
    async runSessionCaptureObserved() {
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async bringToFront() {},
  })).rejects.toThrow("profile-card operation changed the page targets");
  expect(closed).toEqual(["second", "first"]);
});

for (const scenario of [
  {
    name: "transient page target",
    observation: { createdPageTargetIds: ["transient-page"], nativeWindowStayedMinimized: true },
    failure: "profile-card operation created a page target",
  },
  {
    name: "transient native restore",
    observation: { createdPageTargetIds: [], nativeWindowStayedMinimized: false },
    failure: "profile-card operation transiently restored the minimized native window",
  },
]) {
  test(`Windows window acceptance rejects a ${scenario.name} and still closes both browsers`, async () => {
    const closed: string[] = [];
    await expect(exerciseWindowsWindowAcceptance({
      profileIds: ["first", "second"],
      async open() {},
      async close(profileId) { closed.push(profileId); },
      async nativeWindows() {
        return {
          foregroundHwnd: 202,
          windows: {
            first: { hwnd: 101, minimized: true, visible: true },
            second: { hwnd: 202, minimized: false, visible: true },
          },
        };
      },
      async minimize() {},
      async pageTargetIds() { return ["page-1"]; },
      async runProfileCardObserved() { return scenario.observation; },
      async runBackgroundPageObserved() {
        return {
          createdPageTargetIds: ["temporary-page"],
          destroyedPageTargetIds: ["temporary-page"],
          nativeWindowStayedMinimized: true,
        };
      },
      async runSessionCaptureObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async bringToFront() {},
    })).rejects.toThrow(scenario.failure);
    expect(closed).toEqual(["second", "first"]);
  });
}

for (const scenario of [
  {
    name: "missing created background page target",
    observation: {
      createdPageTargetIds: [],
      destroyedPageTargetIds: [],
      nativeWindowStayedMinimized: true,
    },
    failure: "background page operation did not observe exactly one created page target",
  },
  {
    name: "missing destroyed background page target",
    observation: {
      createdPageTargetIds: ["temporary-page"],
      destroyedPageTargetIds: [],
      nativeWindowStayedMinimized: true,
    },
    failure: "background page operation did not observe its page target being destroyed",
  },
  {
    name: "background page native restore",
    observation: {
      createdPageTargetIds: ["temporary-page"],
      destroyedPageTargetIds: ["temporary-page"],
      nativeWindowStayedMinimized: false,
    },
    failure: "background page operation transiently restored the minimized native window",
  },
]) {
  test(`Windows window acceptance rejects a ${scenario.name} and still closes both browsers`, async () => {
    const closed: string[] = [];
    await expect(exerciseWindowsWindowAcceptance({
      profileIds: ["first", "second"],
      async open() {},
      async close(profileId) { closed.push(profileId); },
      async nativeWindows() {
        return {
          foregroundHwnd: 202,
          windows: {
            first: { hwnd: 101, minimized: true, visible: true },
            second: { hwnd: 202, minimized: false, visible: true },
          },
        };
      },
      async minimize() {},
      async pageTargetIds() { return ["page-1"]; },
      async runProfileCardObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async runBackgroundPageObserved() { return scenario.observation; },
      async runSessionCaptureObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async bringToFront() {},
    })).rejects.toThrow(scenario.failure);
    expect(closed).toEqual(["second", "first"]);
  });
}

for (const scenario of [
  {
    name: "session-capture page target",
    observation: { createdPageTargetIds: ["transient-page"], nativeWindowStayedMinimized: true },
    failure: "session capture created a page target",
  },
  {
    name: "session-capture native restore",
    observation: { createdPageTargetIds: [], nativeWindowStayedMinimized: false },
    failure: "session capture transiently restored the minimized native window",
  },
]) {
  test(`Windows window acceptance rejects a ${scenario.name} and still closes both browsers`, async () => {
    const closed: string[] = [];
    await expect(exerciseWindowsWindowAcceptance({
      profileIds: ["first", "second"],
      async open() {},
      async close(profileId) { closed.push(profileId); },
      async nativeWindows() {
        return {
          foregroundHwnd: 202,
          windows: {
            first: { hwnd: 101, minimized: true, visible: true },
            second: { hwnd: 202, minimized: false, visible: true },
          },
        };
      },
      async minimize() {},
      async pageTargetIds() { return ["page-1"]; },
      async runProfileCardObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async runBackgroundPageObserved() {
        return {
          createdPageTargetIds: ["temporary-page"],
          destroyedPageTargetIds: ["temporary-page"],
          nativeWindowStayedMinimized: true,
        };
      },
      async runSessionCaptureObserved() { return scenario.observation; },
      async bringToFront() {},
    })).rejects.toThrow(scenario.failure);
    expect(closed).toEqual(["second", "first"]);
  });
}

test("Cloud restore fixture parses only a loopback port and deterministic mode", () => {
  expect(parseCloudRestoreFixtureOptions(["--port", "49152", "--mode", "healthy"]))
    .toEqual({ port: 49152, mode: "healthy", initialRefresh: "seeded" });
  expect(parseCloudRestoreFixtureOptions(["--port", "49154", "--mode", "offline"]))
    .toEqual({ port: 49154, mode: "offline", initialRefresh: "seeded" });
  expect(parseCloudRestoreFixtureOptions(["--port", "49155", "--mode", "cross-device"]))
    .toEqual({ port: 49155, mode: "cross-device", initialRefresh: "seeded" });
  expect(parseCloudRestoreFixtureOptions([
    "--port", "49153", "--mode", "membership-revoked", "--initial-refresh", "rotated",
  ])).toEqual({ port: 49153, mode: "membership-revoked", initialRefresh: "rotated" });
  expect(() => parseCloudRestoreFixtureOptions(["--port", "0", "--mode", "healthy"])).toThrow("loopback port");
  expect(() => parseCloudRestoreFixtureOptions(["--port", "49152", "--mode", "production"])).toThrow("fixture mode");
  expect(() => parseCloudRestoreFixtureOptions([
    "--port", "49152", "--mode", "healthy", "--initial-refresh", "stale",
  ])).toThrow("initial refresh");
});

test("Cloud cross-device fixture requires exact device credential pairs and returns profile_open", async () => {
  const handler = createCloudCrossDeviceFixtureHandler();
  const open = (
    accessToken: string,
    deviceCredential: string,
    deviceId: string,
  ) => handler(new Request("http://127.0.0.1:49152/v1/profiles/aliasmode-cross-device-profile/open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-aliasmode-device": deviceCredential,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  }));

  expect((await open(
    "aliasmode-cross-device-access-a",
    "aliasmode-cross-device-credential-b",
    "fixture-cross-device-a",
  )).status).toBe(401);
  expect((await open(
    "aliasmode-cross-device-access-b",
    "aliasmode-cross-device-credential-a",
    "fixture-cross-device-b",
  )).status).toBe(401);
  expect((await open(
    "aliasmode-cross-device-access-a",
    "aliasmode-cross-device-credential-a",
    "fixture-cross-device-b",
  )).status).toBe(400);

  const openedA = await open(
    "aliasmode-cross-device-access-a",
    "aliasmode-cross-device-credential-a",
    "fixture-cross-device-a",
  );
  expect(openedA.status).toBe(200);
  expect(await openedA.json()).toMatchObject({ ok: true, baseVersion: 37, activeOpens: [] });

  const rejectedB = await open(
    "aliasmode-cross-device-access-b",
    "aliasmode-cross-device-credential-b",
    "fixture-cross-device-b",
  );
  expect(rejectedB.status).toBe(409);
  expect(await rejectedB.json()).toMatchObject({ ok: false, error: { code: "profile_open" } });

  const fixtureState = await handler(new Request("http://127.0.0.1:49152/control/state"));
  expect(await fixtureState.json()).toMatchObject({
    version: 37,
    activeDevice: "a",
    counters: { open: { a: 1, b: 1 }, profileOpen: 1 },
  });
});

test("Cloud cross-device acceptance preserves conflicts and blocks ambiguous local reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cross-device-acceptance-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createCloudRestoreFixtureHandler("cross-device"),
  });
  try {
    const state = await runCloudCrossDeviceAcceptance(
      statePaths(root),
      `http://127.0.0.1:${server.port}`,
    );
    expect(state).toEqual({
      ok: true,
      version: 42,
      activeDevice: null,
      counters: {
        open: { a: 3, b: 3 },
        close: { a: 4, b: 2 },
        heartbeat: { a: 0, b: 0 },
        abandon: { a: 0, b: 0 },
        acceptedCloses: 4,
        conflicts: 1,
        profileOpen: 1,
        droppedResponses: 2,
      },
    });
  } finally {
    await server.stop(true);
    await removeTemporaryRoot(root);
  }
});

test("Cloud restore fixture accepts only its exact refresh and device credentials", async () => {
  const handler = createCloudRestoreFixtureHandler("healthy");
  const refreshRequest = (refreshToken: string) => new Request(
    "http://127.0.0.1:49152/auth/v1/token?grant_type=refresh_token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  const statusWithoutWaiting = async (request: Request) => Promise.race([
    handler(request).then((response) => response.status),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]);
  const wrongDevice = new Request("http://127.0.0.1:49152/v1/status", {
    headers: {
      authorization: "Bearer aliasmode-fixture-access",
      "x-aliasmode-device": "wrong-device",
    },
  });

  expect(await Promise.all([
    statusWithoutWaiting(refreshRequest("wrong-refresh")),
    statusWithoutWaiting(refreshRequest(" aliasmode-acceptance-refresh-seeded")),
    handler(wrongDevice).then((response) => response.status),
  ])).toEqual([401, 401, 401]);
});

test("Cloud restore fixture returns an invited member or deterministic membership revocation", async () => {
  const healthy = createCloudRestoreFixtureHandler("healthy");
  const offline = createCloudRestoreFixtureHandler("offline");
  const releaseRequest = () => new Request("http://127.0.0.1:49152/control/release", { method: "POST" });
  const releasePending = async (handler: (request: Request) => Promise<Response>) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await handler(releaseRequest());
      if (response.status !== 409) return response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("fixture request did not wait for release");
  };
  expect((await healthy(releaseRequest())).status).toBe(409);
  const refreshRequest = (refreshToken = "aliasmode-acceptance-refresh-seeded") => new Request("http://127.0.0.1:49152/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const healthyPending = healthy(refreshRequest());
  const offlinePending = offline(refreshRequest());
  let refreshSettled = false;
  void healthyPending.then(() => { refreshSettled = true; });
  await Promise.resolve();
  expect(refreshSettled).toBe(false);
  const releases = await Promise.all([
    releasePending(healthy),
    releasePending(offline),
  ]);
  expect(releases.map((response) => response.status)).toEqual([200, 200]);
  const [refreshed, offlineRefresh] = await Promise.all([healthyPending, offlinePending]);
  expect(refreshed.status).toBe(200);
  expect(offlineRefresh).toMatchObject({ status: 0, type: "error" });
  expect((await healthy(releaseRequest())).status).toBe(409);
  expect((await healthy(refreshRequest())).status).toBe(401);
  const rotatedPending = healthy(refreshRequest("aliasmode-fixture-refresh-rotated"));
  expect((await releasePending(healthy)).status).toBe(200);
  expect((await rotatedPending).status).toBe(200);
  const session = await refreshed.json() as Record<string, unknown>;
  expect(typeof session.access_token).toBe("string");
  expect(typeof session.refresh_token).toBe("string");
  expect(session.user).toMatchObject({ id: "fixture-account", email_confirmed_at: "fixture" });

  const statusRequest = new Request("http://127.0.0.1:49152/v1/status", {
    headers: {
      authorization: `Bearer ${session.access_token}`,
      "x-aliasmode-device": "aliasmode-acceptance-device",
    },
  });
  const healthyStatus = await healthy(statusRequest);
  expect(healthyStatus.status).toBe(200);
  const healthyBody = await healthyStatus.json();
  expect(healthyBody.workspace).toMatchObject({ role: "member", ownerAccountId: "fixture-owner" });
  expect(healthyBody.legal.accepted).toMatchObject(healthyBody.legal.current);

  const revoked = createCloudRestoreFixtureHandler("membership-revoked");
  const revokedStatus = await revoked(statusRequest);
  expect(revokedStatus.status).toBe(403);
  expect(await revokedStatus.json()).toMatchObject({
    ok: false,
    error: { code: "membership_revoked" },
  });
});

test("Cloud restore fixture command binds loopback before normal CLI state initialization", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-cloud-restore-fixture-"));
  const stateRoot = join(parent, "must-not-be-created");
  const port = await freeLoopbackPort();
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "cli.ts"),
    "__cloud-restore-fixture",
    "--port", String(port),
    "--mode", "offline",
    "--state-root", stateRoot,
  ], { stdout: "pipe", stderr: "pipe" });
  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(health?.ok).toBe(true);
    expect(await health!.json()).toEqual({ ok: true, mode: "offline" });
    const offlineRequest = fetch(`http://127.0.0.1:${port}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "aliasmode-acceptance-refresh-seeded" }),
    }).then(
      () => { throw new Error("offline fixture unexpectedly returned an HTTP response"); },
      () => undefined,
    );
    let released: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/control/release`, { method: "POST" });
      if (response.ok) {
        released = response;
        break;
      }
      expect(response.status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(released?.ok).toBe(true);
    await expect(offlineRequest).resolves.toBeUndefined();
    expect(existsSync(stateRoot)).toBe(false);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("CLI dispatches the session worker before normal command parsing", async () => {
  const events: string[] = [];
  expect(await dispatchReadSessionWorker(["list"], {
    async readSession() { throw new Error("must not run"); },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(false);
  expect(events).toEqual([]);

  expect(await dispatchReadSessionWorker(["--read-session-worker", "ws://capture"], {
    async readSession(ws) {
      expect(ws).toBe("ws://capture");
      return "captured bundle";
    },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(true);
  expect(events).toEqual([
    JSON.stringify({ ok: true, bundle: "captured bundle" }),
    "exit:0",
  ]);
});

test("official Cloud configuration works without environment variables", () => {
  expect(cloudRuntimeConfiguration(cloudMode, {})).toEqual({
    apiUrl: OFFICIAL_CLOUD_URL,
    authUrl: OFFICIAL_CLOUD_URL,
    anonKey: OFFICIAL_CLOUD_ANON_KEY,
  });
});

test("Cloud configuration preserves explicit staging overrides", () => {
  expect(cloudRuntimeConfiguration(cloudMode, {
    ALIASMODE_CLOUD_URL: "http://127.0.0.1:3000/",
    ALIASMODE_SUPABASE_URL: "http://localhost:9999/",
    ALIASMODE_SUPABASE_ANON_KEY: "staging-public-key",
  })).toEqual({
    apiUrl: "http://127.0.0.1:3000",
    authUrl: "http://localhost:9999",
    anonKey: "staging-public-key",
  });
});

test("persisted Cloud URL configures both API and Auth", () => {
  const savedMode = { ...cloudMode, cloudUrl: "https://saved.aliasmode.test" };
  expect(cloudRuntimeConfiguration(savedMode, {})).toEqual({
    apiUrl: "https://saved.aliasmode.test",
    authUrl: "https://saved.aliasmode.test",
    anonKey: OFFICIAL_CLOUD_ANON_KEY,
  });
});

test("nonblank environment Cloud URL overrides the persisted selection", () => {
  const savedMode = { ...cloudMode, cloudUrl: "https://saved.aliasmode.test" };
  const env = { ALIASMODE_CLOUD_URL: "https://override.aliasmode.test/" };
  expect(selectedCloudUrl(savedMode, env)).toBe("https://override.aliasmode.test/");
  expect(cloudRuntimeConfiguration(savedMode, env)).toMatchObject({
    apiUrl: "https://override.aliasmode.test",
    authUrl: "https://override.aliasmode.test",
  });
});

test("blank Cloud overrides fall back to official configuration", () => {
  expect(cloudRuntimeConfiguration(cloudMode, {
    ALIASMODE_CLOUD_URL: "  ",
    ALIASMODE_SUPABASE_URL: "\t",
    ALIASMODE_SUPABASE_ANON_KEY: " ",
  })).toEqual({
    apiUrl: OFFICIAL_CLOUD_URL,
    authUrl: OFFICIAL_CLOUD_URL,
    anonKey: OFFICIAL_CLOUD_ANON_KEY,
  });
});

test("Local mode does not initialize or validate Cloud configuration", () => {
  const invalidEnv = {
    ALIASMODE_CLOUD_URL: "not a URL",
    ALIASMODE_SUPABASE_URL: "not a URL",
    ALIASMODE_SUPABASE_ANON_KEY: "",
  };
  expect(selectedCloudUrl(localMode, invalidEnv)).toBe("not a URL");
  expect(cloudRuntimeConfiguration(localMode, invalidEnv)).toBeNull();
});

test("Cloud mode rejects invalid explicit configuration", () => {
  expect(() => cloudRuntimeConfiguration(cloudMode, {
    ALIASMODE_CLOUD_URL: "http://cloud.example.com",
  })).toThrow("AliasMode Cloud URL must use HTTPS");
});

test("lifecycle admission env config is optional and parses positive integers", () => {
  expect(lifecycleAdmissionOptionsFromEnv({})).toEqual({});
  expect(lifecycleAdmissionOptionsFromEnv({
    ALIASMODE_LIFECYCLE_CAP: "6",
    ALIASMODE_LIFECYCLE_WAIT_MS: "180000",
  })).toEqual({ limit: 6, queueWaitMs: 180_000 });
});

test("invalid lifecycle admission env config fails startup validation", () => {
  for (const [name, value] of [
    ["ALIASMODE_LIFECYCLE_CAP", "0"],
    ["ALIASMODE_LIFECYCLE_CAP", "4.5"],
    ["ALIASMODE_LIFECYCLE_CAP", "NaN"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", "Infinity"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", ""],
  ] as const) {
    expect(() => lifecycleAdmissionOptionsFromEnv({ [name]: value })).toThrow(`${name} must be a positive integer`);
  }
});

test("remote shutdown retries unconfirmed cleanup until it is safe to exit", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const logs: string[] = [];

  await drainRemoteShutdown(
    async () => ++attempts >= 3,
    {
      retryMs: 7,
      attemptLogMs: 100,
      sleep: async (ms) => { waits.push(ms); },
      log: (message) => logs.push(message),
    },
  );

  expect(attempts).toBe(3);
  expect(waits).toEqual([7, 7]);
  expect(logs.filter((message) => message.includes("remains unconfirmed")).length).toBe(2);
  expect(logs.at(-1)).toContain("confirmed on attempt 3");
});

test("remote shutdown logs a hung cleanup in bounded windows without overlapping it", async () => {
  let attempts = 0;
  let finish!: (confirmed: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { finish = resolve; });
  const logs: string[] = [];

  const draining = drainRemoteShutdown(
    () => {
      attempts++;
      return pending;
    },
    {
      attemptLogMs: 2,
      retryMs: 1,
      sleep: async () => {},
      log: (message) => logs.push(message),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 12));
  expect(attempts).toBe(1);
  expect(logs.some((message) => message.includes("continuing to wait without overlapping"))).toBe(true);

  finish(true);
  await draining;
  expect(attempts).toBe(1);
});

test("remote shutdown has a total deadline even when cleanup never settles", async () => {
  let attempts = 0;
  const never = new Promise<boolean>(() => {});

  const draining = drainRemoteShutdown(
    () => {
      attempts++;
      return never;
    },
    {
      maxDrainMs: 12,
      attemptLogMs: 3,
      retryMs: 1,
      log: () => {},
    },
  );

  await expect(draining).rejects.toBeInstanceOf(RemoteShutdownTimeoutError);
  expect(attempts).toBe(1);
});

test("remote shutdown deadline retains failed cleanup instead of retrying forever", async () => {
  let attempts = 0;
  let now = 0;

  await expect(drainRemoteShutdown(
    async () => {
      attempts++;
      return false;
    },
    {
      maxDrainMs: 10,
      retryMs: 7,
      attemptLogMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      log: () => {},
    },
  )).rejects.toThrow("launch records and any unconfirmed hub locks were intentionally retained");

  expect(attempts).toBe(2);
});

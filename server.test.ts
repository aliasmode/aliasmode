import { test, expect } from "bun:test";
import { ProfileStore } from "./store.ts";
import { Launcher, type SpawnFn, type FetchFn, type CookieEnsurer } from "./launcher.ts";
import {
  handleRequest,
  handleAutomationHealthSnapshot,
  isAdsPowerBrowserControl,
  isAllowedHealthOrigin,
  isLoopbackAddress,
} from "./server.ts";
import {
  LifecycleAdmissionController,
  dispatchWithLifecycleAdmission,
} from "./lifecycle-admission.ts";
import { parseExport } from "./parse.ts";

const SAMPLE = `id=k1d0cd11
name=acct
group=g
cookie=[{"name":"auth_token","value":"v","domain":".x.com","path":"/","session":false,"expires":4070908800}]
proxytype=http
proxy=1.2.3.4:8080:u:p
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

interface Harness {
  store: ProfileStore;
  launcher: Launcher;
  killed: number[];
  injected: number;
  spawnedArgs: string[][];
  /** ws endpoints stop() asked to gracefully close over CDP, in call order. */
  gracefulCloses: string[];
  /** Make the graceful close report a confirmed clean exit (so stop() skips the force-kill). */
  setGracefulExit: (v: boolean) => void;
  /** Simulate whether the persistent profile already has a live X session. */
  setSession: (hasSession: boolean) => void;
  /** Toggle the current launch's CDP endpoint without changing process liveness. */
  setCdpAlive: (alive: boolean) => void;
}

function harness(): Harness {
  const store = new ProfileStore(":memory:");
  for (const p of parseExport(SAMPLE).profiles) store.upsertProfile(p);

  const killed: number[] = [];
  const gracefulCloses: string[] = [];
  let gracefulExit = false;
  const spawnedArgs: string[][] = [];
  let injected = 0;
  let nextPid = 5000;
  const pidByPort = new Map<number, number>();
  const alivePids = new Set<number>();
  const alivePorts = new Set<number>();

  const spawn: SpawnFn = (_bin, args) => {
    spawnedArgs.push(args);
    const pid = nextPid++;
    const port = Number(args.find((a) => a.startsWith("--remote-debugging-port="))!.split("=")[1]);
    pidByPort.set(port, pid);
    alivePids.add(pid);
    alivePorts.add(port);
    return { pid, kill: () => killed.push(pid) };
  };
  // Manager probes http://127.0.0.1:<port>/json/version; return a ws derived from the port.
  const fetchFn: FetchFn = async (url) => {
    const port = url.match(/:(\d+)\//)?.[1] ?? "0";
    return {
      ok: alivePorts.has(Number(port)),
      json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc` }),
    };
  };
  // Model the persistent session: once cookies are injected, the profile has a
  // live session that survives stop/relaunch (as the user-data dir would), so
  // later launches skip injection — unless setSession(false) clears it.
  let hasSession = false;
  const ensureCookies: CookieEnsurer = async () => {
    if (hasSession) return { injected: false };
    injected++;
    hasSession = true;
    return { injected: true };
  };

  const launcher = new Launcher({
    store,
    binaryPath: "/fake/cloakbrowser",
    unsafeDisableIdentityGates: true,
    dataRoot: "/tmp/cloak-test-data",
    portProbe: () => true,
    spawn,
    fetch: fetchFn,
    // The harness models CDP liveness but does not run a real browser. Proxy
    // verification behavior is covered in launcher.test.ts + proxy-live.test.ts.
    verifyProxy: async () => ({ ip: "203.0.113.9" }),
    ensureCookies,
    // stop() routes kills through killPidFn (tree-kill); track them here.
    killPid: async (pid) => {
      killed.push(pid);
      alivePids.delete(pid);
      for (const [port, owner] of pidByPort) if (owner === pid) alivePorts.delete(port);
    },
    isPidAlive: (pid) => alivePids.has(pid),
    findOwnedBrowserPids: async ({ debugPort }) => {
      const pid = pidByPort.get(debugPort);
      return pid !== undefined && alivePids.has(pid) ? [pid] : [];
    },
    // stop() asks the browser to flush+close over CDP before the force-kill.
    browserClose: async (ws) => {
      gracefulCloses.push(ws);
      if (gracefulExit) {
        const port = Number(ws.match(/:(\d+)\//)?.[1]);
        const pid = pidByPort.get(port);
        alivePorts.delete(port);
        if (pid !== undefined) alivePids.delete(pid);
      }
      return gracefulExit;
    },
    cdpReadyTimeoutMs: 1000,
  });

  return {
    store,
    launcher,
    killed,
    get injected() { return injected; },
    spawnedArgs,
    gracefulCloses,
    setGracefulExit: (v: boolean) => { gracefulExit = v; },
    setSession: (v: boolean) => { hasSession = v; },
    setCdpAlive: (v: boolean) => {
      const port = store.getLaunch("k1d0cd11")?.debugPort;
      if (port === undefined) return;
      if (v) alivePorts.add(port); else alivePorts.delete(port);
    },
  } as Harness;
}

function req(path: string): Request {
  return new Request(`http://127.0.0.1:50400${path}`);
}

test("isAdsPowerBrowserControl matches only the lifecycle routes remote mode routes through the hub", () => {
  expect(isAdsPowerBrowserControl("/api/v1/browser/start")).toBe(true);
  expect(isAdsPowerBrowserControl("/api/v1/browser/stop")).toBe(true);
  expect(isAdsPowerBrowserControl("/api/v1/browser/active")).toBe(true);
  expect(isAdsPowerBrowserControl("/api/v1/status")).toBe(false); // health passes through
  expect(isAdsPowerBrowserControl("/api/v2/browser-profile/delete-cache")).toBe(false); // cache trim passes
  expect(isAdsPowerBrowserControl("/ui/api/profiles")).toBe(false);
});

test("automation health endpoint validates and relays the complete snapshot", async () => {
  let relayed: unknown;
  const remote = {
    publishAutomationHealthSnapshot: async (profiles: unknown) => {
      relayed = profiles;
      return { profiles: 2, alive: 1, suspended: 1 };
    },
  };
  const res = await handleAutomationHealthSnapshot(new Request("http://127.0.0.1/api/xactions/health-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ profiles: [
      { profileId: "p1", suspended: false },
      { profileId: "p2", suspended: true },
    ] }),
  }), remote);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, profiles: 2, alive: 1, suspended: 1 });
  expect(relayed).toEqual([
    { profileId: "p1", suspended: false },
    { profileId: "p2", suspended: true },
  ]);
});

test("automation health relay rejects invalid bodies and reports hub failures", async () => {
  let calls = 0;
  const remote = {
    publishAutomationHealthSnapshot: async () => {
      calls++;
      throw new Error("hub unavailable");
    },
  };
  const invalid = await handleAutomationHealthSnapshot(new Request("http://127.0.0.1/api/xactions/health-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profiles: [{ profileId: "p1", suspended: false, extra: true }] }),
  }), remote);
  expect(invalid.status).toBe(400);
  expect(calls).toBe(0);

  const failed = await handleAutomationHealthSnapshot(new Request("http://127.0.0.1/api/xactions/health-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profiles: [] }),
  }), remote);
  expect(failed.status).toBe(502);
  expect((await failed.json()).error).toBe("hub unavailable");
});

test("health relay blocks simple cross-origin posts before publishing", async () => {
  let calls = 0;
  const remote = {
    publishAutomationHealthSnapshot: async () => {
      calls++;
      return { profiles: 1, alive: 0, suspended: 1 };
    },
  };
  const body = JSON.stringify({ profiles: [{ profileId: "p1", suspended: true }] });

  const simplePost = await handleAutomationHealthSnapshot(new Request("http://127.0.0.1/api/xactions/health-snapshot", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://attacker.example" },
    body,
  }), remote);
  expect(simplePost.status).toBe(415);

  const crossOriginJson = await handleAutomationHealthSnapshot(new Request("http://127.0.0.1/api/xactions/health-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body,
  }), remote);
  expect(crossOriginJson.status).toBe(403);
  expect(calls).toBe(0);
});

test("health origin validation allows automation and loopback pages only", () => {
  expect(isAllowedHealthOrigin(null)).toBe(true);
  expect(isAllowedHealthOrigin("http://localhost:50400")).toBe(true);
  expect(isAllowedHealthOrigin("https://127.0.0.1:50400")).toBe(true);
  expect(isAllowedHealthOrigin("http://[::1]:50400")).toBe(true);
  expect(isAllowedHealthOrigin("https://attacker.example")).toBe(false);
  expect(isAllowedHealthOrigin("null")).toBe(false);
});

test("health ingestion accepts only loopback peer addresses", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("127.12.0.4")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("192.168.1.10")).toBe(false);
  expect(isLoopbackAddress(null)).toBe(false);
});

test("status returns code 0", async () => {
  const { launcher, store } = harness();
  const res = await handleRequest(req("/api/v1/status"), launcher, store);
  expect(await res.json()).toEqual({ code: 0, msg: "success", data: {} });
});

test("/status (AdsPower's own path) is also a health check", async () => {
  const { launcher, store } = harness();
  const res = await handleRequest(req("/status"), launcher, store);
  expect((await res.json()).code).toBe(0);
});

test("status exposes shared lifecycle admission gauges additively", async () => {
  const { launcher, store } = harness();
  const admission = new LifecycleAdmissionController({ limit: 4 });
  const body = await (await handleRequest(req("/api/v1/status"), launcher, store, { admission })).json();
  expect(body).toMatchObject({
    code: 0,
    data: { admission: { limit: 4, inFlight: 0, queued: 0 } },
  });
});

test("start returns AdsPower-shaped envelope with ws.puppeteer and debug_port", async () => {
  const { launcher, store } = harness();
  const res = await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), launcher, store);
  const body = await res.json();
  expect(body.code).toBe(0);
  expect(typeof body.data.ws.puppeteer).toBe("string");
  expect(body.data.ws.puppeteer.startsWith("ws://")).toBe(true);
  expect(typeof body.data.debug_port).toBe("string");
  expect(Number(body.data.debug_port)).toBeGreaterThan(0);
});

test("standalone start waits behind shared admission while active bypasses it", async () => {
  const h = harness();
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release!: () => void;
  const held = admission.run({ kind: "cleanup", profileIds: ["other"] }, () =>
    new Promise<void>((resolve) => { release = resolve; })
  );
  const startReq = req("/api/v1/browser/start?user_id=k1d0cd11");
  const start = dispatchWithLifecycleAdmission(
    startReq,
    admission,
    () => handleRequest(startReq, h.launcher, h.store, { admission }),
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(h.spawnedArgs).toHaveLength(0);
  const activeReq = req("/api/v1/browser/active?user_id=k1d0cd11");
  const active = await dispatchWithLifecycleAdmission(
    activeReq,
    admission,
    () => handleRequest(activeReq, h.launcher, h.store, { admission }),
  );
  expect((await active.json()).data).toEqual({ status: "Active", lifecycle: "starting" });

  release();
  await held;
  expect((await (await start).json()).code).toBe(0);
  expect(h.spawnedArgs).toHaveLength(1);
});

test("start injects on first launch, then skips while the session persists", async () => {
  const h = harness();
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.injected).toBe(1);
  expect(h.store.getProfile("k1d0cd11")!.seeded).toBe(true);

  // Relaunch with the session still present → NO re-injection (keeps any
  // cookies X rotated during the prior session).
  await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store);
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.injected).toBe(1);
});

test("start re-injects when the profile has no live session (e.g. logged out)", async () => {
  const h = harness();
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.injected).toBe(1);

  h.setSession(false); // session lost (logged out / never persisted)
  await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store);
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.injected).toBe(2);
});

test("start forwards launch_args and stored identity flags to the browser", async () => {
  const h = harness();
  const launchArgs = JSON.stringify(["--automation-launcher-pid=999", "--disable-sync"]);
  await handleRequest(req(`/api/v1/browser/start?user_id=k1d0cd11&launch_args=${encodeURIComponent(launchArgs)}`), h.launcher, h.store);
  const args = h.spawnedArgs[0]!;
  expect(args).toContain("--automation-launcher-pid=999");
  expect(args).toContain("--disable-sync");
  expect(args.some((a) => a.startsWith("--fingerprint="))).toBe(true);
  // An authenticated proxy is reached via the loopback relay — the upstream creds must NOT be on the
  // command line (Chromium would ignore them anyway); the relay injects them instead.
  expect(args.some((a) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(a))).toBe(true);
  expect(args.some((a) => a.includes("u:p@1.2.3.4"))).toBe(false);
  expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
});

test("active flips Inactive -> Active -> Inactive across start/stop", async () => {
  const h = harness();
  let res = await handleRequest(req("/api/v1/browser/active?user_id=k1d0cd11"), h.launcher, h.store);
  expect((await res.json()).data.status).toBe("Inactive");

  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  res = await handleRequest(req("/api/v1/browser/active?user_id=k1d0cd11"), h.launcher, h.store);
  expect((await res.json()).data.status).toBe("Active");

  await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store);
  res = await handleRequest(req("/api/v1/browser/active?user_id=k1d0cd11"), h.launcher, h.store);
  expect((await res.json()).data.status).toBe("Inactive");
});

test("active returns the live ws endpoint while running (AdsPower parity)", async () => {
  const h = harness();
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  const body = await (await handleRequest(req("/api/v1/browser/active?user_id=k1d0cd11"), h.launcher, h.store)).json();
  expect(body.data.status).toBe("Active");
  expect(body.data.lifecycle).toBe("running");
  expect(typeof body.data.ws.puppeteer).toBe("string");
  expect(body.data.ws.puppeteer.startsWith("ws://")).toBe(true);
});

test("active bypasses occupied admission and reports queued/admitted lifecycle conservatively", async () => {
  const h = harness();
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release!: () => void;
  const held = admission.run({ kind: "start", profileIds: ["k1d0cd11"] }, () =>
    new Promise<void>((resolve) => { release = resolve; })
  );

  const starting = await (await handleRequest(
    req("/api/v1/browser/active?user_id=k1d0cd11"),
    h.launcher,
    h.store,
    { admission },
  )).json();
  expect(starting.data).toEqual({ status: "Active", lifecycle: "starting" });

  release();
  await held;
  const inactive = await (await handleRequest(
    req("/api/v1/browser/active?user_id=k1d0cd11"),
    h.launcher,
    h.store,
    { admission },
  )).json();
  expect(inactive.data.status).toBe("Inactive");
});

test("active exposes no websocket during stopping or uncertain durable ownership", async () => {
  const h = harness();
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release!: () => void;
  const held = admission.run({ kind: "stop", profileIds: ["k1d0cd11"] }, () =>
    new Promise<void>((resolve) => { release = resolve; })
  );

  const stopping = await (await handleRequest(
    req("/api/v1/browser/active?user_id=k1d0cd11"),
    h.launcher,
    h.store,
    { admission },
  )).json();
  expect(stopping.data).toEqual({ status: "Active", lifecycle: "stopping" });
  release();
  await held;

  h.launcher.certifiedActive = async () => false;
  const uncertain = await (await handleRequest(
    req("/api/v1/browser/active?user_id=k1d0cd11"),
    h.launcher,
    h.store,
    { admission },
  )).json();
  expect(uncertain.data).toEqual({ status: "Active", lifecycle: "uncertain" });
});

test("stop kills the spawned process and clears the launch record", async () => {
  const h = harness();
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.store.getLaunch("k1d0cd11")).not.toBeNull();
  await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.killed.length).toBe(1);
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
});

test("stop attempts a graceful CDP close, then force-kills when the exit isn't confirmed", async () => {
  const h = harness(); // gracefulExit defaults to false → close not confirmed
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  const ws = h.store.getLaunch("k1d0cd11")!.ws;
  await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store);
  // Graceful CDP close attempted with the live ws so Chromium can flush to disk...
  expect(h.gracefulCloses).toEqual([ws]);
  // ...and since it wasn't confirmed gone, the force-kill still runs (reaping preserved).
  expect(h.killed.length).toBe(1);
  expect(h.store.getLaunch("k1d0cd11")).toBeNull();
});

test("stop skips the force-kill when the graceful close confirms a clean exit", async () => {
  const h = harness();
  h.setGracefulExit(true); // browser confirmed gone after Browser.close (flush complete)
  await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store);
  const ws = h.store.getLaunch("k1d0cd11")!.ws;
  await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store);
  expect(h.gracefulCloses).toEqual([ws]); // graceful close happened...
  expect(h.killed.length).toBe(0);        // ...and a confirmed exit means NO SIGKILL racing the flush
  expect(h.store.getLaunch("k1d0cd11")).toBeNull(); // launch row still cleaned up
});

test("start on an unknown profile fails AdsPower-style (code -1)", async () => {
  const { launcher, store } = harness();
  const res = await handleRequest(req("/api/v1/browser/start?user_id=nope"), launcher, store);
  const body = await res.json();
  expect(body.code).toBe(-1);
  expect(body.msg).toContain("no such profile");
});

test("repeated start is idempotent (same port, single spawn)", async () => {
  const h = harness();
  const a = await (await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store)).json();
  const b = await (await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store)).json();
  expect(a.data.debug_port).toBe(b.data.debug_port);
  expect(h.spawnedArgs.length).toBe(1);
});

test("CDP-dead/live-process start returns AdsPower failure so stop+retry recovers the same run", async () => {
  const h = harness();
  const first = await (await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store)).json();
  h.setCdpAlive(false); // Chromium still exists, but memory pressure wedged CDP.

  const failed = await (await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store)).json();
  expect(failed.code).toBe(-1);
  expect(failed.msg).toBe("browser_launch/preflight (failed)");
  expect(h.spawnedArgs.length).toBe(1); // no duplicate profile process
  expect(h.store.getLaunch("k1d0cd11")?.debugPort).toBe(Number(first.data.debug_port));

  const stopped = await (await handleRequest(req("/api/v1/browser/stop?user_id=k1d0cd11"), h.launcher, h.store)).json();
  expect(stopped.code).toBe(0);
  const retried = await (await handleRequest(req("/api/v1/browser/start?user_id=k1d0cd11"), h.launcher, h.store)).json();
  expect(retried.code).toBe(0);
  expect(h.spawnedArgs.length).toBe(2);
});

test("delete-cache (AdsPower V2 shape) returns success", async () => {
  const h = harness();
  const res = await handleRequest(
    new Request("http://127.0.0.1:50400/api/v2/browser-profile/delete-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: ["k1d0cd11"], type: ["image_file"] }),
    }),
    h.launcher,
    h.store,
  );
  expect((await res.json()).code).toBe(0);
});

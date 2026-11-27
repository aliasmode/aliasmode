import { test, expect } from "bun:test";
import { captureFingerprint, recordCapture } from "./fingerprint-capture.ts";
import { ProfileStore } from "./store.ts";
import { parseExport, serializeAdsTxt } from "./parse.ts";
import type { FingerprintVerdict, ObservedFingerprint, Profile } from "./types.ts";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "k1d0cd11", accId: "", name: "n", group: "g", username: "", password: "",
    twofa: "", proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080,
    fingerprintSeed: 1, cookies: [], seeded: false, ...overrides,
  };
}

test("capture entrypoint runs over raw CDP in its own tab only and persists exportable observations", async () => {
  const store = new ProfileStore(":memory:");
  const events: string[] = [];
  // A browser over plain CDP: one restored user tab is open, and the capture must never attach to it.
  const server = Bun.serve<{ failure: boolean }, never>({
    port: 0,
    fetch: (request, srv) => srv.upgrade(request, { data: { failure: new URL(request.url).pathname.endsWith("/failure") } }) ? undefined : new Response("", { status: 400 }),
    websocket: {
      open() { events.push("connect"); },
      close() { events.push("detach"); },
      message(ws, raw) {
        const { id, method, params, sessionId } = JSON.parse(String(raw));
        const reply = (result: object = {}) => void ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
        const event = (name: string, eventParams: object) => void ws.send(JSON.stringify({ method: name, params: eventParams, sessionId: "capture-session" }));
        events.push(method);
        if (method === "Target.createTarget") return reply({ targetId: "capture-tab" });
        if (method === "Target.attachToTarget") {
          if (params.targetId !== "capture-tab") throw new Error("attached to a user tab");
          return reply({ sessionId: "capture-session" });
        }
        if (method === "Page.navigate") {
          reply({ frameId: "main", loaderId: "1" });
          event("Fetch.requestPaused", { requestId: "favicon", request: { url: "https://example.com/favicon.ico" } });
          return event("Fetch.requestPaused", { requestId: "document", request: { url: params.url } });
        }
        if (method === "Fetch.fulfillRequest") {
          reply();
          return event("Page.domContentEventFired", { timestamp: 1 });
        }
        if (method === "Runtime.evaluate") {
          if (!params.expression.includes("canvasHash") || !params.expression.endsWith(")()")) throw new Error("missing probe invocation");
          if (ws.data.failure) return reply({ result: { type: "object" }, exceptionDetails: { text: "probe failed" } });
          return reply({ result: { type: "object", value: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/146.0.0.0", platform: "Win32", canvasHash: "captured" } } });
        }
        return reply();
      },
    },
  });
  try {
    // No Node worker starts: a spawn would fail the capture.
    const options = { timeoutMs: 5_000, spawn: () => { throw new Error("worker spawned"); } };
    const p = profile();
    store.upsertProfile(p);
    const logs: string[] = [];
    const run = (endpoint: string) => recordCapture({
      profile: p, capture: () => captureFingerprint(endpoint, options),
      save: (id, observed, verdict) => store.saveObservedFingerprint(id, observed, verdict),
      log: message => logs.push(message),
    });
    expect(await run(`ws://127.0.0.1:${server.port}/devtools/browser/success`)).toBe(true);
    const saved = store.getProfile(p.id)!;
    expect(saved.fpObserved?.canvas).toBe("captured");
    expect(saved.fpObserved?.capturedAt).toBeTruthy();
    const exported = parseExport(serializeAdsTxt([saved])).profiles[0]!;
    expect(exported.ua).toContain("Chrome/146");
    expect(exported.fpExpected?.canvas).toBe("captured");
    expect(await run(`ws://127.0.0.1:${server.port}/devtools/browser/failure`)).toBe(false);
    expect(store.getProfile(p.id)!.fpObserved).toEqual(saved.fpObserved);
    expect(logs).toHaveLength(1);
    const capture = [
      "connect", "Target.createTarget", "Target.attachToTarget", "Fetch.enable", "Page.enable", "Page.navigate",
      "Fetch.failRequest", "Fetch.fulfillRequest", "Runtime.evaluate", "Target.closeTarget", "detach",
    ];
    for (let i = 0; i < 50 && events.length < capture.length * 2; i++) await Bun.sleep(20);
    // Nothing attaches to other tabs on its own (Target.setAutoAttach) or enables a page runtime.
    expect(events).toEqual([...capture, ...capture]);
  } finally {
    server.stop(true);
    store.close();
  }
});

test("partial captures retain diagnostics and do not verify an empty expectation", async () => {
  const c = collector();
  await recordCapture({
    profile: profile({ fpExpected: { capturedAt: "2026-09-05T00:00:00Z" } }),
    capture: async () => ({
      uaFullVersion: "146.0.7680.177", uaDataPlatform: "Windows", uaDataPlatformVersion: "19.0.0",
      uaDataBrands: ["Chromium 146"], uaFullVersionList: ["Chromium 146.0.7680.177"],
      language: "en-US", timezone: "America/New_York",
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, dpr: 1.25 },
      errors: { audio: "unavailable" },
    }),
    save: c.save, log: c.log,
  });
  expect(c.saved[0]!.verdict).toBeNull();
  expect(c.logs).toHaveLength(1);
  const fp = c.saved[0]!.observed;
  const restored = parseExport(serializeAdsTxt([profile({ fpObserved: fp })])).profiles[0]!;
  expect(restored.fpExpected).toEqual(fp);
  expect(fp).toMatchObject({ chrome: "146.0.7680.177", devicePixelRatio: 1.25, availableScreen: "1920*1040", errors: '{"audio":"unavailable"}' });
});

interface Saved {
  id: string;
  observed: ObservedFingerprint;
  verdict: FingerprintVerdict | null;
}

function collector() {
  const saved: Saved[] = [];
  const logs: string[] = [];
  return {
    saved,
    logs,
    save: (id: string, observed: ObservedFingerprint, verdict: FingerprintVerdict | null) =>
      saved.push({ id, observed, verdict }),
    log: (m: string) => logs.push(m),
  };
}

test("a capture with no expectation stores the sample and no verdict", async () => {
  const c = collector();
  await recordCapture({
    profile: profile(),
    capture: async () => ({ canvasHash: "a3f19c8e" }),
    save: c.save,
    log: c.log,
  });
  expect(c.saved[0]!.observed.canvas).toBe("a3f19c8e");
  expect(c.saved[0]!.verdict).toBeNull();
});

test("a capture matching the expectation stores a match verdict", async () => {
  const c = collector();
  await recordCapture({
    profile: profile({ fpExpected: { canvas: "a3f19c8e" } }),
    capture: async () => ({ canvasHash: "a3f19c8e" }),
    save: c.save,
    log: c.log,
  });
  expect(c.saved[0]!.verdict!.verdict).toBe("match");
});

test("a capture contradicting the expectation stores a mismatch naming the field", async () => {
  const c = collector();
  await recordCapture({
    profile: profile({ fpExpected: { canvas: "a3f19c8e" } }),
    capture: async () => ({ canvasHash: "deadbeef" }),
    save: c.save,
    log: c.log,
  });
  expect(c.saved[0]!.verdict!.verdict).toBe("mismatch");
  expect(c.saved[0]!.verdict!.differences[0]!.field).toBe("canvas");
  expect(c.logs.join(" ")).toContain("FINGERPRINT MISMATCH");
});

test("a probe that throws saves nothing and does not propagate", async () => {
  const c = collector();
  await recordCapture({
    profile: profile(),
    capture: async () => {
      throw new Error("CDP gone");
    },
    save: c.save,
    log: c.log,
  });
  expect(c.saved).toEqual([]);
  expect(c.logs.join(" ")).toContain("CDP gone");
});

test("a probe returning null saves nothing", async () => {
  const c = collector();
  await recordCapture({
    profile: profile(),
    capture: async () => null,
    save: c.save,
    log: c.log,
  });
  expect(c.saved).toEqual([]);
});

test("a store write that throws is swallowed too", async () => {
  const logs: string[] = [];
  await recordCapture({
    profile: profile(),
    capture: async () => ({ canvasHash: "a3f19c8e" }),
    save: () => {
      throw new Error("database is locked");
    },
    log: (m) => logs.push(m),
  });
  expect(logs.join(" ")).toContain("database is locked");
});

test("the recorded sample carries the webrtc policy and a capture timestamp", async () => {
  const c = collector();
  await recordCapture({
    profile: profile(),
    capture: async () => ({ canvasHash: "a3f19c8e" }),
    save: c.save,
    log: c.log,
    webrtc: "disable_non_proxied_udp",
  });
  expect(c.saved[0]!.observed.webrtc).toBe("disable_non_proxied_udp");
  expect(Date.parse(c.saved[0]!.observed.capturedAt!)).not.toBeNaN();
});

test("recordCapture reports whether it actually wrote, so the launcher can re-baseline", async () => {
  const c = collector();
  const wrote = await recordCapture({
    profile: profile(),
    capture: async () => ({ canvasHash: "a3f19c8e" }),
    save: c.save,
    log: c.log,
  });
  expect(wrote).toBe(true);

  const failed = await recordCapture({
    profile: profile(),
    capture: async () => {
      throw new Error("CDP gone");
    },
    save: c.save,
    log: c.log,
  });
  expect(failed).toBe(false);
});

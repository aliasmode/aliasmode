import { test, expect } from "bun:test";
import { captureFingerprint, recordCapture } from "./fingerprint-capture.ts";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("capture entrypoint runs the Node worker and persists exportable observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-fingerprint-worker-"));
  const store = new ProfileStore(":memory:");
  const events = join(root, "events.log");
  try {
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = event => appendFile(${JSON.stringify(events)}, event + "\\n");
      export const chromium = { async connectOverCDP(endpoint) {
        await log("connect");
        let closed = false;
        let handler;
        let currentUrl = "about:blank";
        const page = {
          async route(pattern, callback) { handler = callback; await log("route"); },
          async unroute() { handler = undefined; await log("unroute"); },
          url: () => currentUrl,
          async evaluate(source) {
            if (!currentUrl.startsWith("https://fingerprint.aliasmode.invalid/")) throw new Error("probe must have a secure origin");
            if (!source.includes("canvasHash") || !source.includes("navigator") || !source.endsWith(")()")) throw new Error("missing probe invocation");
            await new Promise(resolve => setTimeout(resolve, 20));
            if (closed) throw new Error("page closed before evaluation finished");
            if (endpoint.endsWith("/failure")) throw new Error("probe failed");
            await log("evaluated");
            return { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/146.0.0.0", platform: "Win32", canvasHash: "captured" };
          },
          async goto(url) {
            if (!handler) throw new Error("network navigation attempted");
            let fulfilled = false;
            await handler({ request: () => ({ url: () => url }), async fulfill() { fulfilled = true; }, async abort() {} });
            if (!fulfilled) throw new Error("document was not fulfilled locally");
            currentUrl = url;
            await log("local-document");
          },
          async close() { closed = true; await log("close-page"); },
        };
        return {
          contexts: () => [{
            pages() { throw new Error("capture must not use user tabs"); },
            async newPage() { await log("new-page"); return page; },
          }],
          async close() { await log("detach"); },
        };
      } };
    `);
    const options = {
      runtimeRoot: root,
      timeoutMs: 5_000,
      spawn: (argv: string[]) => Bun.spawn(["node", ...argv.slice(1)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
    };
    const p = profile();
    store.upsertProfile(p);
    const logs: string[] = [];
    const run = (endpoint: string) => recordCapture({
      profile: p, capture: () => captureFingerprint(endpoint, options),
      save: (id, observed, verdict) => store.saveObservedFingerprint(id, observed, verdict),
      log: message => logs.push(message),
    });
    expect(await run("ws://browser/success")).toBe(true);
    const saved = store.getProfile(p.id)!;
    expect(saved.fpObserved?.canvas).toBe("captured");
    expect(saved.fpObserved?.capturedAt).toBeTruthy();
    const exported = parseExport(serializeAdsTxt([saved])).profiles[0]!;
    expect(exported.ua).toContain("Chrome/146");
    expect(exported.fpExpected?.canvas).toBe("captured");
    expect(await run("ws://browser/failure")).toBe(false);
    expect(store.getProfile(p.id)!.fpObserved).toEqual(saved.fpObserved);
    expect(logs).toHaveLength(1);
    expect((await readFile(events, "utf8")).trim().split("\n")).toEqual([
      "connect", "new-page", "route", "local-document", "evaluated", "unroute", "close-page", "detach",
      "connect", "new-page", "route", "local-document", "unroute", "close-page", "detach",
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
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

import { test, expect } from "bun:test";
import { recordCapture } from "./fingerprint-capture.ts";
import type { FingerprintVerdict, ObservedFingerprint, Profile } from "./types.ts";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "k1d0cd11", accId: "", name: "n", group: "g", username: "", password: "",
    twofa: "", proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080,
    fingerprintSeed: 1, cookies: [], seeded: false, ...overrides,
  };
}

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

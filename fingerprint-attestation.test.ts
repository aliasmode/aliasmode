import { test, expect } from "bun:test";
import {
  observedFromSample,
  attestationFields,
  expectationFromRecord,
  compareAttestation,
  FP_BLOCK_KEYS,
} from "./fingerprint-attestation.ts";
import type { ObservedFingerprint } from "./types.ts";

const SAMPLE = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  platform: "Win32",
  languages: ["en-US", "en"],
  hardwareConcurrency: 8,
  deviceMemory: 8,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, dpr: 1 },
  webglVendor: "Google Inc. (Intel)",
  webglRenderer: "ANGLE (Intel, Mesa Intel(R) Graphics (RPL-S), OpenGL 4.6)",
  canvasHash: "a3f19c8e",
  audioHash: "7b2e0451",
};

const OBSERVED: ObservedFingerprint = {
  ua: SAMPLE.userAgent,
  chrome: "146.0.0.0",
  platform: "Win32",
  languages: "en-US,en",
  hardwareConcurrency: 8,
  deviceMemory: 8,
  webglVendor: "Google Inc. (Intel)",
  webglRenderer: "ANGLE (Intel, Mesa Intel(R) Graphics (RPL-S), OpenGL 4.6)",
  canvas: "a3f19c8e",
  audio: "7b2e0451",
  screen: "1920*1080",
};

test("observedFromSample flattens a probe sample into comparable scalars", () => {
  const fp = observedFromSample(SAMPLE, { webrtc: "disable_non_proxied_udp", capturedAt: "2026-08-29T11:04:22Z" });
  expect(fp.ua).toBe(SAMPLE.userAgent);
  expect(fp.chrome).toBe("146.0.0.0");
  expect(fp.languages).toBe("en-US,en");
  expect(fp.screen).toBe("1920*1080");
  expect(fp.webrtc).toBe("disable_non_proxied_udp");
  expect(fp.capturedAt).toBe("2026-08-29T11:04:22Z");
});

test("observedFromSample survives a probe that returned only errors", () => {
  const fp = observedFromSample({ errors: { probe: "boom" } });
  expect(fp.ua).toBeUndefined();
  expect(fp.canvas).toBeUndefined();
});

test("attestationFields emits every fp_ key, blank for an absent sample", () => {
  const blank = attestationFields(undefined);
  expect(Object.keys(blank)).toEqual([...FP_BLOCK_KEYS]);
  expect(Object.values(blank).every((v) => v === "")).toBe(true);
});

test("attestationFields renders values as export strings", () => {
  const f = attestationFields(OBSERVED);
  expect(f.fp_canvas).toBe("a3f19c8e");
  expect(f.fp_hw_concurrency).toBe("8");
  expect(f.fp_webgl_renderer).toBe("ANGLE (Intel, Mesa Intel(R) Graphics (RPL-S), OpenGL 4.6)");
  expect(f.fp_screen).toBe("1920*1080");
});

test("expectationFromRecord round-trips attestationFields", () => {
  const back = expectationFromRecord(attestationFields(OBSERVED));
  expect(back).toEqual(OBSERVED);
});

test("expectationFromRecord returns null when a record carries no fp_ keys", () => {
  expect(expectationFromRecord({ id: "abc", ua: "x" })).toBeNull();
});

test("expectationFromRecord ignores blank fp_ values rather than storing empty strings", () => {
  const fp = expectationFromRecord({ fp_canvas: "a3f19c8e", fp_audio: "", fp_hw_concurrency: "" });
  expect(fp).toEqual({ canvas: "a3f19c8e" });
});

test("identical fingerprints match", () => {
  expect(compareAttestation(OBSERVED, OBSERVED).verdict).toBe("match");
});

test("a changed canvas hash is a mismatch naming that field", () => {
  const v = compareAttestation(OBSERVED, { ...OBSERVED, canvas: "deadbeef" });
  expect(v.verdict).toBe("mismatch");
  expect(v.differences).toEqual([{ field: "canvas", expected: "a3f19c8e", observed: "deadbeef" }]);
});

test("a kernel upgrade alone is NOT a mismatch", () => {
  const upgraded = {
    ...OBSERVED,
    chrome: "147.0.0.0",
    ua: OBSERVED.ua!.replace("146", "147"),
  };
  expect(compareAttestation(OBSERVED, upgraded).verdict).toBe("match");
});

test("a field absent from the expectation is skipped, never a difference", () => {
  const partial: ObservedFingerprint = { canvas: "a3f19c8e" };
  const v = compareAttestation(partial, { ...OBSERVED, webglRenderer: "something else" });
  expect(v.verdict).toBe("match");
  expect(v.differences).toEqual([]);
});

test("a field the expectation has but the browser did not report IS a difference", () => {
  const v = compareAttestation(OBSERVED, { ...OBSERVED, canvas: undefined });
  expect(v.verdict).toBe("mismatch");
  expect(v.differences[0]!.field).toBe("canvas");
  expect(v.differences[0]!.observed).toBe("");
});

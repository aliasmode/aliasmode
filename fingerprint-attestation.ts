/**
 * The attestation: what a profile's fingerprint was measured to be, how it
 * travels through an export block, and whether a relaunch still matches it.
 *
 * Everything here is pure. Capturing lives in fingerprint-capture.ts and
 * persistence in store.ts, so this file can be reasoned about — and tested —
 * without a browser or a database.
 *
 * The fp_* values are a PHOTOGRAPH of an identity, never an input to one. The
 * identity is the seed, the screen, the platform and the timezone; those are
 * restored. Editing fp_webgl_renderer in a spreadsheet changes what an import
 * expects to see, not what the browser reports.
 */

import type { FingerprintSample } from "./diagnose.ts";
import type { FingerprintDifference, FingerprintVerdict, ObservedFingerprint } from "./types.ts";

/**
 * The fp_* keys, in export order. Declared as a literal tuple rather than
 * derived from the map below, because parse.ts spreads it into the `as const`
 * TXT_KEYS/XLSX_COLUMNS tuples — an array typed only as ReadonlyArray<string>
 * would widen those and break the keyed field lookup in serializeAdsTxt.
 */
export const FP_BLOCK_KEYS = [
  "fp_ua",
  "fp_chrome",
  "fp_platform",
  "fp_languages",
  "fp_hw_concurrency",
  "fp_device_memory",
  "fp_webgl_vendor",
  "fp_webgl_renderer",
  "fp_canvas",
  "fp_audio",
  "fp_screen",
  "fp_webrtc",
  "fp_captured_at",
] as const;

export type FpBlockKey = (typeof FP_BLOCK_KEYS)[number];

/** Block/column key → ObservedFingerprint property. */
const FIELD_BY_KEY: Record<FpBlockKey, keyof ObservedFingerprint> = {
  fp_ua: "ua",
  fp_chrome: "chrome",
  fp_platform: "platform",
  fp_languages: "languages",
  fp_hw_concurrency: "hardwareConcurrency",
  fp_device_memory: "deviceMemory",
  fp_webgl_vendor: "webglVendor",
  fp_webgl_renderer: "webglRenderer",
  fp_canvas: "canvas",
  fp_audio: "audio",
  fp_screen: "screen",
  fp_webrtc: "webrtc",
  fp_captured_at: "capturedAt",
};

/** Properties parsed back as numbers rather than strings. */
const NUMERIC_FIELDS = new Set<keyof ObservedFingerprint>(["hardwareConcurrency", "deviceMemory"]);

/**
 * The fields a verdict is computed from — every one a pure function of the
 * seed, screen and platform, so a difference means the identity really changed.
 *
 * `ua`, `chrome`, `webrtc` and `capturedAt` are deliberately absent. They move
 * legitimately when the CloakBrowser kernel upgrades; including them would mark
 * every profile on the estate mismatched the first Monday after an update,
 * which teaches operators to ignore the badge.
 */
export const VERDICT_FIELDS: ReadonlyArray<keyof ObservedFingerprint> = [
  "canvas",
  "audio",
  "webglVendor",
  "webglRenderer",
  "hardwareConcurrency",
  "deviceMemory",
  "languages",
  "screen",
  "platform",
];

/** Pull the Chrome version out of a UA, e.g. "146.0.0.0". */
function chromeVersion(ua: string | undefined): string | undefined {
  return ua?.match(/Chrome\/([\d.]+)/)?.[1];
}

function defined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

/** Flatten a page probe's sample into the comparable, exportable shape. */
export function observedFromSample(
  sample: FingerprintSample,
  extra: { webrtc?: string; capturedAt?: string } = {},
): ObservedFingerprint {
  return defined<ObservedFingerprint>({
    ua: sample.userAgent,
    chrome: chromeVersion(sample.userAgent) ?? sample.uaFullVersion,
    platform: sample.platform ?? sample.uaDataPlatform,
    languages: sample.languages?.join(","),
    hardwareConcurrency: sample.hardwareConcurrency,
    deviceMemory: sample.deviceMemory,
    webglVendor: sample.webglVendor,
    webglRenderer: sample.webglRenderer,
    canvas: sample.canvasHash,
    audio: sample.audioHash,
    screen: sample.screen ? `${sample.screen.width}*${sample.screen.height}` : undefined,
    webrtc: extra.webrtc,
    capturedAt: extra.capturedAt,
  });
}

/**
 * The fp_* half of an export block. Always emits every key — a profile that has
 * never launched exports blanks rather than a differently-shaped block, so the
 * sheet's columns line up whatever the fleet's launch history looks like.
 */
export function attestationFields(fp: ObservedFingerprint | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FP_BLOCK_KEYS) {
    const value = fp?.[FIELD_BY_KEY[key]];
    out[key] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

/** Read an import block's fp_* keys back into an expectation, or null if it has none. */
export function expectationFromRecord(rec: Record<string, string>): ObservedFingerprint | null {
  const out: ObservedFingerprint = {};
  let any = false;
  for (const key of FP_BLOCK_KEYS) {
    const raw = (rec[key] ?? "").trim();
    if (!raw) continue;
    const field = FIELD_BY_KEY[key];
    if (NUMERIC_FIELDS.has(field)) {
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      (out as Record<string, unknown>)[field] = n;
    } else {
      (out as Record<string, unknown>)[field] = raw;
    }
    any = true;
  }
  return any ? out : null;
}

/**
 * Compare a stored expectation against a fresh capture.
 *
 * A field the expectation does not carry is skipped entirely: a file written
 * before this feature existed, or one an operator trimmed, must not manufacture
 * mismatches. A field the expectation DOES carry but the browser did not report
 * is a real difference — something that used to be measurable no longer is.
 */
export function compareAttestation(
  expected: ObservedFingerprint,
  observed: ObservedFingerprint,
): FingerprintVerdict {
  const differences: FingerprintDifference[] = [];
  for (const field of VERDICT_FIELDS) {
    const want = expected[field];
    if (want === undefined || want === null || want === "") continue;
    const got = observed[field];
    if (String(got ?? "") !== String(want)) {
      differences.push({ field, expected: String(want), observed: String(got ?? "") });
    }
  }
  return { verdict: differences.length ? "mismatch" : "match", differences };
}

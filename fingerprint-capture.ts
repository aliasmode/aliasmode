/**
 * Measure a launched browser's fingerprint, once, quietly.
 *
 * Two rules govern this file:
 *
 *  1. It runs in its OWN blank page and never navigates. Reading canvas and
 *     WebGL inside a live account tab is exactly the behaviour a detection
 *     script watches for, and the entire point of this work is to not look
 *     unusual. (diagnoseOverCDP visits example.com and x.com because it is an
 *     operator-invoked diagnostic; a per-launch capture must cost nothing
 *     observable.)
 *  2. It can never fail a launch. Identity capture is bookkeeping. Every
 *     failure path here logs and returns — see recordCapture.
 */

import { withCdpPage } from "./cdp.ts";
import { fingerprintProbe, type FingerprintSample } from "./diagnose.ts";
import { compareAttestation, observedFromSample } from "./fingerprint-attestation.ts";
import type { FingerprintVerdict, ObservedFingerprint, Profile } from "./types.ts";

const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;

/** Read the live fingerprint over CDP from an isolated blank page. */
export async function captureFingerprint(
  ws: string,
  opts: { timeoutMs?: number } = {},
): Promise<FingerprintSample | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  return withCdpPage(
    ws,
    async (page) => (await page.evaluate(fingerprintProbe)) as FingerprintSample,
    { timeoutMs, temporaryPage: true },
  );
}

export interface RecordCaptureArgs {
  profile: Profile;
  capture: () => Promise<FingerprintSample | null>;
  save: (profileId: string, observed: ObservedFingerprint, verdict: FingerprintVerdict | null) => void;
  log: (msg: string) => void;
  /** WebRTC policy in force for this launch; recorded, never compared. */
  webrtc?: string;
}

/**
 * Run a capture and persist it, plus a verdict when the profile carries an
 * expectation to check against. Swallows everything: the caller is a launch.
 *
 * Returns true when a row was actually written. The launcher needs to know:
 * it guards the rest of the launch with a JSON snapshot of the profile, and
 * this write makes that snapshot stale.
 */
export async function recordCapture(args: RecordCaptureArgs): Promise<boolean> {
  const { profile, capture, save, log, webrtc } = args;
  let sample: FingerprintSample | null;
  try {
    sample = await capture();
  } catch (err) {
    log(`fingerprint capture failed for ${profile.id} (continuing): ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (!sample) return false;
  const observed = observedFromSample(sample, { webrtc, capturedAt: new Date().toISOString() });
  const verdict = profile.fpExpected ? compareAttestation(profile.fpExpected, observed) : null;
  try {
    save(profile.id, observed, verdict);
  } catch (err) {
    log(
      `fingerprint capture could not be stored for ${profile.id} (continuing): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
  if (verdict?.verdict === "mismatch") {
    const fields = verdict.differences.map((d) => d.field).join(", ");
    log(`${profile.id}: FINGERPRINT MISMATCH against the imported attestation (${fields})`);
  }
  return true;
}

import { test, expect } from "bun:test";
import { analyze, type ProfileReport } from "./diagnose.ts";

function report(over: Partial<ProfileReport>): ProfileReport {
  return {
    profileId: "p",
    ok: true,
    proxyConfigured: { host: "1.2.3.4", port: "8080" },
    screenConfigured: { width: 1920, height: 1080 },
    egress: { ip: "1.2.3.4" },
    fingerprint: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/143", uaDataPlatform: "Windows", canvasHash: "aaa", audioHash: "x1", webglRenderer: "ANGLE (NVIDIA)" },
    login: { loggedIn: true, loggedOut: false },
    ...over,
  };
}

const SCREEN = (w: number, h: number) => ({ width: w, height: h, availWidth: w, availHeight: h - 40, colorDepth: 24, dpr: 1 });

const REAL_IP = "9.9.9.9";

test("flags a proxy bypass when egress equals the machine's real IP", () => {
  const a = analyze([report({ profileId: "p1", egress: { ip: REAL_IP } })], REAL_IP);
  expect(a.proxy.bypassed).toEqual(["p1"]);
  expect(a.proxy.ok).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("PROXY BYPASSED"))).toBe(true);
});

test("missing baseline IP makes proxy bypass inconclusive, not ok", () => {
  const a = analyze([report({ profileId: "p1", egress: { ip: "1.2.3.4" } })], undefined);
  expect(a.proxy.inconclusive).toEqual(["p1"]);
  expect(a.proxy.ok).toEqual([]);
  expect(a.proxy.bypassed).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("could NOT be checked"))).toBe(true);
});

test("proxy ok and matchesConfiguredHost when egress is the proxy host", () => {
  const a = analyze([report({ profileId: "p1", egress: { ip: "1.2.3.4" } })], REAL_IP);
  expect(a.proxy.ok).toEqual(["p1"]);
  expect(a.proxy.matchesConfiguredHost).toEqual(["p1"]);
  expect(a.proxy.bypassed).toEqual([]);
});

test("no egress captured is reported, not treated as ok", () => {
  const a = analyze([report({ profileId: "p1", egress: null })], REAL_IP);
  expect(a.proxy.noEgress).toEqual(["p1"]);
});

test("detects WebRTC real-IP leak", () => {
  const a = analyze([report({ profileId: "p1", webrtcIps: ["192.168.1.5", REAL_IP] })], REAL_IP);
  expect(a.webrtcLeaks).toEqual(["p1"]);
  const clean = analyze([report({ profileId: "p2", webrtcIps: ["192.168.1.5"] })], REAL_IP);
  expect(clean.webrtcLeaks).toEqual([]);
});

test("detects canvas fingerprint collisions across profiles", () => {
  const a = analyze(
    [
      report({ profileId: "p1", fingerprint: { canvasHash: "same", audioHash: "a1" } }),
      report({ profileId: "p2", fingerprint: { canvasHash: "same", audioHash: "a2" } }),
      report({ profileId: "p3", fingerprint: { canvasHash: "unique", audioHash: "a3" } }),
    ],
    REAL_IP,
  );
  expect(a.fingerprintCollisions.canvas.length).toBe(1);
  expect(a.fingerprintCollisions.canvas[0]!.profiles.sort()).toEqual(["p1", "p2"]);
  expect(a.verdicts.some((v) => v.includes("canvas fingerprint COLLISION"))).toBe(true);
});

test("unique canvas hashes produce no collision", () => {
  const a = analyze(
    [
      report({ profileId: "p1", fingerprint: { canvasHash: "h1" } }),
      report({ profileId: "p2", fingerprint: { canvasHash: "h2" } }),
    ],
    REAL_IP,
  );
  expect(a.fingerprintCollisions.canvas).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("canvas fingerprints unique"))).toBe(true);
});

test("flags fingerprint that changes across relaunch", () => {
  const a = analyze(
    [report({ profileId: "p1", fingerprint: { canvasHash: "first" }, fingerprintRelaunch: { canvasHash: "second" } })],
    REAL_IP,
  );
  expect(a.unstableFingerprints).toEqual(["p1"]);
});

test("stable fingerprint across relaunch is not flagged", () => {
  const a = analyze(
    [report({ profileId: "p1", fingerprint: { canvasHash: "same" }, fingerprintRelaunch: { canvasHash: "same" } })],
    REAL_IP,
  );
  expect(a.unstableFingerprints).toEqual([]);
});

test("flags UA vs UA-CH platform mismatch", () => {
  const a = analyze(
    [report({ profileId: "p1", fingerprint: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/143", uaDataPlatform: "macOS", canvasHash: "h" } })],
    REAL_IP,
  );
  expect(a.uaInconsistencies.length).toBe(1);
  expect(a.uaInconsistencies[0]!.profileId).toBe("p1");
});

test("flags a screen resolution mismatch between configured and reported", () => {
  const a = analyze(
    [
      report({
        profileId: "p1",
        screenConfigured: { width: 1920, height: 1080 },
        fingerprint: { canvasHash: "h", screen: SCREEN(1366, 768) },
      }),
    ],
    REAL_IP,
  );
  expect(a.screenMismatches.length).toBe(1);
  expect(a.screenMismatches[0]!.seen).toBe("1366x768");
  expect(a.screenMismatches[0]!.configured).toBe("1920x1080");
  expect(a.verdicts.some((v) => v.includes("screen resolution mismatch"))).toBe(true);
});

test("matching screen resolution is not flagged and reports a pass", () => {
  const a = analyze(
    [
      report({
        profileId: "p1",
        screenConfigured: { width: 1920, height: 1080 },
        fingerprint: { canvasHash: "h", screen: SCREEN(1920, 1080) },
      }),
    ],
    REAL_IP,
  );
  expect(a.screenMismatches).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("screen resolution matches"))).toBe(true);
});

test("tallies login state", () => {
  const a = analyze(
    [
      report({ profileId: "p1", login: { loggedIn: true, loggedOut: false } }),
      report({ profileId: "p2", login: { loggedIn: false, loggedOut: true } }),
      report({ profileId: "p3", login: { loggedIn: false, loggedOut: false } }),
    ],
    REAL_IP,
  );
  expect(a.login.loggedIn).toEqual(["p1"]);
  expect(a.login.loggedOut).toEqual(["p2"]);
  expect(a.login.unknown).toEqual(["p3"]);
});

import { test, expect } from "bun:test";
import {
  deterministicSeed,
  parseResolution,
  platformFromUA,
  chromeMajorFromUA,
  deriveFingerprintFlags,
  proxyServerFlag,
  isMobileUserAgent,
  convertMobilePersonaToDesktop,
  hostPlatformOs,
} from "./fingerprint.ts";
import type { Profile } from "./types.ts";

const UA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "k1d0cd11",
    accId: "1",
    name: "n",
    group: "g",
    username: "",
    password: "",
    twofa: "",
    proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p@ss word" },
    ua: UA_WIN,
    timezone: "",
    screenWidth: 1680,
    screenHeight: 1050,
    fingerprintSeed: deterministicSeed("k1d0cd11"),
    cookies: [],
    seeded: false,
    ...overrides,
  };
}

test("deterministicSeed is stable and non-zero for the same id", () => {
  const a = deterministicSeed("k1d0cd11");
  const b = deterministicSeed("k1d0cd11");
  expect(a).toBe(b);
  expect(a).toBeGreaterThan(0);
});

test("deterministicSeed differs across ids", () => {
  expect(deterministicSeed("k1d0cd11")).not.toBe(deterministicSeed("k1d0ccwr"));
});

test("parseResolution handles * and x and defaults", () => {
  expect(parseResolution("1680*1050")).toEqual({ width: 1680, height: 1050 });
  expect(parseResolution("1920x1080")).toEqual({ width: 1920, height: 1080 });
  expect(parseResolution("garbage")).toEqual({ width: 1920, height: 1080 });
  expect(parseResolution("")).toEqual({ width: 1920, height: 1080 });
});

test("platform + chrome version inferred from UA", () => {
  expect(platformFromUA(UA_WIN)).toBe("windows");
  expect(platformFromUA(UA_MAC)).toBe("macos");
  expect(platformFromUA("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  expect(platformFromUA("")).toBeNull();
  expect(platformFromUA("Mozilla/5.0 (Linux; Android 14; Mobile)")).toBeNull();
  expect(chromeMajorFromUA(UA_WIN)).toBe("143");
  expect(chromeMajorFromUA("no chrome here")).toBeNull();
});

test("mobile user agents are identified without classifying desktop Linux", () => {
  expect(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/146.0 Mobile Safari/537.36")).toBe(true);
  expect(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148")).toBe(true);
  expect(isMobileUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/146.0.0.0 Safari/537.36")).toBe(false);
});

test("Android conversion preserves account identity and maps the old effective persona to Windows desktop", () => {
  const original = profile({
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36",
    timezone: "America/New_York",
    screenWidth: 412,
    screenHeight: 915,
    cookies: [{ name: "auth_token", value: "secret", domain: ".x.com", path: "/" }],
    extensions: ["ext-one"],
    tags: ["warm"],
    seeded: true,
  });

  const conversion = convertMobilePersonaToDesktop(original);
  expect(conversion.platform).toBe("windows");
  expect(conversion.screenChanged).toBe(true);
  expect(conversion.profile.ua).toContain("Windows NT 10.0");
  expect(conversion.profile.ua).toContain("Chrome/146.0.0.0");
  expect(isMobileUserAgent(conversion.profile.ua)).toBe(false);
  expect(conversion.profile.screenWidth).toBeGreaterThanOrEqual(1024);
  expect(conversion.profile.screenWidth).toBeGreaterThanOrEqual(conversion.profile.screenHeight);
  for (const key of ["id", "fingerprintSeed", "proxy", "timezone", "cookies", "extensions", "tags", "seeded"] as const) {
    expect(conversion.profile[key]).toEqual(original[key]);
  }
  // The helper returns a replacement; a failed save cannot partially mutate the source.
  expect(original.screenWidth).toBe(412);
  expect(isMobileUserAgent(original.ua)).toBe(true);
});

test("iPhone conversion maps to macOS and preserves an already plausible desktop screen", () => {
  const conversion = convertMobilePersonaToDesktop(profile({
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    screenWidth: 1440,
    screenHeight: 900,
  }));
  expect(conversion.platform).toBe("macos");
  expect(conversion.screenChanged).toBe(false);
  expect(conversion.profile.ua).toContain("Macintosh");
  expect([conversion.profile.screenWidth, conversion.profile.screenHeight]).toEqual([1440, 900]);
});

test("desktop profiles cannot be accidentally converted through the mobile migration helper", () => {
  expect(() => convertMobilePersonaToDesktop(profile())).toThrow("does not have a mobile persona");
});

test("deriveFingerprintFlags is deterministic and uses stored identity", () => {
  const p = profile();
  const a = deriveFingerprintFlags(p);
  const b = deriveFingerprintFlags(p);
  expect(a).toEqual(b); // no per-call mutation
  expect(a).toContain(`--fingerprint=${p.fingerprintSeed}`);
  expect(a).toContain("--fingerprint-platform=windows");
  expect(a).toContain("--fingerprint-screen-width=1680");
  expect(a).toContain("--fingerprint-screen-height=1050");
  expect(a.some((flag) => flag.startsWith("--fingerprint-brand-version="))).toBe(false);
});

test("deriveFingerprintFlags does NOT force --user-agent (UA/UA-CH stay consistent)", () => {
  const flags = deriveFingerprintFlags(profile());
  expect(flags.some((f) => f.startsWith("--user-agent"))).toBe(false);
});

test("a generated profile with no imported UA does not force a Windows platform", () => {
  const flags = deriveFingerprintFlags(profile({ ua: "" }));
  expect(flags.some((flag) => flag.startsWith("--fingerprint-platform="))).toBe(false);
});

test("imported profiles keep their platform but use CloakBrowser's native version", () => {
  const flags = deriveFingerprintFlags(profile({ tags: ["imported"], ua: UA_MAC }));
  expect(flags).toContain("--fingerprint-platform=macos");
  expect(flags.some((flag) => flag.startsWith("--fingerprint-brand-version="))).toBe(false);
});

test("deriveFingerprintFlags passes --fingerprint-timezone only when resolved", () => {
  expect(deriveFingerprintFlags(profile({ timezone: "America/New_York" }))).toContain("--fingerprint-timezone=America/New_York");
  // No timezone resolved → omit the flag (CloakBrowser falls back to default).
  expect(deriveFingerprintFlags(profile({ timezone: "" })).some((f) => f.startsWith("--fingerprint-timezone"))).toBe(false);
});

test("proxyServerFlag url-encodes credentials and respects scheme", () => {
  expect(proxyServerFlag(profile())).toBe("--proxy-server=http://u:p%40ss%20word@1.2.3.4:8080");
  expect(proxyServerFlag(profile({ proxy: null }))).toBeNull();
  expect(proxyServerFlag(profile({ proxy: { type: "socks5", host: "h", port: "1", user: "", pass: "" } }))).toBe(
    "--proxy-server=socks5://h:1",
  );
  expect(proxyServerFlag(profile({ proxy: { type: "socks5", host: "h", port: "1", user: "u", pass: "p@ss" } }))).toBe(
    "--proxy-server=socks5://u:p%40ss@h:1",
  );
});

// --- full-fidelity identity: an explicit desktop platform ---

test("an explicit platformOs drives the platform flag", () => {
  const flags = deriveFingerprintFlags(profile({ platformOs: "macos", ua: "" }));
  expect(flags).toContain("--fingerprint-platform=macos");
});

test("platformOs wins over a UA that says otherwise", () => {
  const flags = deriveFingerprintFlags(profile({ platformOs: "macos", ua: UA_WIN }));
  expect(flags).toContain("--fingerprint-platform=macos");
  expect(flags).not.toContain("--fingerprint-platform=windows");
});

test("without platformOs the UA still decides, as before", () => {
  const flags = deriveFingerprintFlags(profile({ ua: UA_WIN }));
  expect(flags).toContain("--fingerprint-platform=windows");
});

test("with neither, no platform flag is emitted", () => {
  const flags = deriveFingerprintFlags(profile({ ua: "" }));
  expect(flags.some((f) => f.startsWith("--fingerprint-platform="))).toBe(false);
});

test("hostPlatformOs reports one of the three CloakBrowser understands", () => {
  expect(["windows", "macos", "linux"]).toContain(hostPlatformOs());
});

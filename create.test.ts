import { test, expect } from "bun:test";
import { buildNewProfile, generateId } from "./create.ts";
import { deterministicSeed, deriveFingerprintFlags, hostPlatformOs, platformFromUA } from "./fingerprint.ts";
import { ProfileStore } from "./store.ts";

test("buildNewProfile makes a unique id with a seed-derived fingerprint and no forced UA", () => {
  const p = buildNewProfile({ name: "sophia", group: "va1" }, () => false);
  expect(p.id).toMatch(/^[a-z0-9]{8}$/);
  expect(p.name).toBe("sophia");
  expect(p.group).toBe("va1");
  expect(p.fingerprintSeed).toBe(deterministicSeed(p.id)); // unique fingerprint from the id
  expect(p.engine).toBe("chromium");
  expect(p.firefox).toBeUndefined();
  expect(p.ua).toBe(""); // UA comes from the seed at launch, never forced
  expect(p.cookies).toEqual([]);
  expect(p.seeded).toBe(false);
  expect(p.screenWidth).toBeGreaterThan(0);
});

test("new Chromium profiles keep their initial timezone across launches", () => {
  const profile = buildNewProfile({}, () => false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(profile.timezone).toBe(timezone);
  const flags = deriveFingerprintFlags(profile);
  expect(flags).toContain(`--fingerprint-timezone=${timezone}`);
  expect(deriveFingerprintFlags(structuredClone(profile))).toEqual(flags);
  expect(flags.some((flag) => flag.startsWith("--user-agent="))).toBe(false);
});

test("buildNewProfile generates and fixes a selected Windows identity for Firefox", () => {
  const p = buildNewProfile({ engine: "firefox", platformOs: "windows", screen: "1440x900" }, () => false);

  expect(p.engine).toBe("firefox");
  expect(p.firefox!.version).toBe(1);
  expect(p.firefox!.runtimeVersion).toBe("152.0.4-beta.30");
  expect(p.firefox!.config["navigator.platform"]).toBe("Win32");
  expect(p.firefox!.config["navigator.userAgent"]).toContain("Firefox/152.0");
  expect(p.firefox!.config["window.outerWidth"]).toBe(1440);
  expect(p.firefox!.config["window.outerHeight"]).toBe(900);
  const configScreenWidth = p.firefox!.config["screen.width"];
  const configScreenHeight = p.firefox!.config["screen.height"];
  const configTimezone = p.firefox!.config.timezone;
  expect(configScreenWidth).toBeNumber();
  expect(configScreenHeight).toBeNumber();
  expect([p.screenWidth, p.screenHeight]).toEqual([
    configScreenWidth as number,
    configScreenHeight as number,
  ]);
  expect(p.timezone).toBe(configTimezone as string);
  expect(p.timezone).toBeString();
  expect(p.timezone).not.toBe("");
  expect(p.ua).toContain("Firefox/152.0");
  expect(p.platformOs).toBe("windows");
});

test("buildNewProfile rejects an unknown browser engine", () => {
  expect(() => buildNewProfile({ engine: "webkit" as any }, () => false)).toThrow("unsupported profile engine");
});


test("buildNewProfile stores account credentials for the Edit view", () => {
  const p = buildNewProfile({
    platform: "x.com",
    username: " alice ",
    password: "x-password",
    email: " alice@example.com ",
    emailPassword: "mail-password",
    twofa: " M4YHM7YCL73FLIEV ",
  }, () => false);

  expect(p.platform).toBe("x.com");
  expect(p.username).toBe("alice");
  expect(p.password).toBe("x-password");
  expect(p.email).toBe("alice@example.com");
  expect(p.emailPassword).toBe("mail-password");
  expect(p.twofa).toBe("M4YHM7YCL73FLIEV");
});

test("buildNewProfile parses an http/socks5 proxy and defaults type to http", () => {
  const a = buildNewProfile({ proxy: { type: "socks5", host: "1.2.3.4", port: "1080", user: "u", pass: "p:x" } }, () => false);
  expect(a.proxy).toEqual({ type: "socks5", host: "1.2.3.4", port: "1080", user: "u", pass: "p:x" });

  const b = buildNewProfile({ proxy: { host: "5.6.7.8", port: "8080" } }, () => false);
  expect(b.proxy!.type).toBe("http");

  const uppercase = buildNewProfile({ proxy: { type: "SOCKS5", host: "proxy.example", port: "1080" } }, () => false);
  expect(uppercase.proxy!.type).toBe("socks5");

  const none = buildNewProfile({ proxy: { host: "", port: "" } }, () => false);
  expect(none.proxy).toBeNull();
});

test("buildNewProfile honors an explicit screen, else picks a realistic one", () => {
  const explicit = buildNewProfile({ screen: "1366x768" }, () => false);
  expect([explicit.screenWidth, explicit.screenHeight]).toEqual([1366, 768]);

  const auto = buildNewProfile({}, () => false);
  expect(auto.screenWidth).toBeGreaterThanOrEqual(1000);
  expect(auto.screenHeight).toBeGreaterThanOrEqual(700);
});

test("buildNewProfile rejects a malformed or impossible explicit screen", () => {
  for (const screen of ["nope", "0x0", "319x1080", "1920x199", "99999x1080"]) {
    expect(() => buildNewProfile({ screen }, () => false)).toThrow("invalid resolution");
  }
});

test("buildNewProfile rejects an invalid port or unsupported proxy type", () => {
  expect(() => buildNewProfile({ proxy: { host: "1.2.3.4", port: "abc" } }, () => false)).toThrow(/invalid proxy port/);
  expect(() => buildNewProfile({ proxy: { host: "1.2.3.4", port: "99999" } }, () => false)).toThrow(/invalid proxy port/);
  expect(() => buildNewProfile({ proxy: { type: "ftp", host: "1.2.3.4", port: "8080" } }, () => false)).toThrow(/unsupported proxy type/);
});

test("buildNewProfile accepts an uppercase X in the screen", () => {
  const p = buildNewProfile({ screen: "1920X1080" }, () => false);
  expect([p.screenWidth, p.screenHeight]).toEqual([1920, 1080]);
});

test("blank name falls back to the generated id", () => {
  const p = buildNewProfile({ name: "  " }, () => false);
  expect(p.name).toBe(p.id);
});

test("generateId retries past collisions and never returns an existing id", () => {
  const taken = new Set<string>();
  let calls = 0;
  const exists = (id: string) => {
    calls++;
    if (calls <= 3) { taken.add(id); return true; } // first 3 collide
    return taken.has(id);
  };
  const id = generateId(exists);
  expect(taken.has(id)).toBe(false);
});

test("a new profile records the host platform explicitly", () => {
  // A blank UA used to mean no --fingerprint-platform flag at all, which let
  // the browser inherit whatever host it ran on. Pin it at creation instead.
  const p = buildNewProfile({ name: "n", group: "g" }, () => false);
  expect(["windows", "macos", "linux"]).toContain(p.platformOs!);
});

test("buildNewProfile honors an explicit platformOs choice end-to-end", () => {
  // Simulates exactly what the UI sends when the operator picks macOS.
  const p = buildNewProfile({ name: "n", group: "g", platformOs: "macos" }, () => false);
  expect(p.platformOs).toBe("macos");
  // ...and the launch flags CloakBrowser actually receives must carry it.
  const flags = deriveFingerprintFlags(p);
  expect(flags).toContain("--fingerprint-platform=macos");
});

test("buildNewProfile rejects an invalid platformOs instead of storing it", () => {
  const p = buildNewProfile({ name: "n", group: "g", platformOs: "amiga" }, () => false);
  // Falls back to the host OS — never persists garbage that would break the flag.
  expect(["windows", "macos", "linux"]).toContain(p.platformOs!);
  expect(p.platformOs).not.toBe("amiga");
});

test.each(["chromium", "firefox"] as const)("new %s profiles default to the host OS family", (engine) => {
  const profile = buildNewProfile({ engine }, () => false);
  expect(profile.platformOs).toBe(hostPlatformOs());
  if (engine === "firefox") expect(platformFromUA(profile.ua)).toBe(hostPlatformOs());
  else expect(deriveFingerprintFlags(profile)).toContain(`--fingerprint-platform=${hostPlatformOs()}`);
});

test.each(["chromium", "firefox"] as const)("new %s profiles preserve every explicit OS choice", (engine) => {
  const store = new ProfileStore(":memory:");
  try {
    for (const platformOs of ["windows", "macos", "linux"] as const) {
      const profile = buildNewProfile({ engine, platformOs }, () => false);
      expect(profile.platformOs).toBe(platformOs);
      if (engine === "firefox") {
        const config = profile.firefox!.config;
        expect(config["navigator.userAgent"]).toBe(profile.ua);
        expect(platformFromUA(profile.ua)).toBe(platformOs);
        expect(config["navigator.platform"]).toBe({ windows: "Win32", macos: "MacIntel", linux: "Linux x86_64" }[platformOs]);
      } else {
        expect(deriveFingerprintFlags(profile)).toContain(`--fingerprint-platform=${platformOs}`);
        expect(profile.ua).toBe("");
      }
      store.upsertProfile(profile);
      const saved = store.getProfile(profile.id)!;
      expect(saved.platformOs).toBe(platformOs);
      expect(saved.locale).toBe(profile.locale);
      expect(saved.firefox).toEqual(profile.firefox);
      expect(saved.fingerprintSeed).toBe(profile.fingerprintSeed);
    }
  } finally {
    store.close();
  }
});

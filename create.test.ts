import { test, expect } from "bun:test";
import { buildNewProfile, defaultProfileEngine, defaultScreen, generateId, hostScreenFloor } from "./create.ts";
import { graphicsIdentity } from "./firefox-config.ts";
import { deterministicSeed, deriveFingerprintFlags, hostPlatformOs, platformFromUA } from "./fingerprint.ts";
import { ProfileStore } from "./store.ts";

test("buildNewProfile makes a unique id with a seed-derived fingerprint and no forced UA", () => {
  const p = buildNewProfile({ engine: "chromium", name: "sophia", group: "va1" }, () => false);
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
  const profile = buildNewProfile({ engine: "chromium" }, () => false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(profile.timezone).toBe(timezone);
  const flags = deriveFingerprintFlags(profile);
  expect(flags).toContain(`--fingerprint-timezone=${timezone}`);
  expect(deriveFingerprintFlags(structuredClone(profile))).toEqual(flags);
  expect(flags.some((flag) => flag.startsWith("--user-agent="))).toBe(false);
});

test("a new Firefox profile stores its own graphics card, matched to its system and not to the host", () => {
  const windows = buildNewProfile({ engine: "firefox", platformOs: "windows" }, () => false);
  const mac = buildNewProfile({ engine: "firefox", platformOs: "macos" }, () => false);

  // Windows reports its cards through ANGLE and Direct3D; a Mac never does.
  expect(String(windows.firefox!.config["webGl:vendor"])).toStartWith("Google Inc.");
  expect(String(windows.firefox!.config["webGl:renderer"])).toContain("Direct3D11");
  expect(String(mac.firefox!.config["webGl:renderer"])).not.toContain("Direct3D");
  // The stored identity has the limits that belong to the card, not only its name.
  for (const key of ["webGl:parameters", "webGl2:parameters", "webGl:supportedExtensions", "webGl:shaderPrecisionFormats"]) {
    expect(windows.firefox!.config[key]).toBeDefined();
  }
  expect(windows.firefox!.config).not.toHaveProperty("webGl2Enabled");
  expect(String(windows.firefox!.config["webGl:renderer"])).not.toMatch(/SwiftShader|Basic Render/);
  // The choice comes from the profile seed, so it is stable for that profile.
  expect(graphicsIdentity("windows", windows.fingerprintSeed)["webGl:renderer"]).toBe(windows.firefox!.config["webGl:renderer"]);
  expect(buildNewProfile({ engine: "chromium" }, () => false).firefox).toBeUndefined();
});

test("buildNewProfile generates and fixes a selected Windows identity for Firefox", () => {
  const p = buildNewProfile({ engine: "firefox", platformOs: "windows", screen: "1440x900" }, () => false);

  expect(p.engine).toBe("firefox");
  expect(p.firefox!.version).toBe(1);
  expect(p.firefox!.runtimeVersion).toBe("156.0.1-beta.36");
  expect(p.firefox!.config["navigator.platform"]).toBe("Win32");
  expect(p.firefox!.config["navigator.userAgent"]).toContain("Firefox/156.0");
  const config = p.firefox!.config as Record<string, number>;
  expect([config["screen.width"], config["screen.height"]]).toEqual([1440, 900]);
  expect([p.screenWidth, p.screenHeight]).toEqual([1440, 900]);
  expect(config["window.outerWidth"]).toBeLessThanOrEqual(Math.min(1024, config["screen.availWidth"]!));
  expect(config["window.outerHeight"]).toBeLessThanOrEqual(Math.min(810, config["screen.availHeight"]!));
  const configTimezone = p.firefox!.config.timezone;
  expect(p.timezone).toBe(configTimezone as string);
  expect(p.timezone).toBeString();
  expect(p.timezone).not.toBe("");
  expect(p.ua).toContain("Firefox/156.0");
  expect(p.platformOs).toBe("windows");
});

test("buildNewProfile rejects an unknown browser engine", () => {
  expect(() => buildNewProfile({ engine: "webkit" as any }, () => false)).toThrow("unsupported profile engine");
});

test("new profiles default to AliasMode Chromium on Windows and AliasMode Firefox on macOS and Linux", () => {
  expect(defaultProfileEngine("win32")).toBe("chromium");
  expect(defaultProfileEngine("darwin")).toBe("firefox");
  expect(defaultProfileEngine("linux")).toBe("firefox");
  expect(buildNewProfile({}, () => false).engine).toBe(defaultProfileEngine());

  // A named runtime implies Chromium. An explicit CloakBrowser request makes a CloakBrowser profile on any computer.
  expect(buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false)).toMatchObject({ engine: "chromium", chromiumRuntime: "aliasmode" });
  const cloak = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  expect(cloak.engine).toBe("chromium");
  expect(cloak.chromiumRuntime).toBeUndefined();
  expect(cloak.hardware).toBeDefined();
  expect(() => buildNewProfile({ engine: "firefox", chromiumRuntime: "cloakbrowser" }, () => false))
    .toThrow("only Chromium profiles can choose a Chromium runtime");
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

test("a new profile's screen is never smaller than this computer's display", () => {
  const env = { ALIASMODE_HOST_SCREEN: "1920x1080", ALIASMODE_HOST_SCALE: "1.25" };
  // Pages measure the display in CSS pixels; Chromium 155 on Windows also divides the stored screen by the scale.
  expect(hostScreenFloor("chromium", "aliasmode", env, "win32")).toEqual({ width: 1920, height: 1080 });
  expect(hostScreenFloor("chromium", "aliasmode", env, "darwin")).toEqual({ width: 1536, height: 864 });
  expect(hostScreenFloor("chromium", undefined, env, "win32")).toEqual({ width: 1536, height: 864 });
  expect(hostScreenFloor("firefox", undefined, env, "win32")).toEqual({ width: 1536, height: 864 });
  expect(hostScreenFloor("firefox", undefined, {}, "win32")).toBeNull();

  expect([0, 0.99].map((r) => defaultScreen({ width: 1920, height: 1080 }, () => r)))
    .toEqual([{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]);
  // No listed resolution is as large as a 4K display at 100%, so the display itself is the screen.
  expect(defaultScreen({ width: 3840, height: 2160 })).toEqual({ width: 3840, height: 2160 });
  // Without a known display any listed resolution can be picked.
  expect(defaultScreen(null, () => 0.5)).toEqual({ width: 1440, height: 900 });

  const saved = { screen: process.env.ALIASMODE_HOST_SCREEN, scale: process.env.ALIASMODE_HOST_SCALE };
  Object.assign(process.env, env);
  try {
    for (let i = 0; i < 20; i++) {
      const profile = buildNewProfile({}, () => false);
      expect(profile.screenWidth >= 1536 && profile.screenHeight >= 864).toBe(true);
    }
    expect(buildNewProfile({ screen: "1366x768" }, () => false).screenWidth).toBe(1366);
  } finally {
    for (const [key, value] of [["ALIASMODE_HOST_SCREEN", saved.screen], ["ALIASMODE_HOST_SCALE", saved.scale]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a new Firefox profile's screen is this computer's display as Firefox pages measure it", () => {
  const saved = { screen: process.env.ALIASMODE_HOST_SCREEN, scale: process.env.ALIASMODE_HOST_SCALE };
  try {
    for (const [screen, scale, expected] of [
      ["1366x768", "1", [1366, 768]], ["1920x1080", "1.25", [1536, 864]], ["2880x1800", "2", [1440, 900]],
    ] as const) {
      Object.assign(process.env, { ALIASMODE_HOST_SCREEN: screen, ALIASMODE_HOST_SCALE: scale });
      const profile = buildNewProfile({ engine: "firefox" }, () => false);
      expect([profile.screenWidth, profile.screenHeight]).toEqual([...expected]);
      expect([profile.firefox!.config["screen.width"], profile.firefox!.config["screen.height"]]).toEqual([...expected]);
      // Its window fits the display's usable area.
      expect(profile.firefox!.config["window.outerHeight"]).toBeLessThanOrEqual(profile.firefox!.config["screen.availHeight"] as number);
      // An explicit screen is kept.
      expect(buildNewProfile({ engine: "firefox", screen: "2560x1440" }, () => false).screenWidth).toBe(2560);
    }
    // Without a known display a listed resolution is picked.
    delete process.env.ALIASMODE_HOST_SCREEN;
    const unknown = buildNewProfile({ engine: "firefox" }, () => false);
    expect([[1920, 1080], [1536, 864], [1366, 768], [1440, 900], [1600, 900], [2560, 1440]])
      .toContainEqual([unknown.screenWidth, unknown.screenHeight]);
  } finally {
    for (const [key, value] of [["ALIASMODE_HOST_SCREEN", saved.screen], ["ALIASMODE_HOST_SCALE", saved.scale]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

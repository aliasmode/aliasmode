import { expect, test } from "bun:test";
import { createFirefoxProfileConfig, firefoxLaunchConfig, fitFirefoxWindow } from "./firefox-config.ts";
import type { JsonValue, Profile } from "./types.ts";

const SEED_KEYS = ["canvas:seed", "audio:seed", "fonts:spacing_seed"];

function profile(fingerprintSeed: number, config: Record<string, JsonValue> = {}, runtimeVersion = "152.0.4-beta.30"): Profile {
  return {
    id: `firefox-${fingerprintSeed}`, accId: "", name: "", group: "", username: "", password: "", twofa: "",
    proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed,
    cookies: [], seeded: false, engine: "firefox",
    firefox: { version: 1, runtimeVersion, config: { "navigator.platform": "Win32", ...config } },
  };
}

test("each Firefox launch gets canvas, audio and font seeds from its profile seed, never stored", () => {
  const one = profile(3983315515);
  const saved = structuredClone(one.firefox);
  const first = firefoxLaunchConfig(one);
  const seeds = SEED_KEYS.map((key) => first[key] as number);
  for (const seed of seeds) {
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(1);
    expect(seed).toBeLessThanOrEqual(0xffff_ffff);
  }
  expect(new Set(seeds).size).toBe(3);
  expect(firefoxLaunchConfig(structuredClone(one))).toEqual(first);
  expect(one.firefox).toEqual(saved);
  const other = firefoxLaunchConfig(profile(2354318635));
  for (const key of SEED_KEYS) expect(other[key]).not.toBe(first[key]);
});

test("Firefox launch seeds keep a stored seed and are left out for other engine versions", () => {
  expect(firefoxLaunchConfig(profile(7, { "canvas:seed": 42 }))["canvas:seed"]).toBe(42);
  const later = firefoxLaunchConfig(profile(7, {}, "156.0-beta.1"));
  for (const key of SEED_KEYS) expect(later).not.toHaveProperty(key);
});

test("an existing Firefox window never exceeds its available screen", () => {
  // Stored before the fix: a full-screen window taller than the taskbar-free area, placed above the screen.
  const tall = firefoxLaunchConfig(profile(1, {
    "screen.availLeft": 1920, "window.screenX": 1912, "window.screenY": -46,
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1032,
    "window.outerWidth": 1920, "window.outerHeight": 1080,
  }));
  expect(tall).toMatchObject({
    "screen.width": 1920, "screen.height": 1080, "screen.availHeight": 1032,
    "window.outerWidth": 1920, "window.outerHeight": 1032, "window.screenX": 0, "window.screenY": 0,
  });
  // A wide screen keeps its stored size; only the window's position comes back inside it.
  const wide = firefoxLaunchConfig(profile(2, {
    "window.screenX": 3307, "window.screenY": 180,
    "screen.width": 5120, "screen.height": 1440, "screen.availWidth": 5120, "screen.availHeight": 1400,
    "window.outerWidth": 1920, "window.outerHeight": 1080,
  }));
  expect(wide).toMatchObject({
    "screen.width": 5120, "screen.height": 1440,
    "window.outerWidth": 1920, "window.outerHeight": 1080, "window.screenX": 3200, "window.screenY": 180,
  });
});

test("fitting a Firefox window keeps the browser frame between outer and inner sizes", () => {
  const config: Record<string, JsonValue> = {
    "screen.width": 1366, "screen.height": 768, "screen.availWidth": 1400, "screen.availHeight": 728,
    "window.outerWidth": 1400, "window.outerHeight": 800, "window.innerWidth": 1380, "window.innerHeight": 700,
  };
  fitFirefoxWindow(config);
  expect(config).toMatchObject({
    "screen.availWidth": 1366, "window.outerWidth": 1366, "window.innerWidth": 1346,
    "window.outerHeight": 728, "window.innerHeight": 628,
  });
});

test.each([
  ["windows", 1920, 1080], ["windows", 1536, 864], ["windows", 2560, 1440], ["macos", 1440, 900], ["linux", 1366, 768],
] as const)("a new %s Firefox profile uses the chosen %ix%i screen and a window inside it", (os, width, height) => {
  const config = createFirefoxProfileConfig(width, height, os, 99).config as Record<string, number>;
  expect([config["screen.width"], config["screen.height"]]).toEqual([width, height]);
  expect(config["screen.availWidth"]).toBeLessThanOrEqual(width);
  expect(config["screen.availHeight"]).toBeLessThanOrEqual(height);
  expect(config["window.outerWidth"]).toBeLessThanOrEqual(config["screen.availWidth"]!);
  expect(config["window.outerHeight"]).toBeLessThanOrEqual(config["screen.availHeight"]!);
  expect(config["window.screenX"]).toBeGreaterThanOrEqual(0);
  expect(config["window.screenY"]).toBeGreaterThanOrEqual(0);
  expect(config["window.screenX"]! + config["window.outerWidth"]!).toBeLessThanOrEqual(width);
  expect(config["window.screenY"]! + config["window.outerHeight"]!).toBeLessThanOrEqual(height);
});

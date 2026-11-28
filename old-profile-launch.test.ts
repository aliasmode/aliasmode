/**
 * Profiles made before a change keep their stored identity, so a new engine or app version must
 * launch them with the same arguments. The snapshot was recorded with the app before the GPU-family
 * rule (origin/main 3a5a843). Only a Firefox runtime pin may change it (its version numbers).
 */
import { expect, test } from "bun:test";
import { firefoxLaunchConfig } from "./firefox-config.ts";
import { Launcher } from "./launcher.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

const SEEDS = [1, 42, 77777, 123456789, 2147483647, 3000000001, 4294967295];

function stored(index: number, seed: number, overrides: Partial<Profile>): Profile {
  return {
    id: `old${index}x${seed % 1000}`,
    accId: "",
    name: `Old ${index}`,
    group: "",
    platform: "x.com",
    username: "",
    password: "",
    twofa: "",
    proxy: index % 2 ? { type: "http", host: "198.51.100.7", port: "8080", user: "u", pass: "p" } : null,
    ua: "",
    timezone: "America/New_York",
    locale: "en-US",
    screenWidth: [1920, 1536, 2560][index % 3]!,
    screenHeight: [1080, 864, 1440][index % 3]!,
    fingerprintSeed: seed,
    platformOs: ["windows", "macos", "linux"][index % 3]!,
    cookies: [],
    seeded: false,
    ...overrides,
  };
}

const PROFILES: Profile[] = SEEDS.flatMap((seed, index) => [
  stored(index, seed, { id: `a${index}x${seed % 1000}`, engine: "chromium", chromiumRuntime: "aliasmode", ...(index === 3 ? { hardware: { cores: 2 } } : {}) }),
  stored(index, seed, { id: `c${index}x${seed % 1000}`, engine: "chromium", hardware: { cores: [8, 12, 16][index % 3]! } }),
]);

const HOSTS = [["win32", "x64"], ["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"]] as const;

test("old profiles launch with byte-identical arguments", () => {
  const result: Record<string, string[]> = {};
  for (const [hostPlatform, hostArch] of HOSTS) {
    const store = new ProfileStore(":memory:");
    for (const profile of PROFILES) store.upsertProfile(profile);
    const launcher = new Launcher({ store, binaryPath: "", hostPlatform, hostArch, spawn: (() => { throw new Error("no spawn"); }) as never });
    for (const { id } of PROFILES) {
      const profile = store.getProfile(id)!;
      // macOS profiles do not open on Windows; every other pair can.
      if (hostPlatform === "win32" && profile.platformOs === "macos" && profile.chromiumRuntime) continue;
      result[`${hostPlatform}-${hostArch} ${id}`] = launcher.buildArgs(profile, 9333, "/data/profile", [], undefined, false, false, "203.0.113.9");
    }
    store.close();
  }
  expect(result).toMatchSnapshot();
});

test("old profiles keep their Cloud payload", () => {
  const store = new ProfileStore(":memory:");
  const payloads = PROFILES.map((profile) => {
    store.upsertProfile(profile);
    const { schemaVersion, profile: encoded } = encodePortableProfile(store.getProfile(profile.id)!);
    return { schemaVersion, profile: encoded };
  });
  store.close();
  expect(payloads).toMatchSnapshot();
});

test("old Firefox profiles launch with an identical config", () => {
  const configs = SEEDS.map((seed, index) => {
    const os = ["windows", "macos", "linux"][index % 3]!;
    const profile = stored(index, seed, {
      engine: "firefox",
      firefox: {
        version: 1,
        runtimeVersion: "156.0.1-beta.36",
        config: {
          "navigator.userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0",
          "navigator.platform": { windows: "Win32", macos: "MacIntel", linux: "Linux x86_64" }[os]!,
          "navigator.hardwareConcurrency": 8,
          "screen.width": 1920,
          "screen.height": 1080,
          "webGl:vendor": "Google Inc. (NVIDIA)",
          "webGl:renderer": "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar",
          timezone: "America/New_York",
        },
      },
    });
    return firefoxLaunchConfig(profile, `Old ${index}`, undefined, "203.0.113.9", undefined, undefined, 16);
  });
  expect(configs).toMatchSnapshot();
});

/**
 * Build a brand-new profile from scratch (the "New Profile" flow).
 *
 * Unlike AdsPower's multi-tab fingerprint form, the operator does NOT configure
 * the fingerprint by hand: a fresh unique id yields a unique deterministic seed,
 * and CloakBrowser derives a coherent, unique fingerprint + UA from that seed at
 * launch (forcing a separate UA would risk UA/UA-CH desync). The operator only
 * supplies name / folder / proxy / (optional) screen; timezone is resolved from
 * the proxy's geoip by the caller.
 */

import type { Profile, ProxySpec } from "./types.ts";
import { deterministicSeed } from "./fingerprint.ts";
import { normalizeProxySpec } from "./proxy.ts";
import { parseStrictCustomNo, parseStrictResolution } from "./parse.ts";

export interface NewProfileInput {
  name?: string;
  group?: string;
  /** Account platform: "x.com", "telegram.org", or "" (none). */
  platform?: string;
  username?: string;
  password?: string;
  email?: string;
  emailPassword?: string;
  twofa?: string;
  proxy?: { type?: string; host?: string; port?: string; user?: string; pass?: string } | null;
  /** "1920x1080" / "1920*1080"; empty → a random realistic resolution. */
  screen?: string;
  /** Operator-chosen serial shown in the roster and the browser window title. */
  customNo?: string;
}

// Realistic desktop resolutions, so each created profile gets a varied screen.
const SCREENS: Array<[number, number]> = [
  [1920, 1080],
  [1536, 864],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [2560, 1440],
];

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join(""); // 8 base36 chars, AdsPower-ish
}

/** A unique profile id, collision-checked against `exists`. */
export function generateId(exists: (id: string) => boolean): string {
  for (let i = 0; i < 100; i++) {
    const id = randomId();
    if (!exists(id)) return id;
  }
  throw new Error("could not generate a unique profile id");
}

export function buildNewProfile(input: NewProfileInput, exists: (id: string) => boolean): Profile {
  const id = generateId(exists);

  const proxy: ProxySpec | null = normalizeProxySpec(input.proxy);

  const screen = (input.screen || "").trim();
  const selected = screen
    ? parseStrictResolution(screen)
    : (() => {
      const [width, height] = SCREENS[Math.floor(Math.random() * SCREENS.length)]!;
      return { width, height };
    })();

  return {
    id,
    accId: "",
    name: (input.name || "").trim() || id, // AdsPower auto-names blank profiles after the id
    group: (input.group || "").trim(),
    platform: (input.platform || "").trim(),
    username: (input.username || "").trim(),
    password: input.password || "",
    email: (input.email || "").trim(),
    emailPassword: input.emailPassword || "",
    twofa: (input.twofa || "").trim(),
    proxy,
    customNo: parseStrictCustomNo(input.customNo),
    ua: "", // CloakBrowser derives a coherent UA from the seed at launch
    timezone: "", // resolved from the proxy's geoip by the caller
    screenWidth: selected.width,
    screenHeight: selected.height,
    fingerprintSeed: deterministicSeed(id),
    cookies: [],
    seeded: false,
  };
}

/**
 * Build a brand-new profile from scratch (the "New Profile" flow).
 *
 * Unlike AdsPower's multi-tab fingerprint form, the operator does NOT configure
 * the fingerprint by hand: a fresh unique id yields a unique deterministic seed,
 * and CloakBrowser derives a coherent, unique fingerprint + UA from that seed at
 * launch (forcing a separate UA would risk UA/UA-CH desync). The operator only
 * supplies name / folder / proxy / (optional) screen; the initial host timezone
 * is saved without a network lookup. Chromium receives a deterministic launch seed;
 * Firefox receives a complete persisted Camoufox config.
 */

import type { Profile, ProfileEngine, ProxySpec } from "./types.ts";
import { completeProfileFingerprint, createFirefoxProfileConfig, normalizeChromiumRuntime, syncFirefoxTimezone } from "./firefox-config.ts";
import { chromiumDeviceScale, defaultChromiumRuntime, hostDisplayScale, hostDisplaySize } from "./aliasmode-chromium.ts";
import { deterministicSeed, generateProfileHardware, hostPlatformOs } from "./fingerprint.ts";
import { normalizeProxySpec } from "./proxy.ts";
import { parseStrictCustomNo, parseStrictResolution, parsePlatformOs } from "./parse.ts";

export interface NewProfileInput {
  /** Browser identity engine. Omitted means this computer's default engine. */
  engine?: ProfileEngine;
  /** "aliasmode" (Chromium 155) or "cloakbrowser". Omitted means Chromium 155 where this computer can run it. */
  chromiumRuntime?: string;
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
  /**
   * "1920x1080" / "1920*1080"; empty → this computer's display for Firefox, else a random realistic
   * resolution no smaller than that display.
   */
  screen?: string;
  /** Fingerprint OS override: "windows" | "macos" | "linux". Empty/omitted → host OS. */
  platformOs?: string;
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

/**
 * This computer's display as a new profile's pages would measure it, or null when unknown.
 * Chromium 155 on Windows reports the stored screen divided by the display scale, as Chrome
 * does there; every other engine reports the stored screen.
 */
export function hostScreenFloor(
  engine: ProfileEngine,
  chromiumRuntime: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { width: number; height: number } | null {
  const display = hostDisplaySize(env);
  if (!display) return null;
  const hostScale = hostDisplayScale(env);
  const scale = hostScale / (engine === "chromium" ? chromiumDeviceScale(platform, chromiumRuntime, hostScale) : 1);
  return { width: Math.round(display.width / scale), height: Math.round(display.height / scale) };
}

/**
 * A random realistic resolution not smaller than `floor`, or `floor` itself when none is.
 * On a smaller screen a maximized window would have to shrink to fit it.
 */
export function defaultScreen(floor: { width: number; height: number } | null, random = Math.random): { width: number; height: number } {
  const fits = SCREENS.filter(([width, height]) => !floor || (width >= floor.width && height >= floor.height));
  if (!fits.length) return floor!;
  const [width, height] = fits[Math.floor(random() * fits.length)]!;
  return { width, height };
}

/**
 * The engine of a new profile that names none: AliasMode Chromium on Windows and AliasMode
 * Firefox on macOS and Linux. CloakBrowser profiles on one computer can be linked to each other.
 */
export function defaultProfileEngine(platform: NodeJS.Platform = process.platform): ProfileEngine {
  return platform === "darwin" || platform === "linux" ? "firefox" : "chromium";
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

  // A named Chromium runtime implies Chromium. A CloakBrowser profile stores no runtime.
  const engine = input.engine ?? (input.chromiumRuntime ? "chromium" : defaultProfileEngine());
  if (engine !== "chromium" && engine !== "firefox") throw new Error("unsupported profile engine");
  const chromiumRuntime = input.chromiumRuntime
    ? normalizeChromiumRuntime(input.chromiumRuntime, engine)
    : engine === "chromium" ? defaultChromiumRuntime() : undefined;
  const screen = (input.screen || "").trim();
  // A real Firefox reports the display it runs on, and its window then fits that display.
  const display = hostScreenFloor(engine, chromiumRuntime);
  const selected = screen ? parseStrictResolution(screen) : engine === "firefox" && display ? display : defaultScreen(display);
  const platformOs = parsePlatformOs(input.platformOs) ?? hostPlatformOs();
  const firefox = engine === "firefox"
    ? createFirefoxProfileConfig(selected.width, selected.height, platformOs, deterministicSeed(id))
    : undefined;
  const firefoxUa = firefox?.config["navigator.userAgent"];
  const firefoxScreenWidth = firefox?.config["screen.width"];
  const firefoxScreenHeight = firefox?.config["screen.height"];
  const firefoxTimezone = firefox?.config.timezone;

  return completeProfileFingerprint({
    id,
    engine,
    ...(chromiumRuntime ? { chromiumRuntime } : {}),
    ...(engine === "chromium" && !chromiumRuntime ? { hardware: generateProfileHardware(deterministicSeed(id)) } : {}),
    ...(firefox ? { firefox } : {}),
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
    ua: typeof firefoxUa === "string" ? firefoxUa : "", // Firefox's UA is generated with its persisted Camoufox config
    // ...but the platform must be pinned, or a blank UA means no
    // --fingerprint-platform flag and the browser inherits whatever host it
    // happens to run on — a silent identity change on a move between boxes.
    // An explicit operator choice wins; otherwise fall back to the host OS.
    platformOs,
    timezone: typeof firefoxTimezone === "string" ? firefoxTimezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    screenWidth: typeof firefoxScreenWidth === "number" ? firefoxScreenWidth : selected.width,
    screenHeight: typeof firefoxScreenHeight === "number" ? firefoxScreenHeight : selected.height,
    fingerprintSeed: deterministicSeed(id),
    cookies: [],
    seeded: false,
  });
}

/**
 * A new imported profile that names no browser, as AdsPower and other tools export it, gets the
 * browser of every other new profile on this computer. It keeps its screen, system, seed and
 * timezone. Chrome extensions need Chromium.
 */
export function withDefaultBrowser(profile: Profile): Profile {
  const engine = profile.engine ?? (profile.extensions?.length ? "chromium" : defaultProfileEngine());
  if (engine === "chromium") {
    const chromiumRuntime = defaultChromiumRuntime();
    return { ...profile, engine, ...(chromiumRuntime ? { chromiumRuntime } : {}) };
  }
  const platformOs = parsePlatformOs(profile.platformOs) ?? hostPlatformOs();
  const firefox = createFirefoxProfileConfig(profile.screenWidth, profile.screenHeight, platformOs, profile.fingerprintSeed);
  const { "navigator.userAgent": ua, "screen.width": width, "screen.height": height, timezone } = firefox.config;
  const imported: Profile = {
    ...profile,
    engine,
    firefox,
    platformOs,
    ua: typeof ua === "string" ? ua : "",
    screenWidth: typeof width === "number" ? width : profile.screenWidth,
    screenHeight: typeof height === "number" ? height : profile.screenHeight,
    timezone: profile.timezone || (typeof timezone === "string" ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone),
  };
  syncFirefoxTimezone(imported);
  return completeProfileFingerprint(imported);
}

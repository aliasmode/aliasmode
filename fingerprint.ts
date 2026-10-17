/**
 * Deterministic fingerprint derivation for CloakBrowser launches.
 *
 * Every value here is a pure function of the stored profile. The same profile
 * always yields the same seed and the same launch flags — there is no
 * randomness and no per-launch mutation. This is the manager-side equivalent
 * of the AdsPower invariant "launch with the profile state that already
 * exists; do not rewrite it".
 *
 * Flag names follow the CloakBrowser CLI:
 *   --fingerprint=SEED
 *   --fingerprint-platform=windows|macos|linux
 *   --fingerprint-screen-width=N / --fingerprint-screen-height=N
 */

import type { Profile, ProfileEngine, ProfileHardware } from "./types.ts";
import { proxyUrl } from "./proxy.ts";

/** FNV-1a 32-bit hash → positive integer. Stable across runs and platforms. */
export function deterministicSeed(profileId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < profileId.length; i++) {
    h ^= profileId.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Keep it well clear of 0 so a seed is always "set".
  return h === 0 ? 1 : h;
}

/** One well-mixed fraction in [0, 1) from a profile seed (Mulberry32). */
export function seedFraction(seed: number): number {
  let mixed = (seed + 0x6d2b79f5) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

// Logical processor counts of current desktop and laptop computers; repeats set the odds.
const CORE_COUNTS = [8, 8, 8, 12, 12, 12, 16, 16, 20, 24] as const;

/** Choose the hardware that a new CloakBrowser profile reports on every computer. */
export function generateProfileHardware(seed: number): ProfileHardware {
  // The extra constant keeps this draw apart from other values drawn from the same seed.
  return { cores: CORE_COUNTS[Math.floor(seedFraction(seed ^ 0x9e3779b9) * CORE_COUNTS.length)]! };
}

/** Validate stored hardware. Only CloakBrowser profiles carry it; the other engines choose their own. */
export function normalizeProfileHardware(value: unknown, engine: ProfileEngine, chromiumRuntime: unknown): ProfileHardware | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const cores = typeof value === "object" && !Array.isArray(value) ? (value as { cores?: unknown }).cores : undefined;
  if (typeof cores !== "number" || !Number.isInteger(cores) || cores < 1 || cores > 256
    || Object.keys(value as object).length !== 1) {
    throw new Error("unsupported profile hardware");
  }
  if (engine !== "chromium" || chromiumRuntime) throw new Error("only CloakBrowser profiles carry stored hardware");
  return { cores };
}

/** Default launch window as fractions of the profile's screen: a tall two-thirds-width window. */
export const DEFAULT_WINDOW_WIDTH_SCALE = 0.65;
export const DEFAULT_WINDOW_HEIGHT_SCALE = 0.9;

/**
 * The OS window size for a screen. The floors stop a small screen (e.g. 1024 -> 666px)
 * from opening as an unusable sliver.
 */
export function launchWindowSize(
  screenWidth: number,
  screenHeight: number,
  widthScale = DEFAULT_WINDOW_WIDTH_SCALE,
  heightScale = DEFAULT_WINDOW_HEIGHT_SCALE,
): [number, number] {
  return [Math.max(800, Math.round(screenWidth * widthScale)), Math.max(480, Math.round(screenHeight * heightScale))];
}

/** Parse AdsPower "1680*1050" (or "1680x1050") → width/height; default 1920x1080. */
export function parseResolution(res: string): { width: number; height: number } {
  const m = (res ?? "").trim().match(/^(\d{3,5})\s*[*x×]\s*(\d{3,5})$/i);
  if (!m) return { width: 1920, height: 1080 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Mobile UAs cannot be represented coherently by AliasMode's desktop browser. */
export function isMobileUserAgent(ua: string): boolean {
  return /\b(?:android|iphone|ipad|ipod|windows phone|mobile)\b/i.test(ua ?? "");
}

/** Infer a recognized desktop platform; blank/mobile/unknown UAs have no imported persona. */
export function platformFromUA(ua: string): "windows" | "macos" | "linux" | null {
  const s = (ua ?? "").toLowerCase();
  if (s.includes("mac os") || s.includes("macintosh")) return "macos";
  if (s.includes("linux") && !s.includes("android")) return "linux";
  if (s.includes("windows")) return "windows";
  return null;
}

/** The platform this host would present, recorded once at profile creation. */
export function hostPlatformOs(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/** Infer only architecture tokens that a desktop UA states explicitly. */
export function architectureFromUA(ua: string): "x64" | "arm64" | null {
  const s = (ua ?? "").toLowerCase();
  if (/\b(?:arm64|aarch64)\b/.test(s)) return "arm64";
  if (/\b(?:x86_64|x64|amd64|win64|wow64)\b/.test(s)) return "x64";
  return null;
}

/** Pull the Chrome major version (e.g. "143") out of a UA, or null. */
export function chromeMajorFromUA(ua: string): string | null {
  const m = (ua ?? "").match(/Chrome\/(\d+)/);
  return m ? m[1]! : null;
}

export type DesktopPersonaPlatform = "windows" | "macos";

export interface MobilePersonaConversion {
  profile: Profile;
  platform: DesktopPersonaPlatform;
  screenChanged: boolean;
}

const DESKTOP_SCREENS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [1536, 864],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [2560, 1440],
];

function mobilePersonaDesktopPlatform(ua: string): DesktopPersonaPlatform {
  // This deliberately follows the effective pre-hardening behavior. The old
  // platform classifier mapped Apple mobile UAs to macOS and defaulted Android
  // and Windows Phone to Windows. Keeping that family minimizes account-visible
  // discontinuity while replacing the impossible mobile claim.
  return /\b(?:iphone|ipad|ipod)\b|mac os/i.test(ua) ? "macos" : "windows";
}

function sourceChromiumMajor(ua: string): string {
  // Preserve the imported major when one exists. Current AliasMode does not
  // force it at launch; this only keeps the persisted/exported desktop UA
  // meaningful and remains compatible with older managers.
  return ua.match(/\b(?:Chrome|CriOS)\/(\d+)/i)?.[1] ?? "146";
}

function desktopUserAgent(platform: DesktopPersonaPlatform, sourceUa: string): string {
  const major = sourceChromiumMajor(sourceUa);
  if (platform === "macos") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Convert an imported mobile persona into the closest coherent desktop one.
 *
 * This is intentionally a narrow, explicit migration: account credentials,
 * cookies, proxy, timezone, fingerprint seed, extensions and tags remain
 * untouched. A plausible landscape desktop screen is preserved; a phone/tablet
 * screen is replaced deterministically from the existing seed so retries are
 * idempotent and the result does not rotate between operators.
 */
export function convertMobilePersonaToDesktop(profile: Profile): MobilePersonaConversion {
  if (!isMobileUserAgent(profile.ua)) {
    throw new Error("profile does not have a mobile persona");
  }
  const platform = mobilePersonaDesktopPlatform(profile.ua);
  const plausibleDesktopScreen = profile.screenWidth >= 1024
    && profile.screenHeight >= 600
    && profile.screenWidth >= profile.screenHeight;
  const screen = plausibleDesktopScreen
    ? [profile.screenWidth, profile.screenHeight] as const
    : DESKTOP_SCREENS[profile.fingerprintSeed % DESKTOP_SCREENS.length]!;
  return {
    platform,
    screenChanged: !plausibleDesktopScreen,
    profile: {
      ...profile,
      ua: desktopUserAgent(platform, profile.ua),
      screenWidth: screen[0],
      screenHeight: screen[1],
    },
  };
}

/**
 * Build the deterministic CloakBrowser identity flags for a profile.
 *
 * Note: we deliberately do NOT force `--user-agent`. CloakBrowser regenerates
 * a UA from the fingerprint plus the native kernel version so that the UA and
 * UA Client Hints stay internally consistent; a flag-forced UA would desync
 * the two, which is itself a detection signal. We steer only the imported
 * desktop platform; an imported Chrome version must never override the real
 * kernel version because its APIs, renderer, codecs and network behavior do
 * not change with that cosmetic flag.
 */
export function deriveFingerprintFlags(profile: Profile): string[] {
  const flags = [
    `--fingerprint=${profile.fingerprintSeed}`,
    `--fingerprint-screen-width=${profile.screenWidth}`,
    `--fingerprint-screen-height=${profile.screenHeight}`,
  ];
  // An explicit stored platform beats inferring one from the UA. This matters
  // because create.ts stores a BLANK ua on purpose (CloakBrowser derives a
  // coherent one from the seed), which previously meant no platform flag at
  // all — and a browser with no platform flag silently inherits the HOST os.
  // Move that profile to a differently-OS'd box and navigator.platform, the
  // UA-CH brand list and the font set all shift with nothing to explain it.
  const platform = profile.platformOs || platformFromUA(profile.ua);
  if (platform) flags.push(`--fingerprint-platform=${platform}`);
  // An imported account observing a normal browser upgrade is coherent. A
  // forced old version beside a newer kernel is not.
  // Match the browser clock to the proxy's geolocation (resolved at import).
  if (profile.timezone) flags.push(`--fingerprint-timezone=${profile.timezone}`);
  if (profile.locale) flags.push(`--fingerprint-locale=${profile.locale}`);
  // CloakBrowser's default ~500 MB storage quota is the classic incognito
  // signal, so Google treats the profile as private. Report a real-disk size.
  // The Chromium 155 runtime derives a real-disk quota from its own profile.
  if (!profile.chromiumRuntime) flags.push(`--fingerprint-storage-quota=${100_000 + (profile.fingerprintSeed % 400_000)}`);
  // Without this flag CloakBrowser reports 8 cores for every profile.
  if (!profile.chromiumRuntime && profile.hardware) {
    flags.push(`--fingerprint-hardware-concurrency=${profile.hardware.cores}`);
  }
  // Without this flag every Chromium 155 profile on one computer draws the same canvas
  // and WebGL image, so a site can link them. The noise comes from the profile seed,
  // so each profile keeps its own image on every launch.
  if (profile.chromiumRuntime) flags.push("--fingerprint-noise");
  return flags;
}

/** Render a ProxySpec as a CloakBrowser `--proxy-server` value with inline creds. */
export function proxyServerFlag(profile: Profile): string | null {
  const p = profile.proxy;
  if (!p) return null;
  return `--proxy-server=${proxyUrl(p)}`;
}

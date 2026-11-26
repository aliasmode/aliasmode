import type { PortableProfile, PortableProfileV1, PortableProfileV2, PortableProfileV3, PortableProfileV4, PortableSessionV1 } from "./contracts/cloud-v1.ts";
import type { ChromiumRuntime, FirefoxProfileConfig, Profile, ProfileHardware } from "./types.ts";
import { normalizeChromiumRuntime, normalizeProfileEngine } from "./firefox-config.ts";
import { normalizeProfileHardware } from "./fingerprint.ts";
import { assertValidProfile, isDisplayScale } from "./profile-validation.ts";
import { normalizeBundle } from "./session.ts";

function portableSession(raw: unknown): PortableSessionV1 {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { cookies?: unknown }).cookies)) {
    throw new Error("portable session must include a cookies array");
  }
  const normalized = normalizeBundle(raw);
  return {
    cookies: normalized.cookies,
    ...(normalized.hasOrigins ? { origins: normalized.origins } : {}),
    ...(normalized.hasTabs ? { tabs: normalized.tabs } : {}),
    ...(normalized.telegramClient ? { telegramClient: normalized.telegramClient } : {}),
  };
}

export function encodePortableProfile(
  profile: Profile & { engine: "firefox"; firefox: FirefoxProfileConfig },
  sessionBundle?: string,
): PortableProfileV2;
export function encodePortableProfile(profile: Profile, sessionBundle?: string): PortableProfileV1 | PortableProfileV3 | PortableProfileV4;
export function encodePortableProfile(profile: Profile, sessionBundle?: string): PortableProfile {
  assertValidProfile(profile);
  const engine = normalizeProfileEngine(profile.engine, profile.firefox);
  let session: PortableSessionV1;
  if (sessionBundle === undefined) {
    session = portableSession({ cookies: profile.cookies });
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sessionBundle);
    } catch (error) {
      throw new Error(`invalid session bundle: ${error instanceof Error ? error.message : String(error)}`);
    }
    session = portableSession(parsed);
  }

  const portableProfile: PortableProfileV1["profile"] = {
    id: profile.id,
    accId: profile.accId,
    name: profile.name,
    group: profile.group,
    platform: profile.platform ?? "",
    username: profile.username,
    password: profile.password,
    email: profile.email ?? "",
    emailPassword: profile.emailPassword ?? "",
    twofa: profile.twofa,
    proxy: profile.proxy ? { ...profile.proxy } : null,
    ...(profile.proxyError ? { proxyError: profile.proxyError } : {}),
    extensionAssignments: [...(profile.extensions ?? [])],
    tags: [...(profile.tags ?? [])],
    ua: profile.ua,
    timezone: profile.timezone,
    ...(profile.timezoneManual ? { timezoneManual: true as const } : {}),
    ...(profile.locale ? { locale: profile.locale } : {}),
    ...(profile.localeManual ? { localeManual: true as const } : {}),
    screenWidth: profile.screenWidth,
    screenHeight: profile.screenHeight,
    fingerprintSeed: profile.fingerprintSeed,
    ...(profile.platformOs ? { platformOs: profile.platformOs } : {}),
  };

  const hardware = normalizeProfileHardware(profile.hardware);
  if (engine.engine === "firefox") {
    return {
      schemaVersion: 2,
      profile: { ...portableProfile, engine: "firefox", firefox: engine.firefox!, ...(hardware ? { hardware } : {}) },
      session,
    };
  }
  // A new schema version, so older clients reject it instead of opening it on CloakBrowser.
  const chromiumRuntime = normalizeChromiumRuntime(profile.chromiumRuntime, engine.engine);
  if (chromiumRuntime) {
    const displayScale = profile.displayScale !== undefined ? { displayScale: profile.displayScale } : {};
    return { schemaVersion: 3, profile: { ...portableProfile, chromiumRuntime, ...(hardware ? { hardware } : {}), ...displayScale }, session };
  }
  // Also a new version: an older client would open the profile with the engine default and then save it without the hardware.
  if (hardware) return { schemaVersion: 4, profile: { ...portableProfile, hardware }, session };
  return { schemaVersion: 1, profile: portableProfile, session };
}

export function decodePortableProfile(payload: PortableProfile): {
  profile: Profile;
  sessionBundle: string;
} {
  if (!payload?.profile || !payload.session) throw new Error("unsupported portable profile payload");
  const portableProfile = payload.profile as PortableProfileV1["profile"] & {
    engine?: unknown;
    firefox?: unknown;
    chromiumRuntime?: unknown;
    hardware?: unknown;
    timezoneManual?: unknown;
    localeManual?: unknown;
    displayScale?: unknown;
  };
  let engine;
  let chromiumRuntime: ChromiumRuntime | undefined;
  let hardware: ProfileHardware | undefined;
  try { hardware = normalizeProfileHardware(portableProfile.hardware); }
  catch { throw new Error("unsupported portable profile payload"); }
  if (portableProfile.localeManual !== undefined && portableProfile.localeManual !== true) {
    throw new Error("unsupported portable profile payload");
  }
  if (portableProfile.timezoneManual !== undefined && portableProfile.timezoneManual !== true) {
    throw new Error("unsupported portable profile payload");
  }
  // Only Chromium 155 (V3) profiles carry a display scale.
  if (portableProfile.displayScale !== undefined && (payload.schemaVersion !== 3 || !isDisplayScale(portableProfile.displayScale))) {
    throw new Error("unsupported portable profile payload");
  }
  if (payload.schemaVersion === 1 || payload.schemaVersion === 3 || payload.schemaVersion === 4) {
    if (portableProfile.engine !== undefined || portableProfile.firefox !== undefined) {
      throw new Error("portable Chromium profile cannot include a Firefox config");
    }
    engine = normalizeProfileEngine(undefined, undefined);
    chromiumRuntime = normalizeChromiumRuntime(portableProfile.chromiumRuntime, engine.engine);
    // V1 carries neither; V3 always has a runtime and may have hardware; V4 is CloakBrowser with hardware.
    const carried = chromiumRuntime ? 3 : hardware ? 4 : 1;
    if (payload.schemaVersion !== carried) throw new Error("unsupported portable profile payload");
  } else if (payload.schemaVersion === 2) {
    if (portableProfile.engine !== "firefox") throw new Error("unsupported portable profile payload");
    engine = normalizeProfileEngine(portableProfile.engine, portableProfile.firefox);
  } else {
    throw new Error("unsupported portable profile payload");
  }

  const session = portableSession(payload.session);
  const profile: Profile = {
    id: portableProfile.id,
    engine: engine.engine,
    ...(chromiumRuntime ? { chromiumRuntime } : {}),
    ...(hardware ? { hardware } : {}),
    ...(engine.firefox ? { firefox: engine.firefox } : {}),
    accId: portableProfile.accId,
    name: portableProfile.name,
    group: portableProfile.group,
    platform: portableProfile.platform,
    username: portableProfile.username,
    password: portableProfile.password,
    email: portableProfile.email,
    emailPassword: portableProfile.emailPassword,
    twofa: portableProfile.twofa,
    proxy: portableProfile.proxy ? { ...portableProfile.proxy } : null,
    ...(portableProfile.proxyError ? { proxyError: portableProfile.proxyError } : {}),
    extensions: [...portableProfile.extensionAssignments],
    tags: [...portableProfile.tags],
    ua: portableProfile.ua,
    timezone: portableProfile.timezone,
    ...(portableProfile.timezoneManual ? { timezoneManual: true } : {}),
    ...(isDisplayScale(portableProfile.displayScale) ? { displayScale: portableProfile.displayScale } : {}),
    ...(portableProfile.locale !== undefined ? { locale: portableProfile.locale } : {}),
    ...(portableProfile.localeManual ? { localeManual: true } : {}),
    screenWidth: portableProfile.screenWidth,
    screenHeight: portableProfile.screenHeight,
    fingerprintSeed: portableProfile.fingerprintSeed,
    // A measurement (fpObserved/fpExpected/fpVerdict) is local to the machine
    // that made it and deliberately does NOT travel in the portable payload.
    platformOs: portableProfile.platformOs ?? "",
    cookies: session.cookies.map((cookie) => ({ ...cookie })),
    seeded: false,
  };
  assertValidProfile(profile);
  return { profile, sessionBundle: JSON.stringify(session) };
}

import type { PortableProfile, PortableProfileV1, PortableProfileV2, PortableProfileV3, PortableProfileV4, PortableProfileV5, PortableSessionV1 } from "./contracts/cloud-v1.ts";
import type { ChromiumRuntime, FirefoxProfileConfig, Profile, ProfileHardware } from "./types.ts";
import { normalizeChromiumRuntime, normalizeProfileEngine } from "./firefox-config.ts";
import { normalizeProfileHardware, normalizeProfileIdentity } from "./fingerprint.ts";
import { assertValidProfile, isDisplayScale } from "./profile-validation.ts";
import { normalizeBundle } from "./session.ts";

const NEW_IDENTITY_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session it carries never includes `newIdentity`: only the New identity upload adds that token. */
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

/** `newIdentity` is for the New identity upload only; every other save leaves it out. */
export function encodePortableProfile(
  profile: Profile & { engine: "firefox"; firefox: FirefoxProfileConfig },
  sessionBundle?: string,
  newIdentity?: string,
): PortableProfileV2;
export function encodePortableProfile(profile: Profile, sessionBundle?: string, newIdentity?: string): PortableProfileV1 | PortableProfileV3 | PortableProfileV4 | PortableProfileV5;
export function encodePortableProfile(profile: Profile, sessionBundle?: string, newIdentity?: string): PortableProfile {
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
  if (newIdentity !== undefined) {
    if (!NEW_IDENTITY_TOKEN.test(newIdentity)) throw new Error("invalid new identity token");
    session.newIdentity = newIdentity;
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
    ...(profile.blockMedia ? { blockMedia: true as const } : {}),
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
    const chromium = { ...portableProfile, chromiumRuntime, ...(hardware ? { hardware } : {}), ...displayScale };
    // Also a new version for a stored identity: an older client would open the profile without it and save it without it.
    const identity = normalizeProfileIdentity(profile.identity);
    if (identity) return { schemaVersion: 5, profile: { ...chromium, identity }, session };
    return { schemaVersion: 3, profile: chromium, session };
  }
  // Also a new version: an older client would open the profile with the engine default and then save it without the hardware.
  if (hardware) return { schemaVersion: 4, profile: { ...portableProfile, hardware }, session };
  return { schemaVersion: 1, profile: portableProfile, session };
}

export function decodePortableProfile(payload: PortableProfile): {
  profile: Profile;
  sessionBundle: string;
  /** The token of a New identity that Cloud still holds; the session bundle never carries it. */
  newIdentity?: string;
} {
  if (!payload?.profile || !payload.session) throw new Error("unsupported portable profile payload");
  const portableProfile = payload.profile as PortableProfileV1["profile"] & {
    engine?: unknown;
    firefox?: unknown;
    chromiumRuntime?: unknown;
    hardware?: unknown;
    timezoneManual?: unknown;
    localeManual?: unknown;
    blockMedia?: unknown;
    displayScale?: unknown;
    identity?: unknown;
  };
  let engine;
  let chromiumRuntime: ChromiumRuntime | undefined;
  let hardware: ProfileHardware | undefined;
  let identity: Profile["identity"];
  try {
    hardware = normalizeProfileHardware(portableProfile.hardware);
    identity = normalizeProfileIdentity(portableProfile.identity);
  } catch { throw new Error("unsupported portable profile payload"); }
  if (portableProfile.localeManual !== undefined && portableProfile.localeManual !== true) {
    throw new Error("unsupported portable profile payload");
  }
  if (portableProfile.timezoneManual !== undefined && portableProfile.timezoneManual !== true) {
    throw new Error("unsupported portable profile payload");
  }
  if (portableProfile.blockMedia !== undefined && portableProfile.blockMedia !== true) {
    throw new Error("unsupported portable profile payload");
  }
  // Only AliasMode Chromium (V3, and V5 with a stored identity) profiles carry a display scale.
  const schemaVersion = payload.schemaVersion as number;
  if (portableProfile.displayScale !== undefined && ((schemaVersion !== 3 && schemaVersion !== 5) || !isDisplayScale(portableProfile.displayScale))) {
    throw new Error("unsupported portable profile payload");
  }
  if (portableProfile.identity !== undefined && schemaVersion !== 5) throw new Error("unsupported portable profile payload");
  if (schemaVersion === 1 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5) {
    if (portableProfile.engine !== undefined || portableProfile.firefox !== undefined) {
      throw new Error("portable Chromium profile cannot include a Firefox config");
    }
    engine = normalizeProfileEngine(undefined, undefined);
    chromiumRuntime = normalizeChromiumRuntime(portableProfile.chromiumRuntime, engine.engine);
    // V1 carries neither; V3 always has a runtime and may have hardware; V4 is CloakBrowser with hardware;
    // V5 is V3 with a stored identity.
    const carried = chromiumRuntime ? identity ? 5 : 3 : hardware ? 4 : 1;
    if (schemaVersion !== carried) throw new Error("unsupported portable profile payload");
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
    ...(identity ? { identity } : {}),
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
    ...(portableProfile.blockMedia ? { blockMedia: true } : {}),
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
  const newIdentity = (payload.session as { newIdentity?: unknown }).newIdentity;
  return {
    profile,
    sessionBundle: JSON.stringify(session),
    ...(typeof newIdentity === "string" && NEW_IDENTITY_TOKEN.test(newIdentity) ? { newIdentity } : {}),
  };
}

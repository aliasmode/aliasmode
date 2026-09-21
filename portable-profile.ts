import type { PortableProfile, PortableProfileV1, PortableProfileV2, PortableSessionV1 } from "./contracts/cloud-v1.ts";
import type { FirefoxProfileConfig, Profile } from "./types.ts";
import { normalizeProfileEngine } from "./firefox-config.ts";
import { assertValidProfile } from "./profile-validation.ts";
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
export function encodePortableProfile(profile: Profile, sessionBundle?: string): PortableProfileV1;
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
    screenWidth: profile.screenWidth,
    screenHeight: profile.screenHeight,
    fingerprintSeed: profile.fingerprintSeed,
    ...(profile.platformOs ? { platformOs: profile.platformOs } : {}),
  };

  if (engine.engine === "firefox") {
    return {
      schemaVersion: 2,
      profile: { ...portableProfile, engine: "firefox", firefox: engine.firefox! },
      session,
    };
  }
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
  };
  let engine;
  if (payload.schemaVersion === 1) {
    if (portableProfile.engine !== undefined || portableProfile.firefox !== undefined) {
      throw new Error("portable Chromium profile cannot include a Firefox config");
    }
    engine = normalizeProfileEngine(undefined, undefined);
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

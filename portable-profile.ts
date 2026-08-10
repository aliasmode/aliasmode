import type { PortableProfileV1, PortableSessionV1 } from "./contracts/cloud-v1.ts";
import { assertValidProfile } from "./profile-validation.ts";
import { normalizeBundle } from "./session.ts";
import type { Profile } from "./types.ts";

function portableSession(raw: unknown): PortableSessionV1 {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { cookies?: unknown }).cookies)) {
    throw new Error("portable session must include a cookies array");
  }
  const normalized = normalizeBundle(raw);
  return {
    cookies: normalized.cookies,
    ...(normalized.hasOrigins ? { origins: normalized.origins } : {}),
    ...(normalized.telegramClient ? { telegramClient: normalized.telegramClient } : {}),
  };
}

export function encodePortableProfile(profile: Profile, sessionBundle?: string): PortableProfileV1 {
  assertValidProfile(profile);
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

  return {
    schemaVersion: 1,
    profile: {
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
    },
    session,
  };
}

export function decodePortableProfile(payload: PortableProfileV1): {
  profile: Profile;
  sessionBundle: string;
} {
  if (payload?.schemaVersion !== 1 || !payload.profile || !payload.session) {
    throw new Error("unsupported portable profile payload");
  }
  const session = portableSession(payload.session);
  const profile: Profile = {
    id: payload.profile.id,
    accId: payload.profile.accId,
    name: payload.profile.name,
    group: payload.profile.group,
    platform: payload.profile.platform,
    username: payload.profile.username,
    password: payload.profile.password,
    email: payload.profile.email,
    emailPassword: payload.profile.emailPassword,
    twofa: payload.profile.twofa,
    proxy: payload.profile.proxy ? { ...payload.profile.proxy } : null,
    ...(payload.profile.proxyError ? { proxyError: payload.profile.proxyError } : {}),
    extensions: [...payload.profile.extensionAssignments],
    tags: [...payload.profile.tags],
    ua: payload.profile.ua,
    timezone: payload.profile.timezone,
    screenWidth: payload.profile.screenWidth,
    screenHeight: payload.profile.screenHeight,
    fingerprintSeed: payload.profile.fingerprintSeed,
    cookies: session.cookies.map((cookie) => ({ ...cookie })),
    seeded: false,
  };
  assertValidProfile(profile);
  return { profile, sessionBundle: JSON.stringify(session) };
}

import { CloudApiError, type CloudClient } from "./cloud-client.ts";
import type { PortableProfile } from "./contracts/cloud-v1.ts";
import { convertMobilePersonaToDesktop, editedProfileHardware, isMobileUserAgent } from "./fingerprint.ts";
import { attachTimezones, type FetchLike } from "./geoip.ts";
import { mergeCookies, parseStrictCores, parseStrictProxy, parseStrictResolution, parseStrictPlatformOs, parseStrictSeed, parseStrictTimezone } from "./parse.ts";
import { completeProfileFingerprint, setFirefoxScreen, syncFirefoxTimezone } from "./firefox-config.ts";
import { normalizeProfileLocale } from "./profile-locale.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import { proxyLegacyString } from "./proxy.ts";
import type { ProfileStore } from "./store.ts";
import type { CookieRecord, Profile } from "./types.ts";

type CloudProfileEditorClient = Pick<CloudClient, "getProfile" | "moveProfile" | "updateProfile">;
type CloudProfileEditorStore = Pick<ProfileStore, "getLaunch">;

export interface CloudProfileEditView {
  id: string;
  engine?: "chromium" | "firefox";
  chromiumRuntime?: "aliasmode";
  name: string;
  group: string;
  platform: string;
  proxyType: string;
  proxy: string;
  proxyError?: string;
  username: string;
  password: string;
  email: string;
  emailPassword: string;
  twofa: string;
  resolution: string;
  platformOs: string;
  timezone: string;
  timezoneManual?: boolean;
  locale: string;
  cores: string;
  fingerprintSeed: string;
  extensions: string[];
  tags: string;
  cookieCount: number;
  seeded: boolean;
  mobilePersona: boolean;
  desktopConversion?: {
    platform: string;
    resolution: string;
    screenChanged: boolean;
  };
  expectedVersion: number;
}

export class CloudProfileEditorError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CloudProfileEditorError";
  }
}

export function cloudProfileEditorErrorStatus(error: unknown): number {
  if (error instanceof CloudProfileEditorError || error instanceof CloudApiError) return error.status;
  return 500;
}

function editView(profile: Profile, expectedVersion: number): CloudProfileEditView {
  const proxy = profile.proxy;
  const conversion = isMobileUserAgent(profile.ua) ? convertMobilePersonaToDesktop(profile) : null;
  return {
    id: profile.id,
    ...(profile.engine === "firefox" ? { engine: "firefox" as const } : {}),
    ...(profile.chromiumRuntime ? { chromiumRuntime: profile.chromiumRuntime } : {}),
    name: profile.name,
    group: profile.group,
    platform: profile.platform ?? "",
    proxyType: proxy?.type ?? "http",
    proxy: proxy ? proxyLegacyString(proxy) : "",
    ...(profile.proxyError ? { proxyError: profile.proxyError } : {}),
    username: profile.username,
    password: profile.password,
    email: profile.email ?? "",
    emailPassword: profile.emailPassword ?? "",
    twofa: profile.twofa,
    resolution: `${profile.screenWidth}*${profile.screenHeight}`,
    platformOs: profile.platformOs ?? "",
    timezone: profile.timezone,
    ...(profile.timezoneManual ? { timezoneManual: true } : {}),
    locale: profile.locale ?? "",
    cores: profile.hardware ? String(profile.hardware.cores) : "",
    fingerprintSeed: String(profile.fingerprintSeed),
    extensions: profile.extensions ?? [],
    tags: (profile.tags ?? []).join(", "),
    cookieCount: profile.cookies.length,
    seeded: profile.seeded,
    mobilePersona: !!conversion,
    ...(conversion ? {
      desktopConversion: {
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}*${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      },
    } : {}),
    expectedVersion,
  };
}

function applyEdits(profile: Profile, set: Record<string, unknown>): boolean {
  if ("engine" in set && set.engine !== (profile.engine ?? "chromium")) {
    throw new CloudProfileEditorError("profile engine cannot be changed", 400);
  }
  let proxyChanged = false;
  if ("name" in set) profile.name = String(set.name ?? "");
  if ("group" in set) profile.group = String(set.group ?? "");
  if ("platform" in set) profile.platform = String(set.platform ?? "");
  if ("username" in set) profile.username = String(set.username ?? "");
  if ("password" in set) profile.password = String(set.password ?? "");
  if ("email" in set) profile.email = String(set.email ?? "");
  if ("emailPassword" in set) profile.emailPassword = String(set.emailPassword ?? "");
  if ("twofa" in set) profile.twofa = String(set.twofa ?? "");
  if ("resolution" in set) {
    const resolution = parseStrictResolution(set.resolution);
    if (profile.engine === "firefox" && (resolution.width !== profile.screenWidth || resolution.height !== profile.screenHeight)) {
      setFirefoxScreen(profile, resolution.width, resolution.height);
    }
    profile.screenWidth = resolution.width;
    profile.screenHeight = resolution.height;
  }
  if ("platformOs" in set) {
    const platformOs = parseStrictPlatformOs(set.platformOs);
    if (profile.engine === "firefox" && platformOs !== (profile.platformOs ?? "")) {
      throw new CloudProfileEditorError("Firefox operating system cannot be changed", 400);
    }
    profile.platformOs = platformOs;
  }
  if ("locale" in set) profile.locale = normalizeProfileLocale(set.locale) ?? profile.locale;
  if ("timezone" in set) {
    profile.timezone = parseStrictTimezone(set.timezone);
    // A typed timezone stays when the proxy changes and on every launch. A blank one follows the proxy.
    if (profile.timezone) profile.timezoneManual = true;
    else delete profile.timezoneManual;
    syncFirefoxTimezone(profile);
  }
  if ("fingerprintSeed" in set) profile.fingerprintSeed = parseStrictSeed(set.fingerprintSeed);
  if ("cores" in set) {
    const hardware = editedProfileHardware(profile, parseStrictCores(set.cores));
    if (hardware) profile.hardware = hardware;
    else delete profile.hardware;
  }
  if ("proxy" in set) {
    const nextProxy = parseStrictProxy(set.proxyType ?? profile.proxy?.type ?? "http", set.proxy);
    const previousProxy = profile.proxy;
    proxyChanged = !!profile.proxyError ||
      previousProxy?.type !== nextProxy?.type ||
      previousProxy?.host !== nextProxy?.host ||
      previousProxy?.port !== nextProxy?.port ||
      previousProxy?.user !== nextProxy?.user ||
      previousProxy?.pass !== nextProxy?.pass;
    profile.proxy = nextProxy;
    delete profile.proxyError;
    if (proxyChanged && profile.engine !== "firefox" && !("timezone" in set) && !profile.timezoneManual) profile.timezone = "";
  }
  if ("extensions" in set) {
    const extensions = Array.isArray(set.extensions) ? set.extensions.map(String) : [];
    if (profile.engine === "firefox" && extensions.length) {
      throw new CloudProfileEditorError("Chrome extensions are not supported by Firefox profiles", 400);
    }
    profile.extensions = extensions;
  }
  if ("tags" in set) {
    profile.tags = Array.isArray(set.tags)
      ? set.tags.map(String)
      : String(set.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  return proxyChanged;
}

export class CloudProfileEditor {
  constructor(
    private readonly cloud: CloudProfileEditorClient,
    private readonly store: CloudProfileEditorStore,
    private readonly timezoneFetch?: FetchLike,
  ) {}

  /** Check Cloud's current open state and this machine's launch cache before a destructive operation. */
  async closedProfileVersion(profileId: string): Promise<number> {
    assertSafeProfileId(profileId);
    const authoritative = await this.cloud.getProfile(profileId);
    this.assertClosed(profileId, authoritative.profile.activeOpens.length);
    return authoritative.profile.version;
  }

  async get(profileId: string): Promise<CloudProfileEditView> {
    assertSafeProfileId(profileId);
    const authoritative = await this.cloud.getProfile(profileId);
    this.assertClosed(profileId, authoritative.profile.activeOpens.length);
    const { profile } = decodePortableProfile(authoritative.payload);
    if (profile.id !== profileId) throw new Error("Cloud returned a mismatched profile payload");
    return editView(profile, authoritative.profile.version);
  }

  async save(
    profileId: string,
    expectedVersion: number,
    set: Record<string, unknown>,
  ): Promise<void> {
    assertSafeProfileId(profileId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new CloudProfileEditorError("expectedVersion must be a non-negative integer", 400);
    }

    let authoritative = await this.cloud.getProfile(profileId);
    if (authoritative.profile.version !== expectedVersion) {
      throw new CloudProfileEditorError("Cloud profile changed; reload it before saving", 409);
    }
    this.assertClosed(profileId, authoritative.profile.activeOpens.length);

    let { profile } = decodePortableProfile(authoritative.payload);
    if (profile.id !== profileId) throw new Error("Cloud returned a mismatched profile payload");
    const destination = "group" in set ? String(set.group ?? "") : profile.group;
    let updateVersion = expectedVersion;
    if (destination !== profile.group) {
      // Validate all supplied fields before the move commits independently.
      applyEdits({ ...profile }, set);
      const moved = await this.cloud.moveProfile(profileId, { destination, expectedVersion });
      updateVersion = moved.profile.version;
      authoritative = await this.cloud.getProfile(profileId);
      if (authoritative.profile.version !== updateVersion) {
        throw new CloudProfileEditorError("Cloud profile changed; reload it before saving", 409);
      }
      this.assertClosed(profileId, authoritative.profile.activeOpens.length);
      profile = decodePortableProfile(authoritative.payload).profile;
      if (profile.id !== profileId) throw new Error("Cloud returned a mismatched profile payload");
    }
    const proxyChanged = applyEdits(profile, set);
    if (proxyChanged && profile.proxy && !("timezone" in set) && !profile.timezoneManual) {
      await attachTimezones([profile], this.timezoneFetch, !("locale" in set)).catch(() => {});
      syncFirefoxTimezone(profile);
    }

    const encoded = encodePortableProfile(completeProfileFingerprint(profile), JSON.stringify(authoritative.payload.session));
    const encodedProfile = {
      ...authoritative.payload.profile,
      ...encoded.profile,
    };
    if (!("proxyError" in encoded.profile)) delete encodedProfile.proxyError;
    if (!("platformOs" in encoded.profile)) delete encodedProfile.platformOs;
    if (!("timezoneManual" in encoded.profile)) delete encodedProfile.timezoneManual;
    if (!("hardware" in encoded.profile)) delete (encodedProfile as { hardware?: unknown }).hardware;
    const payload = {
      ...authoritative.payload,
      ...encoded,
      profile: encodedProfile,
      session: authoritative.payload.session,
    } as PortableProfile;
    await this.cloud.updateProfile(profileId, { expectedVersion: updateVersion, payload });
  }

  /**
   * Add cookies to a closed profile's Cloud session. The next open on any device restores that
   * session (it differs from the copy the device kept), so the cookies are set before the first page.
   */
  async addSessionCookies(profileId: string, cookies: CookieRecord[]): Promise<void> {
    assertSafeProfileId(profileId);
    const authoritative = await this.cloud.getProfile(profileId);
    this.assertClosed(profileId, authoritative.profile.activeOpens.length);
    const session = authoritative.payload.session;
    const payload = {
      ...authoritative.payload,
      session: { ...session, cookies: mergeCookies(session.cookies, cookies) },
    } as PortableProfile;
    // Refuse a payload this app could not open again.
    decodePortableProfile(payload);
    await this.cloud.updateProfile(profileId, { expectedVersion: authoritative.profile.version, payload });
  }

  private assertClosed(profileId: string, activeOpenCount: number): void {
    if (activeOpenCount > 0) {
      throw new CloudProfileEditorError("profile is currently open; close it before editing identity fields", 409);
    }
    if (this.store.getLaunch(profileId)) {
      throw new CloudProfileEditorError("profile is currently open locally; close it before editing identity fields", 409);
    }
  }
}

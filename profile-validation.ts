import type { CookieRecord, Profile } from "./types.ts";
import { MAX_CUSTOM_NO_LENGTH, MAX_SCREEN_DIMENSION, MIN_SCREEN_HEIGHT, MIN_SCREEN_WIDTH } from "./parse.ts";
import { assertSafeProfileId } from "./profile-id.ts";

const REQUIRED_STRING_FIELDS = [
  "accId",
  "name",
  "group",
  "username",
  "password",
  "twofa",
  "ua",
  "timezone",
] as const;

/** A rename must be meaningful, but callers persist the original string exactly. */
export function isValidProfileName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertCookie(value: unknown, index: number): asserts value is CookieRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`profile cookie ${index} must be an object`);
  }
  const cookie = value as Record<string, unknown>;
  for (const field of ["name", "value", "domain", "path"] as const) {
    if (typeof cookie[field] !== "string") throw new Error(`profile cookie ${index} ${field} must be a string`);
  }
  if (!cookie.name || !cookie.domain || !cookie.path) {
    throw new Error(`profile cookie ${index} requires non-empty name, domain, and path`);
  }
  for (const field of ["httpOnly", "secure"] as const) {
    if (cookie[field] !== undefined && typeof cookie[field] !== "boolean") {
      throw new Error(`profile cookie ${index} ${field} must be boolean`);
    }
  }
  if (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== "string") {
    throw new Error(`profile cookie ${index} partitionKey must be a string`);
  }
  if (cookie._crHasCrossSiteAncestor !== undefined && typeof cookie._crHasCrossSiteAncestor !== "boolean") {
    throw new Error(`profile cookie ${index} _crHasCrossSiteAncestor must be boolean`);
  }
  if (cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires))) {
    throw new Error(`profile cookie ${index} expires must be a finite number`);
  }
  if (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(String(cookie.sameSite))) {
    throw new Error(`profile cookie ${index} has an invalid sameSite value`);
  }
}

/** Runtime validation for every full-profile persistence boundary. */
export function assertValidProfile(value: unknown): asserts value is Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile must be an object");
  const profile = value as Record<string, unknown>;
  assertSafeProfileId(profile.id);

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof profile[field] !== "string") throw new Error(`profile ${field} must be a string`);
  }
  for (const field of ["email", "emailPassword"] as const) {
    if (profile[field] !== undefined && typeof profile[field] !== "string") {
      throw new Error(`profile ${field} must be a string`);
    }
  }
  if (profile.platform !== undefined && typeof profile.platform !== "string") {
    throw new Error("profile platform must be a string");
  }
  if (profile.proxy !== null && (typeof profile.proxy !== "object" || Array.isArray(profile.proxy))) {
    throw new Error("profile proxy must be an object or null");
  }
  if (profile.proxyError !== undefined && typeof profile.proxyError !== "string") {
    throw new Error("profile proxyError must be a string");
  }
  if (profile.customNo !== undefined) {
    if (typeof profile.customNo !== "string") throw new Error("profile customNo must be a string");
    if (profile.customNo && !new RegExp(`^\\d{1,${MAX_CUSTOM_NO_LENGTH}}$`).test(profile.customNo)) {
      throw new Error(`profile customNo must be empty or 1-${MAX_CUSTOM_NO_LENGTH} digits`);
    }
  }
  for (const field of ["extensions", "tags"] as const) {
    const list = profile[field];
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string"))) {
      throw new Error(`profile ${field} must be an array of strings`);
    }
  }

  const width = profile.screenWidth;
  const height = profile.screenHeight;
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || (width as number) < MIN_SCREEN_WIDTH || (height as number) < MIN_SCREEN_HEIGHT
    || (width as number) > MAX_SCREEN_DIMENSION || (height as number) > MAX_SCREEN_DIMENSION
  ) {
    throw new Error(
      `profile screen must be integer width ${MIN_SCREEN_WIDTH}-${MAX_SCREEN_DIMENSION} ` +
      `and height ${MIN_SCREEN_HEIGHT}-${MAX_SCREEN_DIMENSION}`,
    );
  }
  const seed = profile.fingerprintSeed;
  if (!Number.isSafeInteger(seed) || (seed as number) < 1 || (seed as number) > 0xffff_ffff) {
    throw new Error("profile fingerprintSeed must be an integer from 1 to 4294967295");
  }
  if (!Array.isArray(profile.cookies)) throw new Error("profile cookies must be an array");
  profile.cookies.forEach(assertCookie);
  if (typeof profile.seeded !== "boolean") throw new Error("profile seeded must be boolean");

  const timezone = profile.timezone as string;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      throw new Error("profile timezone must be empty or a valid IANA timezone");
    }
  }
}

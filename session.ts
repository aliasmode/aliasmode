/**
 * Session bundle read/write over CDP, for roaming. A bundle is JSON
 * `{ cookies: CookieRecord[], origins: OriginStorage[], telegramClient?: "a"|"k" }` for normal
 * HTTP/HTTPS websites. Raw cookie files are DPAPI-encrypted per machine and not
 * portable, so cookies move through CDP. Telegram Web keeps its login in
 * origin storage (localStorage/IndexedDB) instead of a stable auth cookie —
 * cookies alone can never roam a Telegram session, so origin storage roams too.
 */

import type { CookieRecord } from "./types.ts";
import { createHash } from "node:crypto";
import { PlaywrightWorkerError, resolvePlaywrightRuntime, runPlaywrightWorker, type PlaywrightWorkerOptions } from "./playwright-runtime.ts";

const SESSION_URLS = [
  "https://x.com",
  "https://web.telegram.org",
  "https://www.linkedin.com",
  "https://linkedin.com",
  "https://www.instagram.com",
  "https://instagram.com",
  "https://www.facebook.com",
  "https://facebook.com",
  "https://www.tiktok.com",
  "https://tiktok.com",
  "https://www.reddit.com",
  "https://reddit.com",
];
const SESSION_HOSTS = [...new Set(SESSION_URLS.map((url) => new URL(url).hostname))];
const TELEGRAM_ORIGIN = "https://web.telegram.org";
const SESSION_CAPTURE_TIMEOUT_MS = 45_000;
const SESSION_WRITE_TIMEOUT_MS = 240_000;
const SESSION_CONNECT_TIMEOUT_MS = 30_000;
const SESSION_CONTEXT_RETRY_MS = 100;
const SESSION_DISCONNECT_TIMEOUT_MS = 5_000;
const SESSION_SUBPROCESS_TIMEOUT_MS = 240_000;
export const READ_SESSION_WORKER_ARG = "--read-session-worker";
const PLAYWRIGHT_TRANSPORT_STATS = Symbol.for("aliasmode.playwrightTransportStats");

export interface PlaywrightTransportAttribution {
  opened: number;
  closed: number;
  forced: number;
  active: number;
}

export function playwrightTransportAttribution(): PlaywrightTransportAttribution {
  const stats = (globalThis as any)[PLAYWRIGHT_TRANSPORT_STATS] as Partial<PlaywrightTransportAttribution> | undefined;
  return {
    opened: stats?.opened ?? 0,
    closed: stats?.closed ?? 0,
    forced: stats?.forced ?? 0,
    active: stats?.active ?? 0,
  };
}

export type TelegramWebClient = "a" | "k";

// LinkedIn device-identity cookies. These are minted on the account's ORIGINAL device (these accounts
// were created on mobile/Android) and claim that device, conflicting with aliasmode's Windows-desktop
// fingerprint — LinkedIn detects the mismatch and kills the session (Set-Cookie li_at="delete me" +
// /uas/login) a few seconds after the feed loads. We strip ONLY these; li_at, JSESSIONID (the CSRF
// token the SPA needs for any click/action — over-stripping it logs you out on the first interaction)
// and routing cookies are kept. These names are LinkedIn-specific, so this is a no-op for other
// platforms. Note: the session must also be MINTED on a desktop browser for a full match.
const LINKEDIN_DEVICE_COOKIES = new Set(["bcookie", "bscookie", "li_rm"]);

export interface StorageNameValue {
  name: string;
  value: string;
}

export interface OriginStorage {
  origin: string;
  localStorage: StorageNameValue[];
  indexedDB?: unknown[];
}

export interface SessionBundle {
  cookies: CookieRecord[];
  origins?: OriginStorage[];
  /** Ordered normal web tabs. Duplicates are intentional. */
  tabs?: string[];
  /** Telegram web variant last used in this profile. A and K share an origin but not all passcode DBs. */
  telegramClient?: TelegramWebClient;
}

export interface CapturedSessionBundle extends SessionBundle {
  origins: OriginStorage[];
}

export interface SessionCaptureSeed {
  origins: string[];
  telegramClient?: TelegramWebClient;
}

export interface NormalizedSessionBundle {
  cookies: CookieRecord[];
  origins: OriginStorage[];
  tabs: string[];
  telegramClient?: TelegramWebClient;
  /** False for a legacy cookie-only bundle — distinct from a modern bundle with an empty origins list. */
  hasOrigins: boolean;
  /** False for bundles created before portable tab capture. */
  hasTabs: boolean;
}

export type SessionRestoreOperation =
  | "invalid_bundle"
  | "connect"
  | "context"
  | "origin_storage"
  | "cookie_clear"
  | "cookie_add"
  | "navigation"
  | "disconnect";

export type SessionRestoreOutcome = "failed" | "timeout";

export class SessionRestoreError extends Error {
  override readonly name = "SessionRestoreError";

  constructor(
    readonly operation: SessionRestoreOperation,
    readonly outcome: SessionRestoreOutcome,
  ) {
    super(`session_restore/${operation} (${outcome})`);
  }
}

export interface TelegramAuthIndexedDBPresenceRule {
  /** Alternative stores in which this auth marker may live. */
  stores: readonly string[];
  /** Every one of these keys must have a value in the same store. */
  allKeys?: readonly string[];
  /** Or at least one valued key must match this JavaScript RegExp source. */
  anyKeyPattern?: string;
  caseInsensitive?: boolean;
}

export interface TelegramAuthIndexedDBRule {
  databaseName?: string;
  databasePattern?: string;
  stores: readonly string[];
  presence: readonly TelegramAuthIndexedDBPresenceRule[];
}

/**
 * Single serializable allowlist for Telegram auth/passcode IndexedDB. It is used by bundle
 * normalization/detection and embedded into both in-page probe/capture scripts, so support cannot
 * drift between the Node and browser sides again.
 */
export const TELEGRAM_AUTH_INDEXEDDB_RULES: readonly TelegramAuthIndexedDBRule[] = [
  {
    databaseName: "tt-passcode",
    stores: ["store"],
    presence: [{ stores: ["store"], allKeys: ["sessionEncrypted", "globalEncrypted"] }],
  },
  {
    databaseName: "tweb-common",
    stores: ["session", "localStorage__encrypted"],
    presence: [{ stores: ["localStorage__encrypted"], allKeys: ["data"] }],
  },
  {
    databasePattern: "^tweb(?:-account-\\d+)?$",
    stores: ["session", "session__encrypted"],
    presence: [{ stores: ["session", "session__encrypted"], anyKeyPattern: "^dc[1-5]_auth_key$", caseInsensitive: true }],
  },
];

function telegramAuthIndexedDBRule(name: string): TelegramAuthIndexedDBRule | undefined {
  return TELEGRAM_AUTH_INDEXEDDB_RULES.find((rule) =>
    rule.databaseName ? name === rule.databaseName : !!rule.databasePattern && new RegExp(rule.databasePattern).test(name),
  );
}

/**
 * Telegram's normal A and K login is in localStorage. Only their optional local-passcode login needs
 * IndexedDB. Keep those tiny auth DBs/stores and discard chat/media caches (`tt-data`, messages, users,
 * etc.). Besides making a 3-second auth checkpoint cheap, this prevents a lossy cache value from
 * invalidating an otherwise-good auth snapshot during restore.
 */
function filterTelegramAuthIndexedDB(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const candidate of raw) {
    const db = candidate as { name?: unknown; version?: unknown; stores?: unknown };
    if (typeof db?.name !== "string" || typeof db.version !== "number" || db.version <= 0 || !Array.isArray(db.stores)) continue;
    const rule = telegramAuthIndexedDBRule(db.name);
    if (!rule) continue;
    const allowedStores = new Set<string>(rule.stores);
    const stores = db.stores.filter((store: any) => typeof store?.name === "string" && allowedStores.has(store.name));
    if (stores.length > 0) out.push({ ...db, stores });
  }
  return out;
}

function domainMatchesHost(domain: string | undefined, host: string): boolean {
  const d = (domain ?? "").replace(/^\./, "").toLowerCase();
  return d === host || d.endsWith(`.${host}`);
}

/** True for a cookie belonging to one of the supported platform hosts (mirrors the old `ctx.cookies(SESSION_URLS)` filter). */
export function isSessionCookie(cookie: { domain?: string }): boolean {
  return SESSION_HOSTS.some((host) => domainMatchesHost(cookie.domain, host));
}

function canonicalWebOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return value === parsed.origin ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Canonical user-visible web page URL, excluding AliasMode's temporary/internal pages. */
export function canonicalUserPageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.searchParams.has("__aliasmode_session_capture__")
      || parsed.searchParams.has("__aliasmode_session_restore__")) return null;
    if (parsed.hostname === "127.0.0.1"
      && parsed.pathname === "/card"
      && parsed.searchParams.has("id")) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Keep well-shaped localStorage for web origins and only allowlisted Telegram auth IndexedDB. */
export function normalizeOriginStorage(origin: string, storage: any): OriginStorage | null {
  const normalizedOrigin = canonicalWebOrigin(origin);
  if (!normalizedOrigin || !Array.isArray(storage?.localStorage)) return null;
  const localStorage = storage.localStorage
    .filter((e: any) => typeof e?.name === "string" && typeof e?.value === "string")
    .map((e: any) => ({ name: e.name, value: e.value }));
  if (storage.localStorage.length > 0 && localStorage.length === 0) return null;
  const indexedDB = normalizedOrigin === TELEGRAM_ORIGIN
    ? filterTelegramAuthIndexedDB(storage?.indexedDB)
    : [];
  return { origin: normalizedOrigin, localStorage, ...(indexedDB.length ? { indexedDB } : {}) };
}

// Per-platform auth cookie — the one whose live presence means "logged in". Telegram is deliberately
// excluded here for reset safety: Telegram Web's restorable auth is in origin storage, not cookies.
const AUTH_COOKIES: Array<{ platform: string; parentDomain: string; cookie: string }> = [
  { platform: "x.com", parentDomain: "x.com", cookie: "auth_token" },
  { platform: "instagram.com", parentDomain: "instagram.com", cookie: "sessionid" },
  { platform: "facebook.com", parentDomain: "facebook.com", cookie: "c_user" },
  { platform: "tiktok.com", parentDomain: "tiktok.com", cookie: "sessionid" },
  { platform: "tiktok.com", parentDomain: "tiktok.com", cookie: "sessionid_ss" },
  { platform: "linkedin.com", parentDomain: "linkedin.com", cookie: "li_at" },
  { platform: "reddit.com", parentDomain: "reddit.com", cookie: "reddit_session" },
];

function parseBundle(bundle: string): any | null {
  try {
    return JSON.parse(bundle);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validOptionalKeyPath(value: Record<string, unknown>): boolean {
  return (value.keyPath === undefined || typeof value.keyPath === "string")
    && (value.keyPathArray === undefined
      || (Array.isArray(value.keyPathArray) && value.keyPathArray.every((part) => typeof part === "string")));
}

function validCapturedTelegramIndexedDB(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  return raw.every((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string"
      || !Number.isInteger(candidate.version) || (candidate.version as number) <= 0
      || !Array.isArray(candidate.stores) || candidate.stores.length === 0) return false;
    const rule = telegramAuthIndexedDBRule(candidate.name);
    if (!rule) return false;
    const allowedStores = new Set(rule.stores);
    return candidate.stores.every((store) => {
      if (!isRecord(store) || typeof store.name !== "string" || !allowedStores.has(store.name)
        || typeof store.autoIncrement !== "boolean" || !Array.isArray(store.records)
        || !store.records.every(isRecord) || !Array.isArray(store.indexes)
        || !validOptionalKeyPath(store)) return false;
      return store.indexes.every((index) => isRecord(index)
        && typeof index.name === "string"
        && typeof index.multiEntry === "boolean"
        && typeof index.unique === "boolean"
        && validOptionalKeyPath(index));
    });
  });
}

function capturedOriginStorage(origin: unknown, storage: unknown): OriginStorage | null {
  if (typeof origin !== "string" || canonicalWebOrigin(origin) !== origin || !isRecord(storage)
    || !Array.isArray(storage.localStorage)
    || !storage.localStorage.every((entry) => isRecord(entry)
      && typeof entry.name === "string" && typeof entry.value === "string")) {
    throw new Error("invalid captured origin storage");
  }
  if (storage.indexedDB !== undefined
    && (origin !== TELEGRAM_ORIGIN || !validCapturedTelegramIndexedDB(storage.indexedDB))) {
    throw new Error("invalid captured origin storage");
  }
  return normalizeOriginStorage(origin, storage);
}

/** Strictly validate a newly captured bundle before it can replace a known-good checkpoint. */
export function parseCapturedSessionBundle(bundle: string): CapturedSessionBundle {
  const parsed = parseBundle(bundle);
  const invalid = () => { throw new Error("invalid captured session bundle"); };
  if (!isRecord(parsed) || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) invalid();
  if (parsed.tabs !== undefined && !Array.isArray(parsed.tabs)) invalid();
  if (parsed.telegramClient !== undefined && parsed.telegramClient !== "a" && parsed.telegramClient !== "k") invalid();
  if (Array.isArray(parsed.tabs)
    && parsed.tabs.some((tab: unknown) => canonicalUserPageUrl(tab) !== tab)) invalid();

  for (const cookie of parsed.cookies) {
    if (!isRecord(cookie)
      || typeof cookie.name !== "string" || typeof cookie.value !== "string"
      || typeof cookie.domain !== "string" || typeof cookie.path !== "string"
      || (cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires)))
      || (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean")
      || (cookie.secure !== undefined && typeof cookie.secure !== "boolean")
      || (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== "string")
      || (cookie._crHasCrossSiteAncestor !== undefined && typeof cookie._crHasCrossSiteAncestor !== "boolean")
      || (cookie.sameSite !== undefined && cookie.sameSite !== "Strict" && cookie.sameSite !== "Lax" && cookie.sameSite !== "None")) invalid();
  }

  for (const origin of parsed.origins) {
    if (!isRecord(origin) || typeof origin.origin !== "string"
      || canonicalWebOrigin(origin.origin) !== origin.origin || !Array.isArray(origin.localStorage)
      || !origin.localStorage.every((entry) => isRecord(entry)
        && typeof entry.name === "string" && typeof entry.value === "string")) invalid();
    const hasIndexedDB = origin.indexedDB !== undefined;
    if (hasIndexedDB
      && (origin.origin !== TELEGRAM_ORIGIN || !validCapturedTelegramIndexedDB(origin.indexedDB))) invalid();
  }
  return parsed as unknown as CapturedSessionBundle;
}

function cookieDomainMatches(domain: string | undefined, parentDomain: string): boolean {
  const d = (domain ?? "").replace(/^\./, "").toLowerCase();
  return d === parentDomain || d.endsWith(`.${parentDomain}`);
}

/** A cookie counts as a live login only if it has a value and hasn't expired. A missing/negative
 *  `expires` is a session cookie (no expiry) and counts as live. `now` is epoch ms; expires is epoch s. */
function cookieIsLive(c: { value?: string; expires?: number }, now: number): boolean {
  if (!c?.value) return false;
  const e = c.expires;
  if (e == null || e < 0) return true;
  return e * 1000 > now;
}

/** True if the bundle carries a live auth cookie (right name, on the platform's domain, valued + unexpired). */
function bundleHasLiveAuthCookie(bundle: string, name: string, parentDomain: string, now: number): boolean {
  const parsed = parseBundle(bundle);
  const cookies = (parsed?.cookies ?? []) as Array<{ name?: string; value?: string; domain?: string; expires?: number }>;
  return cookies.some((c) => c?.name === name && cookieDomainMatches(c.domain, parentDomain) && cookieIsLive(c, now));
}

function entryName(entry: unknown): string {
  const n = (entry as { name?: unknown })?.name;
  return typeof n === "string" ? n : "";
}

function entryValue(entry: unknown): string {
  const v = (entry as { value?: unknown })?.value;
  return typeof v === "string" ? v : "";
}

function parsedStorageValue(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hasStoredAuthKey(value: string): boolean {
  const parsed = parsedStorageValue(value);
  return typeof parsed === "string" && parsed.length > 0;
}

const TELEGRAM_DC_AUTH_KEY_RE = /^dc[1-5]_auth_key$/i;
const TELEGRAM_ACCOUNT_KEY_RE = /^account[1-9]\d*$/i;

/** A and K both store each account as JSON in `accountN`; validate the object structurally. */
function accountEntryHasAuth(entry: unknown): boolean {
  if (!TELEGRAM_ACCOUNT_KEY_RE.test(entryName(entry))) return false;
  const value = parsedStorageValue(entryValue(entry));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dcId = Number(value.dcId ?? value.dcID);
  if (Number.isInteger(dcId) && dcId >= 1 && dcId <= 5 && typeof value[`dc${dcId}_auth_key`] === "string" && value[`dc${dcId}_auth_key`].length > 0) return true;
  return Object.entries(value).some(([name, stored]) => TELEGRAM_DC_AUTH_KEY_RE.test(name) && typeof stored === "string" && stored.length > 0);
}

function localStorageHasTelegramAuth(entries: unknown[]): boolean {
  return entries.some((entry) => {
    const name = entryName(entry);
    return (TELEGRAM_DC_AUTH_KEY_RE.test(name) && hasStoredAuthKey(entryValue(entry))) || accountEntryHasAuth(entry);
  });
}

function recordKey(record: any): string {
  return typeof record?.key === "string" ? record.key : "";
}

function recordHasValue(record: any): boolean {
  if (!record || typeof record !== "object") return false;
  if (record.valueEncoded !== undefined) return true;
  if (record.value === undefined || record.value === null || record.value === "") return false;
  if (Array.isArray(record.value)) return record.value.length > 0;
  return true;
}

/** Recognize only the documented A/K passcode stores (plus the old K session store). */
function indexedDBHasTelegramAuth(raw: unknown): boolean {
  for (const db of filterTelegramAuthIndexedDB(raw) as any[]) {
    const rule = telegramAuthIndexedDBRule(db.name);
    if (!rule) continue;
    for (const presence of rule.presence) {
      for (const storeName of presence.stores) {
        const store = (db.stores ?? []).find((candidate: any) => candidate?.name === storeName);
        const records = Array.isArray(store?.records) ? store.records.filter(recordHasValue) : [];
        const keys: string[] = records.map((record: any) => recordKey(record));
        if (presence.allKeys && presence.allKeys.every((key) => keys.includes(key))) return true;
        if (presence.anyKeyPattern) {
          const matcher = new RegExp(presence.anyKeyPattern, presence.caseInsensitive ? "i" : "");
          if (keys.some((key) => matcher.test(key))) return true;
        }
      }
    }
  }
  return false;
}

function telegramOriginHasAuth(origin: { localStorage?: unknown[]; indexedDB?: unknown[] }): boolean {
  const localStorage = Array.isArray(origin.localStorage) ? origin.localStorage : [];
  return localStorageHasTelegramAuth(localStorage) || indexedDBHasTelegramAuth(origin.indexedDB);
}

/** True when the bundle carries Telegram auth-key origin storage (a live login), not just incidental state. */
export function bundleHasTelegramAuthStorage(bundle: string): boolean {
  const parsed = parseBundle(bundle);
  if (!parsed) return false;
  const origins = (parsed.origins ?? []) as Array<{ origin?: string; localStorage?: unknown[]; indexedDB?: unknown[] }>;
  return origins.some((origin) => origin?.origin === TELEGRAM_ORIGIN && telegramOriginHasAuth(origin));
}

function bundleHasTelegramSession(bundle: string): boolean {
  // Telegram cookies do not contain the MTProto authorization and cannot restore a login.
  return bundleHasTelegramAuthStorage(bundle);
}

/** The A/K path last observed, with `kz_version` as a migration fallback for older bundles. */
export function bundleTelegramClient(bundle: string): TelegramWebClient | undefined {
  const parsed = parseBundle(bundle);
  if (!parsed) return undefined;
  if (parsed.telegramClient === "a" || parsed.telegramClient === "k") return parsed.telegramClient;
  const origin = (parsed.origins ?? []).find((o: any) => o?.origin === TELEGRAM_ORIGIN);
  const entry = Array.isArray(origin?.localStorage)
    ? origin.localStorage.find((item: unknown) => entryName(item) === "kz_version")
    : undefined;
  const value = String(parsedStorageValue(entryValue(entry))).toLowerCase();
  if (value === "a" || value === "z") return "a";
  if (value === "k") return "k";
  return undefined;
}

/**
 * Stable, auth-only signature used by the fast checkpoint loop. Cache/message changes are excluded, so
 * this changes only when a Telegram login/passcode/client actually changes.
 */
export function telegramAuthSignature(bundle: string): string | null {
  const parsed = parseBundle(bundle);
  if (!parsed) return null;
  const origin = (parsed.origins ?? []).find((o: any) => o?.origin === TELEGRAM_ORIGIN);
  if (!origin || !telegramOriginHasAuth(origin)) return null;
  const localStorage = (Array.isArray(origin.localStorage) ? origin.localStorage : [])
    .filter((entry: unknown) => {
      const name = entryName(entry);
      return TELEGRAM_DC_AUTH_KEY_RE.test(name) || name === "user_auth" || accountEntryHasAuth(entry);
    })
    .map((entry: unknown) => [entryName(entry), entryValue(entry)] as [string, string])
    .sort((left: [string, string], right: [string, string]) => left[0].localeCompare(right[0]));
  const indexedDB = filterTelegramAuthIndexedDB(origin.indexedDB);
  return JSON.stringify({ client: bundleTelegramClient(bundle) ?? null, localStorage, indexedDB });
}

/** True if the bundle explicitly carries Telegram origin storage. */
export function bundleHasTelegramOrigin(bundle: string): boolean {
  const parsed = parseBundle(bundle);
  const origins = (parsed?.origins ?? []) as Array<{ origin?: string }>;
  return origins.some((o) => o?.origin === "https://web.telegram.org");
}

/** Return the bundle with any https://web.telegram.org origin removed; cookies and other origins kept. */
export function stripTelegramOrigin(bundle: string): string {
  const parsed = parseBundle(bundle);
  if (!parsed || !Array.isArray(parsed.origins)) return bundle;
  parsed.origins = parsed.origins.filter((o: { origin?: string }) => o?.origin !== "https://web.telegram.org");
  return JSON.stringify(parsed);
}

/** Which supported platforms this bundle is actually logged in for, derived from the bundle's auth material. */
export function bundleLoggedInPlatforms(bundle: string, now: number): Set<string> {
  const set = new Set<string>();
  for (const a of AUTH_COOKIES) if (bundleHasLiveAuthCookie(bundle, a.cookie, a.parentDomain, now)) set.add(a.platform);
  if (bundleHasTelegramSession(bundle)) set.add("telegram.org");
  return set;
}

/**
 * True if injecting this bundle would put a login BACK — a valued supported-platform auth cookie or
 * origin storage (Telegram's localStorage/IndexedDB). Used to decide whether it's safe to reset a
 * profile's local volatile storage after a crash: only when the bundle we're about to inject can restore
 * the login. On a first-migration open the hub has no session, the fallback bundle is just the import
 * cookies, and Telegram's auth (which lives in localStorage) would NOT be restorable — so resetting then
 * would wipe Telegram's only local copy. This returns false for that case, gating the reset off.
 */
export function bundleHasRestorableLogin(bundleJson: string, now = Date.now()): boolean {
  for (const a of AUTH_COOKIES) if (bundleHasLiveAuthCookie(bundleJson, a.cookie, a.parentDomain, now)) return true;
  return bundleHasTelegramAuthStorage(bundleJson);
}

/** Parse + validate an arbitrary hub bundle payload into a safe shape, tolerating malformed/legacy input. */
export function normalizeBundle(raw: any): NormalizedSessionBundle {
  const cookies = Array.isArray(raw?.cookies) ? raw.cookies : [];
  const hasOrigins = Array.isArray(raw?.origins);
  const origins = hasOrigins
    ? raw.origins
        .map((o: any) => (typeof o?.origin === "string" ? normalizeOriginStorage(o.origin, o) : null))
        .filter((o: OriginStorage | null): o is OriginStorage => !!o)
    : [];
  const hasTabs = Array.isArray(raw?.tabs);
  const tabs = hasTabs
    ? raw.tabs.map(canonicalUserPageUrl).filter((tab: string | null): tab is string => !!tab)
    : [];
  const telegramClient = raw?.telegramClient === "a" || raw?.telegramClient === "k" ? raw.telegramClient : undefined;
  return {
    cookies,
    origins,
    tabs,
    ...(telegramClient ? { telegramClient } : {}),
    hasOrigins,
    hasTabs,
  };
}

/** Ordered portable user tabs from a tolerant legacy/external bundle. */
export function bundleTabUrls(bundle: string): string[] {
  return normalizeBundle(parseBundle(bundle)).tabs;
}

export function sessionCaptureSeed(bundle: string): SessionCaptureSeed {
  const normalized = normalizeBundle(parseBundle(bundle));
  return {
    origins: normalized.origins.map((origin) => origin.origin),
    ...(normalized.telegramClient ? { telegramClient: normalized.telegramClient } : {}),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function sortCanonical(values: unknown[]): unknown[] {
  return values.map(canonicalValue).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

/** Private deterministic fingerprint for suppressing unchanged local checkpoints. */
export function sessionBundleSignature(bundle: string): string {
  const raw = parseBundle(bundle);
  const normalized = normalizeBundle(raw);
  const origins = normalized.origins.map((origin) => ({
    origin: origin.origin,
    localStorage: sortCanonical(origin.localStorage),
    ...(origin.indexedDB ? { indexedDB: sortCanonical(origin.indexedDB) } : {}),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
  const canonical = JSON.stringify({
    cookies: sortCanonical(normalized.cookies),
    origins,
    tabs: normalized.tabs,
    telegramClient: normalized.telegramClient ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function telegramClientForUrl(raw: string): TelegramWebClient | undefined {
  try {
    const path = new URL(raw).pathname.toLowerCase();
    if (path === "/a" || path.startsWith("/a/")) return "a";
    if (path === "/k" || path.startsWith("/k/")) return "k";
  } catch {}
  return undefined;
}

interface AttachedPageStorage {
  origins: OriginStorage[];
  telegramClient?: TelegramWebClient;
}

function validateCaptureSeed(seed: SessionCaptureSeed): void {
  if (!Array.isArray(seed.origins)
    || seed.origins.some((origin) => typeof origin !== "string" || canonicalWebOrigin(origin) !== origin)
    || (seed.telegramClient !== undefined && seed.telegramClient !== "a" && seed.telegramClient !== "k")) {
    throw new Error("invalid session capture seed");
  }
}

async function primeCaptureOrigins(context: any, seed: SessionCaptureSeed): Promise<() => Promise<void>> {
  validateCaptureSeed(seed);
  if (typeof context.newPage !== "function" || typeof context.route !== "function") return async () => {};
  const origins = new Set(seed.origins);
  for (const page of context.pages()) {
    try {
      const pageUrl = canonicalUserPageUrl(page.url());
      if (pageUrl) origins.add(new URL(pageUrl).origin);
    } catch {}
  }
  const pages: any[] = [];
  const routes: Array<{ url: string; handler: (route: any) => unknown }> = [];
  const cdpSessions: any[] = [];
  try {
    let ordinal = 0;
    for (const origin of [...origins].sort()) {
      const page = await context.newPage();
      pages.push(page);
      if (typeof context.newCDPSession === "function") {
        const cdp = await context.newCDPSession(page);
        cdpSessions.push(cdp);
        await cdp.send("Network.enable");
        await cdp.send("Network.setBypassServiceWorker", { bypass: true });
      }
      const url = `${origin}/?__aliasmode_session_capture__=${++ordinal}`;
      let intercepted = false;
      const handler = (route: any) => {
        intercepted = true;
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>capture</title>",
        });
      };
      routes.push({ url, handler });
      await context.route(url, handler);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (!intercepted) throw new Error("capture navigation was not intercepted");
      if (new URL(page.url()).origin !== origin) throw new Error("wrong capture origin");
    }
  } catch (error) {
    for (const page of pages) await page.close().catch(() => {});
    for (const cdp of cdpSessions) await cdp.detach().catch(() => {});
    for (const route of routes) await context.unroute(route.url, route.handler).catch(() => {});
    throw error;
  }
  return async () => {
    for (const page of pages) await page.close().catch(() => {});
    for (const cdp of cdpSessions) await cdp.detach().catch(() => {});
    for (const route of routes) await context.unroute(route.url, route.handler).catch(() => {});
  };
}

/** Collect storage from supported pages that were already loaded before Playwright attached over CDP. */
async function collectAttachedPageOrigins(context: any): Promise<AttachedPageStorage> {
  const origins: OriginStorage[] = [];
  const seen = new Set<string>();
  let telegramClient: TelegramWebClient | undefined;
  const localStorageExpr = `(() => ({
    localStorage: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) }))
  }))()`;
  const telegramAuthIndexedDBRules = JSON.stringify(TELEGRAM_AUTH_INDEXEDDB_RULES);
  for (const page of context.pages()) {
    const pageUrl = page.url();
    let origin: string;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      continue;
    }
    if (origin === TELEGRAM_ORIGIN && !telegramClient) telegramClient = telegramClientForUrl(pageUrl);
    if (origin !== TELEGRAM_ORIGIN || seen.has(origin)) continue;
    seen.add(origin);
    let storage = await page.evaluate(localStorageExpr);

    // Normal A/K auth is localStorage. Check only the small optional-passcode DBs when local auth is
    // absent or encrypted passcode records exist; never walk Telegram's chat/media databases.
    let needsPasscodeCapture = origin === TELEGRAM_ORIGIN && !localStorageHasTelegramAuth(storage?.localStorage ?? []);
    if (origin === TELEGRAM_ORIGIN && !needsPasscodeCapture) {
      // Web A can keep its ordinary auth keys until the last passcode-protected tab unloads. Detect the
      // already-written encrypted records too, so a checkpoint taken before native window-close does
      // not silently downgrade/omit the passcode session.
      const passcodePresenceExpr = `(async () => {
        const rules = ${telegramAuthIndexedDBRules};
        const ruleFor = (name) => rules.find((rule) => rule.databaseName
          ? name === rule.databaseName
          : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
        const resultOf = (request) => new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
        });
        const open = (name) => resultOf(indexedDB.open(name));
        for (const meta of await indexedDB.databases()) {
          const name = meta && meta.name;
          const rule = name && ruleFor(name);
          if (!rule) continue;
          const db = await open(name);
          if (!db) continue;
          try {
            for (const presence of rule.presence) {
              for (const storeName of presence.stores) {
                if (!db.objectStoreNames.contains(storeName)) continue;
                const store = db.transaction(storeName, "readonly").objectStore(storeName);
                if (presence.allKeys) {
                  const values = await Promise.all(presence.allKeys.map((key) => resultOf(store.get(key))));
                  if (values.every((value) => value !== undefined && value !== null)) return true;
                }
                if (presence.anyKeyPattern) {
                  const keys = await resultOf(store.getAllKeys());
                  const matcher = new RegExp(presence.anyKeyPattern, presence.caseInsensitive ? "i" : "");
                  if (Array.isArray(keys) && keys.some((key) => matcher.test(String(key)))) return true;
                }
              }
            }
          } finally {
            db.close();
          }
        }
        return false;
      })()`;
      needsPasscodeCapture = await page.evaluate(passcodePresenceExpr);
    }
    if (origin === TELEGRAM_ORIGIN && needsPasscodeCapture) {
      const source = await storageScriptSource();
      const passcodeExpr = `(() => {
        const module = { exports: {} };
        ${source}
        const script = new (module.exports.StorageScript())(false);
        return (async () => {
          const rules = ${telegramAuthIndexedDBRules};
          const ruleFor = (name) => rules.find((rule) => rule.databaseName
            ? name === rule.databaseName
            : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
          const localStorage = Object.keys(globalThis.localStorage).map((name) => ({ name, value: globalThis.localStorage.getItem(name) }));
          const indexedDB = [];
          for (const meta of await globalThis.indexedDB.databases()) {
            const name = meta && meta.name;
            const rule = name && ruleFor(name);
            if (!rule) continue;
            const stores = new Set(rule.stores);
            const db = await script._collectDB(meta);
            db.stores = db.stores.filter((store) => stores.has(store.name));
            if (db.stores.length) indexedDB.push(db);
          }
          return { localStorage, indexedDB };
        })();
      })()`;
      const withPasscode = await page.evaluate(passcodeExpr);
      storage = withPasscode;
    }
    const normalized = capturedOriginStorage(origin, storage);
    if (normalized) origins.push(normalized);
  }
  return { origins, ...(telegramClient ? { telegramClient } : {}) };
}

export async function collectSessionFromContext(
  ctx: any,
  captureSeed: SessionCaptureSeed = { origins: [] },
): Promise<SessionBundle> {
  const tabs = ctx.pages()
    .map((page: any) => canonicalUserPageUrl(page.url()))
    .filter((tab: string | null): tab is string => !!tab);
  const cleanup = await primeCaptureOrigins(ctx, captureSeed);
  try {
    // The public no-IndexedDB state is deliberately the baseline. Telegram's normal A/K login is
    // localStorage, and collecting every cache DB made auth checkpoints slow and occasionally lossy.
    // collectAttachedPageOrigins adds only the allowlisted current/legacy passcode stores when needed.
    const state = await ctx.storageState();
    const cookies = state.cookies;
    const byOrigin = new Map<string, OriginStorage>();
    for (const origin of state.origins ?? []) {
      const normalized = capturedOriginStorage(origin?.origin, origin);
      if (normalized) byOrigin.set(normalized.origin, normalized);
    }
    const attachedPages = await collectAttachedPageOrigins(ctx);
    for (const attached of attachedPages.origins) {
      // Prefer the attached page's fresher localStorage, but don't drop IndexedDB the storageState pass
      // captured just because this page fell back to a localStorage-only collect.
      const prev = byOrigin.get(attached.origin);
      const merged = prev?.indexedDB && !attached.indexedDB ? { ...attached, indexedDB: prev.indexedDB } : attached;
      byOrigin.set(attached.origin, merged);
    }
    const telegramClient = attachedPages.telegramClient ?? captureSeed.telegramClient;
    return {
      cookies,
      origins: [...byOrigin.values()],
      tabs,
      ...(telegramClient ? { telegramClient } : {}),
    };
  } finally {
    await cleanup();
  }
}

class DeadlineExceededError extends Error {}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeadlineExceededError(`${label} exceeded ${timeoutMs}ms`)),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Capture one attached browser under hard deadlines. Playwright's public
 * storageState/page APIs do not all accept an AbortSignal, so a wedged target
 * could otherwise leave a remote heartbeat permanently in flight.
 */
export async function readSessionFromBrowser(
  browser: any,
  options: {
    captureTimeoutMs?: number;
    disconnectTimeoutMs?: number;
    captureSeed?: SessionCaptureSeed;
  } = {},
): Promise<string> {
  const captureTimeoutMs = options.captureTimeoutMs ?? SESSION_CAPTURE_TIMEOUT_MS;
  const disconnectTimeoutMs = options.disconnectTimeoutMs ?? SESSION_DISCONNECT_TIMEOUT_MS;
  const capture = (async () => {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const bundle = JSON.stringify(await collectSessionFromContext(ctx, options.captureSeed));
    parseCapturedSessionBundle(bundle);
    return bundle;
  })();
  try {
    return await withDeadline(capture, captureTimeoutMs, "session capture");
  } finally {
    // Closing the Playwright CDP client normally aborts a stuck storage read.
    // Bound close too: a dead transport must not turn the deadline above into
    // another permanent heartbeat stall.
    await withDeadline(
      Promise.resolve().then(() => browser.close()),
      disconnectTimeoutMs,
      "session disconnect",
    ).catch(() => {});
  }
}

/** Read the running browser's portable web cookies and origin storage into a bundle. */
export async function readSession(
  ws: string,
  captureSeed: SessionCaptureSeed = { origins: [] },
): Promise<string> {
  const bundle = await runPlaywrightWorker<string>("session-capture", {
    endpoint: ws,
    connectTimeoutMs: 30_000,
    captureSeed,
  }, { timeoutMs: SESSION_SUBPROCESS_TIMEOUT_MS });
  parseCapturedSessionBundle(bundle);
  return bundle;
}

export type ReadSessionResult =
  | { ok: true; bundle: string }
  | { ok: false; error: string };

export function encodeReadSessionResult(result: ReadSessionResult): string {
  return JSON.stringify(result);
}

export function decodeReadSessionResult(raw: string): ReadSessionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid session capture subprocess response");
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as any).ok !== "boolean") {
    throw new Error("invalid session capture subprocess response");
  }
  if ((parsed as any).ok === true && typeof (parsed as any).bundle === "string") {
    return { ok: true, bundle: (parsed as any).bundle };
  }
  if ((parsed as any).ok === false && typeof (parsed as any).error === "string") {
    return { ok: false, error: (parsed as any).error };
  }
  throw new Error("invalid session capture subprocess response");
}

interface ReadSessionSubprocessOptions extends PlaywrightWorkerOptions {
  captureSeed?: SessionCaptureSeed;
}

export function readSessionWorkerCommand(
  _ws: string,
  runtimeRoot?: string,
): string[] {
  const runtime = resolvePlaywrightRuntime({ runtimeRoot });
  return [runtime.nodeExecutable, runtime.workerPath];
}

/** Capture in the common one-shot official Node worker. */
export async function readSessionInSubprocess(
  ws: string,
  options: ReadSessionSubprocessOptions = {},
): Promise<string> {
  const bundle = await runPlaywrightWorker<string>("session-capture", {
    endpoint: ws,
    connectTimeoutMs: 30_000,
    captureSeed: options.captureSeed ?? { origins: [] },
  }, { ...options, timeoutMs: options.timeoutMs ?? SESSION_SUBPROCESS_TIMEOUT_MS });
  parseCapturedSessionBundle(bundle);
  return bundle;
}

export async function runReadSessionWorker(
  argv: string[],
  deps: {
    readSession: (ws: string) => Promise<string>;
    write: (value: string) => Promise<unknown>;
    exit: (code: number) => void;
  },
): Promise<void> {
  try {
    const ws = argv[0] === READ_SESSION_WORKER_ARG ? argv[1] : undefined;
    if (!ws) throw new Error("session capture worker requires a WebSocket endpoint");
    const bundle = await deps.readSession(ws);
    await deps.write(encodeReadSessionResult({ ok: true, bundle }));
    deps.exit(0);
  } catch (error) {
    await deps.write(encodeReadSessionResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    deps.exit(1);
  }
}

/**
 * Read a running browser's cookies for the given URLs over CDP — via Playwright's `context.cookies()`.
 *
 * This is the ONLY cookie-read that works on CloakBrowser: its anti-cookie-theft layer HANGS raw CDP
 * cookie dumps (`Storage.getCookies` / `Network.getCookies`), so a client driving the browser with
 * zendriver/puppeteer over raw CDP can never read the jar — every read times out. Playwright's
 * `connectOverCDP` + `context.cookies()` path IS answered (this is exactly how li-login harvests
 * li_at/JSESSIONID and how roaming reads sessions), including httpOnly cookies like auth_token. The
 * Compatibility clients can call this over HTTP to harvest auth cookies instead of fighting the
 * blocked raw-CDP read. Returns the raw Playwright cookie records (httpOnly included).
 */
export async function harvestCookies(ws: string, urls: string[]): Promise<CookieRecord[]> {
  return runPlaywrightWorker<CookieRecord[]>("cookie-harvest", {
    endpoint: ws,
    urls,
    connectTimeoutMs: 30_000,
  });
}

async function storageScriptSource(): Promise<string> {
  // Main-process helpers remain injectable/testable, but production Playwright storage work runs in worker.mjs.
  return "module.exports.StorageScript = class StorageScript {};";
}

/**
 * Restore origin storage (localStorage + IndexedDB) into an ALREADY-RUNNING,
 * CDP-attached context. Unlike the read side, Playwright has no public API for
 * this direction — `newContext({storageState})` only applies at context
 * creation, and a persistent-profile CloakBrowser only ever has one context to
 * attach to. So this uses Playwright's internal per-origin storage script (the
 * same one storageState() uses internally to collect) via a ONE-TIME
 * navigate-then-evaluate on a throwaway page, not `addInitScript` — that API
 * re-runs on EVERY future navigation to a matching origin for the life of the
 * context (Playwright's own docs: "evaluated whenever the page is navigated"),
 * which would silently re-apply this stale snapshot — and could log the
 * operator back out — on the next reload or in-session navigation to Telegram.
 * A throwaway-page restore is still race-free: localStorage/IndexedDB are
 * durable per-origin browser state, so once this write lands, the caller's own
 * subsequent navigation of the REAL tab to the platform's home page (always
 * sequenced after writeSession() returns) reads the already-correct state from
 * its very first load — no script needs to run again after that.
 */
export async function restoreOriginStorage(context: any, origins: OriginStorage[]): Promise<void> {
  // Restore ONLY well-shaped web origins carried by the bundle. Always use a throwaway page in
  // production so seeding never navigates or races the operator's real tabs.
  const targets = origins.flatMap((target) => {
    const origin = canonicalWebOrigin(target.origin);
    return origin ? [{ ...target, origin }] : [];
  });
  if (targets.length === 0) return;
  const existing = context.pages();
  const closePage = typeof context.newPage === "function";
  const page = closePage ? await context.newPage() : existing[0]; // fallback keeps simple test doubles compatible
  if (!page) throw new Error("cannot restore origin storage: no page available");
  try {
    for (const target of targets) {
      // Chrome can restore last-run tabs before the coordinator seeds the bundle. Move every matching
      // page off-origin so live application code cannot overwrite localStorage during restore.
      for (const existingPage of existing) {
        try {
          if (new URL(existingPage.url()).origin === target.origin) {
            await existingPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
          }
        } catch {}
      }
      // Fulfil a same-origin blank document where routing is available. Loading the real site before
      // its session exists can let application code observe "logged out" and mutate storage during restore.
      const canRoute = typeof context.route === "function" && typeof context.unroute === "function";
      const restoreUrl = canRoute ? `${target.origin}/?__aliasmode_session_restore__=${Date.now()}` : target.origin;
      let intercepted = false;
      const routeHandler = (route: any) => {
        intercepted = true;
        return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>restore</title>" });
      };
      const cdp = typeof context.newCDPSession === "function" ? await context.newCDPSession(page) : null;
      try {
        if (cdp) {
          await cdp.send("Network.enable");
          await cdp.send("Network.setBypassServiceWorker", { bypass: true });
        }
        if (canRoute) await context.route(restoreUrl, routeHandler);
        try {
          await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
        } finally {
          if (canRoute) await context.unroute(restoreUrl, routeHandler).catch(() => {});
        }
        if (canRoute && !intercepted) throw new Error("restore navigation was not intercepted");
      } finally {
        if (cdp) await cdp.detach().catch(() => {});
      }
      if (typeof page.url === "function" && new URL(page.url()).origin !== target.origin) {
        throw new Error(`origin restore navigated to ${page.url()} instead of ${target.origin}`);
      }

      // Telegram passcode state is authoritative, including an empty tombstone. Remove only the
      // allowlisted auth databases, then rebuild those present in the bundle.
      if (target.origin === TELEGRAM_ORIGIN) {
        const databases = Array.isArray(target.indexedDB) ? target.indexedDB : [];
        const source = databases.length ? await storageScriptSource() : "";
        const idbExpr = `(() => {
          const rules = ${JSON.stringify(TELEGRAM_AUTH_INDEXEDDB_RULES)};
          const databases = ${JSON.stringify(databases)};
          const ruleFor = (name) => rules.find((rule) => rule.databaseName
            ? name === rule.databaseName
            : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
          const deleteDatabase = (name) => new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error("deleteDatabase failed: " + name));
            request.onblocked = () => reject(new Error("deleteDatabase blocked: " + name));
          });
          return (async () => {
            for (const database of await indexedDB.databases()) {
              if (database && database.name && ruleFor(database.name)) await deleteDatabase(database.name);
            }
            if (databases.length) {
              const module = { exports: {} };
              ${source}
              const script = new (module.exports.StorageScript())(false);
              for (const database of databases) await script._restoreDB(database);
            }
            return true;
          })();
        })()`;
        await page.evaluate(idbExpr);
      }

      // Apply localStorage transactionally: if quota/security/setItem fails, restore the prior values
      // and throw instead of silently navigating onward with a partial session.
      const localStorageExpr = `(() => {
        const entries = ${JSON.stringify(target.localStorage)};
        const backup = Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) }));
        try {
          localStorage.clear();
          for (const entry of entries) localStorage.setItem(entry.name, entry.value);
          for (const entry of entries) {
            if (localStorage.getItem(entry.name) !== entry.value) throw new Error("localStorage verification failed: " + entry.name);
          }
          return true;
        } catch (error) {
          try {
            localStorage.clear();
            for (const entry of backup) localStorage.setItem(entry.name, entry.value);
          } catch {}
          throw error;
        }
      })()`;
      await page.evaluate(localStorageExpr);
    }
    if (!closePage) await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
  } finally {
    if (closePage) await page.close();
  }
}

/**
 * Make the bundle the browser's authoritative portable web session: cookies
 * are always cleared first so stale local cookies from a previous run can't shadow
 * the roamed ones (an empty bundle still clears — authoritative logged out). Origin
 * storage is only rewritten for the origins the bundle actually carries, so roaming
 * a single-platform bundle never wipes another platform still logged in locally
 * (see restoreOriginStorage).
 */
export async function writeSessionToBrowser(
  browser: any,
  parsed: NormalizedSessionBundle,
  options: { writeTimeoutMs?: number; disconnectTimeoutMs?: number; disconnect?: boolean } = {},
): Promise<void> {
  const writeTimeoutMs = options.writeTimeoutMs ?? SESSION_WRITE_TIMEOUT_MS;
  const disconnectTimeoutMs = options.disconnectTimeoutMs ?? SESSION_DISCONNECT_TIMEOUT_MS;
  let cancelled = false;
  let activeOperation: SessionRestoreOperation = "context";
  const ensureCurrent = () => {
    if (cancelled) throw new SessionRestoreError(activeOperation, "failed");
  };
  const runOperation = async <T>(operation: SessionRestoreOperation, task: () => Promise<T> | T): Promise<T> => {
    activeOperation = operation;
    try {
      return await task();
    } catch (error) {
      if (error instanceof SessionRestoreError) throw error;
      throw new SessionRestoreError(operation, "failed");
    }
  };
  const write = (async () => {
    const ctx = await runOperation("context", () => {
      const context = browser.contexts()[0];
      if (!context) throw new Error("persistent context unavailable");
      return context;
    });
    ensureCurrent();
    // Seed durable origin auth first. If it fails, cookies and navigation are left untouched and the
    // remote coordinator keeps this open from being presented as a successful session handoff.
    if (parsed.hasOrigins) {
      await runOperation("origin_storage", () => restoreOriginStorage(ctx, parsed.origins));
    }
    ensureCurrent();
    // Always clear first so stale local cookies can't shadow the hub's
    // authoritative state — including when that state is intentionally empty.
    await runOperation("cookie_clear", () => ctx.clearCookies());
    ensureCurrent();
    // Strip the Android device-identity cookies (see LINKEDIN_DEVICE_COOKIES) but keep everything else,
    // crucially li_at and JSESSIONID (CSRF). No-op for non-LinkedIn platforms.
    const inject = parsed.cookies.filter((c) => !LINKEDIN_DEVICE_COOKIES.has(c.name));
    if (inject.length > 0) {
      await runOperation("cookie_add", () => ctx.addCookies(inject as any));
    }
  })();

  let writeFailed = false;
  let writeError: SessionRestoreError | undefined;
  try {
    await withDeadline(write, writeTimeoutMs, "session restore");
  } catch (error) {
    writeFailed = true;
    writeError = error instanceof DeadlineExceededError
      ? new SessionRestoreError(activeOperation, "timeout")
      : error instanceof SessionRestoreError
        ? error
        : new SessionRestoreError(activeOperation, "failed");
    cancelled = true;
  }

  if (options.disconnect === false) {
    if (writeError) throw writeError;
    return;
  }

  let disconnectError: SessionRestoreError | undefined;
  try {
    const disconnect = Promise.resolve().then(() => browser.close());
    const cleanup = writeFailed
      ? Promise.allSettled([disconnect, write]).then(([result]) => {
          if (result?.status === "rejected") throw result.reason;
        })
      : disconnect;
    await withDeadline(cleanup, disconnectTimeoutMs, "session disconnect");
  } catch (error) {
    disconnectError = new SessionRestoreError(
      "disconnect",
      error instanceof DeadlineExceededError ? "timeout" : "failed",
    );
  }

  if (writeError) throw writeError;
  if (disconnectError) throw disconnectError;
}

function parseSessionBundle(bundle: string): NormalizedSessionBundle {
  try {
    return normalizeBundle(JSON.parse(bundle));
  } catch {
    throw new SessionRestoreError("invalid_bundle", "failed");
  }
}

export interface WriteSessionOptions {
  connectTimeoutMs?: number;
  contextRetryMs?: number;
  writeTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  /** Clear stale browser auth even when the authoritative bundle is empty. */
  authoritative?: boolean;
  connect?: (endpoint: string, timeoutMs: number) => Promise<any>;
  sleep?: (ms: number) => Promise<void>;
  /** Fixed-label step logging (no endpoints, cookies, or payload values). */
  log?: (message: string) => void;
}

async function connectPersistentSessionBrowser(
  endpoint: string,
  options: WriteSessionOptions,
): Promise<any> {
  const connectTimeoutMs = Math.max(1, options.connectTimeoutMs ?? SESSION_CONNECT_TIMEOUT_MS);
  const contextRetryMs = Math.max(1, options.contextRetryMs ?? SESSION_CONTEXT_RETRY_MS);
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const connect = options.connect;
  if (!connect) throw new SessionRestoreError("connect", "failed");
  const deadline = Date.now() + connectTimeoutMs;
  let waitingFor: SessionRestoreOperation = "connect";

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new SessionRestoreError(waitingFor, "timeout");

    let browser: any;
    try {
      browser = await connect(endpoint, remainingMs);
    } catch {
      waitingFor = "connect";
      const retryInMs = Math.min(contextRetryMs, deadline - Date.now());
      if (retryInMs <= 0) throw new SessionRestoreError("connect", "timeout");
      await sleep(retryInMs);
      continue;
    }

    let persistentContext: any;
    try {
      persistentContext = browser.contexts()[0];
    } catch {
      persistentContext = undefined;
    }
    if (persistentContext) return browser;

    waitingFor = "context";
    try {
      const disconnectMs = Math.min(
        options.disconnectTimeoutMs ?? SESSION_DISCONNECT_TIMEOUT_MS,
        Math.max(1, deadline - Date.now()),
      );
      await withDeadline(
        Promise.resolve().then(() => browser.close()),
        disconnectMs,
        "session disconnect",
      );
    } catch (error) {
      throw new SessionRestoreError(
        "disconnect",
        error instanceof DeadlineExceededError ? "timeout" : "failed",
      );
    }

    const retryInMs = Math.min(contextRetryMs, deadline - Date.now());
    if (retryInMs <= 0) throw new SessionRestoreError("context", "timeout");
    await sleep(retryInMs);
  }
}

export async function writeSession(
  ws: string,
  bundle: string,
  options: WriteSessionOptions = {},
): Promise<void> {
  const parsed = parseSessionBundle(bundle);
  if (isSessionBundleEmpty(parsed) && !options.authoritative) return;
  if (options.connect) {
    const browser = await connectPersistentSessionBrowser(ws, options);
    await writeSessionToBrowser(browser, parsed, options);
    return;
  }
  try {
    await runPlaywrightWorker("session-restore", {
      endpoint: ws,
      bundle,
      urls: [],
      authoritative: !!options.authoritative,
      connectTimeoutMs: options.connectTimeoutMs ?? SESSION_CONNECT_TIMEOUT_MS,
    }, { timeoutMs: options.writeTimeoutMs ?? SESSION_WRITE_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof SessionRestoreError) throw error;
    if (error instanceof PlaywrightWorkerError && error.details?.operation) {
      throw new SessionRestoreError(
        error.details.operation as SessionRestoreOperation,
        error.details.outcome === "timeout" ? "timeout" : "failed",
      );
    }
    throw new SessionRestoreError("connect", error instanceof PlaywrightWorkerError && error.code === "timeout" ? "timeout" : "failed");
  }
}

/** A bundle with no cookies and no origin storage needs no browser attach at all. */
function isSessionBundleEmpty(parsed: NormalizedSessionBundle): boolean {
  return parsed.cookies.length === 0 && parsed.origins.length === 0;
}

/** Replace stale normal pages while keeping one blank tab and AliasMode-owned pages. */
async function restorePortableTabs(context: any, urls: readonly string[]): Promise<void> {
  const targets = urls
    .map(canonicalUserPageUrl)
    .filter((url: string | null): url is string => !!url);
  const existing = [...context.pages()];
  let blank = existing.find((page: any) => {
    try { return page.url() === "about:blank"; } catch { return false; }
  });
  if (!blank) blank = await context.newPage();

  let firstError: unknown;
  for (const page of existing) {
    let url = "";
    try { url = page.url(); } catch {}
    const disposable = canonicalUserPageUrl(url) !== null || (url === "about:blank" && page !== blank);
    if (!disposable) continue;
    try { await page.close(); } catch (error) { firstError ??= error; }
  }

  for (let index = 0; index < targets.length; index++) {
    const page = index === 0 ? blank : await context.newPage();
    try {
      await page.goto(targets[index]!, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

/**
 * ONE CDP attach for the whole Cloud open: wait for the persistent context,
 * restore the authoritative bundle (skipped when empty), replace portable tabs,
 * then detach exactly once. Replaces the probe/restore/navigate chain of
 * separate connects that hung against CloakBrowser's CDP server on real devices.
 */
export async function applySessionToEndpoint(
  ws: string,
  bundle: string,
  urls: readonly string[],
  options: WriteSessionOptions = {},
): Promise<void> {
  const parsed = parseSessionBundle(bundle);
  const empty = isSessionBundleEmpty(parsed);
  const navigationUrls = [...parsed.tabs, ...urls];
  if (options.connect) {
    const log = options.log ?? (() => {});
    const browser = await connectPersistentSessionBrowser(ws, options);
    try {
      if (!empty) await writeSessionToBrowser(browser, parsed, { ...options, disconnect: false });
      const context = browser.contexts()[0];
      if (!context) throw new SessionRestoreError("context", "failed");
      try {
        await restorePortableTabs(context, navigationUrls);
      } catch (error) {
        if (error instanceof SessionRestoreError) throw error;
        throw new SessionRestoreError("navigation", "failed");
      }
    } finally { await browser.close(); }
    log("session attach: detached");
    return;
  }
  try {
    await runPlaywrightWorker("session-restore", {
      endpoint: ws,
      bundle,
      urls: navigationUrls,
      replacePages: true,
      connectTimeoutMs: options.connectTimeoutMs ?? SESSION_CONNECT_TIMEOUT_MS,
    }, { timeoutMs: options.writeTimeoutMs ?? SESSION_WRITE_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof PlaywrightWorkerError && error.details?.operation) {
      throw new SessionRestoreError(
        error.details.operation as SessionRestoreOperation,
        error.details.outcome === "timeout" ? "timeout" : "failed",
      );
    }
    throw error;
  }
}

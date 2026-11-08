/**
 * Dashboard API — the `/ui/api/*` namespace consumed by the web UI.
 *
 * Kept entirely separate from the AdsPower-compatible API (server.ts /
 * handleRequest) so the `/api/v1|v2/*` compatibility contract is never touched.
 *
 * SECURITY: responses are redacted. They expose profile metadata (proxy
 * host:port, cookie COUNT, group, etc.) but NEVER secrets — no password, 2FA,
 * cookie values, or proxy credentials. Same rule the `inspect` command follows.
 */

import { BrowserLaunchError, defaultSetCookies, launchIdentityChanged, type Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { AutomationHealthStatus } from "./remote-types.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { AppConfigStore } from "./app-config.ts";
import type { CloudAuthRuntime } from "./cloud-auth.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import type {
  CloudBrowserCloseResult,
  CloudBrowserLifecycle,
} from "./cloud-browser.ts";
import type { StoreEventType } from "./contracts/cloud-v1.ts";
import type { McpTunnelLifecycle } from "./mcp-tunnel.ts";
import { normalizeCloudDiagnostics } from "./cloud-diagnostics.ts";
import { CloudApiError, CloudRequestError } from "./cloud-client.ts";
import { EmailVerificationRequiredError, SupabaseAuthRequestError } from "./supabase-auth.ts";
import {
  CloudProfileEditor,
  cloudProfileEditorErrorStatus,
} from "./cloud-profile-editor.ts";
import type { PendingSyncRuntime } from "./pending-sync.ts";
import type { StatePaths } from "./paths.ts";
import type { ChromiumRuntime, FingerprintVerdict, Profile, CookieRecord, ProxySpec } from "./types.ts";
import { checkProxy as runProxyCheck, type ProxyCheckResult } from "./proxy-check.ts";
import { handleProxyToolsRequest } from "./proxy-tools.ts";
import { handleTrashRequest } from "./trash.ts";
import { importInbox, importBuffers, prepareImportBuffers, ProfileImportError, type ImportOverrides } from "./inbox.ts";
import { hostChromiumRuntime, supportsChromium155Host } from "./aliasmode-chromium.ts";
import { buildNewProfile, defaultProfileEngine, type NewProfileInput } from "./create.ts";
import { firefoxGraphicsRenderer } from "./firefox-config.ts";
import { attachTimezones, lookupExitLocation, type FetchLike } from "./geoip.ts";
import { localeForCountry, localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";
import { parseUpdateFile, rowsToUpdates, serializeCsv, serializeAdsTxt, serializeXlsxRows, parseStrictProxy, parseStrictResolution, parseStrictPlatformOs, parseStrictTimezone, parseStrictCustomNo, parseStrictCores, parseStrictSeed, decodeText, parseCookieText, cookiesForEngine } from "./parse.ts";
import type { ProfileExport } from "./parse.ts";
import { writeXlsx, readXlsx } from "./xlsx.ts";
import { generateTotp } from "./totp.ts";
import {
  installExtension,
  installWebStoreExtension,
  parseWebStoreExtensionId,
  removeExtensionFiles,
  type ExtensionFetch,
} from "./extensions.ts";
import { decodePortableProfile } from "./portable-profile.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "./profile-id.ts";
import { normalizeProxySpec, proxyHostPort, proxyLegacyString, type ProxyInput } from "./proxy.ts";
import { convertMobilePersonaToDesktop, editedProfileHardware, isMobileUserAgent } from "./fingerprint.ts";
import { setFirefoxScreen, syncFirefoxTimezone } from "./firefox-config.ts";
import { join, resolve, dirname } from "node:path";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { validAgentAuthorization } from "./agent-control.ts";
import { ScriptError, prefetchPythonFor, type ScriptLibrary, type ScriptSupervisor } from "./scripts.ts";
import type { PythonRuntime } from "./python-runtime.ts";
import { runtimeDownloads } from "./runtime-download.ts";
import { loadServices } from "./services-directory.ts";

/** Readiness metadata supplied by the desktop parent process. */
export interface UiHealthMetadata {
  version: string;
  root: string;
  instance: string;
}

/** Redacted, dashboard-safe view of a profile + its live status. */
export interface UiProfile {
  id: string;
  name: string;
  /** Browser family. Legacy profiles without a value are Chromium. */
  engine: "chromium" | "firefox";
  /** Present only for the opt-in Chromium 155 beta. */
  chromiumRuntime?: ChromiumRuntime;
  group: string;
  /** Account platform: "x.com", "telegram.org", or "" (none). */
  platform: string;
  /** "host:port" only — never user/pass. Null when the profile has no proxy. */
  proxy: string | null;
  /** Safe validation message for a quarantined legacy proxy. */
  proxyError?: string;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  mobilePersona?: boolean;
  /** Whether a 2FA secret is stored (drives the row's authenticator button). */
  has2fa: boolean;
  /** Store serial (SQLite rowid) — the roster's default "No." for this profile. */
  serial: number | null;
  /** Creation time, ms. 0 for rows imported before the column existed. */
  createdAt: number;
  /** Most recent launch, ms. 0 when this profile has never been opened here. */
  lastOpenAt: number;
  /** Operator-chosen "custom NO.", or "" when the serial is used instead. */
  customNo: string;
  running: boolean;
  /** The open browser runs with an older proxy or fingerprint than the saved one. */
  restartPending?: boolean;
  /** Cookies added while the profile was closed; the next start sets them. */
  pendingCookieCount?: number;
  debugPort?: number;
  startedAt?: number;
  healthStatus?: AutomationHealthStatus;
  healthObservedAt?: number | null;
  /**
   * Whether the last launch's measured fingerprint still matches the one an
   * import claimed. Null when nothing was imported to check against — that is
   * "unknown", not "verified", and the dashboard must render it as neither.
   */
  fpVerdict: FingerprintVerdict | null;
  /** ISO-8601 instant of the last measurement; "" if never launched. */
  fpCapturedAt: string;
}

function profileEngine(profile: unknown): "chromium" | "firefox" {
  return typeof profile === "object" && profile !== null && "engine" in profile && profile.engine === "firefox"
    ? "firefox"
    : "chromium";
}

function openResponse(
  profile: unknown,
  result: { port?: number; warning?: string },
): Response {
  const engine = profileEngine(profile);
  return Response.json({
    ok: true,
    ...(engine === "firefox"
      ? { engine, capabilities: { cdp: false, pdf: false, chromeExtensions: false } }
      : { port: result.port }),
    ...(result.warning === undefined ? {} : { warning: result.warning }),
  });
}

/**
 * Map the store into redacted UiProfiles joined with running state. Status comes
 * from the launches table, which is authoritative for every browser THIS manager
 * started — campaign-launched or dashboard-launched alike (one manager per box).
 */
export function listUiProfiles(store: ProfileStore): UiProfile[] {
  const launches = new Map(store.listLaunches().map((l) => [l.profileId, l]));
  const meta = store.listProfileMeta();
  const pendingCookies = store.pendingCookieCounts();
  return store.listProfiles().map((p) => {
    const l = launches.get(p.id);
    return {
      id: p.id,
      name: p.name,
      engine: profileEngine(p),
      ...(p.chromiumRuntime ? { chromiumRuntime: p.chromiumRuntime } : {}),
      group: p.group,
      platform: p.platform ?? "",
      tags: p.tags ?? [],
      proxy: p.proxy ? proxyHostPort(p.proxy) : null,
      ...(p.proxyError ? { proxyError: p.proxyError } : {}),
      timezone: p.timezone,
      cookieCount: p.cookies.length,
      seeded: p.seeded,
      screen: `${p.screenWidth}x${p.screenHeight}`,
      has2fa: !!(p.twofa && p.twofa.trim()),
      serial: meta.get(p.id)?.serial ?? null,
      createdAt: meta.get(p.id)?.createdAt ?? 0,
      lastOpenAt: meta.get(p.id)?.lastOpenAt ?? 0,
      customNo: p.customNo ?? "",
      mobilePersona: isMobileUserAgent(p.ua),
      running: !!l,
      ...(l && launchIdentityChanged(p, l) ? { restartPending: true } : {}),
      ...(pendingCookies.get(p.id) ? { pendingCookieCount: pendingCookies.get(p.id) } : {}),
      ...(profileEngine(p) === "chromium" ? { debugPort: l?.debugPort } : {}),
      startedAt: l?.startedAt,
      // null when nothing was imported to check this profile against.
      fpVerdict: p.fpVerdict ?? null,
      fpCapturedAt: p.fpObserved?.capturedAt ?? "",
    };
  });
}

async function readLatestDiagnose(reportsRoot = "reports"): Promise<unknown | null> {
  try {
    const f = Bun.file(join(reportsRoot, "diagnose-latest.json"));
    if (!(await f.exists())) return null;
    return await f.json();
  } catch {
    return null;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Below 2 GB free Chromium gives sites no new storage and below 1 GB it evicts their data;
 * Firefox evicts the least recently used sites when the disk runs low. 5 GB warns before that.
 */
export const LOW_DISK_SPACE_BYTES = 5 * 1024 ** 3;

type CloudRestoreStage = "auth_refresh" | "cloud_status" | "lifecycle_resume";
type CloudRestoreCategory = "network" | "service" | "authentication";

interface CloudRestoreFailure {
  ok: false;
  error: string;
  stage: CloudRestoreStage;
  retryable: boolean;
  category: CloudRestoreCategory;
  code: string;
}

const PERMANENT_CLOUD_SESSION_ERRORS = new Set([
  "authentication_required",
  "email_not_verified",
  "device_revoked",
  "membership_revoked",
]);

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function cloudRestoreFailure(error: unknown, stage: CloudRestoreStage): CloudRestoreFailure {
  if (error instanceof EmailVerificationRequiredError) {
    return {
      ok: false,
      error: "Saved Cloud session is no longer valid. Sign in again.",
      stage,
      retryable: false,
      category: "authentication",
      code: "email_not_verified",
    };
  }
  if (error instanceof SupabaseAuthRequestError) {
    if (!error.failure.retryable) {
      return {
        ok: false,
        error: "Saved Cloud session is no longer valid. Sign in again.",
        stage,
        retryable: false,
        category: "authentication",
        code: "authentication_invalid",
      };
    }
    const network = error.failure.kind !== "http";
    return {
      ok: false,
      error: "Saved Cloud session could not be restored. Try again when the connection is available.",
      stage,
      retryable: true,
      category: network ? "network" : "service",
      code: network ? "network_unavailable" : "service_unavailable",
    };
  }
  if (error instanceof CloudRequestError) {
    return {
      ok: false,
      error: "Saved Cloud session could not be restored. Try again when the connection is available.",
      stage,
      retryable: true,
      category: "network",
      code: "network_unavailable",
    };
  }
  if (
    error instanceof CloudApiError
    && (error.status === 401 || PERMANENT_CLOUD_SESSION_ERRORS.has(error.code))
  ) {
    return {
      ok: false,
      error: "Saved Cloud session is no longer valid. Sign in again.",
      stage,
      retryable: false,
      category: "authentication",
      code: PERMANENT_CLOUD_SESSION_ERRORS.has(error.code) ? error.code : "authentication_invalid",
    };
  }
  if (
    error instanceof CloudApiError
    && (retryableHttpStatus(error.status) || error.code === "rate_limited" || error.code === "internal_error")
  ) {
    return {
      ok: false,
      error: "Saved Cloud session could not be restored. Try again when the connection is available.",
      stage,
      retryable: true,
      category: "service",
      code: "service_unavailable",
    };
  }
  return {
    ok: false,
    error: "Saved Cloud session could not be restored. Try again when the connection is available.",
    stage,
    retryable: true,
    category: "service",
    code: "response_invalid",
  };
}

const STORE_EVENT_TYPES = new Set<unknown>(["entry_click", "store_view", "pay_click"] satisfies StoreEventType[]);

/** A store placement slug such as `sidebar-cart`, or null. */
function storeSrc(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) ? value : null;
}

function rejectUntrustedJsonMutation(req: Request): Response | null {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ ok: false, error: "application/json is required" }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return Response.json({ ok: false, error: "cross-origin requests are forbidden" }, { status: 403 });
  }
  return null;
}

function normalizeCookieDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  if (!input || /[\x00-\x20\x7f]/.test(input)) return null;
  const includeSubdomains = input.startsWith(".");
  const candidate = includeSubdomains ? input.slice(1) : input;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return null;
    return includeSubdomains ? `.${hostname}` : hostname;
  } catch {
    return null;
  }
}

/** One cookie from the Add cookie form, or the reason it is invalid. */
function singleCookie(body: Record<string, unknown>): CookieRecord | string {
  const name = body.name;
  const value = body.value;
  const domain = normalizeCookieDomain(body.domain);
  const path = body.path === undefined ? "/" : body.path;
  if (typeof name !== "string" || !name || /[\s\x00-\x1f\x7f;=]/.test(name)) return "cookie name is invalid";
  if (typeof value !== "string" || /[\x00-\x1f\x7f;]/.test(value)) return "cookie value is invalid";
  if (!domain) return "cookie domain is invalid";
  if (typeof path !== "string" || !path.startsWith("/")) return "cookie path must start with /";
  return {
    name,
    value,
    domain,
    path,
    expires: Math.floor(Date.now() / 1_000) + 31_536_000,
    secure: true,
    sameSite: "Lax",
  };
}

function cloudCloseResponse(result: CloudBrowserCloseResult): Response {
  if (!result.closed) {
    return Response.json(
      { ok: false, error: "browser teardown unconfirmed" },
      { status: 500 },
    );
  }
  // The dashboard shows its own translated notice for this case. A conflict keeps its message.
  if (result.captureFailed && result.sync !== "conflict") {
    return Response.json({
      ok: true,
      sync: result.sync,
      captureFailed: true,
      warning: "Browser closed, but its latest session could not be read. Cloud keeps the last saved copy, and this device saves the newer session to Cloud the next time you open the profile here.",
    });
  }
  if (result.sync === "pending") {
    return Response.json({
      ok: true,
      sync: result.sync,
      warning: "Browser closed. Saving this profile to Cloud will retry automatically.",
    });
  }
  if (result.sync === "conflict") {
    return Response.json({
      ok: true,
      sync: result.sync,
      warning: "Browser closed, but Cloud could not accept the saved session. The encrypted snapshot remains on this device.",
    });
  }
  return Response.json({ ok: true, sync: result.sync });
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Shell UI language preference. localStorage cannot persist it: the desktop
// shell serves the UI from a random loopback port each launch, and localStorage
// is origin-scoped (http://127.0.0.1:PORT), so it is wiped on every restart.
// Persist to <state-root>/shell.json instead. The value is a BCP47 language
// tag validated by pattern only, so adding a locale never needs backend changes.
const SHELL_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

function shellLanguagePath(paths?: StatePaths): string | null {
  if (!paths?.root) return null;
  return join(paths.root, "shell.json");
}

/** The saved shell language, or null when the user never chose one (the UI then follows the system language). */
export function readShellLanguage(paths?: StatePaths): string | null {
  try {
    const file = shellLanguagePath(paths);
    if (!file) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { language?: unknown };
    if (typeof raw.language === "string" && SHELL_LANGUAGE_PATTERN.test(raw.language)) return raw.language;
  } catch {
    // Missing or corrupt file: nothing chosen yet.
  }
  return null;
}

export function writeShellLanguage(paths: StatePaths | undefined, language: string): void {
  if (!SHELL_LANGUAGE_PATTERN.test(language)) throw new Error(`Invalid language tag: ${language}`);
  const file = shellLanguagePath(paths);
  if (!file) throw new Error("Shell language storage is unavailable");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ language })}\n`, "utf8");
}

function proxyCheckView(result: ProxyCheckResult): ProxyCheckResult {
  return {
    status: result.status,
    attempts: result.attempts,
    successes: result.successes,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.ip ? { ip: result.ip } : {}),
    ...(result.country ? { country: result.country } : {}),
    ...(result.region ? { region: result.region } : {}),
    ...(result.city ? { city: result.city } : {}),
    ...(result.rotating !== undefined ? { rotating: result.rotating } : {}),
  };
}
const APPLICATION_ROOT = resolve(import.meta.dir);

let appVersionPromise: Promise<string> | null = null;
function appVersion(): Promise<string> {
  if (!appVersionPromise) {
    appVersionPromise = (async () => {
      try {
        const file = Bun.file(join(APPLICATION_ROOT, "VERSION.txt"));
        if (!(await file.exists())) return "dev";
        return (await file.text()).trim() || "dev";
      } catch {
        return "dev";
      }
    })();
  }
  return appVersionPromise;
}

/**
 * Full editable detail for the Edit modal — UNLIKE the redacted list view, this
 * DOES include the account secrets and full proxy creds, because you can't edit
 * what you can't see. Safe only because the dashboard is loopback-only (same
 * trust boundary as the `inspect` command).
 */
/** The hardware a profile is set to report, for display. Engines choose what is absent. */
function storedHardware(p: Profile): { gpu?: string; cores?: number } | undefined {
  // The card the browser shows, which is Apple's for a macOS profile saved with another.
  const gpu = p.firefox ? firefoxGraphicsRenderer(p) : undefined;
  const cores = p.hardware?.cores ?? p.firefox?.config["navigator.hardwareConcurrency"];
  const hardware = {
    ...(typeof gpu === "string" && gpu ? { gpu } : {}),
    ...(typeof cores === "number" ? { cores } : {}),
  };
  return Object.keys(hardware).length ? hardware : undefined;
}

function profileEditView(p: Profile) {
  const px = p.proxy;
  const proxy = px ? proxyLegacyString(px) : "";
  const conversion = isMobileUserAgent(p.ua) ? convertMobilePersonaToDesktop(p) : null;
  return {
    id: p.id, name: p.name, engine: profileEngine(p), ...(p.chromiumRuntime ? { chromiumRuntime: p.chromiumRuntime } : {}),
    ...(storedHardware(p) ? { hardware: storedHardware(p) } : {}),
    group: p.group, platform: p.platform ?? "",
    proxyType: px?.type ?? "http", proxy,
    ...(p.proxyError ? { proxyError: p.proxyError } : {}),
    username: p.username, password: p.password,
    email: p.email ?? "", emailPassword: p.emailPassword ?? "", twofa: p.twofa,
    resolution: `${p.screenWidth}*${p.screenHeight}`,
    extensions: p.extensions ?? [],
    tags: (p.tags ?? []).join(", "),
    customNo: p.customNo ?? "",
    platformOs: p.platformOs ?? "",
    timezone: p.timezone,
    ...(p.timezoneManual ? { timezoneManual: true } : {}),
    locale: p.locale ?? "",
    cores: p.hardware ? String(p.hardware.cores) : "",
    fingerprintSeed: String(p.fingerprintSeed),
    cookieCount: p.cookies.length, seeded: p.seeded,
    mobilePersona: !!conversion,
    ...(conversion ? {
      desktopConversion: {
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}*${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      },
    } : {}),
  };
}

/** `{ restartRequired: true }` when the open browser runs with an older proxy or fingerprint than the saved one. */
function restartRequired(store: ProfileStore, id: string): { restartRequired?: true } {
  const launch = store.getLaunch(id);
  const profile = launch ? store.getProfile(id) : null;
  return profile && launchIdentityChanged(profile, launch) ? { restartRequired: true } : {};
}

/**
 * Apply a partial field set onto a profile in place. Only keys present in `set`
 * change — everything else (cookies, fingerprint seed, seeded) is preserved.
 * This is what makes single-edit and file bulk-update safe. Shared by both.
 */
function applyEdits(p: Profile, set: Record<string, unknown>): boolean {
  let proxyChanged = false;
  if ("name" in set) p.name = String(set.name ?? "");
  if ("group" in set) p.group = String(set.group ?? "");
  if ("platform" in set) p.platform = String(set.platform ?? "");
  if ("username" in set) p.username = String(set.username ?? "");
  if ("password" in set) p.password = String(set.password ?? "");
  if ("email" in set) p.email = String(set.email ?? "");
  if ("emailPassword" in set) p.emailPassword = String(set.emailPassword ?? "");
  if ("twofa" in set) p.twofa = String(set.twofa ?? "");
  if ("resolution" in set) {
    const r = parseStrictResolution(set.resolution);
    if (profileEngine(p) === "firefox" && (p.screenWidth !== r.width || p.screenHeight !== r.height)) {
      setFirefoxScreen(p, r.width, r.height);
    }
    p.screenWidth = r.width;
    p.screenHeight = r.height;
  }
  if ("platformOs" in set) {
    const platformOs = parseStrictPlatformOs(set.platformOs);
    if (profileEngine(p) === "firefox" && platformOs !== (p.platformOs ?? "")) {
      throw new Error("Firefox operating system cannot be changed");
    }
    p.platformOs = platformOs;
  }
  if ("locale" in set) p.locale = normalizeProfileLocale(set.locale) ?? p.locale;
  if ("timezone" in set) {
    p.timezone = parseStrictTimezone(set.timezone);
    // A typed timezone stays when the proxy changes and on every launch. A blank one follows the proxy.
    if (p.timezone) p.timezoneManual = true;
    else delete p.timezoneManual;
    syncFirefoxTimezone(p);
  }
  if ("fingerprintSeed" in set) p.fingerprintSeed = parseStrictSeed(set.fingerprintSeed);
  if ("cores" in set) {
    const hardware = editedProfileHardware(p, parseStrictCores(set.cores));
    if (hardware) p.hardware = hardware;
    else delete p.hardware;
  }
  if ("proxy" in set) {
    const nextProxy = parseStrictProxy(set.proxyType ?? p.proxy?.type ?? "http", set.proxy);
    const previousProxy = p.proxy;
    proxyChanged = !!p.proxyError ||
      previousProxy?.type !== nextProxy?.type ||
      previousProxy?.host !== nextProxy?.host ||
      previousProxy?.port !== nextProxy?.port ||
      previousProxy?.user !== nextProxy?.user ||
      previousProxy?.pass !== nextProxy?.pass;
    p.proxy = nextProxy;
    delete p.proxyError;
  }
  if ("extensions" in set) {
    const extensions = Array.isArray(set.extensions) ? set.extensions.map(String) : [];
    if (profileEngine(p) === "firefox" && extensions.length > 0) {
      throw new Error("Chrome extensions are unavailable for Firefox profiles");
    }
    p.extensions = extensions;
  }
  if ("tags" in set) {
    p.tags = Array.isArray(set.tags)
      ? set.tags.map(String)
      : String(set.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  }
  if ("customNo" in set) p.customNo = parseStrictCustomNo(set.customNo);
  return proxyChanged;
}

function legalAcceptanceIsCurrent(legal: {
  current: { terms: string; privacy: string; acceptableUse: string };
  accepted: { terms: string; privacy: string; acceptableUse: string } | null;
}): boolean {
  return !!legal.accepted &&
    legal.accepted.terms === legal.current.terms &&
    legal.accepted.privacy === legal.current.privacy &&
    legal.accepted.acceptableUse === legal.current.acceptableUse;
}

export interface UiRuntimeOptions {
  scripts?: { library: ScriptLibrary; runner: ScriptSupervisor; nonce: string; python?: PythonRuntime };
  appConfig?: AppConfigStore;
  paths?: StatePaths;
  defaultCloudUrl?: string;
  cloudAuth?: CloudAuthRuntime;
  cloudConnection?: CloudConnectionRuntime;
  pendingSync?: PendingSyncRuntime;
  cloudBrowser?: CloudBrowserLifecycle;
  mcpTunnel?: McpTunnelLifecycle;
  health?: UiHealthMetadata | null;
  timezoneFetch?: FetchLike;
  proxyCheck?: (proxy: ProxySpec) => Promise<ProxyCheckResult>;
  extensionFetch?: ExtensionFetch;
  servicesFetch?: typeof fetch;
  /** Sets cookies in an open browser. Defaults to Playwright's addCookies. */
  setCookies?: (ws: string, cookies: CookieRecord[]) => Promise<void>;
  /** Mode whose runtimes were wired when this process started. */
  runtimeMode?: "unconfigured" | "local" | "cloud";
}

/**
 * Handle a `/ui/api/*` request. Returns null for any other path so the caller
 * can fall through to the AdsPower API handler.
 */
export async function handleUiRequest(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  remote?: RemoteCoordinator | null,
  options: UiRuntimeOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/ui/api/")) return null;

  if (pathname === "/ui/api/scripts" || pathname.startsWith("/ui/api/scripts/")) {
    const scripts = options.scripts;
    if (!scripts) return noStoreJson({ ok: false, error: "Scripts require the desktop app" }, 503);
    if (!validAgentAuthorization(req.headers.get("authorization"), scripts.nonce)) {
      return noStoreJson({ ok: false, error: "Script authorization failed" }, 401);
    }
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin) return noStoreJson({ ok: false, error: "Cross-origin requests are forbidden" }, 403);
    if (req.method !== "GET") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    try {
      if (pathname === "/ui/api/scripts/run") {
        if (req.method === "GET") return noStoreJson({ ok: true, run: scripts.runner.status() });
        if (req.method === "POST") return noStoreJson({ ok: true, run: scripts.runner.start(await req.json()) });
      }
      if (pathname === "/ui/api/scripts/stop" && req.method === "POST") {
        return noStoreJson({ ok: true, run: await scripts.runner.stop() });
      }
      if (pathname === "/ui/api/scripts/python-runtime") {
        // null: a source checkout runs Python scripts on python3 and downloads nothing.
        if (req.method === "POST") scripts.python?.ensure().catch(() => {});
        if (req.method === "GET" || req.method === "POST") return noStoreJson({ ok: true, python: scripts.python?.status() ?? null });
      }
      if (pathname === "/ui/api/scripts/log" && req.method === "GET") {
        const params = new URL(req.url).searchParams;
        return noStoreJson({ ok: true, ...scripts.runner.log(params.get("runId") ?? "", Number(params.get("offset") ?? 0)) });
      }
      if (pathname === "/ui/api/scripts/library" && req.method === "GET") {
        const params = new URL(req.url).searchParams;
        const language = params.get("language") || undefined;
        if (language !== undefined && language !== "javascript" && language !== "python") throw new ScriptError("Unsupported script language");
        return noStoreJson(await scripts.library.browse({
          q: params.get("q") ?? undefined,
          language: language || undefined,
          offset: params.has("offset") ? Number(params.get("offset")) : undefined,
        }));
      }
      const publicMatch = pathname.match(/^\/ui\/api\/scripts\/library\/([^/]+)(\/import)?$/);
      if (publicMatch) {
        const id = decodeURIComponent(publicMatch[1]!);
        if (!publicMatch[2] && req.method === "GET") return noStoreJson({ ok: true, script: await scripts.library.viewPublished(id) });
        if (publicMatch[2] && req.method === "POST") {
          const script = await scripts.library.importPublished(id);
          prefetchPythonFor(scripts.python, [script]);
          return noStoreJson({ ok: true, script });
        }
      }
      const publicationMatch = pathname.match(/^\/ui\/api\/scripts\/([^/]+)\/publication$/);
      if (publicationMatch) {
        const id = decodeURIComponent(publicationMatch[1]!);
        if (req.method === "PUT") return noStoreJson({ ok: true, script: await scripts.library.publish(id, await req.json()) });
        if (req.method === "DELETE") {
          await scripts.library.unpublish(id);
          return noStoreJson({ ok: true, unpublished: true });
        }
      }
      // Having or adding a Python script starts the Python runtime download in the background.
      if (pathname === "/ui/api/scripts") {
        if (req.method === "GET") {
          const info = await scripts.library.info();
          prefetchPythonFor(scripts.python, info.scripts);
          return noStoreJson({ ok: true, ...info });
        }
        if (req.method === "POST") {
          const script = await scripts.library.save(await req.json());
          prefetchPythonFor(scripts.python, [script]);
          return noStoreJson({ ok: true, script });
        }
      }
      const match = pathname.match(/^\/ui\/api\/scripts\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (req.method === "GET") return noStoreJson({ ok: true, script: await scripts.library.get(id) });
        if (req.method === "PATCH") {
          const body = await req.json();
          const script = await scripts.library.save(body, id, body?.expectedRevision);
          prefetchPythonFor(scripts.python, [script]);
          return noStoreJson({ ok: true, script });
        }
        if (req.method === "DELETE") {
          const body = await req.json();
          await scripts.library.delete(id, body?.expectedRevision);
          return noStoreJson({ ok: true });
        }
      }
      return noStoreJson({ ok: false, error: "Unknown script operation" }, 404);
    } catch (error) {
      const status = error instanceof ScriptError || error instanceof CloudApiError ? error.status
        : error instanceof CloudRequestError ? 502 : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      return noStoreJson({ ok: false, error: error instanceof SyntaxError ? "Invalid JSON request" : msg(error) }, status);
    }
  }

  // Dependency-free readiness probe for the Windows updater. Unlike the
  // profile roster it does not touch CDP, the process scanner, SQLite rows, or
  // the remote hub, so an upstream outage cannot masquerade as a failed update.
  if (pathname === "/ui/api/health" && req.method === "GET") {
    const logDir = options.paths ? join(options.paths.root, "logs") : undefined;
    return Response.json(options.health
      ? { ok: true, ...options.health, ...(logDir ? { logDir } : {}) }
      : { ok: true, version: await appVersion(), root: APPLICATION_ROOT, ...(logDir ? { logDir } : {}) });
  }

  // Warning only: under storage pressure both engines evict saved site data.
  if (pathname === "/ui/api/disk-space" && req.method === "GET") {
    const freeBytes = launcher.dataDriveFreeBytes();
    return noStoreJson({ ok: true, freeBytes, low: freeBytes !== null && freeBytes < LOW_DISK_SPACE_BYTES });
  }

  if (pathname === "/ui/api/logs" && req.method === "GET") {
    if (!options.paths) return Response.json({ ok: false, error: "logs are unavailable" }, { status: 503 });
    try {
      const dir = join(options.paths.root, "logs");
      const name = readdirSync(dir).filter((f) => /^aliasmode-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().pop();
      if (!name) return Response.json({ ok: false, error: "no log file yet" });
      const content = readFileSync(join(dir, name), "utf8");
      return Response.json({ ok: true, file: name, content: content.slice(-64 * 1024) });
    } catch {
      return Response.json({ ok: false, error: "log file could not be read" });
    }
  }

  if (pathname === "/ui/api/app-mode" && req.method === "GET") {
    const config = options.appConfig?.read() ?? { version: 1 as const, mode: "local" as const, localAnalytics: false };
    return Response.json({
      ...config,
      ...(remote ? { legacyRemote: true } : {}),
      ...(options.runtimeMode ? { restartRequired: config.mode !== options.runtimeMode } : {}),
      ...(hostChromiumRuntime() ? { chromiumRuntime: hostChromiumRuntime() } : {}),
      ...(!remote && supportsChromium155Host(process.platform, process.arch) ? { defaultChromiumRuntime: "aliasmode" } : {}),
      ...(!remote ? { defaultEngine: defaultProfileEngine() } : {}),
    });
  }

  if (pathname === "/ui/api/shell-language" && req.method === "GET") {
    return noStoreJson({ language: readShellLanguage(options.paths) });
  }

  if (pathname === "/ui/api/shell-language" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { language?: unknown };
    const language = typeof body.language === "string" && SHELL_LANGUAGE_PATTERN.test(body.language)
      ? body.language
      : "en-US";
    try {
      writeShellLanguage(options.paths, language);
    } catch {
      return noStoreJson({ ok: false, error: "Could not save language preference" }, 500);
    }
    return noStoreJson({ ok: true, language });
  }

  // The Services page asks for its list only when it opens.
  if (pathname === "/ui/api/services" && req.method === "GET") {
    return noStoreJson(await loadServices(options.servicesFetch));
  }

  if (pathname === "/ui/api/services/visibility" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (!options.appConfig) return noStoreJson({ ok: false, error: "app configuration is unavailable" }, 503);
    const body = (await req.json().catch(() => ({}))) as { hidden?: unknown };
    if (typeof body.hidden !== "boolean") return noStoreJson({ ok: false, error: "hidden must be true or false" }, 400);
    const config = options.appConfig.write({ ...options.appConfig.read(), servicesHidden: body.hidden });
    return noStoreJson({ ok: true, hidden: config.servicesHidden === true });
  }

  if (pathname === "/ui/api/cloud-events" && req.method === "GET") {
    return Response.json(
      { events: normalizeCloudDiagnostics(options.cloudBrowser?.diagnostics?.() ?? []) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Browser runtimes downloading now, so the dashboard can show their progress.
  if (pathname === "/ui/api/runtime-downloads" && req.method === "GET") {
    return noStoreJson({ downloads: runtimeDownloads() });
  }

  if (pathname === "/ui/api/proxy/check" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }
    let proxy: ProxySpec;
    try {
      const body = await req.json() as { proxy?: unknown };
      if (!body || typeof body !== "object" || !body.proxy || typeof body.proxy !== "object" || Array.isArray(body.proxy)) {
        throw new Error("invalid proxy input");
      }
      const normalized = normalizeProxySpec(body.proxy as ProxyInput);
      if (!normalized || (normalized.type !== "http" && normalized.type !== "socks5")) {
        throw new Error("unsupported proxy input");
      }
      proxy = normalized;
    } catch {
      return noStoreJson({ ok: false, error: "Invalid proxy settings" }, 400);
    }
    try {
      const result = await (options.proxyCheck ?? runProxyCheck)(proxy);
      return noStoreJson({ ok: true, ...proxyCheckView(result) });
    } catch {
      return noStoreJson({ ok: false, error: "Proxy check failed" }, 500);
    }
  }

  if (pathname === "/ui/api/app-mode" && req.method === "POST") {
    if (!options.appConfig) return Response.json({ ok: false, error: "app configuration is unavailable" }, { status: 503 });
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = await req.json() as { mode?: unknown };
      if (body.mode !== "local" && body.mode !== "cloud") {
        return Response.json({ ok: false, error: "mode must be local or cloud" }, { status: 400 });
      }
      const cloudUrl = options.defaultCloudUrl;
      if (body.mode === "cloud" && !cloudUrl) {
        return Response.json(
          { ok: false, error: "AliasMode Cloud is not configured in this build" },
          { status: 503 },
        );
      }
      const config = options.appConfig.setMode(body.mode, cloudUrl);
      return Response.json({
        ok: true,
        config,
        restartRequired: options.runtimeMode ? config.mode !== options.runtimeMode : true,
      });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }

  if (pathname === "/ui/api/cloud-auth" && req.method === "GET") {
    if (!options.cloudAuth) {
      return Response.json({ ok: false, error: "AliasMode Cloud authentication is unavailable" }, { status: 503 });
    }
    const state = options.cloudAuth.state();
    if (!state.authenticated || !options.cloudConnection?.accountId()) {
      return Response.json({ ok: true, ...state });
    }
    try {
      const status = await options.cloudConnection.client.status();
      return Response.json({ ok: true, ...state, workspace: status.workspace, legal: status.legal });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }

  if (pathname.startsWith("/ui/api/cloud-auth/") && req.method === "POST") {
    if (!options.cloudAuth) {
      return Response.json({ ok: false, error: "AliasMode Cloud authentication is unavailable" }, { status: 503 });
    }
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    const exitsAccount = pathname === "/ui/api/cloud-auth/signout" ||
      pathname === "/ui/api/cloud-auth/forget";
    const finishAccountExit = exitsAccount ? options.cloudAuth.beginExit() : undefined;
    const resumeScripts = exitsAccount ? options.scripts?.runner.pause() : undefined;
    const authTransition = exitsAccount ? undefined : await options.cloudAuth.acquireTransition();
    const transitionCurrent = () => !authTransition || options.cloudAuth!.isTransitionCurrent(authTransition);
    try {
      if (!transitionCurrent()) {
        return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
      }
      const body = await req.json() as {
        email?: unknown;
        password?: unknown;
        refreshToken?: unknown;
        deviceId?: unknown;
        deviceCredential?: unknown;
        queueKey?: unknown;
        resumeLifecycle?: unknown;
        code?: unknown;
      };
      if (exitsAccount) await options.scripts?.runner.stop();
      if (pathname === "/ui/api/cloud-auth/signup") {
        if (typeof body.email !== "string" || typeof body.password !== "string") {
          return Response.json({ ok: false, error: "email and password are required" }, { status: 400 });
        }
        const result = await options.cloudAuth.signUp(body.email, body.password);
        return Response.json({
          ok: true,
          verificationRequired: result.verificationRequired,
          user: { id: result.user.id, email: result.user.email },
        });
      }
      if (pathname === "/ui/api/cloud-auth/resend-signup") {
        if (typeof body.email !== "string" || !body.email) {
          return Response.json({ ok: false, error: "email is required" }, { status: 400 });
        }
        await options.cloudAuth.resendSignUpConfirmation(body.email);
        return Response.json({ ok: true });
      }
      if (pathname === "/ui/api/cloud-auth/verify-signup") {
        if (typeof body.email !== "string" || !body.email || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
          return Response.json({ ok: false, error: "Enter the 6-digit code from the email." }, { status: 400 });
        }
        try {
          await options.cloudAuth.verifySignUpCode(body.email, body.code);
        } catch (error) {
          // Auth answers a wrong or expired code with 403 otp_expired.
          if (error instanceof SupabaseAuthRequestError && error.failure.kind === "http" && (error.failure.status === 403 || error.failure.code === "otp_expired")) {
            return Response.json({ ok: false, error: "The code is wrong or has expired.", code: "otp_invalid" }, { status: 400 });
          }
          throw error;
        }
        return Response.json({ ok: true });
      }
      if (pathname === "/ui/api/cloud-auth/forgot-password") {
        if (typeof body.email !== "string" || !body.email) {
          return Response.json({ ok: false, error: "email is required" }, { status: 400 });
        }
        try {
          await options.cloudAuth.requestPasswordReset(body.email);
        } catch (error) {
          // Auth throttles repeat reset emails per address; keep the reply neutral.
          if (!(error instanceof SupabaseAuthRequestError && error.failure.kind === "http" && error.failure.status === 429)) throw error;
        }
        return Response.json({ ok: true });
      }
      if (pathname === "/ui/api/cloud-auth/signin") {
        if (typeof body.email !== "string" || typeof body.password !== "string") {
          return Response.json({ ok: false, error: "email and password are required" }, { status: 400 });
        }
        if (!options.cloudConnection || !options.pendingSync) {
          return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
        }
        if (!options.cloudAuth.canSignIn()) {
          return Response.json(
            { ok: false, error: "Sign out before signing in to another Cloud account" },
            { status: 409 },
          );
        }
        if (body.queueKey !== undefined && (typeof body.queueKey !== "string" || !body.queueKey)) {
          return Response.json({ ok: false, error: "stored queue encryption key is invalid" }, { status: 400 });
        }
        const activeQueue = options.pendingSync.queue();
        const pending = activeQueue
          ? { queue: activeQueue, createdKey: undefined }
          : options.pendingSync.hasStoredState() || body.queueKey
            ? options.pendingSync.initialize(body.queueKey as string | undefined)
            : undefined;
        try {
          const result = await options.cloudAuth.signIn(body.email, body.password);
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          const bootstrap = await options.cloudConnection.bootstrap(transitionCurrent);
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          const initialized = pending ?? options.pendingSync.initialize();
          if (legalAcceptanceIsCurrent(bootstrap.legal)) {
            await options.cloudBrowser?.resumeAfterAuthentication(transitionCurrent);
          } else {
            await options.cloudBrowser?.secureAfterAuthentication(transitionCurrent);
          }
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          options.mcpTunnel?.refresh();
          return Response.json({
            ok: true,
            authenticated: true,
            refreshToken: result.refreshToken,
            deviceId: bootstrap.device.id,
            deviceCredential: bootstrap.deviceCredential,
            ...(initialized.createdKey ? { queueKey: initialized.createdKey } : {}),
            ...(options.pendingSync.persistsQueueKey() ? { queueKeyPersisted: true } : {}),
            expiresAt: result.expiresAt,
            legal: bootstrap.legal,
            workspace: bootstrap.workspace,
            user: { id: result.user?.id, email: result.user?.email },
          });
        } catch (error) {
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          await options.mcpTunnel?.disconnect();
          options.pendingSync.close();
          options.cloudAuth.clear();
          options.cloudConnection.clearDevice();
          throw error;
        }
      }
      if (pathname === "/ui/api/cloud-auth/restore") {
        if (typeof body.refreshToken !== "string" || !body.refreshToken) {
          return Response.json({ ok: false, error: "refresh token is required" }, { status: 400 });
        }
        if (!options.cloudConnection || typeof body.deviceCredential !== "string" || !body.deviceCredential) {
          return Response.json({ ok: false, error: "stored device credential is required" }, { status: 400 });
        }
        if (!options.pendingSync || typeof body.queueKey !== "string" || !body.queueKey) {
          return Response.json({ ok: false, error: "stored queue encryption key is required" }, { status: 400 });
        }
        if (!options.cloudAuth.canRestore(body.refreshToken)) {
          return Response.json(
            { ok: false, error: "Sign out before restoring another Cloud account" },
            { status: 409 },
          );
        }
        if (body.resumeLifecycle !== undefined && typeof body.resumeLifecycle !== "boolean") {
          return Response.json({ ok: false, error: "resumeLifecycle must be boolean" }, { status: 400 });
        }
        let stage: CloudRestoreStage = "auth_refresh";
        try {
          const queueWasInitialized = !!options.pendingSync.queue();
          if (!queueWasInitialized) options.pendingSync.initialize(body.queueKey);
          const priorAccountId = options.cloudConnection.accountId();
          const result = await options.cloudAuth.restore(body.refreshToken);
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          stage = "cloud_status";
          options.cloudConnection.restoreCredential(body.deviceCredential);
          const status = await options.cloudConnection.client.status();
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          options.cloudConnection.restoreAccount(status.account.id);
          options.cloudConnection.restoreDevice(status.device.id, body.deviceCredential);
          stage = "lifecycle_resume";
          if (
            legalAcceptanceIsCurrent(status.legal) &&
            (body.resumeLifecycle === true || !queueWasInitialized || (priorAccountId && priorAccountId !== status.account.id))
          ) {
            await options.cloudBrowser?.resumeAfterAuthentication(transitionCurrent);
          } else {
            await options.cloudBrowser?.secureAfterAuthentication(transitionCurrent);
          }
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          options.mcpTunnel?.refresh();
          return Response.json({
            ok: true,
            authenticated: true,
            refreshToken: result.refreshToken,
            deviceId: status.device.id,
            expiresAt: result.expiresAt,
            legal: status.legal,
            workspace: status.workspace,
            user: { id: result.user?.id, email: result.user?.email },
          });
        } catch (error) {
          if (!transitionCurrent()) {
            return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
          }
          const failure = cloudRestoreFailure(error, stage);
          if (!failure.retryable) {
            await options.mcpTunnel?.disconnect();
            options.pendingSync.close();
            options.cloudConnection.clearDevice();
            await options.cloudAuth.clearStoredSession().catch(() => {});
          }
          return Response.json(failure, { status: failure.retryable ? 503 : 401 });
        }
      }
      if (pathname === "/ui/api/cloud-auth/accept-invitation") {
        if (!options.cloudConnection || typeof body.code !== "string" || !body.code.trim()) {
          return Response.json({ ok: false, error: "invitation code is required" }, { status: 400 });
        }
        return Response.json(await options.cloudConnection.client.acceptInvitation(body.code.trim()));
      }
      if (pathname === "/ui/api/cloud-auth/accept-legal") {
        if (!options.cloudConnection) {
          return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
        }
        const status = await options.cloudConnection.client.status();
        if (!transitionCurrent()) {
          return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
        }
        const accepted = await options.cloudConnection.client.acceptLegal({ versions: status.legal.current });
        if (!transitionCurrent()) {
          return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
        }
        await options.cloudBrowser?.resumeAfterAuthentication(transitionCurrent);
        if (!transitionCurrent()) {
          return Response.json({ ok: false, error: "Cloud authentication was cancelled" }, { status: 409 });
        }
        options.mcpTunnel?.refresh();
        return Response.json({
          ok: true,
          legal: { current: status.legal.current, accepted: accepted.accepted },
        });
      }
      if (pathname === "/ui/api/cloud-auth/forget") {
        await options.mcpTunnel?.disconnect();
        if (options.cloudBrowser && !await options.cloudBrowser.releaseAll()) {
          options.mcpTunnel?.refresh();
          return Response.json(
            { ok: false, error: "Cloud browsers could not be closed safely" },
            { status: 409 },
          );
        }
        options.pendingSync?.close();
        options.cloudConnection?.clearDevice();
        await options.cloudAuth.clearStoredSession();
        return Response.json({ ok: true });
      }
      if (pathname === "/ui/api/cloud-auth/signout") {
        await options.mcpTunnel?.disconnect();
        if (options.cloudBrowser && !await options.cloudBrowser.releaseAll()) {
          options.mcpTunnel?.refresh();
          return Response.json(
            { ok: false, error: "Cloud browsers could not be closed safely" },
            { status: 409 },
          );
        }
        options.pendingSync?.close();
        options.cloudConnection?.clearDevice();
        await options.cloudAuth.signOut();
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unknown Cloud auth action" }, { status: 404 });
    } catch (error) {
      // Auth error codes such as email_not_confirmed let the dashboard pick the next step.
      const code = error instanceof SupabaseAuthRequestError && error.failure.kind === "http" ? error.failure.code : undefined;
      return Response.json({ ok: false, error: msg(error), ...(code ? { code } : {}) }, { status: 400 });
    } finally {
      authTransition?.release();
      finishAccountExit?.();
      resumeScripts?.();
    }
  }

  if (pathname === "/ui/api/cloud-connector" && req.method === "POST") {
    if (!options.cloudConnection) {
      return noStoreJson({ ok: false, error: "AliasMode Cloud connection is unavailable" }, 503);
    }
    if (!options.cloudConnection.accountId() || !options.cloudConnection.deviceId()) {
      return noStoreJson({ ok: false, error: "AliasMode Cloud authentication is required" }, 401);
    }
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }
    try {
      const body = await req.json() as { action?: unknown; connectorId?: unknown };
      const cloud = options.cloudConnection.client;
      if (body.action === "create") {
        const created = await cloud.createMcpConnector("AliasMode Settings");
        return noStoreJson({
          ok: true,
          state: "active",
          connectorId: created.connector.id,
          deviceId: created.connector.deviceId,
          url: cloud.remoteMcpUrl(created.connector.deviceId),
          token: created.token,
        });
      }
      if (body.action !== "status" && body.action !== "revoke") {
        return noStoreJson({ ok: false, error: "unknown Cloud connector action" }, 400);
      }
      if (typeof body.connectorId !== "string" || !body.connectorId) {
        return noStoreJson({ ok: false, error: "connectorId is required" }, 400);
      }
      const listed = await cloud.listMcpConnectors();
      const connector = listed.connectors.find((candidate) => candidate.id === body.connectorId);
      if (body.action === "status") {
        return noStoreJson({
          ok: true,
          state: !connector ? "missing" : connector.revokedAt === null ? "active" : "revoked",
          url: cloud.remoteMcpUrl(options.cloudConnection.deviceId()!),
        });
      }
      if (connector && connector.revokedAt === null) {
        await cloud.revokeMcpConnector(connector.id);
      }
      return noStoreJson({ ok: true, state: "disabled" });
    } catch (error) {
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError ? 502 : 400;
      return noStoreJson({ ok: false, error: msg(error) }, status);
    }
  }

  if (pathname === "/ui/api/cloud-workspace" && (req.method === "GET" || req.method === "POST")) {
    if (!options.cloudConnection) return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
    try {
      const cloud = options.cloudConnection.client;
      if (req.method === "GET") {
        const [status, folders, members] = await Promise.all([
          cloud.status(), cloud.listFolders(), cloud.listMembers(),
        ]);
        const invitations = status.workspace.role === "member"
          ? { invitations: [] }
          : await cloud.listInvitations();
        return Response.json({ ok: true, folders: folders.folders, members: members.members, invitations: invitations.invitations });
      }
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
      const body = await req.json() as Record<string, unknown>;
      const action = String(body.action ?? "");
      if (action === "invite") return Response.json(await cloud.createInvitation(String(body.email ?? ""), body.role === "admin" ? "admin" : "member"));
      if (action === "create-folder") return Response.json(await cloud.createFolder(String(body.name ?? ""), typeof body.parentName === "string" ? body.parentName : null));
      if (action === "move-folder") return Response.json(await cloud.moveFolder(String(body.name ?? ""), typeof body.parentName === "string" ? body.parentName : null));
      if (action === "profile-grant") return Response.json(await cloud.setProfileGrant(String(body.profileId ?? ""), String(body.accountId ?? ""), body.permission === "edit" ? "edit" : "view"));
      if (action === "remove-profile-grant") return Response.json(await cloud.removeProfileGrant(String(body.profileId ?? ""), String(body.accountId ?? "")));
      if (action === "delete-folder") return Response.json(await cloud.deleteFolder(String(body.name ?? "")));
      if (action === "resend") return Response.json(await cloud.resendInvitation(String(body.id ?? "")));
      if (action === "revoke") return Response.json(await cloud.revokeInvitation(String(body.id ?? "")));
      if (action === "role") return Response.json(await cloud.changeMemberRole(String(body.accountId ?? ""), body.role === "admin" ? "admin" : "member"));
      if (action === "reset-password") return Response.json(await cloud.sendMemberPasswordReset(String(body.accountId ?? "")));
      if (action === "remove-member") return Response.json(await cloud.removeMember(String(body.accountId ?? "")));
      if (action === "grant") return Response.json(await cloud.setFolderGrant(String(body.folderName ?? ""), String(body.accountId ?? ""), body.permission === "edit" ? "edit" : "view"));
      if (action === "remove-grant") return Response.json(await cloud.removeFolderGrant(String(body.folderName ?? ""), String(body.accountId ?? "")));
      return Response.json({ ok: false, error: "unknown Cloud workspace action" }, { status: 400 });
    } catch (error) {
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError ? 502 : 400;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  if (pathname === "/ui/api/cloud-store" && (req.method === "GET" || req.method === "POST")) {
    if (!options.cloudConnection) return noStoreJson({ ok: false, error: "AliasMode Cloud connection is unavailable" }, 503);
    const cloud = options.cloudConnection.client;
    try {
      if (req.method === "GET") {
        // Cloud bodies pass through unchanged. The catalog comes from NobleProxy and can be down
        // (503 partner_unavailable); the wallet and the owned proxies still show without it.
        const catalog = cloud.getProxyCatalog().then(
          (value) => ({ catalog: value }),
          () => ({ catalog: null }),
        );
        const [wallet, proxies] = await Promise.all([cloud.getWallet(), cloud.listPurchasedProxies()]);
        return noStoreJson({ ok: true, available: true, wallet, proxies, ...await catalog });
      }
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
      const body = await req.json() as Record<string, unknown>;
      const text = (value: unknown) => typeof value === "string" && value ? value : null;
      const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
      if (body.action === "deposit") {
        const amountCents = count(body.amountCents);
        if (!amountCents || (body.method !== "card" && body.method !== "crypto")) return noStoreJson({ ok: false, error: "Enter an amount and a payment method" }, 400);
        return noStoreJson(await cloud.createDeposit({ amountCents, method: body.method }));
      }
      if (body.action === "deposit-status") {
        const depositId = text(body.depositId);
        if (!depositId) return noStoreJson({ ok: false, error: "depositId is required" }, 400);
        return noStoreJson(await cloud.getDeposit(depositId));
      }
      if (body.action === "purchase") {
        const type = text(body.type), country = text(body.country), quantity = count(body.quantity), idempotencyKey = text(body.idempotencyKey);
        if (!type || !country || !quantity || !idempotencyKey) return noStoreJson({ ok: false, error: "Choose a proxy type, country and quantity" }, 400);
        const src = storeSrc(body.src);
        try {
          return noStoreJson(await cloud.purchaseProxies({ type, country, quantity, idempotencyKey, ...(src ? { src } : {}) }));
        } catch (error) {
          // A Cloud without `src` rejects the field before it charges anything: buy again without it, same key.
          if (!src || !(error instanceof CloudApiError && error.code === "validation_failed")) throw error;
          return noStoreJson(await cloud.purchaseProxies({ type, country, quantity, idempotencyKey }));
        }
      }
      if (body.action === "store-events") {
        // Only the type, the placement slug and the time go to Cloud.
        const events = (Array.isArray(body.events) ? body.events : []).flatMap((event: any) => {
          const src = storeSrc(event?.src);
          return STORE_EVENT_TYPES.has(event?.type) && src && Number.isSafeInteger(event?.at) && event.at > 0
            ? [{ type: event.type, src, at: event.at }] : [];
        });
        if (!events.length) return noStoreJson({ ok: false, error: "events are required" }, 400);
        return noStoreJson(await cloud.postStoreEvents({ events }));
      }
      if (body.action === "auto-renew") {
        const orderId = text(body.orderId);
        if (!orderId || typeof body.enabled !== "boolean") return noStoreJson({ ok: false, error: "orderId and enabled are required" }, 400);
        return noStoreJson(await cloud.setProxyAutoRenew(orderId, body.enabled));
      }
      if (body.action === "nobleproxy-handoff") return noStoreJson(await cloud.createNobleProxyHandoff());
      return noStoreJson({ ok: false, error: "unknown Cloud store action" }, 400);
    } catch (error) {
      // An older Cloud has no wallet or store yet: the app keeps the outside offer link.
      if (req.method === "GET" && error instanceof CloudApiError && error.status === 404) return noStoreJson({ ok: true, available: false });
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError ? 502 : 400;
      return noStoreJson({ ok: false, error: msg(error), ...(error instanceof CloudApiError ? { code: error.code } : {}) }, status);
    }
  }

  if (options.appConfig?.read().mode === "cloud" && !remote && !options.cloudBrowser) {
    return Response.json(
      { ok: false, error: "AliasMode Cloud authentication is required" },
      { status: 503 },
    );
  }

  if (pathname.startsWith("/ui/api/proxies/")) {
    if (remote) return noStoreJson({ ok: false, error: "Bulk proxy tools are unavailable in legacy remote mode" }, 400);
    if (req.method !== "POST") return noStoreJson({ ok: false, error: "POST is required" }, 405);
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (options.cloudBrowser && !options.cloudConnection) return noStoreJson({ ok: false, error: "Cloud connection is unavailable" }, 503);
    return handleProxyToolsRequest(req, store, launcher, options);
  }

  if (pathname === "/ui/api/trash" || pathname.startsWith("/ui/api/trash/")) {
    if (remote) return noStoreJson({ ok: false, error: "Trash is unavailable in legacy remote mode" }, 400);
    if (req.method !== "GET") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    if (options.cloudBrowser && !options.cloudConnection) return noStoreJson({ ok: false, error: "Cloud connection is unavailable" }, 503);
    return handleTrashRequest(req, store, launcher, options);
  }

  const cloudLifecycleRoute =
    (pathname === "/ui/api/profiles" && (req.method === "GET" || req.method === "POST")) ||
    (pathname === "/ui/api/profiles/move" && req.method === "POST") ||
    (pathname === "/ui/api/profiles/delete" && req.method === "POST") ||
    (pathname === "/ui/api/profiles/export" && req.method === "POST") ||
    (pathname === "/ui/api/profiles/update-file" && req.method === "POST") ||
    (pathname === "/ui/api/import/upload" && req.method === "POST") ||
    (pathname === "/ui/api/groups/rename" && req.method === "POST") ||
    (req.method === "POST" &&
      /^\/ui\/api\/profiles\/[^/]+\/(open|close|clear-cache|raise|cookies|restore-session|check-fingerprint)$/.test(pathname)) ||
    (pathname === "/ui/api/profiles/cookies" && req.method === "POST");
  const cloudEditorRoute =
    (req.method === "GET" && /^\/ui\/api\/profiles\/[^/]+$/.test(pathname)) ||
    (req.method === "POST" && /^\/ui\/api\/profiles\/[^/]+\/update$/.test(pathname));
  // The extension registry stores files on this device. Cloud profiles and
  // folders sync assignment ids, then resolve matching local installs at launch.
  const cloudExtensionRoute =
    (pathname === "/ui/api/extensions" && req.method === "GET") ||
    (pathname === "/ui/api/extensions/web-store" && req.method === "POST") ||
    (pathname === "/ui/api/extensions/upload" && req.method === "POST") ||
    (pathname === "/ui/api/extensions/delete" && req.method === "POST") ||
    (pathname === "/ui/api/groups/extensions" && (req.method === "GET" || req.method === "POST"));
  if (
    options.appConfig?.read().mode === "cloud" &&
    options.cloudBrowser &&
    !remote &&
    !cloudLifecycleRoute &&
    !cloudEditorRoute &&
    !cloudExtensionRoute
  ) {
    return Response.json(
      { ok: false, error: "This Cloud profile operation is not available yet" },
      { status: 501 },
    );
  }

  if (pathname === "/ui/api/profiles" && req.method === "GET") {
    try {
      if (options.cloudBrowser) {
        return Response.json(await options.cloudBrowser.listRoster());
      }
      if (remote) {
        // Remote mode: the roster is the hub's (with lock + session status); layer
        // on this machine's local running state. Probe live CDP ports first and drop
        // launch rows for browsers the user closed manually (or that crashed) — else
        // the row lingers and the profile shows "running" with a stale Close button.
        // remote.listRoster() then releases the now-orphaned hub lock for those.
        await launcher.reconcileOrphans();
        const roster = await remote.listRoster();
        const profiles = roster.profiles.map((p) => {
          const { debugPort: _debugPort, ...profile } = p as typeof p & { debugPort?: number };
          const l = store.getLaunch(p.id);
          const engine = profileEngine(p);
          return { ...profile, engine, running: !!l, ...(engine === "chromium" ? { debugPort: l?.debugPort } : {}) };
        });
        return Response.json({ profiles, healthSources: roster.healthSources });
      }
      // Probe live CDP ports and clear stale launch rows first: a crash or an
      // external debug-port teardown leaves the row in SQLite, which would
      // otherwise show "running" forever and hide the Open action. reconcileOrphans
      // probes active() per launch and drops dead rows (it never kills processes).
      await launcher.reconcileOrphans();
      return Response.json({ profiles: listUiProfiles(store), healthSources: [], groups: store.listGroups(), folders: store.listFolders() });
    } catch (error) {
      // Bun renders an uncaught route exception as an HTML 500 page. The React
      // client then cannot expose the actual hub/reconciliation error and only
      // sees "Unexpected token '<'". Keep this API JSON-shaped even on failure.
      return Response.json(
        { ok: false, error: `profile roster failed: ${msg(error)}` },
        { status: remote || options.cloudBrowser ? 502 : 500 },
      );
    }
  }

  if (pathname === "/ui/api/profiles" && req.method === "POST") {
    // Create a new profile: unique id → unique seed → unique fingerprint/UA.
    try {
      const input = (await req.json()) as NewProfileInput;
      if (remote && input.chromiumRuntime) throw new Error("AliasMode Chromium is unavailable in legacy Remote mode");
      if (remote) {
        const { id } = await remote.createProfile(input);
        return Response.json({ ok: true, id });
      }
      const profile = buildNewProfile(input, (id) => !!store.getProfile(id));
      if (!options.cloudBrowser) store.applyGroupExtensionDefaults(profile, null, false);
      // Best-effort: match the browser clock to the proxy's exit location. A
      // failed lookup keeps the host timezone.
      if (profile.proxy) {
        await attachTimezones([profile], options.timezoneFetch, true).catch(() => {});
        syncFirefoxTimezone(profile);
      }
      const created = options.cloudBrowser ? await options.cloudBrowser.create(profile) : undefined;
      if (!created) store.upsertProfile(profile);
      launcher.prefetchFirefoxFontPacks?.([profile]);
      return Response.json({ ok: true, ...(created ?? { id: profile.id }) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 400 });
    }
  }

  if (pathname === "/ui/api/profiles/move" && req.method === "POST") {
    try {
      const body = (await req.json()) as { ids?: unknown; group?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const group = typeof body.group === "string" ? body.group.trim() : "";
      if (ids.length === 0) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
      if (options.cloudBrowser) {
        const summaries = (await options.cloudConnection!.client.listProfiles()).profiles;
        for (const id of ids) {
          const profile = summaries.find((item) => item.id === id);
          if (!profile) return Response.json({ ok: false, error: `profile ${id} was not found` }, { status: 404 });
          await options.cloudConnection!.client.moveProfile(id, { destination: group, expectedVersion: profile.version });
        }
        return Response.json({ ok: true, moved: ids.length, group });
      }
      const moved = remote ? await remote.move(ids, group) : store.setGroup(ids, group);
      return Response.json({ ok: true, moved, group });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/profiles/delete" && req.method === "POST") {
    try {
      const body = (await req.json()) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (ids.length === 0) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
      if (options.cloudBrowser) {
        const cloud = options.cloudConnection!.client;
        const transition = await options.cloudAuth?.acquireTransition();
        try {
          const accountId = options.cloudConnection!.accountId();
          const current = () => !req.signal.aborted && (!transition || options.cloudAuth!.isTransitionCurrent(transition)) &&
            options.cloudConnection!.accountId() === accountId;
          if (!current()) return noStoreJson({ ok: false, error: "Account changed; reload profiles" }, 409);
          const summaries = new Map((await cloud.listProfiles()).profiles.map((profile) => [profile.id, profile]));
          const uniqueIds = [...new Set(ids)];
          const outcomes: Array<"deleted" | "locked" | "failed"> = [];
          let cursor = 0;
          const worker = async () => {
            while (cursor < uniqueIds.length) {
              const index = cursor++, id = uniqueIds[index]!;
              outcomes[index] = "failed";
              if (!current()) continue;
              const profile = summaries.get(id);
              if (!profile || profile.trashedAt !== null || profile.permission !== "edit" || !isSafeProfileId(id)) continue;
              await launcher.cacheCleanupSettled(id);
              if (profile.activeOpens.length || launcher.profileDeletionBlocked(id)) { outcomes[index] = "locked"; continue; }
              try {
                await cloud.trashProfile(id, { expectedVersion: profile.version });
                outcomes[index] = "deleted";
              } catch (error) {
                if (error instanceof CloudApiError && error.status === 409 && error.code === "profile_open") outcomes[index] = "locked";
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, uniqueIds.length) }, worker));
          if (!current()) return noStoreJson({ ok: false, error: "Operation interrupted; reload profiles before retrying" }, 409);
          return noStoreJson({
            ok: true, deleted: outcomes.filter((outcome) => outcome === "deleted").length,
            locked: uniqueIds.filter((_, index) => outcomes[index] === "locked"),
            failed: uniqueIds.filter((_, index) => outcomes[index] === "failed"),
          });
        } finally { transition?.release(); }
      }
      if (remote) {
        const r = await remote.deleteProfiles(ids);
        return Response.json({ ok: true, ...r });
      }
      // Standalone deletion never closes a browser implicitly. Preflight the
      // full selection before mutation so a mixed open/closed batch is atomic.
      const existing = ids.filter((id) => store.getProfile(id));
      await Promise.all(existing.map((id) => launcher.cacheCleanupSettled(id)));
      const locked = existing.filter((id) => launcher.profileDeletionBlocked(id));
      if (locked.length > 0) {
        return Response.json({
          ok: false,
          error: "close open profiles before deleting them",
          deleted: 0,
          locked,
        }, { status: 409 });
      }
      let deleted = 0;
      for (const id of existing) {
        if (store.trashProfile(id)) deleted++;
      }
      return Response.json({ ok: true, deleted, locked: [] });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/import" && req.method === "POST") {
    // In remote mode the local inbox isn't the source of truth — importing there
    // would write to the local launch-cache, never reaching the hub roster.
    if (remote) return Response.json({ ok: false, error: "remote mode: import via the hub (upload in the dashboard)" }, { status: 400 });
    try {
      const r = await importInbox(store, options.paths?.inbox);
      launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
      return Response.json({ ok: true, ...r });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/import/upload" && req.method === "POST") {
    try {
      const form = await req.formData();
      const uploads: { name: string; bytes: Uint8Array }[] = [];
      const override = importOverridesFromForm(form);
      if (options.cloudBrowser && !override.group) {
        return Response.json({ ok: false, error: "a Cloud destination folder is required" }, { status: 400 });
      }
      for (const [, value] of form) {
        if (value instanceof File) uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
      if (uploads.length === 0) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });
      if (options.cloudBrowser) {
        const prepared = await prepareImportBuffers(uploads, console.log, override, undefined, options.timezoneFetch);
        await options.cloudBrowser.importProfiles(override.group!, prepared.imports.map(({ profile, sessionBundle }) => ({ ...profile, sessionBundle })));
        launcher.prefetchFirefoxFontPacks?.(prepared.imports.map(({ profile }) => profile));
        return Response.json({ ok: true, ...prepared.result });
      }
      if (remote) {
        const result = await remote.importToHub(uploads, override);
        if (result.profiles === 0) {
          return Response.json(
            { ok: false, error: "the hub found no profiles in the uploaded export" },
            { status: 400 },
          );
        }
        return Response.json({ ok: true, ...result });
      }
      const imported = await importBuffers(store, uploads, console.log, override, undefined, options.timezoneFetch);
      launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
      return Response.json({ ok: true, ...imported });
    } catch (error) {
      const status = error instanceof ProfileImportError
        ? error.status
        : error instanceof CloudApiError ? error.status
        : error instanceof CloudRequestError ? 502
        : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  if (pathname === "/ui/api/export" && req.method === "POST") {
    if (remote) {
      return Response.json({ ok: false, error: "remote mode: export from the hub, not this launch cache" }, { status: 400 });
    }
    return Response.json({ ok: false, error: "export is not available" }, { status: 404 });
  }

  if (pathname === "/ui/api/diagnose/latest" && req.method === "GET") {
    return Response.json({ report: await readLatestDiagnose(options.paths?.reports) });
  }

  // Cloud exports fan out this many concurrent profile fetches. Big enough to
  // keep a 1,600-profile export moving, small enough not to open hundreds of
  // Cloud connections at once.
  const CLOUD_EXPORT_BATCH = 16;

  if (pathname === "/ui/api/profiles/export" && req.method === "POST") {
    // Export selected profiles for offline editing. Replies with the finished
    // file directly (not JSON) so the browser saves it; the dashboard opts into
    // `stream: true` for newline-delimited progress + file records instead.
    // Both formats carry `id` so the file can be re-uploaded through
    // /ui/api/profiles/update-file.
    let body: { ids?: unknown; format?: unknown; stream?: unknown };
    try {
      body = (await req.json()) as { ids?: unknown; format?: unknown; stream?: unknown };
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) {
      return Response.json({ ok: false, error: "select at least one profile to export" }, { status: 400 });
    }
    if (ids.some((id) => !isSafeProfileId(id))) {
      return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    }
    if (body.format !== "txt" && body.format !== "xlsx" && body.format !== "csv") {
      return Response.json({ ok: false, error: "format must be csv, txt, or xlsx" }, { status: 400 });
    }
    const format = body.format;
    // .txt and .xlsx are the full-fidelity forms: they carry cookies and the
    // user-agent, so they need the profile's secrets. .csv is the trimmed
    // credential view.
    const full = format !== "csv";
    if (options.cloudBrowser && !options.cloudConnection && !remote) {
      return Response.json(
        { ok: false, error: "AliasMode Cloud connection is unavailable" },
        { status: 503 },
      );
    }
    try {
      // Collect the export rows from whichever store owns the profile. The
      // optional hooks exist for the streaming response below: `onProgress`
      // reports how many selected profiles are fully processed, and `aborted`
      // (a disconnected client) stops further batches instead of fetching a
      // file nobody is left to receive.
      const collectProfiles = async (
        onProgress: (completed: number) => void,
        aborted: () => boolean,
      ): Promise<ProfileExport[]> => {
        if (remote) {
          // The local store is only a launch cache in remote mode; the hub
          // reader keeps its own bounded fan-out and reports between batches.
          return remote.getProfiles(ids, full, (completed) => onProgress(completed));
        }
        if (options.cloudBrowser) {
          const profiles: ProfileExport[] = [];
          for (let i = 0; i < ids.length; i += CLOUD_EXPORT_BATCH) {
            if (aborted()) return profiles;
            const batch = await Promise.all(ids.slice(i, i + CLOUD_EXPORT_BATCH).map(async (id) => {
              const authoritative = await options.cloudConnection!.client.getProfile(id);
              const { profile, sessionBundle } = decodePortableProfile(authoritative.payload);
              if (profile.id !== id) throw new Error("Cloud returned a mismatched profile payload");
              const local = store.getProfile(id);
              if (local?.fpObserved) profile.fpObserved = { ...local.fpObserved };
              if (local?.fpExpected) profile.fpExpected = { ...local.fpExpected };
              return { ...profile, sessionBundle, sessionSource: "cloud" as const };
            }));
            profiles.push(...batch);
            onProgress(Math.min(i + CLOUD_EXPORT_BATCH, ids.length));
          }
          return profiles;
        }
        const profiles: ProfileExport[] = [];
        let processed = 0;
        for (const id of ids) {
          if (aborted()) return profiles;
          const fresh = full && await launcher.captureLocalSession(id);
          const profile = store.getProfile(id);
          if (profile) {
            const sessionBundle = full ? store.getSessionBundle(id) ?? undefined : undefined;
            profiles.push({ ...profile, sessionBundle, sessionSource: fresh ? "live" : sessionBundle ? "saved" : "stored-cookies" });
          }
          onProgress(++processed);
        }
        return profiles;
      };

      const buildExportFile = async (profiles: ProfileExport[]): Promise<{ mime: string; bytes: Uint8Array }> => {
        if (format === "xlsx") {
          const { headers, rows } = serializeXlsxRows(profiles);
          return {
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            bytes: await writeXlsx(headers, rows),
          };
        }
        const text = format === "txt" ? serializeAdsTxt(profiles) : serializeCsv(profiles);
        return { mime: `${format === "txt" ? "text/plain" : "text/csv"}; charset=utf-8`, bytes: new TextEncoder().encode(text) };
      };

      if (body.stream !== true) {
        // Legacy single-response export: build everything, then reply with the
        // finished file in one piece.
        const { mime, bytes } = await buildExportFile(await collectProfiles(() => {}, () => false));
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            "content-type": mime,
            "content-disposition": `attachment; filename=aliasmode-export.${format}`,
            "cache-control": "no-store",
          },
        });
      }

      // Streaming export (dashboard): newline-delimited JSON records keep the
      // HTTP response alive while profiles are fetched — a 1,600-profile Cloud
      // export can run for minutes — then one file record delivers the bytes.
      // The connection staying active also sidesteps idle-timeout failure of a
      // single long-silent response.
      let clientGone = false;
      req.signal.addEventListener("abort", () => { clientGone = true; });
      const encoder = new TextEncoder();
      const records = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (record: unknown) => {
            if (clientGone) return;
            try {
              controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
            } catch {
              clientGone = true; // the client aborted between batches
            }
          };
          try {
            send({ type: "progress", completed: 0, total: ids.length });
            const profiles = await collectProfiles(
              (completed) => send({ type: "progress", completed, total: ids.length }),
              () => clientGone,
            );
            if (clientGone) return;
            const { mime, bytes } = await buildExportFile(profiles);
            send({ type: "file", mime, data: Buffer.from(bytes).toString("base64") });
          } catch (error) {
            send({ type: "error", error: msg(error) });
          } finally {
            try { controller.close(); } catch { /* already closed by cancel() */ }
          }
        },
        cancel() { clientGone = true; },
      });
      return new Response(records, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError || options.cloudBrowser ? 502 : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  if (pathname === "/ui/api/profiles/update-file" && req.method === "POST") {
    // File-based bulk update (AdsPower "Update profile"): re-upload an edited
    // export. Rows matched to existing profiles by `id`; only columns present in
    // the file change. Unknown ids reported, never created.
    if (remote) return Response.json({ ok: false, error: "remote mode: update via the hub" }, { status: 400 });
    try {
      const form = await req.formData();
      let updated = 0, skipped = 0;
      const notFound: string[] = [];
      const errors: Array<{ id: string; error: string }> = [];
      const pending = new Map<string, Profile>();
      const cloudPending = new Map<string, Record<string, string>>();
      const proxyChanged = new Set<string>();
      const applied: Array<{ id: string; set: Record<string, string> }> = [];
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const bytes = new Uint8Array(await value.arrayBuffer());
        // An .xlsx is a ZIP, so it is binary and starts "PK" — decoding it as
        // text would turn a spreadsheet into mojibake with no usable `id`
        // column and report the whole upload as zero rows changed.
        const isWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;
        const summary = isWorkbook
          ? rowsToUpdates(await readXlsx(bytes))
          : parseUpdateFile(decodeText(bytes));
        skipped += summary.skipped;
        for (const u of summary.updates) {
          if (!isSafeProfileId(u.id)) {
            errors.push({ id: u.id, error: PROFILE_ID_ERROR });
            continue;
          }
          if (options.cloudBrowser) {
            const set = { ...cloudPending.get(u.id), ...u.set };
            delete set.customNo;
            cloudPending.set(u.id, set);
            continue;
          }
          const p = pending.get(u.id) ?? store.getProfile(u.id);
          if (!p) { notFound.push(u.id); continue; }
          try {
            const previousGroup = p.group;
            if (applyEdits(p, u.set)) proxyChanged.add(u.id);
            store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in u.set);
            pending.set(u.id, p);
            applied.push(u);
          } catch (error) {
            errors.push({ id: u.id, error: msg(error) });
          }
        }
      }
      // Validate the entire upload before opening a transaction. A bad row
      // reports its id and leaves every otherwise-valid row untouched.
      if (errors.length) {
        return Response.json({ ok: false, updated: 0, skipped, notFound, errors }, { status: 400 });
      }
      if (options.cloudBrowser) {
        if (!options.cloudConnection) {
          return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
        }
        const editor = new CloudProfileEditor(options.cloudConnection.client, store, options.timezoneFetch);
        // Cloud writes are separate versioned requests, not a Local transaction.
        for (const [id, set] of cloudPending) {
          try {
            const expectedVersion = await editor.closedProfileVersion(id);
            await editor.save(id, expectedVersion, set);
            updated++;
          } catch (error) {
            if (error instanceof CloudApiError && error.code === "profile_not_found") notFound.push(id);
            else errors.push({ id, error: msg(error) });
          }
        }
        return Response.json({ ok: errors.length === 0, updated, skipped, notFound, errors });
      }
      // Open profiles change too. Their browsers keep the identity they launched with until the next start.
      // A new proxy gets its exit timezone. A failed lookup keeps the saved one.
      const located = [...proxyChanged]
        .map((id) => pending.get(id))
        .filter((profile): profile is Profile => !!profile?.proxy && !profile.timezoneManual)
        .map((profile) => ({ ...profile, timezone: "" }));
      if (located.length > 0) {
        await attachTimezones(located, options.timezoneFetch).catch(() => {});
        // Apply the rows again to current copies, so changes saved during the lookups are kept.
        pending.clear();
        for (const { id, set } of applied) {
          const p = pending.get(id) ?? store.getProfile(id);
          if (!p) continue;
          const previousGroup = p.group;
          applyEdits(p, set);
          store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in set);
          pending.set(id, p);
        }
        for (const { id, timezone } of located) {
          const p = pending.get(id);
          if (p && timezone) {
            p.timezone = timezone;
            syncFirefoxTimezone(p);
          }
        }
      }
      store.upsertProfiles([...pending.values()]);
      updated = pending.size;
      return Response.json({ ok: true, updated, skipped, notFound, errors: [] });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/create" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { name?: unknown; parentName?: unknown };
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "group name required" }, { status: 400 });
      if (name === "all") return Response.json({ ok: false, error: "group name is reserved" }, { status: 400 });
      const folder = store.createGroup(name, typeof body.parentName === "string" ? body.parentName : null);
      return Response.json({ ok: true, name: folder.name, folder });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/rename" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { from?: unknown; to?: unknown };
      const from = String(body.from ?? "").trim(), to = String(body.to ?? "").trim();
      if (!from || !to) return Response.json({ ok: false, error: "from and to group names required" }, { status: 400 });
      if (options.cloudBrowser) {
        const renamed = await options.cloudConnection!.client.renameFolder(from, to);
        return Response.json({ ok: true, moved: 0, folder: renamed.folder });
      }
      const source = store.listFolders().find((folder) => folder.name === from);
      const moved = store.renameGroup(from, to);
      const name = source?.parentName ? `${source.parentName}/${to}` : to;
      return Response.json({ ok: true, moved, folder: store.listFolders().find((folder) => folder.name === name) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/move" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = await req.json() as { name?: unknown; parentName?: unknown };
      if (typeof body.name !== "string" || (body.parentName !== null && typeof body.parentName !== "string")) {
        return Response.json({ ok: false, error: "name and parentName are required" }, { status: 400 });
      }
      return Response.json({ ok: true, folder: store.moveGroup(body.name, body.parentName) });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }

  if (pathname === "/ui/api/groups/delete" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { name?: unknown };
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "group name required" }, { status: 400 });
      return Response.json({ ok: true, ungrouped: store.deleteGroup(name) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/extensions" && (req.method === "GET" || req.method === "POST")) {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      if (req.method === "GET") {
        if (options.cloudBrowser) {
          const folders = (await options.cloudConnection!.client.listFolders()).folders;
          return Response.json({
            ok: true,
            groups: folders
              .filter((folder) => !folder.archivedAt)
              .map((folder) => ({
                name: folder.name,
                extensions: folder.extensionDefaults ?? [],
                permission: folder.permission,
              })),
          });
        }
        return Response.json({
          ok: true,
          groups: store.listGroupExtensionDefaults().map((group) => ({ ...group, permission: "edit" as const })),
        });
      }

      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
      const body = (await req.json()) as { group?: unknown; extensions?: unknown };
      const group = String(body.group ?? "").trim();
      const extensions = Array.isArray(body.extensions) ? body.extensions.map(String) : null;
      if (!group || !extensions) {
        return Response.json({ ok: false, error: "group and extensions are required" }, { status: 400 });
      }
      if (options.cloudBrowser) {
        return Response.json(await options.cloudConnection!.client.setFolderExtensionDefaults(group, extensions));
      }
      return Response.json({ ok: true, updatedCount: store.setGroupExtensionDefaults(group, extensions) });
    } catch (error) {
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError ? 502 : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  // --- Extensions registry (upload / list / delete) ---
  if (pathname === "/ui/api/extensions" && req.method === "GET") {
    return Response.json({ ok: true, extensions: store.listExtensions().map((e) => ({ id: e.id, name: e.name })) });
  }

  if (pathname === "/ui/api/extensions/web-store" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    let source: string;
    let id: string;
    try {
      const body = (await req.json()) as { source?: unknown };
      source = String(body.source ?? "").trim();
      id = parseWebStoreExtensionId(source);
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
    const existing = store.getExtension(id);
    if (existing) {
      return Response.json({
        ok: true,
        installed: { id: existing.id, name: existing.name },
        alreadyInstalled: true,
      });
    }
    try {
      const installed = await installWebStoreExtension(
        source,
        options.paths?.extensions,
        options.extensionFetch,
      );
      try {
        store.addExtension({ id, name: installed.name, loadDir: installed.loadDir });
      } catch (error) {
        removeExtensionFiles(id, options.paths?.extensions);
        throw error;
      }
      return Response.json({
        ok: true,
        installed: { id, name: installed.name },
        alreadyInstalled: false,
      });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/extensions/upload" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const form = await req.formData();
      const installed: Array<{ id: string; name: string }> = [];
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const id = "ext" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const bytes = new Uint8Array(await value.arrayBuffer());
        const fallback = value.name.replace(/\.(zip|crx)$/i, "");
        const { loadDir, name } = await installExtension(bytes, id, fallback, options.paths?.extensions);
        store.addExtension({ id, name, loadDir });
        installed.push({ id, name });
      }
      if (!installed.length) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });
      return Response.json({ ok: true, installed });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/extensions/delete" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { id?: unknown };
      const id = String(body.id ?? "").trim();
      if (!id) return Response.json({ ok: false, error: "extension id required" }, { status: 400 });
      const liveIds = store.listProfiles()
        .filter((profile) => profile.extensions?.includes(id) && store.getLaunch(profile.id))
        .map((profile) => profile.id);
      if (liveIds.length > 0) {
        return Response.json(
          { ok: false, error: `extension is assigned to open profile(s) ${liveIds.join(", ")}; close them before deleting it` },
          { status: 409 },
        );
      }
      store.unassignExtension(id); // drop it from any profile that had it
      store.deleteExtension(id);
      removeExtensionFiles(id, options.paths?.extensions);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  // Bulk assign / unassign one extension across many selected profiles.
  if (pathname === "/ui/api/profiles/extensions" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { ids?: unknown; extensionId?: unknown; op?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const extId = String(body.extensionId ?? "").trim();
      const add = body.op !== "remove";
      if (!ids.length || !extId) return Response.json({ ok: false, error: "ids and extensionId required" }, { status: 400 });
      const firefoxIds = ids.filter((id) => profileEngine(store.getProfile(id)) === "firefox");
      if (firefoxIds.length > 0) {
        return Response.json({ ok: false, error: "Chrome extensions are unavailable for Firefox profiles" }, { status: 400 });
      }
      if (add && !store.getExtension(extId)) return Response.json({ ok: false, error: "unknown extension" }, { status: 404 });
      // An open browser loads the change at its next start.
      return Response.json({ ok: true, updated: store.assignExtension(ids, extId, add) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  const timezoneRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/timezone$/);
  if (timezoneRoute && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (remote || options.cloudBrowser) {
      return Response.json({ ok: false, error: "timezone lookup is available for Local profiles only" }, { status: 400 });
    }
    try {
      const id = decodeURIComponent(timezoneRoute[1]!);
      if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      const profile = store.getProfile(id);
      if (!profile) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (profile.proxyError) return Response.json({ ok: false, error: "Fix or remove the invalid proxy before setting the timezone." }, { status: 400 });
      const location = await lookupExitLocation(profile.proxy, options.timezoneFetch);
      if (!location) return Response.json({ ok: false, error: "Could not determine the connection timezone. The saved timezone is unchanged." }, { status: 502 });
      const current = store.getProfile(id);
      if (!current || current.proxyError || JSON.stringify(current.proxy) !== JSON.stringify(profile.proxy)) {
        return Response.json({ ok: false, error: "Profile connection changed. Reopen Edit and try again." }, { status: 409 });
      }
      current.timezone = location.timezone;
      delete current.timezoneManual;
      current.locale = localeForCountry(location.country) ?? localeForTimezone(location.timezone);
      syncFirefoxTimezone(current);
      store.upsertProfile(current);
      return Response.json({ ok: true, timezone: current.timezone, locale: current.locale, ...restartRequired(store, id) });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  // Add cookies to one profile (/profiles/<id>/cookies) or to the selected ones (/profiles/cookies).
  // An open browser gets them now. A closed profile keeps them and its next start sets them before
  // the first page opens: a Local profile in its pending list, a Cloud profile in its Cloud session.
  const cookieRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/cookies$/);
  if ((cookieRoute || pathname === "/ui/api/profiles/cookies") && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, error: "invalid cookie request" }, { status: 400 });
    }
    let ids: string[];
    try {
      ids = cookieRoute ? [decodeURIComponent(cookieRoute[1]!)] : Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    } catch {
      return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    }
    if (!ids.length) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
    if (!ids.every(isSafeProfileId)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });

    let cookies: CookieRecord[];
    if (typeof body.text === "string") {
      try {
        cookies = parseCookieText(body.text);
      } catch (error) {
        return Response.json({ ok: false, error: msg(error) }, { status: 400 });
      }
    } else {
      const cookie = singleCookie(body);
      if (typeof cookie === "string") return Response.json({ ok: false, error: cookie }, { status: 400 });
      cookies = [cookie];
    }

    const setCookies = options.setCookies ?? defaultSetCookies;
    let live = 0;
    let nextStart = 0;
    const errors: Array<{ id: string; error: string; status: number }> = [];
    for (const id of ids) {
      try {
        const launch = store.getLaunch(id);
        if (launch) {
          if (!await launcher.certifiedActive(id).catch(() => false) || !store.getLaunch(id)?.ws) {
            errors.push({ id, error: "profile browser is not open", status: 409 });
            continue;
          }
          const engine = launch.engine === "firefox" || profileEngine(store.getProfile(id)) === "firefox" ? "firefox" : "chromium";
          try {
            await setCookies(store.getLaunch(id)!.ws, cookiesForEngine(cookies, engine));
          } catch {
            // The worker error can quote the cookie value.
            errors.push({ id, error: "cookie could not be added", status: 500 });
            continue;
          }
          live++;
        } else if (options.cloudBrowser) {
          if (!options.cloudConnection) {
            errors.push({ id, error: "AliasMode Cloud connection is unavailable", status: 503 });
            continue;
          }
          // A newer session this device still has to upload would be replaced by the Cloud copy.
          if (options.cloudBrowser.sessionSettled?.(id) === false) {
            errors.push({ id, error: "This device has a newer session of this profile that is not in Cloud yet. Open the profile once, then add the cookies.", status: 409 });
            continue;
          }
          await new CloudProfileEditor(options.cloudConnection.client, store, options.timezoneFetch).addSessionCookies(id, cookies);
          nextStart++;
        } else if (remote) {
          errors.push({ id, error: "profile browser is not open", status: 409 });
        } else {
          if (!store.getProfile(id)) {
            errors.push({ id, error: "no such profile", status: 404 });
            continue;
          }
          store.addPendingCookies(id, cookies);
          nextStart++;
        }
      } catch (error) {
        errors.push({ id, error: msg(error), status: options.cloudBrowser ? cloudProfileEditorErrorStatus(error) : 500 });
      }
    }
    if (cookieRoute) {
      const error = errors[0];
      if (error) return Response.json({ ok: false, error: error.error }, { status: error.status });
      return Response.json(live ? { ok: true, applied: "now", count: cookies.length } : { ok: true, applied: "next-start", count: cookies.length });
    }
    return Response.json({
      ok: errors.length === 0, count: cookies.length, live, nextStart,
      errors: errors.map(({ id, error }) => ({ id, error })),
    });
  }

  // Cookies a closed Local profile sets at its next start: list them (domain and name only) or remove them.
  const pendingCookieRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/pending-cookies(\/clear)?$/);
  if (pendingCookieRoute && (pendingCookieRoute[2] ? req.method === "POST" : req.method === "GET")) {
    if (req.method === "POST") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    let id: string;
    try {
      id = decodeURIComponent(pendingCookieRoute[1]!);
    } catch {
      return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    }
    if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    if (!store.getProfile(id)) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    const pending = store.getPendingCookies(id);
    if (pendingCookieRoute[2]) {
      store.clearPendingCookies(id, pending);
      return Response.json({ ok: true, removed: pending.length });
    }
    return noStoreJson({ ok: true, cookies: pending.map(({ domain, name }) => ({ domain, name })) });
  }

  // Open the AliasMode fingerprint test in a new tab of a running profile. Only these pages can be opened.
  const fingerprintCheck = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/check-fingerprint$/);
  if (fingerprintCheck && req.method === "POST") {
    const id = decodeURIComponent(fingerprintCheck[1]!);
    const body = await req.json().catch(() => ({})) as { page?: unknown };
    const pages: Record<string, string> = {
      en: "https://aliasmode.com/check/",
      ru: "https://aliasmode.com/ru/fingerprint-test/",
      "zh-cn": "https://aliasmode.com/zh-cn/fingerprint-test/",
    };
    const url = pages[typeof body.page === "string" ? body.page : "en"] ?? pages.en!;
    if (!await launcher.certifiedActive(id).catch(() => false)) {
      return Response.json({ ok: false, error: "profile browser is not open" }, { status: 409 });
    }
    const launch = store.getLaunch(id);
    if (!launch?.ws) {
      return Response.json({ ok: false, error: "profile browser is not open" }, { status: 409 });
    }
    try {
      await launcher.navigate(launch.ws, [url], false);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  // Bring a running profile's browser window to the foreground.
  const raise = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/raise$/);
  if (raise && req.method === "POST") {
    // Raising the window is a purely LOCAL operation (the browser runs on this operator in both
    // modes; bringToFront uses the local launch record + CDP), so it works in remote mode too.
    try {
      const id = decodeURIComponent(raise[1]!);
      if (profileEngine(store.getProfile(id)) === "firefox") {
        return Response.json({ ok: false, error: "bringing a Firefox profile to the front is unavailable" }, { status: 400 });
      }
      await launcher.bringToFront(id);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  // Live 2FA code (TOTP) for a profile — the authenticator. Returns only the
  // current code (never the secret), so the redacted list can offer quick-copy.
  const totp = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/totp$/);
  if (totp && req.method === "GET") {
    const p = store.getProfile(decodeURIComponent(totp[1]!));
    if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    const r = generateTotp(p.twofa ?? "");
    if (!r) return Response.json({ ok: true, code: null });
    return Response.json({ ok: true, code: r.code, secondsRemaining: r.secondsRemaining, period: r.period });
  }

  // Single-profile edit detail (WITH secrets) for the Edit modal.
  const single = pathname.match(/^\/ui\/api\/profiles\/([^/]+)$/);
  if (single && req.method === "GET") {
    const id = decodeURIComponent(single[1]!);
    if (options.cloudBrowser) {
      // A profile open on THIS device is edited live: its decrypted copy in the
      // local cache is the session writer's source of truth, and the checkpoint
      // and close syncs push the whole profile — edited fields included — back
      // to Cloud. No expectedVersion handshake applies on this path, and no
      // Cloud connection is needed — so this branch stays ahead of that guard.
      if (options.cloudBrowser.canEditLive?.(id) === true) {
        const live = store.getProfile(id);
        if (!live) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
        return Response.json({ ok: true, profile: { ...profileEditView(live), liveEdit: true } });
      }
      if (!options.cloudConnection) {
        return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
      }
      try {
        const editor = new CloudProfileEditor(options.cloudConnection.client, store, options.timezoneFetch);
        return Response.json({ ok: true, profile: await editor.get(id) });
      } catch (error) {
        return Response.json(
          { ok: false, error: msg(error) },
          { status: cloudProfileEditorErrorStatus(error) },
        );
      }
    }
    const p = remote
      ? await remote.getProfile(id).catch(() => null)
      : store.getProfile(id);
    if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    return Response.json({ ok: true, profile: profileEditView(p) });
  }

  // Apply edits to one profile (Edit modal save).
  const upd = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/update$/);
  if (upd && req.method === "POST") {
    try {
      const id = decodeURIComponent(upd[1]!);
      if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      if (options.cloudBrowser) {
        const rejected = rejectUntrustedJsonMutation(req);
        if (rejected) return rejected;
        const body = (await req.json()) as { expectedVersion?: unknown; set?: unknown };
        const set = body.set && typeof body.set === "object" && !Array.isArray(body.set)
          ? body.set as Record<string, unknown>
          : {};
        // Open on this device → live edit of the local cached copy; the running
        // session's checkpoint/close sync carries the change to Cloud. The
        // coordinator commits through the same transition fence as close.
        if (options.cloudBrowser.canEditLive?.(id) === true) {
          const live = store.getProfile(id);
          if (!live) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
          // The portable-profile contract carries no custom NO., so accepting
          // one here would only survive until the next open erased it. Ignore
          // it, like the closed-profile Cloud editor does.
          delete set.customNo;
          // The open browser keeps its launch identity; a changed proxy or fingerprint applies at its next start.
          const liveProxyChanged = applyEdits(live, set) && !live.timezoneManual;
          if (liveProxyChanged && live.proxy && !("timezone" in set)) {
            const location = await lookupExitLocation(live.proxy, options.timezoneFetch);
            if (location) live.timezone = location.timezone;
            syncFirefoxTimezone(live);
          } else if (liveProxyChanged && !("timezone" in set)) {
            live.timezone = "";
            syncFirefoxTimezone(live);
          }
          const committed = await (options.cloudBrowser.commitLiveEdit?.(live) ?? Promise.resolve(false));
          if (!committed) {
            return Response.json(
              { ok: false, error: "the browser just closed; reopen Edit before saving" },
              { status: 409 },
            );
          }
          return Response.json({ ok: true, ...restartRequired(store, id) });
        }
        if (body.expectedVersion === undefined) {
          // The dialog was opened against a running profile that has since
          // finished closing — its live-edit path is gone and there is no
          // version to hand the Cloud editor.
          return Response.json(
            { ok: false, error: "the browser just closed; reopen Edit before saving" },
            { status: 409 },
          );
        }
        if (!options.cloudConnection) {
          return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
        }
        const editor = new CloudProfileEditor(options.cloudConnection.client, store, options.timezoneFetch);
        await editor.save(id, body.expectedVersion as number, set);
        return Response.json({ ok: true });
      }
      const body = (await req.json()) as { set?: unknown };
      const set = body.set && typeof body.set === "object" ? (body.set as Record<string, unknown>) : {};
      // Every field saves now, also while the browser is open. That browser keeps the identity it
      // launched with; a changed proxy or fingerprint applies at its next start.
      let p = remote ? await remote.getProfile(id).catch(() => null) : store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      let previousGroup = p.group;
      const proxyChanged = applyEdits(p, set);
      // A new proxy gets its exit timezone, like a Cloud edit. A failed lookup keeps the saved one.
      if (!remote && proxyChanged && p.proxy && !("timezone" in set) && !p.timezoneManual) {
        const location = await lookupExitLocation(p.proxy, options.timezoneFetch);
        // Apply the edit to the current copy, so changes saved during the lookup are kept.
        p = store.getProfile(id);
        if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
        previousGroup = p.group;
        applyEdits(p, set);
        if (location) {
          p.timezone = location.timezone;
          syncFirefoxTimezone(p);
        }
      }
      if (!remote) store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in set);
      if (remote) await remote.saveProfile(p);
      else {
        store.upsertProfile(p);
        if ("timezone" in set) store.setTimezone(id, p.timezone);
        if ("cores" in set) store.setHardware(id, p.hardware);
      }
      return Response.json({ ok: true, ...(remote ? {} : restartRequired(store, id)) });
    } catch (e) {
      return Response.json(
        { ok: false, error: msg(e) },
        { status: options.cloudBrowser ? cloudProfileEditorErrorStatus(e) : 500 },
      );
    }
  }

  // Explicit one-time migration for imported mobile personas. AliasMode cannot
  // reproduce a phone/tablet coherently with its desktop kernel, but the
  // account/session data remains useful. Preserve it while replacing only the
  // impossible device claim with the closest stable desktop persona.
  const convertMobile = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/convert-mobile$/);
  if (convertMobile && req.method === "POST") {
    try {
      const id = decodeURIComponent(convertMobile[1]!);
      if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      const p = remote ? await remote.getProfile(id).catch(() => null) : store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (!isMobileUserAgent(p.ua)) {
        return Response.json({ ok: true, changed: false });
      }
      if (!remote && store.getLaunch(id)) {
        return Response.json(
          { ok: false, error: "profile is currently open; close it before converting its device persona" },
          { status: 409 },
        );
      }
      const conversion = convertMobilePersonaToDesktop(p);
      if (remote) await remote.saveProfile(conversion.profile);
      else store.upsertProfile(conversion.profile);
      return Response.json({
        ok: true,
        changed: true,
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}x${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      });
    } catch (e) {
      const error = msg(e);
      const status = /currently open|in use/i.test(error) ? 409 : 500;
      return Response.json({ ok: false, error }, { status });
    }
  }

  const restore = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/restore-session$/);
  if (restore && req.method === "POST") {
    if (!options.cloudBrowser) {
      return Response.json({ ok: false, error: "Saved sessions are a Cloud feature" }, { status: 400 });
    }
    try {
      const result = await options.cloudBrowser.restoreParkedSession(decodeURIComponent(restore[1]!));
      return result.ok
        ? Response.json({ ok: true, version: result.version })
        : Response.json({ ok: false, error: result.error }, { status: 409 });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  const action = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/(open|close|clear-cache)$/);
  if (action && req.method === "POST") {
    const id = decodeURIComponent(action[1]!);
    if (options.cloudBrowser) {
      try {
        if (action[2] === "open") {
          const result = await options.cloudBrowser.open(id);
          return result.ok
            ? openResponse(store.getProfile(id), result)
            : Response.json({ ok: false, error: result.error ?? "open failed" }, { status: 500 });
        }
        if (action[2] === "close") {
          return cloudCloseResponse(await options.cloudBrowser.close(id));
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ ok: false, error: msg(error) }, { status: 500 });
      }
    }
    if (remote) {
      try {
        if (action[2] === "open") {
          const force = new URL(req.url).searchParams.get("force") === "1";
          const profile = remote.getProfile
            ? await remote.getProfile(id).catch(() => null)
            : null;
          const r = await remote.open(id, [], force);
          if (r.ok) return openResponse(profile, r);
          return Response.json(
            { ok: false, error: r.lockedBy ? `in use by ${r.lockedBy}` : (r.error ?? "open failed"), lockedBy: r.lockedBy },
            { status: r.lockedBy ? 409 : 500 },
          );
        }
        if (action[2] === "close") {
          return (await remote.close(id))
            ? Response.json({ ok: true })
            : Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
        }
        return Response.json({ ok: true }); // clear-cache: not applicable in remote mode
      } catch (e) {
        return Response.json({ ok: false, error: msg(e) }, { status: 500 });
      }
    }
    const profile = store.getProfile(id);
    if (!profile) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    try {
      if (action[2] === "open") {
        const r = await launcher.start(id);
        return openResponse(profile, r);
      }
      if (action[2] === "close") {
        const launch = store.getLaunch(id);
        await launcher.captureLocalSession(id);
        return (await launcher.stop(id, launch ?? undefined))
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
      }
      const r = await launcher.clearCache(id);
      return Response.json({ ok: true, cleared: r.cleared });
    } catch (e) {
      // A preflight refusal says what happened and what to do instead of its bare code.
      return Response.json({ ok: false, error: e instanceof BrowserLaunchError && e.guidance ? e.guidance : msg(e) }, { status: 500 });
    }
  }

  return Response.json({ error: `unknown ui route: ${pathname}` }, { status: 404 });
}

function importOverridesFromForm(form: FormData): ImportOverrides {
  const override: ImportOverrides = {};
  const group = form.get("group");
  if (typeof group === "string" && group.trim()) override.group = group.trim();
  const platform = form.get("platform");
  if (typeof platform === "string" && platform.trim()) override.platform = platform.trim();
  return override;
}

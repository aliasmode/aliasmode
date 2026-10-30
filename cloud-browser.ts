import { mkdirSync, watch } from "node:fs";
import { basename } from "node:path";
import { CloudApiError, type CloudClient } from "./cloud-client.ts";
import type {
  CloudProfileSummary,
  ImportProfilesResponse,
  OpenProfileResponse,
} from "./contracts/cloud-v1.ts";
import {
  CloudDiagnostics,
  type CloudDiagnosticEvent,
  type CloudDiagnosticType,
} from "./cloud-diagnostics.ts";
import {
  BrowserLaunchError,
  platformHomeUrl,
  splitLaunchUrls,
  type BrowserOpenOptions,
  type Launcher,
} from "./launcher.ts";
import {
  isResavableConflict,
  type PendingClose,
  type PendingCloseSummary,
  type PendingOpenSession,
  type PendingSyncQueue,
  retryPendingSync,
} from "./pending-sync.ts";
import { PlaywrightWorkerError } from "./playwright-runtime.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { completeProfileFingerprint } from "./firefox-config.ts";
import { proxyHostPort } from "./proxy.ts";
import {
  bundleHasRestorableLogin,
  bundleTabUrls,
  telegramHomeClient,
  keepUncapturedOrigins,
  parseCapturedSessionBundle,
  sessionBundleSignature,
  sessionCaptureSeed,
  sessionLoginSignature,
  type SessionCaptureSeed,
  SessionRestoreError,
} from "./session.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";
import type { ProfileExport } from "./parse.ts";

export interface CloudBrowserOpenResult {
  ok: boolean;
  ws?: string;
  port?: number;
  error?: string;
  warning?: string;
}

export interface CloudBrowserClosedResult {
  closed: true;
  sync: "complete" | "pending" | "conflict";
  /** The final capture failed: Cloud got the last checkpoint, and this device keeps the newer session. */
  captureFailed?: true;
}

export type CloudBrowserCloseResult =
  | CloudBrowserClosedResult
  | { closed: false; reason: "teardown_unconfirmed" };

export type CloudRestoreResult =
  | { ok: true; version: number }
  | { ok: false; error: string };

/** A session Cloud refused for good, kept encrypted here for manual recovery. */
export interface CloudParkedSession {
  savedAt: number;
  reason: string | null;
}

export interface CloudBrowserProfile {
  id: string;
  engine?: "chromium" | "firefox";
  name: string;
  group: string;
  platform: string;
  tags: string[];
  /** "host:port" from the locally cached decrypted profile — never user/pass.
      Null until this device has opened the profile (the Cloud summary cannot
      carry it: the proxy lives inside the end-to-end encrypted payload). */
  proxy: string | null;
  proxyError?: string;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  has2fa: boolean;
  running: boolean;
  debugPort?: number;
  startedAt?: number;
  lockedBy: string | null;
  permission: "view" | "edit";
  version: number;
  /** Present while a refused session for this profile is recoverable here. */
  parkedSession?: CloudParkedSession;
  /** Since when Cloud holds an older copy: live checkpoint uploads keep failing, or the profile
      closed without its final capture. */
  cloudUnsavedSince?: number;
}

export interface CloudBrowserLifecycle {
  listRoster(): Promise<{ profiles: CloudBrowserProfile[]; healthSources: [] }>;
  canEditLive?(profileId: string): boolean;
  /** Commit a prepared live edit only while the exact running Cloud generation
      still owns the profile. The close transition uses the same fence. */
  commitLiveEdit?(profile: Profile): Promise<boolean>;
  /** A live edit changed the cached profile of an open session — make the next
      checkpoint re-encode it and happen promptly. Optional for partial fakes. */
  noteProfileEdited?(profileId: string): void;
  create(profile: Profile): Promise<{ id: string }>;
  importProfiles(destination: string, profiles: ProfileExport[]): Promise<ImportProfilesResponse>;
  open(profileId: string, launchArgs?: string[], options?: BrowserOpenOptions): Promise<CloudBrowserOpenResult>;
  close(profileId: string): Promise<CloudBrowserCloseResult>;
  /** Write this device's refused session back to Cloud as a new version. */
  restoreParkedSession(profileId: string): Promise<CloudRestoreResult>;
  secureAfterAuthentication(current?: () => boolean): Promise<void>;
  resumeAfterAuthentication(current?: () => boolean): Promise<void>;
  retryPending(): Promise<void>;
  /** Close every browser before releasing authentication. Ready encrypted close
      records may remain for same-account synchronization after reauthentication. */
  releaseAll(permanent?: boolean): Promise<boolean>;
  diagnostics?(): readonly CloudDiagnosticEvent[];
}

type CloudBrowserClient = Pick<
  CloudClient,
  "listProfiles" | "getProfile" | "createProfile" | "importProfiles" | "openProfile" | "heartbeat" | "closeOpen" | "abandon"
> & Partial<Pick<CloudClient, "checkpointOpen">>;

type CloudBrowserLauncher = Pick<
  Launcher,
  "start" | "stop" | "active" | "hasPageTargets" | "verifyRunningIdentity" | "reconcileOrphan" |
  "browserStorageWatchPaths" | "failedStartGeneration" |
  "matchesCloudSession" | "recordCloudSession" | "navigate"
> & Partial<Pick<Launcher, "closedFirefoxTabs" | "prefetchFirefoxFontPacks" | "nativeSessionReadable">>;

export interface CloudBrowserOptions {
  cloud: CloudBrowserClient;
  launcher: CloudBrowserLauncher & Partial<Pick<Launcher, "prefetchBrowserRuntimes">>;
  store: ProfileStore;
  queue: () => PendingSyncQueue | undefined;
  accountId: () => string | undefined;
  deviceId: () => string | undefined;
  readSession: (endpoint: string, captureSeed: SessionCaptureSeed) => Promise<string>;
  /** Restore the bundle and open startup pages over ONE CDP attach, then detach. */
  applySession: (endpoint: string, bundle: string, urls: readonly string[]) => Promise<void>;
  heartbeatMs?: number;
  /** Checkpoint the open tabs soon after browser storage changes on disk. On by default. */
  storageCheckpoints?: boolean;
  checkpointDebounceMs?: number;
  checkpointMinIntervalMs?: number;
  /** How often a changed checkpoint of an open profile is saved to Cloud. */
  cloudCheckpointIntervalMs?: number;
  /** After a login, logout or account switch, save to Cloud once this long after the last save. */
  cloudCheckpointSoonMs?: number;
  watchPath?: (path: string, onDirty: () => void) => { close(): void };
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  log?: (message: string) => void;
}

const PENDING_SESSION_BASE_VERSION = -1;
/** Proxy-cache backfill: how many uncached profiles one roster poll fetches. */
const PROXY_BACKFILL_BATCH = 8;
/** How long a failed backfill fetch stays quiet before it is retried. */
const PROXY_BACKFILL_RETRY_MS = 300_000;
/** Parallel closes during a release, matching the dashboard lifecycle limit. */
const RELEASE_CLOSE_LIMIT = 4;
const DEFAULT_CHECKPOINT_DEBOUNCE_MS = 2_000;
const DEFAULT_CHECKPOINT_MIN_INTERVAL_MS = 20_000;
const DEFAULT_CLOUD_CHECKPOINT_INTERVAL_MS = 180_000;
const DEFAULT_CLOUD_CHECKPOINT_SOON_MS = 30_000;
/** Failed checkpoint uploads in a row before the dashboard says the profile is not saved to Cloud yet. */
const CLOUD_UPLOAD_FAILURES_SHOWN = 2;
/** How often a running Cloud browser is checked for a closed last window. */
// Local /json/list probe for a user-closed window; three empty reads (~15 s) end the open.
const WINDOW_CHECK_MS = 5_000;
/** Checks in a row without a page before the last window counts as closed. */
const WINDOW_CLOSED_CHECKS = 3;
// Storage watchers capture every change, so the heartbeat runs a full capture only every Nth beat.
const HEARTBEAT_FULL_CAPTURE_EVERY = 10;
const CLOUD_PROFILE_OPEN_ERROR =
  "This Cloud profile is open in another session. Close it there, or try again shortly if that browser already closed.";
const TERMINAL_CONFLICT_WARNING =
  "Opened the current Cloud copy. This device's last session for this profile was not saved because " +
  "Cloud rejected it; that session remains encrypted on this device.";
const RESAVE_PENDING_ERROR =
  "This profile's last session from this device is still being saved to Cloud. Try again shortly.";
const CAPTURE_KEPT_OPEN_ERROR =
  "Could not save this profile's session, so its browser stays open. Try closing it again.";

/**
 * Watch one browser storage folder. In Chromium's Network folder only the cookie database holds
 * logins: Chromium rewrites its own network state there (Network Persistent State, Reporting and
 * NEL, TransportSecurity) every 20 to 60 s on an idle profile, which would checkpoint as often.
 */
export function watchBrowserStorage(path: string, dirty: () => void): { close(): void } {
  // A new profile creates these folders at its first write; watching must not miss that write.
  mkdirSync(path, { recursive: true });
  const cookiesOnly = basename(path) === "Network";
  return watch(path, { recursive: true }, (_event, file) => {
    if (!cookiesOnly || !file || basename(String(file)).startsWith("Cookies")) dirty();
  });
}

/** A conflict Cloud will never accept, unlike a close that only lost its lease. */
function isTerminalConflict(capture: PendingClose): boolean {
  return capture.status === "conflict" && !isResavableConflict(capture);
}

interface CloudCheckpointState {
  registrationId: string;
  signature: string;
  tabs: string[];
  origins: Set<string>;
  telegramClient?: "a" | "k";
}

interface CloudDirtyMonitor {
  registrationId: string;
  debugPort: number;
  startedAt: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
  watchers: Array<{ close(): void }>;
  watcherGeneration: number;
  dirty: boolean;
  captureInFlight: boolean;
  lastCaptureAt: number;
  heartbeats: number;
}

/** Live checkpoint uploads of one open registration. */
interface CloudUploadState {
  registrationId: string;
  /** The local checkpoint changed since Cloud last saved it. */
  dirty: boolean;
  /** A login changed since Cloud last saved this session: upload early. */
  soon: boolean;
  /** `sessionLoginSignature` of the session Cloud last saved. */
  loginSignature: string;
  lastAttemptAt: number;
  failures: number;
  failingSince?: number;
  /** The service has no checkpoint endpoint: Cloud gets this session at close, as before. */
  unsupported: boolean;
}

interface CloudLeaseResult {
  accountId: string;
  registrationId: string;
  outcome: "ok" | "transient" | "terminal";
  errorCode?: string;
  /** On a version conflict: the newest version this registration saved, as Cloud reports it. */
  currentVersion?: number;
}

interface CloudLeaseInFlight {
  registrationId: string;
  promise: Promise<CloudLeaseResult>;
}

interface CloudMaintenanceInFlight {
  registrationId: string;
  promise: Promise<void>;
}

const TERMINAL_HEARTBEAT_ERRORS = new Set([
  "device_revoked",
  "membership_revoked",
  "version_conflict",
  "profile_not_found",
  "profile_trashed",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openProfileError(error: unknown): string {
  if (error instanceof CloudApiError && error.code === "profile_open") return CLOUD_PROFILE_OPEN_ERROR;
  return errorMessage(error);
}

/** The most recent session Cloud refused for good, for this profile. */
function newestParkedSession(
  queue: PendingSyncQueue,
  accountId: string,
  profileId: string,
): PendingCloseSummary | undefined {
  return newestParkedSessions(queue.list(accountId)).get(profileId);
}

/** Newest parked session per profile, from one queue read (the roster has ~14k profiles). */
function newestParkedSessions(summaries: PendingCloseSummary[]): Map<string, PendingCloseSummary> {
  const parked = new Map<string, PendingCloseSummary>();
  for (const summary of summaries) {
    if (summary.status === "conflict" && summary.readyToSubmit && !isResavableConflict(summary)) {
      parked.set(summary.profileId, summary);
    }
  }
  return parked;
}

function errorCode(error: unknown): string {
  if (error instanceof CloudApiError) return error.code;
  if (error instanceof SessionRestoreError) return error.outcome;
  if (error instanceof PlaywrightWorkerError) return error.code;
  if (error instanceof BrowserLaunchError) return "failed";
  return "transport_error";
}

export type CloudOpenStage =
  | "pending_sync"
  | "cloud_registration"
  | "lifecycle_opening"
  | "payload_restore"
  | "browser_launch"
  | "lifecycle_restoring"
  | "session_restore"
  | "version_commit"
  | "lifecycle_running"
  | "navigation";

function safeErrorType(error: unknown): string {
  if (error instanceof CloudApiError) return "CloudApiError";
  if (error instanceof SessionRestoreError) return "SessionRestoreError";
  if (error instanceof PlaywrightWorkerError) return "PlaywrightWorkerError";
  if (error instanceof BrowserLaunchError) return "BrowserLaunchError";
  if (error instanceof TypeError) return "TypeError";
  return error instanceof Error ? "Error" : "unknown";
}

function captureFailureStage(error: unknown): string {
  if (!(error instanceof PlaywrightWorkerError)) return "unknown";
  // Worker envelopes are runtime data. Never print arbitrary detail fields.
  const stage = error.details?.operation ?? error.details?.responseCategory;
  return typeof stage === "string" && [
    "connect", "context", "hidden_target", "hidden_target_unsupported", "navigation", "origin_storage", "cookies",
    "disconnect", "validation", "worker_timeout", "empty_stdout", "malformed_json",
    "wrong_protocol_shape", "stdout_overflow", "stdout_read_failed", "success_nonzero_exit",
  ].includes(stage) ? stage : "unknown";
}

function sessionRestoreDiagnostic(error: SessionRestoreError): CloudDiagnosticType {
  return `session_restore_${error.operation}_${error.outcome}`;
}

function browserLaunchDiagnostic(error: BrowserLaunchError): CloudDiagnosticType {
  return `browser_launch_${error.failure}_failed`;
}

function normalizeBrowserLaunchError(error: unknown): BrowserLaunchError {
  return error instanceof BrowserLaunchError ? error : new BrowserLaunchError("preflight");
}

export class CloudBrowserCoordinator implements CloudBrowserLifecycle {
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, Promise<CloudBrowserOpenResult>>();
  private readonly startupLeases = new Map<string, { registrationId: string; error?: CloudApiError }>();
  private readonly closing = new Map<string, Promise<CloudBrowserCloseResult>>();
  /** Per profile: the heartbeat and window-check intervals. */
  private readonly timers = new Map<string, unknown[]>();
  private readonly windowChecks = new Set<string>();
  private readonly heartbeatInFlight = new Map<string, CloudLeaseInFlight>();
  private readonly maintenanceInFlight = new Map<string, CloudMaintenanceInFlight>();
  private readonly checkpointSignatures = new Map<string, CloudCheckpointState>();
  private readonly dirtyMonitors = new Map<string, CloudDirtyMonitor>();
  private readonly uploads = new Map<string, CloudUploadState>();
  /** Per profile: since when it is closed without its final capture, until a later capture is in Cloud. */
  private readonly closedUnsaved = new Map<string, number>();
  private readonly missingPageObservations = new Map<string, {
    registrationId: string;
    count: number;
  }>();
  private pendingRetryTimer: unknown;
  private pendingRetryInFlight: Promise<void> | null = null;
  private readonly heartbeatMs: number;
  private readonly storageCheckpoints: boolean;
  private readonly checkpointDebounceMs: number;
  private readonly checkpointMinIntervalMs: number;
  private readonly cloudCheckpointIntervalMs: number;
  private readonly cloudCheckpointSoonMs: number;
  private readonly log: (message: string) => void;
  private readonly diagnosticEvents = new CloudDiagnostics();
  private shuttingDown = false;
  private draining = false;
  /** Versions this run has decrypted into the local cache, per profile. */
  private readonly proxyCacheVersions = new Map<string, number>();
  /** Last backfill attempt per profile, so a failing fetch is not retried every poll. */
  private readonly proxyCacheAttempts = new Map<string, number>();
  private proxyBackfillTask: Promise<void> | null = null;
  private rosterReconcile: Promise<void> | null = null;

  constructor(private readonly options: CloudBrowserOptions) {
    this.heartbeatMs = Math.max(0, options.heartbeatMs ?? 60_000);
    this.storageCheckpoints = options.storageCheckpoints ?? true;
    this.checkpointDebounceMs = Math.max(0, options.checkpointDebounceMs ?? DEFAULT_CHECKPOINT_DEBOUNCE_MS);
    this.checkpointMinIntervalMs = Math.max(0, options.checkpointMinIntervalMs ?? DEFAULT_CHECKPOINT_MIN_INTERVAL_MS);
    this.cloudCheckpointIntervalMs = Math.max(0, options.cloudCheckpointIntervalMs ?? DEFAULT_CLOUD_CHECKPOINT_INTERVAL_MS);
    this.cloudCheckpointSoonMs = Math.max(0, options.cloudCheckpointSoonMs ?? DEFAULT_CLOUD_CHECKPOINT_SOON_MS);
    this.log = options.log ?? (() => {});
  }

  diagnostics(): readonly CloudDiagnosticEvent[] {
    return this.diagnosticEvents.snapshot();
  }

  canEditLive(profileId: string): boolean {
    return !this.draining &&
      !this.shuttingDown &&
      !this.closing.has(profileId) &&
      this.hasLiveEditGeneration(profileId);
  }

  async commitLiveEdit(profile: Profile): Promise<boolean> {
    return this.withProfileTransition(profile.id, async () => {
      if (this.draining || this.shuttingDown || !this.hasLiveEditGeneration(profile.id)) {
        return false;
      }
      this.options.store.upsertProfile(profile);
      this.noteProfileEdited(profile.id);
      return true;
    });
  }

  private hasLiveEditGeneration(profileId: string): boolean {
    let context: { queue: PendingSyncQueue; accountId: string };
    try {
      context = this.requireContext(false);
    } catch {
      return false;
    }
    const open = context.queue.getOpen(profileId, context.accountId);
    const launch = this.options.store.getLaunch(profileId);
    return !!open &&
      !open.cleanupMode &&
      !!launch &&
      this.isExactRunningLaunch(open, launch);
  }

  async listRoster(): Promise<{ profiles: CloudBrowserProfile[]; healthSources: [] }> {
    const { queue, accountId } = this.requireContext(false);
    // Finishing a closed browser uploads its session and waits behind any open
    // or close of that profile; on a slow link that takes minutes. Run it beside
    // the roster fetch so the list never waits for it. Local probes usually
    // finish before the fetch returns, so running state stays current.
    if (!this.rosterReconcile) {
      this.rosterReconcile = this.reconcileClosedBrowsers(queue, accountId)
        .catch((error) => this.log(`Cloud roster reconciliation failed (${safeErrorType(error)})`))
        .finally(() => { this.rosterReconcile = null; });
    }
    const localRegistrations = new Map<string, Set<string>>();
    const rememberRegistration = (profileId: string, registrationId: string) => {
      const registrations = localRegistrations.get(profileId) ?? new Set<string>();
      registrations.add(registrationId);
      localRegistrations.set(profileId, registrations);
    };
    // A registration that finishes during the fetch can still be in the Cloud reply.
    const rememberLocal = () => {
      for (const open of queue.listOpens(accountId)) rememberRegistration(open.profileId, open.registrationId);
      for (const summary of queue.list(accountId)) {
        try {
          const pending = queue.get(summary.id, accountId);
          if (pending) rememberRegistration(pending.profileId, pending.registrationId);
        } catch {
          // An unreadable registration cannot prove local ownership or hide a Cloud lock.
        }
      }
    };
    rememberLocal();
    const response = await this.options.cloud.listProfiles();
    this.backfillProxyCache(response.profiles);
    rememberLocal();
    const parkedSessions = newestParkedSessions(queue.list(accountId));
    return {
      profiles: response.profiles
        .filter((profile) => profile.trashedAt === null)
        .map((profile) => {
          const launch = this.options.store.getLaunch(profile.id);
          const cached = this.options.store.getProfile(profile.id);
          const parked = parkedSessions.get(profile.id);
          const upload = launch ? this.uploads.get(profile.id) : undefined;
          // A parked session means Cloud took another device's copy; its own notice covers that.
          const unsavedSince = upload?.failingSince !== undefined && upload.failures >= CLOUD_UPLOAD_FAILURES_SHOWN
            ? upload.failingSince
            : parked ? undefined : this.closedUnsaved.get(profile.id);
          const localRegistrationIds = localRegistrations.get(profile.id);
          const otherActiveOpens = profile.activeOpens.filter(
            (open) => !localRegistrationIds?.has(open.registrationId),
          );
          return {
            id: profile.id,
            ...(cached?.engine === "firefox" ? { engine: "firefox" as const } : {}),
            ...(cached?.chromiumRuntime ? { chromiumRuntime: cached.chromiumRuntime } : {}),
            name: profile.name,
            group: profile.group,
            platform: profile.platform,
            tags: [...profile.tags],
            proxy: cached?.proxy ? proxyHostPort(cached.proxy) : null,
            ...(cached?.proxyError ? { proxyError: cached.proxyError } : {}),
            timezone: "",
            cookieCount: 0,
            seeded: false,
            screen: "",
            has2fa: false,
            running: !!launch,
            ...(launch?.engine === "firefox" ? {} : { debugPort: launch?.debugPort }),
            startedAt: launch?.startedAt,
            lockedBy: otherActiveOpens.length > 0
              ? `${otherActiveOpens.length} other session(s)`
              : null,
            permission: profile.permission,
            version: profile.version,
            ...(parked ? { parkedSession: { savedAt: parked.createdAt, reason: parked.error } } : {}),
            ...(unsavedSince !== undefined ? { cloudUnsavedSince: unsavedSince } : {}),
          };
        }),
      healthSources: [],
    };
  }

  /**
   * The Cloud summary cannot carry the proxy — it lives inside the end-to-end
   * encrypted payload only this device can decrypt. A profile never opened here
   * would therefore show no proxy forever, so fetch and cache a few uncached
   * profiles per roster poll in the background; the column fills in over the
   * next polls without blocking this one. A version change on a profile cached
   * this run (a remote edit) triggers a refetch the same way.
   */
  private backfillProxyCache(profiles: readonly CloudProfileSummary[]): void {
    if (this.proxyBackfillTask || this.shuttingDown) return;
    const now = Date.now();
    const candidates = profiles
      .filter((profile) => {
        if (profile.trashedAt !== null) return false;
        const cachedVersion = this.proxyCacheVersions.get(profile.id);
        if (cachedVersion === profile.version) return false;
        // Cached by an earlier run at an unknown version: keep what we have
        // rather than re-downloading the whole roster on every start.
        if (cachedVersion === undefined && this.options.store.getProfile(profile.id)) return false;
        const attempted = this.proxyCacheAttempts.get(profile.id);
        return attempted === undefined || now - attempted > PROXY_BACKFILL_RETRY_MS;
      })
      .slice(0, PROXY_BACKFILL_BATCH);
    if (candidates.length === 0) return;
    this.proxyBackfillTask = (async () => {
      for (const summary of candidates) {
        if (this.shuttingDown) return;
        this.proxyCacheAttempts.set(summary.id, now);
        try {
          const response = await this.options.cloud.getProfile(summary.id);
          const { profile } = decodePortableProfile(response.payload);
          if (profile.id !== summary.id) continue;
          // A locally open profile's live state owns the cached row.
          if (this.options.store.getLaunch(summary.id)) continue;
          this.options.store.upsertProfile(profile);
          this.options.store.setTimezone(profile.id, profile.timezone);
          this.options.store.setHardware(profile.id, profile.hardware);
          this.proxyCacheVersions.set(summary.id, response.profile.version);
          // A profile synced from another device may need a Firefox font pack here.
          this.options.launcher.prefetchFirefoxFontPacks?.([profile]);
        } catch {
          // Transient Cloud errors: the attempt stamp keeps retries spaced out.
        }
      }
    })().finally(() => { this.proxyBackfillTask = null; });
  }

  private async reconcileClosedBrowsers(queue: PendingSyncQueue, accountId: string): Promise<void> {
    for (const candidate of queue.listOpens(accountId)) {
      await this.withProfileTransition(candidate.profileId, async () => {
        let current = queue.getOpen(candidate.profileId, accountId);
        if (!current || current.registrationId !== candidate.registrationId) return;
        if (current.cleanupMode) {
          await this.retryCleanup(current, queue);
          return;
        }

        let launch = this.options.store.getLaunch(candidate.profileId);
        if (launch && this.isExactRunningLaunch(current, launch)) {
          const reconciled = await this.options.launcher.reconcileOrphan(candidate.profileId, {
            debugPort: launch.debugPort,
            startedAt: launch.startedAt,
          });
          current = queue.getOpen(candidate.profileId, accountId);
          launch = this.options.store.getLaunch(candidate.profileId);
          if (!current || current.registrationId !== candidate.registrationId
            || reconciled === "generation_changed") return;
          if (reconciled === "alive") {
            return;
          }
        } else if (launch) {
          return;
        }

        if (this.options.store.getLaunch(candidate.profileId)) return;
        this.diagnosticEvents.record("browser_death_confirmed");
        this.diagnosticEvents.record("manual_stop_detected");
        await this.stopHeartbeat(candidate.profileId);
        const finished = await this.finishStoppedOpen(current, queue);
        if (!finished) this.startHeartbeat(candidate.profileId);
      });
    }
  }

  async create(profile: Profile): Promise<{ id: string }> {
    this.requireContext(false);
    const created = await this.options.cloud.createProfile({
      payload: encodePortableProfile(completeProfileFingerprint(profile)),
    });
    if (created.profile.id !== profile.id) {
      throw new Error("Cloud returned a mismatched created profile");
    }
    // This device saves a Cloud profile only when it opens it, so start its browser download now.
    this.options.launcher.prefetchBrowserRuntimes?.([profile]);
    return { id: profile.id };
  }

  async importProfiles(destination: string, profiles: ProfileExport[]): Promise<ImportProfilesResponse> {
    this.requireContext(false);
    const ids = profiles.map((profile) => profile.id);
    const imported = await this.options.cloud.importProfiles({
      destination,
      profiles: profiles.map((profile) => encodePortableProfile(completeProfileFingerprint(profile), profile.sessionBundle)),
    });
    if (
      imported.imported !== ids.length
      || imported.ids.length !== ids.length
      || imported.ids.some((id, index) => id !== ids[index])
    ) {
      throw new Error("Cloud returned a mismatched profile import result");
    }
    this.options.launcher.prefetchBrowserRuntimes?.(profiles);
    return imported;
  }

  async open(
    profileId: string,
    launchArgs: string[] = [],
    options: BrowserOpenOptions = {},
  ): Promise<CloudBrowserOpenResult> {
    if (this.shuttingDown || this.draining) {
      return { ok: false, error: "Cloud browser coordinator is shutting down" };
    }
    const existing = this.opening.get(profileId);
    if (existing) return existing;
    const promise = this.withProfileTransition(profileId, () => this.doOpen(profileId, launchArgs, options));
    this.opening.set(profileId, promise);
    try {
      return await promise;
    } finally {
      if (this.opening.get(profileId) === promise) this.opening.delete(profileId);
    }
  }

  private async doOpen(
    profileId: string,
    launchArgs: string[],
    options: BrowserOpenOptions,
  ): Promise<CloudBrowserOpenResult> {
    this.diagnosticEvents.record("open_started");
    let context: { queue: PendingSyncQueue; accountId: string; deviceId: string };
    try {
      context = this.requireContext(true);
    } catch (error) {
      this.diagnosticEvents.record("open_failed");
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const { queue, accountId, deviceId } = context;
    let stage: CloudOpenStage = "pending_sync";
    let registrationRecorded = false;
    let registrationId: string | undefined;
    let cleanupGeneration: { debugPort: number; startedAt: number } | undefined;
    let retainedGeneration: { debugPort: number; startedAt: number; ws: string } | undefined;
    let retainAfterSessionFailure = false;
    let identityCheckFailed = false;
    const verifyIdentity = () => this.options.launcher.verifyRunningIdentity(profileId).catch((error) => {
      identityCheckFailed = true;
      throw error;
    });
    // Stage timing into the persistent log file: fixed stage names + ms only.
    const openStartedAt = Date.now();
    let lastStageAt = openStartedAt;
    let lastLoggedStage: string = stage;
    const logStage = (next: string) => {
      const now = Date.now();
      this.log(`${profileId}: open ${lastLoggedStage} -> ${next} (${now - lastStageAt}ms, total ${now - openStartedAt}ms)`);
      lastStageAt = now;
      lastLoggedStage = next;
    };

    try {
      await this.submitPending(queue, accountId);
      const pendingForProfile = queue.list(accountId)
        .filter((pending) => pending.profileId === profileId);
      if (pendingForProfile.some((pending) => pending.status !== "conflict")) {
        return { ok: false, error: "Pending Cloud synchronization must be resolved before reopening" };
      }
      // Opening now would restore the older Cloud copy over the unsaved session.
      if (pendingForProfile.some(isResavableConflict)) {
        return { ok: false, error: RESAVE_PENDING_ERROR };
      }
      const hasTerminalConflict = pendingForProfile.some((pending) => pending.status === "conflict");
      if (queue.getOpen(profileId, accountId)) {
        return { ok: false, error: "Cloud profile recovery must finish before opening" };
      }
      if (this.options.store.getLaunch(profileId)) {
        return { ok: false, error: "an unmanaged local browser is already recorded for this profile" };
      }

      stage = "cloud_registration";
      logStage("cloud_registration");
      const opened = await this.options.cloud.openProfile(profileId, { deviceId });
      registrationId = opened.registrationId;
      this.diagnosticEvents.record("cloud_registered");

      stage = "lifecycle_opening";
      logStage("lifecycle_opening");
      queue.recordOpen({
        accountId,
        profileId,
        registrationId,
        expectedVersion: opened.baseVersion,
      });
      registrationRecorded = true;

      const otherActiveOpens = opened.activeOpens.filter(
        (open) => open.registrationId !== opened.registrationId,
      );
      if (otherActiveOpens.length > 0) {
        if (!queue.setOpenCleanup(profileId, accountId, registrationId, "abandon")) {
          throw new Error("Cloud open lifecycle state disappeared before concurrent-open cleanup");
        }
        const current = queue.getOpen(profileId, accountId);
        const released = !!current && await this.retryCleanup(current, queue);
        this.diagnosticEvents.record(released ? "cloud_registration_released" : "cleanup_retained");
        this.diagnosticEvents.record("open_failed");
        return { ok: false, error: CLOUD_PROFILE_OPEN_ERROR };
      }

      // Lease renewal must not wait for browser launch or session restoration.
      const startupLease: { registrationId: string; error?: CloudApiError } = { registrationId };
      this.startupLeases.set(profileId, startupLease);
      this.startHeartbeat(profileId);

      stage = "payload_restore";
      logStage("payload_restore");
      const { profile: decoded, sessionBundle } = decodePortableProfile(opened.payload);
      if (decoded.id !== profileId) throw new Error("Cloud returned a mismatched profile payload");
      this.options.store.upsertProfile(completeProfileFingerprint(decoded));
      this.options.store.setTimezone(decoded.id, decoded.timezone);
      this.options.store.setHardware(decoded.id, decoded.hardware);
      const profile = this.options.store.getProfile(profileId)!;
      this.proxyCacheVersions.set(profileId, opened.baseVersion);

      stage = "browser_launch";
      logStage("browser_launch");
      const { chromeArgs, startupUrls } = splitLaunchUrls(launchArgs);
      const signature = sessionBundleSignature(sessionBundle);
      // Start URLs open beside the session; they never choose the older Cloud copy over this device's.
      let restoreNativeSession = this.options.launcher.matchesCloudSession(profileId, signature);
      // Native cookies written under another Windows account are unreadable here.
      if (restoreNativeSession && (await this.options.launcher.nativeSessionReadable?.(profileId)) === false) {
        restoreNativeSession = false;
        this.log(`${profileId}: local cookie key belongs to another Windows account; restoring from the Cloud copy`);
      }
      // An interrupted restore must not leave partially replaced disk state trusted.
      this.options.launcher.recordCloudSession(profileId, null);
      const startBrowser = async () => {
        return await this.options.launcher.start(profileId, chromeArgs, {
          autoNavigate: false,
          restoreLocalSession: false,
          restoreLastSession: restoreNativeSession,
          resetStorage: !restoreNativeSession && bundleHasRestorableLogin(sessionBundle),
          sessionBaseVersion: PENDING_SESSION_BASE_VERSION,
          headless: options.headless,
          keepAliveWithoutWindows: true,
        });
      };
      let launched: Awaited<ReturnType<typeof startBrowser>>;
      try {
        launched = await startBrowser();
      } catch (error) {
        cleanupGeneration = this.options.launcher.failedStartGeneration(error);
        if (error instanceof SessionRestoreError) throw error;
        const launchError = normalizeBrowserLaunchError(error);
        // A failed start can retain exact ownership. Stop only the generation tied
        // to that rejection, then retry once so a replacement can never be targeted.
        if (!cleanupGeneration) throw launchError;
        const stopped = await this.options.launcher.stop(profileId, cleanupGeneration).catch(() => false);
        if (!stopped) throw launchError;
        if (startupLease.error) throw startupLease.error;
        this.log(`${profileId}: stopped retained browser launch ownership; retrying once`);
        try {
          launched = await startBrowser();
        } catch (retryError) {
          cleanupGeneration = this.options.launcher.failedStartGeneration(retryError);
          if (retryError instanceof SessionRestoreError) throw retryError;
          throw normalizeBrowserLaunchError(retryError);
        }
      }
      this.diagnosticEvents.record("browser_started");
      const launch = this.options.store.getLaunch(profileId);
      if (!launch) throw new Error("browser launch did not create durable lifecycle state");
      cleanupGeneration = {
        debugPort: launch.debugPort,
        startedAt: launch.startedAt,
      };
      if (startupLease.error) throw startupLease.error;

      stage = "lifecycle_restoring";
      logStage("lifecycle_restoring");

      stage = "session_restore";
      logStage("session_restore");
      this.diagnosticEvents.record("session_restore_started");
      await verifyIdentity();
      const verifiedLaunch = this.options.store.getLaunch(profileId);
      if (
        !verifiedLaunch ||
        verifiedLaunch.debugPort !== launch.debugPort ||
        verifiedLaunch.startedAt !== launch.startedAt
      ) {
        throw new Error("Cloud browser identity changed before session restore");
      }
      retainedGeneration = {
        debugPort: verifiedLaunch.debugPort,
        startedAt: verifiedLaunch.startedAt,
        ws: verifiedLaunch.ws,
      };
      if (!queue.updateOpen(profileId, accountId, "restoring", {
        debugPort: verifiedLaunch.debugPort,
        startedAt: verifiedLaunch.startedAt,
      })) {
        retainedGeneration = undefined;
        throw new Error("Cloud open lifecycle state disappeared during launch");
      }
      // ONE CDP attach: restore the authoritative bundle (no-op attach-free when
      // the bundle is empty) and open explicit pages after its saved tabs.
      const home = platformHomeUrl(profile.platform, telegramHomeClient(sessionBundle));
      const savedTabs = bundleTabUrls(sessionBundle);
      const urls = startupUrls.length > 0
        ? startupUrls
        : savedTabs.length === 0 && home
          ? [home]
          : [];
      let navigationWarning: string | undefined;
      const nativeState = restoreNativeSession && !!(launched.nativeSessionRestored || launched.nativeSessionLoaded);
      this.log(`${profileId}: Cloud open restores ${nativeState ? "this device's session" : "the Cloud copy"}`);
      try {
        // Portable seeding blanks origin pages and replaces tabs. Native restore
        // already has newer local state and preserves the full Chromium layout.
        if (!nativeState) {
          await this.options.applySession(verifiedLaunch.ws, sessionBundle, urls);
        } else if (!launched.nativeSessionRestored && savedTabs.length + urls.length > 0) {
          // Chromium loaded this device's last session but showed no page. Its cookies are at least
          // as new as the Cloud copy, so open the saved tabs without replacing them.
          await this.options.launcher.navigate(verifiedLaunch.ws, [...savedTabs, ...urls], true)
            .catch(() => { throw new SessionRestoreError("navigation", "failed"); });
        } else if (launched.nativeSessionRestored && startupUrls.length > 0) {
          // Start URLs open in new tabs beside the restored session.
          await this.options.launcher.navigate(verifiedLaunch.ws, startupUrls)
            .catch(() => { throw new SessionRestoreError("navigation", "failed"); });
        }
      } catch (error) {
        if (error instanceof SessionRestoreError && error.operation === "navigation") {
          navigationWarning = "Profile opened, but startup navigation failed. Open the site manually.";
          this.log(`${profileId}: Cloud startup navigation failed (${error.outcome}); continuing`);
        } else {
          retainAfterSessionFailure = true;
          throw error;
        }
      }
      const renewal = this.heartbeatInFlight.get(profileId);
      if (renewal?.registrationId === registrationId) await renewal.promise;
      await verifyIdentity();
      if (startupLease.error) throw startupLease.error;
      const restoredLaunch = this.options.store.getLaunch(profileId);
      if (
        !restoredLaunch ||
        restoredLaunch.debugPort !== launch.debugPort ||
        restoredLaunch.startedAt !== launch.startedAt ||
        restoredLaunch.ws !== verifiedLaunch.ws
      ) {
        throw new Error("Cloud browser identity changed during session restore");
      }
      this.diagnosticEvents.record("session_restore_completed");

      stage = "version_commit";
      logStage("version_commit");
      this.options.store.updateLaunchSessionBaseVersion(profileId, opened.baseVersion);

      stage = "lifecycle_running";
      logStage("lifecycle_running");
      if (!queue.updateOpen(profileId, accountId, "running", {
        debugPort: restoredLaunch.debugPort,
        startedAt: restoredLaunch.startedAt,
      })) {
        throw new Error("Cloud open lifecycle state disappeared after restore");
      }
      queue.enqueue({
        accountId,
        profileId,
        registrationId,
        expectedVersion: opened.baseVersion,
        // The stored profile carries the timezone the launch took from the proxy exit.
        payload: encodePortableProfile(this.options.store.getProfile(profileId) ?? profile, sessionBundle),
        readyToSubmit: false,
      });
      // Cloud already holds the session this open restored.
      this.uploads.set(profileId, {
        registrationId, dirty: false, soon: false, loginSignature: sessionLoginSignature(sessionBundle),
        lastAttemptAt: 0, failures: 0, unsupported: false,
      });
      const captureSeed = sessionCaptureSeed(sessionBundle);
      this.checkpointSignatures.set(profileId, {
        registrationId,
        signature,
        tabs: bundleTabUrls(sessionBundle),
        origins: new Set(captureSeed.origins),
        ...(captureSeed.telegramClient ? { telegramClient: captureSeed.telegramClient } : {}),
      });
      // A failed page open leaves this device's session untouched, so it stays trusted.
      if (!navigationWarning || nativeState) this.recordCloudSessionSignature(profileId, signature);

      // Startup navigation already happened inside the single restore attach above.
      this.diagnosticEvents.record("open_running");
      this.startHeartbeat(profileId);
      const lapsed = opened.lapsedOpens?.[0];
      const lapsedWarning = !lapsed
        ? undefined
        : lapsed.checkpointAt
          ? `${lapsed.deviceLabel} did not close this profile. This is the copy it saved to Cloud at ${new Date(lapsed.checkpointAt).toLocaleString()}.`
          : `${lapsed.deviceLabel} did not close this profile. Its changes after it opened the profile are not in Cloud.`;
      const warnings = [
        navigationWarning,
        hasTerminalConflict ? TERMINAL_CONFLICT_WARNING : undefined,
        lapsedWarning,
      ].filter((warning): warning is string => !!warning);
      return {
        ok: true,
        ws: restoredLaunch.ws,
        port: restoredLaunch.debugPort,
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      };
    } catch (error) {
      this.stopHeartbeat(profileId);
      if (error instanceof SessionRestoreError) {
        this.diagnosticEvents.record(sessionRestoreDiagnostic(error));
      } else if (error instanceof BrowserLaunchError) {
        this.diagnosticEvents.record(browserLaunchDiagnostic(error));
      } else if (stage === "session_restore") {
        this.diagnosticEvents.record("session_restore_unclassified_failed");
      }
      this.diagnosticEvents.record("open_failed");
      this.log(`${profileId}: open FAILED at ${lastLoggedStage} after ${Date.now() - openStartedAt}ms`);
      // payload_restore only checks the downloaded profile and stores it on this
      // device: a failure there is the payload, never the network.
      const code = stage === "payload_restore" ? "invalid_payload" : errorCode(error);
      const failureStage = error instanceof SessionRestoreError
        ? `session_restore/${error.operation}`
        : error instanceof BrowserLaunchError
          ? `browser_launch/${error.failure}`
          : stage;
      // Before registration only the local pending-sync queue is touched, so a
      // failure there is a local queue/database error whose message holds no
      // session material and is the only clue an operator gets. Payload checks
      // name the field that failed (e.g. "profile cookie 3 ..."), not session or login values.
      // Launcher identity checks name only local runtime state; restore errors may carry page detail.
      const localDetail = error instanceof Error && (stage === "pending_sync" || stage === "payload_restore" || identityCheckFailed)
        ? `: ${error.message}` : "";
      const guidance = error instanceof BrowserLaunchError && error.guidance ? `: ${error.guidance}` : "";
      this.log(`${profileId}: Cloud open failed at ${failureStage} (${code}, ${safeErrorType(error)})${localDetail}${guidance}`);
      const currentLaunch = retainAfterSessionFailure && retainedGeneration
        ? this.options.store.getLaunch(profileId)
        : undefined;
      const retainBrowser = !!currentLaunch && !!retainedGeneration &&
        currentLaunch.debugPort === retainedGeneration.debugPort &&
        currentLaunch.startedAt === retainedGeneration.startedAt &&
        currentLaunch.ws === retainedGeneration.ws;
      if (retainBrowser) {
        this.diagnosticEvents.record("cleanup_retained");
        this.startHeartbeat(profileId);
        return {
          ok: false,
          error: `Cloud profile open failed at ${failureStage} (${code}); browser left open${guidance}`,
        };
      }
      if (registrationRecorded && registrationId && cleanupGeneration) {
        const failedOpen = queue.getOpen(profileId, accountId);
        if (
          failedOpen?.registrationId === registrationId &&
          (failedOpen.debugPort === null || failedOpen.startedAt === null)
        ) {
          queue.updateOpen(profileId, accountId, "restoring", cleanupGeneration);
        }
      }
      const failedLaunch = registrationId
        ? this.options.store.getLaunch(profileId)
        : null;
      let stopped = false;
      if (registrationId && !failedLaunch && !cleanupGeneration) {
        stopped = true;
      } else if (
        registrationId && failedLaunch && cleanupGeneration &&
        failedLaunch.debugPort === cleanupGeneration.debugPort &&
        failedLaunch.startedAt === cleanupGeneration.startedAt
      ) {
        stopped = await this.options.launcher.stop(profileId, cleanupGeneration).catch(() => false);
      }
      if (!stopped && registrationId) {
        if (registrationRecorded) {
          queue.setOpenCleanup(profileId, accountId, registrationId, "abandon");
        }
        this.diagnosticEvents.record("cleanup_retained");
      }
      if (stopped && registrationId) {
        try {
          await this.options.cloud.abandon(registrationId);
          if (registrationRecorded) {
            queue.removeOpenRegistration(profileId, accountId, registrationId);
          }
        } catch (abandonError) {
          if (
            registrationRecorded &&
            abandonError instanceof CloudApiError &&
            abandonError.code === "profile_not_found"
          ) {
            queue.removeOpenRegistration(profileId, accountId, registrationId);
          } else {
            this.diagnosticEvents.record("cleanup_retained");
          }
          // Other failures retain durable metadata for authenticated recovery.
        }
      }
      if (error instanceof CloudApiError && error.code === "profile_open") {
        return { ok: false, error: CLOUD_PROFILE_OPEN_ERROR };
      }
      return {
        ok: false,
        error: `Cloud profile open failed at ${failureStage} (${code})${guidance}`,
      };
    } finally {
      if (this.startupLeases.get(profileId)?.registrationId === registrationId) {
        this.startupLeases.delete(profileId);
      }
    }
  }

  /**
   * Write a parked session back to Cloud as a new version. A session is parked
   * when Cloud refused its close for good — the profile changed elsewhere first
   * — so only the operator can decide it is the state they want. Everything but
   * the session keeps Cloud's current values, and the parked copy is released
   * only once Cloud accepts it.
   */
  async restoreParkedSession(profileId: string): Promise<CloudRestoreResult> {
    if (this.shuttingDown || this.draining) {
      return { ok: false, error: "Cloud browser coordinator is shutting down" };
    }
    return this.withProfileTransition(profileId, async () => {
      const { queue, accountId, deviceId } = this.requireContext(true);
      if (queue.getOpen(profileId, accountId) || this.options.store.getLaunch(profileId)) {
        return { ok: false, error: "Close this profile's browser before restoring a saved session." };
      }
      const summary = newestParkedSession(queue, accountId, profileId);
      if (!summary) return { ok: false, error: "This profile has no saved session on this device." };
      let parked: PendingClose | null;
      try {
        parked = queue.get(summary.id, accountId);
      } catch {
        return { ok: false, error: "The saved session on this device could not be decrypted." };
      }
      if (!parked) return { ok: false, error: "This profile has no saved session on this device." };

      let opened: OpenProfileResponse;
      try {
        opened = await this.options.cloud.openProfile(profileId, { deviceId });
      } catch (error) {
        return { ok: false, error: openProfileError(error) };
      }
      try {
        const response = await this.options.cloud.closeOpen(opened.registrationId, {
          expectedVersion: opened.baseVersion,
          payload: { ...opened.payload, session: parked.payload.session },
        });
        if (!response.ok) {
          await this.options.cloud.abandon(opened.registrationId).catch(() => {});
          return { ok: false, error: "Cloud changed while restoring. Try again." };
        }
        queue.remove(parked.id, accountId);
        this.diagnosticEvents.record("parked_session_restored");
        return { ok: true, version: response.version };
      } catch (error) {
        await this.options.cloud.abandon(opened.registrationId).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async close(profileId: string): Promise<CloudBrowserCloseResult> {
    return this.closeOnce(profileId, true);
  }

  /** Without `stopOnCaptureFailure`, a failed final capture leaves the browser open for the caller. */
  private async closeOnce(profileId: string, stopOnCaptureFailure: boolean): Promise<CloudBrowserCloseResult> {
    const existing = this.closing.get(profileId);
    if (existing) return existing;
    const promise = this.withProfileTransition(profileId, () => this.doClose(profileId, stopOnCaptureFailure));
    this.closing.set(profileId, promise);
    try {
      return await promise;
    } finally {
      if (this.closing.get(profileId) === promise) this.closing.delete(profileId);
    }
  }

  private async doClose(profileId: string, stopOnCaptureFailure: boolean): Promise<CloudBrowserCloseResult> {
    this.diagnosticEvents.record("close_started");
    const { queue, accountId } = this.requireContext(false);
    let open = queue.getOpen(profileId, accountId);
    let launch = this.options.store.getLaunch(profileId);
    if (open && launch && open.debugPort !== null && open.startedAt !== null
      && launch.debugPort === open.debugPort && launch.startedAt === open.startedAt) {
      const registrationId = open.registrationId;
      const reconciled = await this.options.launcher.reconcileOrphan(profileId, {
        debugPort: launch.debugPort,
        startedAt: launch.startedAt,
      });
      if (reconciled === "generation_changed") return this.teardownUnconfirmed();
      open = queue.getOpen(profileId, accountId);
      launch = this.options.store.getLaunch(profileId);
      if (!open || open.registrationId !== registrationId) return this.teardownUnconfirmed();
    }
    if (!open) {
      if (launch) {
        this.diagnosticEvents.record("cleanup_retained");
        throw new Error("Cloud open lifecycle state is missing; browser left open");
      }
      await this.stopHeartbeatAndWait(profileId);
      return this.closedProfileResult(profileId, accountId, queue);
    }

    this.stopDirtyMonitor(profileId);
    this.missingPageObservations.delete(profileId);
    if (open.cleanupMode) {
      await this.retryCleanup(open, queue);
      const current = queue.getOpen(profileId, accountId);
      if (current?.registrationId === open.registrationId) {
        this.startHeartbeat(profileId);
        return this.teardownUnconfirmed();
      }
      return this.closeResultForOpen(open, queue);
    }
    if (launch && open.phase !== "running") {
      if (
        open.debugPort === null ||
        open.startedAt === null ||
        launch.debugPort !== open.debugPort ||
        launch.startedAt !== open.startedAt
      ) {
        this.diagnosticEvents.record("cleanup_retained");
        this.startHeartbeat(profileId);
        return this.teardownUnconfirmed();
      }
      const stopped = await this.options.launcher.stop(profileId, {
        debugPort: launch.debugPort,
        startedAt: launch.startedAt,
      }).catch(() => false);
      if (!stopped) {
        this.diagnosticEvents.record("cleanup_retained");
        this.startHeartbeat(profileId);
        return this.teardownUnconfirmed();
      }
      await this.stopHeartbeatAndWait(profileId);
      this.diagnosticEvents.record("browser_stopped");
      const finished = await this.abandonStoppedOpen(open, queue);
      this.diagnosticEvents.record(finished ? "cloud_registration_released" : "cleanup_retained");
      return this.closeResultForOpen(open, queue);
    }
    if (!launch) {
      await this.stopHeartbeatAndWait(profileId);
      const hadCapture = this.pendingCapturesForOpen(open, queue).length > 0;
      const finished = await this.finishStoppedOpen(open, queue);
      const retained = this.pendingCapturesForOpen(open, queue).length > 0;
      this.diagnosticEvents.record(
        !finished || retained
          ? "cleanup_retained"
          : hadCapture
            ? "session_synced"
            : "cloud_registration_released",
      );
      return this.closeResultForOpen(open, queue);
    }

    let captureFailed = false;
    try {
      const profile = this.options.store.getProfile(profileId);
      if (!profile) throw new Error("Cloud profile cache is missing");
      await this.options.launcher.verifyRunningIdentity(profileId);
      const verifiedLaunch = this.options.store.getLaunch(profileId);
      if (!verifiedLaunch || !this.isExactRunningLaunch(open, verifiedLaunch)) {
        throw new Error("Cloud browser identity changed before session capture");
      }
      const sessionBundle = await this.captureSession(open, queue, verifiedLaunch.ws, false, true);
      await this.options.launcher.verifyRunningIdentity(profileId);
      const capturedLaunch = this.options.store.getLaunch(profileId);
      if (!capturedLaunch || !this.isExactRunningLaunch(open, capturedLaunch)) {
        throw new Error("Cloud browser identity changed during session capture");
      }
      if (!this.checkpointOpen(open, queue, sessionBundle)) {
        throw new Error("Cloud checkpoint state changed during session capture");
      }
      const pending = this.pendingCapturesForOpen(open, queue)
        .find((capture) => !capture.readyToSubmit && capture.status !== "conflict");
      if (!pending) throw new Error("Cloud checkpoint is missing after session capture");
      this.diagnosticEvents.record("session_captured");
      this.closedUnsaved.delete(profileId);
      if (!queue.setOpenCleanup(profileId, accountId, open.registrationId, "sync")) {
        this.diagnosticEvents.record("cleanup_retained");
        this.startHeartbeat(profileId);
        return this.teardownUnconfirmed();
      }
    } catch (error) {
      if (!stopOnCaptureFailure || !this.prepareStopWithoutCapture(open, queue)) {
        this.log(`${profileId}: Cloud session capture failed (${errorCode(error)})${stopOnCaptureFailure ? "; browser left open" : ""}`);
        this.diagnosticEvents.record("cleanup_retained");
        this.startHeartbeat(profileId);
        throw new Error(CAPTURE_KEPT_OPEN_ERROR);
      }
      captureFailed = true;
      this.log(`${profileId}: Cloud session capture failed (${errorCode(error)}); stopping the browser with the last saved copy`);
    }

    const stopLaunch = this.options.store.getLaunch(profileId);
    const stopped = !!stopLaunch && this.isExactRunningLaunch(open, stopLaunch) &&
      await this.options.launcher.stop(profileId, {
        debugPort: stopLaunch.debugPort,
        startedAt: stopLaunch.startedAt,
      }).catch(() => false);
    if (!stopped) {
      this.diagnosticEvents.record("cleanup_retained");
      this.startHeartbeat(profileId);
      return this.teardownUnconfirmed();
    }
    await this.stopHeartbeatAndWait(profileId);
    this.diagnosticEvents.record("browser_stopped");

    const failed = captureFailed ? { captureFailed: true as const } : {};
    if (!this.finalizeOpenCheckpoint(open, queue)) {
      this.diagnosticEvents.record("cleanup_retained");
      return { ...this.closeResultForOpen(open, queue), ...failed };
    }
    this.clearCheckpointSignature(open);
    if (this.options.accountId() === accountId) {
      await this.submitPending(queue, accountId);
    }
    const result = this.closeResultForOpen(open, queue);
    this.diagnosticEvents.record(result.sync === "complete" ? "session_synced" : "cleanup_retained");
    return { ...result, ...failed };
  }

  /**
   * The final capture failed: let the browser stop anyway and finish with the open's last
   * checkpoint. Cloud gets that checkpoint, and the newer state stays on this device's disk. Its
   * native-session marker names that checkpoint, so the next open here restores the newer state
   * and saves it to Cloud. Without a checkpoint, nothing would tie the state on disk to the Cloud
   * copy, so the browser stays open.
   */
  private prepareStopWithoutCapture(open: PendingOpenSession, queue: PendingSyncQueue): boolean {
    try {
      const current = queue.getOpen(open.profileId, open.accountId);
      const launch = this.options.store.getLaunch(open.profileId);
      if (
        !current || current.registrationId !== open.registrationId || current.cleanupMode ||
        !launch || !this.isExactRunningLaunch(current, launch) ||
        !this.pendingCapturesForOpen(current, queue).some((capture) => !capture.readyToSubmit && capture.status !== "conflict") ||
        !queue.setOpenCleanup(open.profileId, open.accountId, open.registrationId, "sync")
      ) return false;
    } catch {
      return false;
    }
    this.closedUnsaved.set(open.profileId, Date.now());
    return true;
  }

  private teardownUnconfirmed(): CloudBrowserCloseResult {
    this.diagnosticEvents.record("browser_teardown_unconfirmed");
    return { closed: false, reason: "teardown_unconfirmed" };
  }

  private closeResultForOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
  ): CloudBrowserClosedResult {
    const captures = this.pendingCapturesForOpen(open, queue);
    const current = queue.getOpen(open.profileId, open.accountId);
    return this.closedSyncResult(
      captures,
      current?.registrationId === open.registrationId,
    );
  }

  private closedProfileResult(
    profileId: string,
    accountId: string,
    queue: PendingSyncQueue,
  ): CloudBrowserClosedResult {
    const captures = queue.list(accountId)
      .filter((item) => item.profileId === profileId)
      .map((item) => queue.get(item.id, accountId))
      .filter((item): item is PendingClose => !!item);
    return this.closedSyncResult(captures, false);
  }

  private closedSyncResult(
    captures: PendingClose[],
    registrationRetained: boolean,
  ): CloudBrowserClosedResult {
    if (!registrationRetained && captures.length === 0) {
      return { closed: true, sync: "complete" };
    }
    this.startPendingRetry();
    if (captures.some(isTerminalConflict)) {
      this.diagnosticEvents.record("session_sync_conflict");
      return { closed: true, sync: "conflict" };
    }
    this.diagnosticEvents.record("session_sync_pending");
    return { closed: true, sync: "pending" };
  }

  private pendingCapturesForOpen(open: PendingOpenSession, queue: PendingSyncQueue): PendingClose[] {
    return queue.list(open.accountId)
      .filter((item) => item.profileId === open.profileId)
      .map((item) => queue.get(item.id, open.accountId))
      .filter((item): item is PendingClose => !!item && item.registrationId === open.registrationId);
  }

  private checkpointState(open: PendingOpenSession, queue: PendingSyncQueue): CloudCheckpointState {
    const current = this.checkpointSignatures.get(open.profileId);
    if (current?.registrationId === open.registrationId) return current;
    const checkpoint = this.pendingCapturesForOpen(open, queue)
      .find((capture) => !capture.readyToSubmit && capture.status !== "conflict");
    const bundle = checkpoint ? JSON.stringify(checkpoint.payload.session) : null;
    const captureSeed: SessionCaptureSeed = bundle ? sessionCaptureSeed(bundle) : { origins: [] };
    const state: CloudCheckpointState = {
      registrationId: open.registrationId,
      signature: bundle ? sessionBundleSignature(bundle) : "",
      tabs: bundleTabUrls(bundle ?? ""),
      origins: new Set(captureSeed.origins),
      ...(captureSeed.telegramClient ? { telegramClient: captureSeed.telegramClient } : {}),
    };
    this.checkpointSignatures.set(open.profileId, state);
    return state;
  }

  private async abandonStoppedOpen(open: PendingOpenSession, queue: PendingSyncQueue): Promise<boolean> {
    try {
      await this.options.cloud.abandon(open.registrationId);
      queue.removeOpenRegistration(open.profileId, open.accountId, open.registrationId);
      this.clearCheckpointSignature(open);
      return true;
    } catch (error) {
      if (error instanceof CloudApiError && error.code === "profile_not_found") {
        queue.removeOpenRegistration(open.profileId, open.accountId, open.registrationId);
        this.clearCheckpointSignature(open);
        return true;
      }
      return false;
    }
  }

  private async retryCleanup(open: PendingOpenSession, queue: PendingSyncQueue): Promise<boolean> {
    const current = queue.getOpen(open.profileId, open.accountId);
    if (!current || current.registrationId !== open.registrationId) return true;
    const launch = this.options.store.getLaunch(open.profileId);
    if (launch) {
      const exact = current.debugPort !== null && current.startedAt !== null &&
        launch.debugPort === current.debugPort && launch.startedAt === current.startedAt;
      if (
        !exact ||
        !await this.options.launcher.stop(open.profileId, {
          debugPort: launch.debugPort,
          startedAt: launch.startedAt,
        }).catch(() => false)
      ) {
        this.diagnosticEvents.record("cleanup_retained");
        return false;
      }
    }
    await this.stopHeartbeatAndWait(open.profileId);

    if (current.cleanupMode === "discard") {
      queue.removeUnreadyCaptures(current.profileId, current.accountId, current.registrationId);
      const removed = queue.removeOpenRegistration(
        current.profileId,
        current.accountId,
        current.registrationId,
      );
      if (removed) this.clearCheckpointSignature(current);
      return removed;
    }
    if (current.cleanupMode === "abandon" || current.phase !== "running") {
      return this.abandonStoppedOpen(current, queue);
    }
    return this.finishStoppedOpen(current, queue);
  }

  private finalizeOpenCheckpoint(open: PendingOpenSession, queue: PendingSyncQueue): boolean {
    const tabs = this.options.launcher.closedFirefoxTabs?.(open.profileId, open);
    const checkpoint = tabs === undefined ? undefined : this.pendingCapturesForOpen(open, queue)
      .find((capture) => !capture.readyToSubmit && capture.status !== "conflict");
    if (checkpoint) {
      const session = { ...checkpoint.payload.session, tabs };
      queue.enqueue({
        accountId: open.accountId,
        profileId: open.profileId,
        registrationId: open.registrationId,
        expectedVersion: checkpoint.expectedVersion,
        payload: { ...checkpoint.payload, session },
        readyToSubmit: false,
      });
      this.recordCloudSessionSignature(open.profileId, sessionBundleSignature(JSON.stringify(session)));
    }
    return queue.finalizeOpenCheckpoint(open.profileId, open.accountId, open.registrationId);
  }

  private async finishStoppedOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    current: () => boolean = () => true,
  ): Promise<boolean> {
    const captures = this.pendingCapturesForOpen(open, queue);
    if (captures.length > 0) {
      if (!this.finalizeOpenCheckpoint(open, queue)) return false;
      this.clearCheckpointSignature(open);
      if (current() && this.options.accountId() === open.accountId) {
        await this.submitPending(queue, open.accountId, current);
      }
      const retainedCaptures = this.pendingCapturesForOpen(open, queue);
      if (retainedCaptures.length > 0) {
        this.diagnosticEvents.record(
          retainedCaptures.some(isTerminalConflict)
            ? "session_sync_conflict"
            : "session_sync_pending",
        );
        if (current()) this.startPendingRetry();
      }
      return retainedCaptures.length === 0;
    }

    if (!current()) return false;
    return this.abandonStoppedOpen(open, queue);
  }

  private clearCheckpointSignature(open: PendingOpenSession): void {
    if (this.checkpointSignatures.get(open.profileId)?.registrationId === open.registrationId) {
      this.checkpointSignatures.delete(open.profileId);
    }
    if (this.uploads.get(open.profileId)?.registrationId === open.registrationId) {
      this.uploads.delete(open.profileId);
    }
  }

  /**
   * `openTabsOnly` reads only origins with an open tab, so no temporary page opens, and keeps the
   * saved storage of every other origin from the current checkpoint. An origin that the worker
   * cannot read keeps its storage from the checkpoint too. `retry` reads once more after a
   * failure that did not use up the worker's time limit.
   */
  private async captureSession(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    endpoint: string,
    openTabsOnly = false,
    retry = false,
  ): Promise<string> {
    const state = this.checkpointState(open, queue);
    const checkpoint = this.pendingCapturesForOpen(open, queue)
      .find((capture) => !capture.readyToSubmit && capture.status !== "conflict")?.payload.session;
    if (openTabsOnly && !checkpoint) throw new Error("Cloud checkpoint is missing before an open-tab capture");
    const saved = checkpoint ? sessionCaptureSeed(JSON.stringify(checkpoint)).saved : undefined;
    const captureSeed: SessionCaptureSeed = {
      origins: openTabsOnly ? [] : [...state.origins].sort(),
      ...(state.telegramClient ? { telegramClient: state.telegramClient } : {}),
      ...(openTabsOnly ? { openTabsOnly } : {}),
      ...(saved ? { saved } : {}),
    };
    const monitor = this.dirtyMonitors.get(open.profileId);
    const suspended = monitor?.registrationId === open.registrationId ? monitor : undefined;
    if (suspended) this.stopStorageWatchers(suspended);
    try {
      const read = async () => {
        const startedAt = performance.now();
        try {
          return await this.options.readSession(endpoint, captureSeed);
        } catch (error) {
          this.diagnosticEvents.record("checkpoint_capture_failed");
          this.log(`${open.profileId}: Cloud session capture failed (${errorCode(error)}, ${safeErrorType(error)}, stage=${captureFailureStage(error)}, elapsedMs=${Math.round(performance.now() - startedAt)})`);
          throw error;
        }
      };
      let bundle: string;
      try {
        bundle = await read();
      } catch (error) {
        if (!retry || errorCode(error) === "timeout") throw error;
        bundle = await read();
      }
      try {
        if (openTabsOnly) bundle = keepUncapturedOrigins(bundle, saved);
        const captured = parseCapturedSessionBundle(bundle);
        if (captured.tabs === undefined) bundle = JSON.stringify({
          ...captured,
          tabs: this.options.launcher.closedFirefoxTabs?.(open.profileId, open) ?? state.tabs,
        });
        for (const origin of captured.origins) state.origins.add(origin.origin);
        if (captured.telegramClient) state.telegramClient = captured.telegramClient;
      } catch (error) {
        this.diagnosticEvents.record("checkpoint_invalid");
        throw error;
      }
      return bundle;
    } finally {
      if (suspended && this.dirtyMonitors.get(open.profileId) === suspended) {
        const current = queue.getOpen(open.profileId, open.accountId);
        const launch = this.options.store.getLaunch(open.profileId);
        if (
          current?.registrationId === open.registrationId &&
          current.phase === "running" &&
          !current.cleanupMode &&
          launch?.debugPort === suspended.debugPort &&
          launch.startedAt === suspended.startedAt
        ) {
          this.startStorageWatchers(open.profileId, suspended);
        }
      }
    }
  }

  private recordCloudSessionSignature(profileId: string, signature: string): void {
    try {
      this.options.launcher.recordCloudSession(profileId, signature);
    } catch {
      // The durable Cloud checkpoint still owns recovery if this optional stamp fails.
      this.log(`${profileId}: native session marker unavailable; keeping Cloud lifecycle active`);
    }
  }

  private checkpointOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    sessionBundle: string,
  ): "saved" | "unchanged" | false {
    const current = queue.getOpen(open.profileId, open.accountId);
    const profile = this.options.store.getProfile(open.profileId);
    if (
      !current ||
      !profile ||
      current.registrationId !== open.registrationId ||
      current.phase !== "running" ||
      current.cleanupMode
    ) return false;
    const signature = sessionBundleSignature(sessionBundle);
    const prior = this.checkpointSignatures.get(open.profileId);
    if (prior?.registrationId === open.registrationId && prior.signature === signature) {
      this.recordCloudSessionSignature(open.profileId, signature);
      // Cloud already holds this exact session.
      if (!this.uploadState(open).dirty) this.closedUnsaved.delete(open.profileId);
      this.diagnosticEvents.record("checkpoint_unchanged");
      return "unchanged";
    }
    queue.enqueue({
      accountId: open.accountId,
      profileId: open.profileId,
      registrationId: open.registrationId,
      expectedVersion: open.expectedVersion,
      payload: encodePortableProfile(profile, sessionBundle),
      readyToSubmit: false,
    });
    const state = this.checkpointState(open, queue);
    state.signature = signature;
    state.tabs = bundleTabUrls(sessionBundle);
    this.checkpointSignatures.set(open.profileId, state);
    this.recordCloudSessionSignature(open.profileId, signature);
    const upload = this.uploadState(open);
    upload.dirty = true;
    if (sessionLoginSignature(sessionBundle) !== upload.loginSignature) upload.soon = true;
    this.diagnosticEvents.record("checkpoint_saved");
    return "saved";
  }

  private uploadState(open: PendingOpenSession): CloudUploadState {
    const existing = this.uploads.get(open.profileId);
    if (existing?.registrationId === open.registrationId) return existing;
    // A registration this run did not open (app restart, lease renewal) may hold changes Cloud lacks.
    const state: CloudUploadState = {
      registrationId: open.registrationId, dirty: true, soon: false, loginSignature: "",
      lastAttemptAt: 0, failures: 0, unsupported: false,
    };
    this.uploads.set(open.profileId, state);
    return state;
  }

  /**
   * Save the open's local checkpoint to Cloud while the browser stays open, so another device
   * opens a recent copy even after a crash, sleep or network loss here. A login change is saved
   * soon (the storage watcher captures it within seconds); other changes every few minutes, as
   * each save is a new Cloud version. Runs inside the profile transition, so it never overlaps a
   * close. Without the service endpoint, Cloud gets the session at close, as before.
   */
  private async uploadCheckpoint(open: PendingOpenSession, queue: PendingSyncQueue): Promise<void> {
    const cloud = this.options.cloud;
    const state = this.uploadState(open);
    if (!cloud.checkpointOpen || state.unsupported || !state.dirty) return;
    const now = Date.now();
    if (now - state.lastAttemptAt < (state.soon ? this.cloudCheckpointSoonMs : this.cloudCheckpointIntervalMs)) return;
    state.lastAttemptAt = now;
    try {
      // A `behind` reply means an earlier upload was saved but its reply was lost: adopt that
      // version, then save this checkpoint on top of it.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = queue.getOpen(open.profileId, open.accountId);
        if (!current || current.registrationId !== open.registrationId || current.cleanupMode) return;
        const capture = this.pendingCapturesForOpen(current, queue)
          .find((item) => !item.readyToSubmit && item.status !== "conflict");
        if (!capture) return;
        const saved = await cloud.checkpointOpen(open.registrationId, {
          expectedVersion: capture.expectedVersion,
          payload: capture.payload,
        });
        const behind = saved.status === "behind";
        if (!queue.advanceOpenVersion(
          open.profileId, open.accountId, open.registrationId, capture.expectedVersion, saved.version,
          behind ? undefined : capture.id,
        )) return;
        if (behind) continue;
        state.dirty = false;
        state.soon = false;
        state.loginSignature = sessionLoginSignature(JSON.stringify(capture.payload.session));
        state.failures = 0;
        delete state.failingSince;
        this.closedUnsaved.delete(open.profileId);
        this.diagnosticEvents.record("checkpoint_uploaded");
        return;
      }
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 404) {
        state.unsupported = true;
        this.log(`${open.profileId}: Cloud has no live checkpoints; the session is saved at close`);
        return;
      }
      state.failures++;
      state.failingSince ??= now;
      this.diagnosticEvents.record("checkpoint_upload_failed");
      this.log(`${open.profileId}: Cloud checkpoint upload failed (${errorCode(error)})`);
    }
  }

  private async refreshCheckpoint(open: PendingOpenSession, queue: PendingSyncQueue, openTabsOnly = false): Promise<void> {
    const launch = this.options.store.getLaunch(open.profileId);
    if (!launch || !this.isExactRunningLaunch(open, launch)) return;
    try {
      await this.options.launcher.verifyRunningIdentity(open.profileId);
      const verified = this.options.store.getLaunch(open.profileId);
      const current = queue.getOpen(open.profileId, open.accountId);
      if (
        !verified ||
        !current ||
        current.registrationId !== open.registrationId ||
        current.cleanupMode ||
        !this.isExactRunningLaunch(current, verified)
      ) return;
      const sessionBundle = await this.captureSession(current, queue, verified.ws, openTabsOnly);
      await this.options.launcher.verifyRunningIdentity(open.profileId);
      const captured = this.options.store.getLaunch(open.profileId);
      const latest = queue.getOpen(open.profileId, open.accountId);
      if (
        !captured ||
        !latest ||
        latest.registrationId !== open.registrationId ||
        latest.cleanupMode ||
        !this.isExactRunningLaunch(latest, captured)
      ) return;
      this.checkpointOpen(latest, queue, sessionBundle);
      await this.uploadCheckpoint(latest, queue);
    } catch {
      // Keep the last durable checkpoint when a background capture is inconclusive.
    }
  }

  private async cleanupRestoringOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
  ): Promise<boolean> {
    this.stopHeartbeat(open.profileId);
    if (!queue.setOpenCleanup(
      open.profileId,
      open.accountId,
      open.registrationId,
      "abandon",
    )) {
      this.diagnosticEvents.record("cleanup_retained");
      this.startHeartbeat(open.profileId);
      return false;
    }
    const retained = queue.getOpen(open.profileId, open.accountId);
    const finished = !!retained && await this.retryCleanup(retained, queue);
    if (!finished) this.startHeartbeat(open.profileId);
    return finished;
  }

  async heartbeatOnce(profileId: string): Promise<void> {
    const lease = await this.renewLeaseOnce(profileId);
    if (!lease) return;
    if (lease.outcome === "terminal") {
      this.stopHeartbeatForRegistration(profileId, lease.accountId, lease.registrationId);
      await this.handleTerminalHeartbeat(profileId, lease);
      return;
    }
    await this.maintainOpenOnce(profileId, lease);
  }

  private async renewLeaseOnce(profileId: string): Promise<CloudLeaseResult | null> {
    let context: { queue: PendingSyncQueue; accountId: string };
    try {
      context = this.requireContext(false);
    } catch {
      return null;
    }
    const open = context.queue.getOpen(profileId, context.accountId);
    if (!open) return null;
    const existing = this.heartbeatInFlight.get(profileId);
    if (existing?.registrationId === open.registrationId) return existing.promise;

    let entry!: CloudLeaseInFlight;
    const promise = (async (): Promise<CloudLeaseResult> => {
      try {
        await this.options.cloud.heartbeat(open.registrationId);
        return {
          accountId: context.accountId,
          registrationId: open.registrationId,
          outcome: "ok",
        };
      } catch (error) {
        const code = errorCode(error);
        if (
          error instanceof CloudApiError &&
          (error.code === "folder_access_denied" || TERMINAL_HEARTBEAT_ERRORS.has(error.code))
        ) {
          // The open transition owns cleanup until startup settles. Remember
          // terminal access loss now so it cannot promote this launch to running.
          const startupLease = this.startupLeases.get(profileId);
          if (startupLease?.registrationId === open.registrationId) startupLease.error = error;
          this.diagnosticEvents.record(
            error.code === "version_conflict"
              ? "heartbeat_terminal_conflict"
              : "heartbeat_terminal_access_ended",
          );
          return {
            accountId: context.accountId,
            registrationId: open.registrationId,
            outcome: "terminal",
            errorCode: error.code,
            ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
          };
        }
        this.diagnosticEvents.record("heartbeat_failed");
        this.log(`${profileId}: Cloud heartbeat failed (${code})`);
        return {
          accountId: context.accountId,
          registrationId: open.registrationId,
          outcome: "transient",
          errorCode: code,
        };
      }
    })().finally(() => {
      if (this.heartbeatInFlight.get(profileId) === entry) {
        this.heartbeatInFlight.delete(profileId);
      }
    });
    entry = { registrationId: open.registrationId, promise };
    this.heartbeatInFlight.set(profileId, entry);
    return promise;
  }

  private maintainOpenOnce(profileId: string, lease: CloudLeaseResult): Promise<void> {
    const existing = this.maintenanceInFlight.get(profileId);
    if (existing?.registrationId === lease.registrationId) return existing.promise;
    let entry!: CloudMaintenanceInFlight;
    const promise = this.withProfileTransition(
      profileId,
      () => this.doHeartbeatMaintenance(profileId, lease.accountId, lease.registrationId),
    ).finally(() => {
      if (this.maintenanceInFlight.get(profileId) === entry) {
        this.maintenanceInFlight.delete(profileId);
      }
    });
    entry = { registrationId: lease.registrationId, promise };
    this.maintenanceInFlight.set(profileId, entry);
    return promise;
  }

  private async doHeartbeatMaintenance(
    profileId: string,
    accountId: string,
    registrationId: string,
  ): Promise<void> {
    let context: { queue: PendingSyncQueue; accountId: string };
    try {
      context = this.requireContext(false);
    } catch {
      return;
    }
    if (context.accountId !== accountId) return;
    const open = context.queue.getOpen(profileId, accountId);
    if (!open || open.registrationId !== registrationId ||
      (open.phase !== "running" && open.phase !== "restoring")) return;
    if (open.cleanupMode) {
      if (await this.retryCleanup(open, context.queue)) {
        this.stopHeartbeatForRegistration(profileId, accountId, registrationId);
      }
      return;
    }
    if (open.phase === "restoring") {
      const launch = this.options.store.getLaunch(profileId);
      if (!launch || this.isExactRestoringLaunch(open, launch)) {
        let dead = !launch;
        if (launch) {
          try {
            dead = await this.options.launcher.reconcileOrphan(profileId, {
              debugPort: launch.debugPort,
              startedAt: launch.startedAt,
            }) === "dead";
          } catch {
            // An uncertain local probe must not release or stop the retained browser.
          }
        }
        const current = context.queue.getOpen(profileId, accountId);
        if (!current || current.registrationId !== registrationId) return;
        if (dead && !this.options.store.getLaunch(profileId)) {
          this.diagnosticEvents.record("browser_death_confirmed");
          this.diagnosticEvents.record("manual_stop_detected");
          await this.cleanupRestoringOpen(current, context.queue);
        }
      }
      return;
    }

    const active = await this.options.launcher.active(profileId).catch(() => true);
    if (!active) {
      const launch = this.options.store.getLaunch(profileId);
      let dead = !launch;
      if (launch && this.isExactRunningLaunch(open, launch)) {
        try {
          const reconciled = await this.options.launcher.reconcileOrphan(profileId, {
            debugPort: launch.debugPort,
            startedAt: launch.startedAt,
          });
          const current = context.queue.getOpen(profileId, accountId);
          if (!current || current.registrationId !== registrationId) return;
          dead = reconciled === "dead" && !this.options.store.getLaunch(profileId);
        } catch {
          dead = false;
        }
      } else if (launch) {
        return;
      }
      if (dead) {
        this.diagnosticEvents.record("browser_death_confirmed");
        this.stopHeartbeatForRegistration(profileId, accountId, registrationId);
        context.queue.setOpenCleanup(
          profileId,
          accountId,
          registrationId,
          open.phase === "running" ? "sync" : "abandon",
        );
        const retained = context.queue.getOpen(profileId, accountId);
        if (retained && !await this.retryCleanup(retained, context.queue)) {
          this.startHeartbeat(profileId);
        }
        return;
      }
    }
    // A full capture spawns a Playwright helper. With live storage watchers, every 60 s per
    // browser was redundant load; still upload what the watchers captured.
    const monitor = this.dirtyMonitors.get(profileId);
    if (monitor?.registrationId === registrationId && monitor.watchers.length > 0
      && ++monitor.heartbeats % HEARTBEAT_FULL_CAPTURE_EVERY !== 0) {
      await this.uploadCheckpoint(open, context.queue);
      return;
    }
    await this.refreshCheckpoint(open, context.queue);
  }

  private async handleTerminalHeartbeat(profileId: string, lease: CloudLeaseResult): Promise<void> {
    await this.withProfileTransition(profileId, async () => {
      let context: { queue: PendingSyncQueue; accountId: string };
      try {
        context = this.requireContext(false);
      } catch {
        return;
      }
      if (context.accountId !== lease.accountId) return;
      let open = context.queue.getOpen(profileId, lease.accountId);
      if (!open || open.registrationId !== lease.registrationId ||
        (open.phase !== "running" && open.phase !== "restoring")) return;
      this.diagnosticEvents.record("access_ended");

      const launch = this.options.store.getLaunch(profileId);
      let dead = !launch;
      if (launch) {
        const exact = open.phase === "running"
          ? this.isExactRunningLaunch(open, launch)
          : this.isExactRestoringLaunch(open, launch);
        if (exact) {
          try {
            const reconciled = await this.options.launcher.reconcileOrphan(profileId, {
              debugPort: launch.debugPort,
              startedAt: launch.startedAt,
            });
            const current = context.queue.getOpen(profileId, lease.accountId);
            if (!current || current.registrationId !== lease.registrationId) return;
            dead = reconciled === "dead" && !this.options.store.getLaunch(profileId);
          } catch {
            dead = false;
          }
        }
      }
      if (dead) {
        this.diagnosticEvents.record("browser_death_confirmed");
        const cleanupMode = lease.errorCode === "folder_access_denied"
          ? "discard"
          : open.phase === "running" ? "sync" : "abandon";
        if (!context.queue.setOpenCleanup(
          profileId,
          lease.accountId,
          lease.registrationId,
          cleanupMode,
        )) {
          this.diagnosticEvents.record("cleanup_retained");
          this.startPendingRetry();
          return;
        }
        const retained = context.queue.getOpen(profileId, lease.accountId);
        const finished = !!retained && await this.retryCleanup(retained, context.queue);
        if (!finished) {
          this.diagnosticEvents.record("cleanup_retained");
          this.startPendingRetry();
        }
        this.log(finished
          ? `${profileId}: Cloud access ended (${lease.errorCode}); browser death was reconciled`
          : `${profileId}: Cloud access ended (${lease.errorCode}); stopped-browser recovery was retained`);
        return;
      }

      if (lease.errorCode === "folder_access_denied") {
        context.queue.setOpenCleanup(
          profileId,
          lease.accountId,
          lease.registrationId,
          "discard",
        );
        const retained = context.queue.getOpen(profileId, lease.accountId);
        const stopped = !!retained && await this.retryCleanup(retained, context.queue);
        if (!stopped) this.startHeartbeat(profileId);
        this.log(stopped
          ? `${profileId}: Cloud access ended (${lease.errorCode}); browser stopped`
          : `${profileId}: Cloud access ended (${lease.errorCode}); browser was retained`);
        return;
      }
      if (open.phase === "restoring") {
        const finished = await this.cleanupRestoringOpen(open, context.queue);
        this.log(finished
          ? `${profileId}: Cloud access ended (${lease.errorCode}); browser stopped`
          : `${profileId}: Cloud access ended (${lease.errorCode}); browser was retained`);
        return;
      }
      // Cloud reports the newest version this registration saved itself. A higher one than this
      // device knows means a checkpoint reply was lost; renewing must compare against it.
      if (
        lease.errorCode === "version_conflict" && lease.currentVersion !== undefined &&
        lease.currentVersion > open.expectedVersion &&
        context.queue.advanceOpenVersion(profileId, lease.accountId, open.registrationId, open.expectedVersion, lease.currentVersion)
      ) {
        open = context.queue.getOpen(profileId, lease.accountId) ?? open;
      }
      const renewal = lease.errorCode === "version_conflict" ? await this.renewLapsedOpen(open, context.queue) : "failed";
      if (renewal !== "failed") {
        this.startHeartbeat(profileId);
        this.log(renewal === "renewed"
          ? `${profileId}: Cloud lease lapsed; the browser stays open under a fresh registration`
          : `${profileId}: Cloud lease lapsed and Cloud could not be reached; renewal is retried`);
        return;
      }
      const secured = await this.captureAndStopOpen(open, context.queue, true);
      if (!secured) this.startHeartbeat(profileId);
      this.log(secured
        ? `${profileId}: Cloud access ended (${lease.errorCode}); browser stopped`
        : `${profileId}: Cloud access ended (${lease.errorCode}); capture failed and browser was retained`);
    });
  }

  async secureAfterAuthentication(current: () => boolean = () => true): Promise<void> {
    this.draining = true;
    try {
      if (!current()) return;
      const { queue, accountId } = this.requireContext(false);
      await this.secureForeignAccountBrowsers(queue, accountId, current);
    } finally {
      if (!this.shuttingDown && current()) this.draining = false;
    }
  }

  async resumeAfterAuthentication(current: () => boolean = () => true): Promise<void> {
    this.draining = true;
    try {
      if (!current()) return;
      const { queue, accountId } = this.requireContext(false);
      await this.secureForeignAccountBrowsers(queue, accountId, current);
      if (!current()) return;

      for (const open of queue.listOpens(accountId)) {
        if (!current()) return;
        const launch = this.options.store.getLaunch(open.profileId);
        if (launch && this.isExactRestoringLaunch(open, launch)) {
          try {
            await this.options.launcher.verifyRunningIdentity(open.profileId);
            const verified = this.options.store.getLaunch(open.profileId);
            if (current() && verified && this.isExactRestoringLaunch(open, verified)) {
              this.startHeartbeat(open.profileId);
            }
          } catch {
            // Retain untrusted ownership when survivor verification is inconclusive.
          }
          continue;
        }
        if (launch && this.isExactRunningLaunch(open, launch)) {
          try {
            await this.options.launcher.verifyRunningIdentity(open.profileId);
            if (await this.options.launcher.active(open.profileId)) {
              if (!current()) return;
              this.startHeartbeat(open.profileId);
              continue;
            }
          } catch {
            // Capture the exact Cloud generation before any teardown attempt.
          }
          if (!current()) return;
          let dead = false;
          try {
            const reconciled = await this.options.launcher.reconcileOrphan(open.profileId, {
              debugPort: launch.debugPort,
              startedAt: launch.startedAt,
            });
            dead = reconciled === "dead" && !this.options.store.getLaunch(open.profileId);
          } catch {
            // An uncertain local probe must not release the retained browser.
          }
          if (!current() || this.options.accountId() !== accountId) return;
          const retained = queue.getOpen(open.profileId, accountId);
          if (dead && retained?.registrationId === open.registrationId) {
            await this.stopHeartbeatAndWait(open.profileId);
            if (!current() || this.options.accountId() !== accountId) return;
            const latest = queue.getOpen(open.profileId, accountId);
            if (latest?.registrationId === open.registrationId && !latest.cleanupMode && !this.options.store.getLaunch(open.profileId)) {
              this.diagnosticEvents.record("browser_death_confirmed");
              await this.finishStoppedOpen(latest, queue, current);
              continue;
            }
          }
          // Not a close the user asked for: a survivor whose capture fails stays open and is retried.
          if (!await this.captureAndStopOpen(open, queue, true, current, false)) {
            this.log("Cloud browser recovery remains pending; retained local ownership without blocking same-account login");
          }
          continue;
        }

        const exactGeneration = launch && open.debugPort !== null && open.startedAt !== null &&
          launch.debugPort === open.debugPort && launch.startedAt === open.startedAt;
        const stopped = !launch || (exactGeneration && await this.options.launcher.stop(open.profileId, {
          debugPort: launch.debugPort,
          startedAt: launch.startedAt,
        }).catch(() => false));
        if (stopped) await this.finishStoppedOpen(open, queue, current);
      }
      if (!current()) return;
      await this.submitPending(queue, accountId, current);
      if (current()) this.startPendingRetry();
    } finally {
      if (!this.shuttingDown && current()) this.draining = false;
    }
  }

  private async secureForeignAccountBrowsers(
    queue: PendingSyncQueue,
    accountId: string,
    current: () => boolean = () => true,
  ): Promise<void> {
    for (const foreign of queue.listAllOpens().filter((open) => open.accountId !== accountId)) {
      if (!current()) return;
      const heartbeat = this.stopHeartbeat(foreign.profileId);
      if (heartbeat) await heartbeat.catch(() => {});
      if (!current()) return;
      this.stopHeartbeat(foreign.profileId);
      const launch = this.options.store.getLaunch(foreign.profileId);
      if (!launch) {
        if (foreign.phase === "running") continue;
        const abandoned = await this.withProfileTransition(
          foreign.profileId,
          () => current() ? this.abandonStoppedOpen(foreign, queue) : Promise.resolve(false),
        );
        if (!abandoned) {
          throw new Error("a browser from another Cloud account could not be stopped");
        }
        continue;
      }
      if (this.isExactRunningLaunch(foreign, launch)) {
        const secured = await this.withProfileTransition(
          foreign.profileId,
          () => this.captureAndStopOpen(foreign, queue, false, current),
        );
        if (!secured) {
          throw new Error("a browser from another Cloud account could not be secured");
        }
      } else if (this.isExactRestoringLaunch(foreign, launch)) {
        const stopped = await this.withProfileTransition(
          foreign.profileId,
          async () => {
            if (!current()) return false;
            if (!await this.options.launcher.stop(foreign.profileId, {
              debugPort: launch.debugPort,
              startedAt: launch.startedAt,
            }).catch(() => false)) return false;
            if (!current()) return false;
            return this.abandonStoppedOpen(foreign, queue);
          },
        );
        if (!stopped) {
          throw new Error("a browser from another Cloud account could not be stopped");
        }
      }
    }
  }

  private isExactRestoringLaunch(
    open: PendingOpenSession,
    launch: { debugPort: number; startedAt: number },
  ): boolean {
    return open.phase === "restoring" &&
      launch.debugPort === open.debugPort &&
      launch.startedAt === open.startedAt;
  }

  private isExactRunningLaunch(
    open: PendingOpenSession,
    launch: { debugPort: number; startedAt: number },
  ): boolean {
    return open.phase === "running" &&
      launch.debugPort === open.debugPort &&
      launch.startedAt === open.startedAt;
  }

  /**
   * A heartbeat gap longer than the Cloud lease (laptop sleep, network outage)
   * expires the registration even when nobody else wants the profile. Take a
   * fresh registration for the still-running browser instead of closing it.
   * Cloud refuses the fresh open while another device holds the profile, and a
   * different base version means someone else wrote first: both keep the
   * capture-and-stop path. Right after a wake the network is often not back
   * yet, so an unreachable Cloud is retried on the next heartbeat.
   */
  private async renewLapsedOpen(open: PendingOpenSession, queue: PendingSyncQueue): Promise<"renewed" | "retry" | "failed"> {
    const deviceId = this.options.deviceId();
    const launch = this.options.store.getLaunch(open.profileId);
    if (!deviceId || open.cleanupMode || !launch || !this.isExactRunningLaunch(open, launch)) return "failed";
    let fresh: OpenProfileResponse;
    try {
      fresh = await this.options.cloud.openProfile(open.profileId, { deviceId });
    } catch (error) {
      return error instanceof CloudApiError && error.status < 500 ? "failed" : "retry";
    }
    if (
      fresh.baseVersion === open.expectedVersion &&
      queue.replaceOpenRegistration(open.profileId, open.accountId, open.registrationId, fresh.registrationId)
    ) {
      this.clearCheckpointSignature(open);
      return "renewed";
    }
    await this.options.cloud.abandon(fresh.registrationId).catch(() => {});
    return "failed";
  }

  private async captureAndStopOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    submitAfterStop: boolean,
    current: () => boolean = () => true,
    stopOnCaptureFailure = true,
  ): Promise<boolean> {
    if (!current()) return false;
    const launch = this.options.store.getLaunch(open.profileId);
    const profile = this.options.store.getProfile(open.profileId);
    if (!launch || !profile) return false;
    try {
      await this.options.launcher.verifyRunningIdentity(open.profileId);
      if (!current()) return false;
      const verifiedLaunch = this.options.store.getLaunch(open.profileId);
      if (!verifiedLaunch || !this.isExactRunningLaunch(open, verifiedLaunch)) return false;
      const sessionBundle = await this.captureSession(open, queue, verifiedLaunch.ws, false, true);
      if (!current()) return false;
      await this.options.launcher.verifyRunningIdentity(open.profileId);
      if (!current()) return false;
      const capturedLaunch = this.options.store.getLaunch(open.profileId);
      if (!capturedLaunch || !this.isExactRunningLaunch(open, capturedLaunch)) return false;
      if (!this.checkpointOpen(open, queue, sessionBundle)) return false;
      const pending = this.pendingCapturesForOpen(open, queue)
        .find((capture) => !capture.readyToSubmit && capture.status !== "conflict");
      if (!pending) return false;
      if (!queue.setOpenCleanup(open.profileId, open.accountId, open.registrationId, "sync")) {
        return false;
      }
      this.closedUnsaved.delete(open.profileId);
    } catch (error) {
      if (!stopOnCaptureFailure || !current() || !this.prepareStopWithoutCapture(open, queue)) return false;
      this.log(`${open.profileId}: Cloud session capture failed (${errorCode(error)}); stopping the browser with the last saved copy`);
    }
    if (!current()) return false;
    const stopLaunch = this.options.store.getLaunch(open.profileId);
    if (!stopLaunch || !this.isExactRunningLaunch(open, stopLaunch)) return false;
    if (!await this.options.launcher.stop(open.profileId, {
      debugPort: stopLaunch.debugPort,
      startedAt: stopLaunch.startedAt,
    }).catch(() => false)) return false;
    await this.stopHeartbeatAndWait(open.profileId);
    if (!this.finalizeOpenCheckpoint(open, queue)) return false;
    this.clearCheckpointSignature(open);
    if (
      submitAfterStop && current() &&
      this.options.accountId() === open.accountId
    ) {
      await this.submitPending(queue, open.accountId, current);
      if (current()) this.closeResultForOpen(open, queue);
    }
    return true;
  }

  private submitPending(
    queue: PendingSyncQueue,
    accountId: string,
    current?: () => boolean,
  ): ReturnType<typeof retryPendingSync> {
    return retryPendingSync(queue, this.options.cloud, accountId, current, this.options.deviceId(), this.heartbeatMs / 2);
  }

  async retryPending(): Promise<void> {
    if (this.pendingRetryInFlight) return this.pendingRetryInFlight;
    const pending = (async () => {
      const { queue, accountId } = this.requireContext(false);
      await this.reconcileClosedBrowsers(queue, accountId);
      await this.submitPending(queue, accountId);
    })().finally(() => {
      if (this.pendingRetryInFlight === pending) this.pendingRetryInFlight = null;
    });
    this.pendingRetryInFlight = pending;
    return pending;
  }

  async releaseAll(permanent = false): Promise<boolean> {
    if (permanent) this.shuttingDown = true;
    this.draining = true;
    let released = false;
    try {
      await this.stopPendingRetry();
      await Promise.allSettled([...this.opening.values()]);
      const queue = this.options.queue();
      const accountId = this.options.accountId();
      if (!queue) {
        released = true;
        return true;
      }
      if (!accountId) {
        released = queue.listAllOpens().length === 0;
        return released;
      }

      let teardownConfirmed = true;
      await this.submitPending(queue, accountId);
      while (true) {
        const opens = queue.listOpens(accountId);
        if (opens.length === 0) break;
        let closedThisPass = 0;
        // Each close captures and uploads a whole browser session, so closing
        // them one at a time makes a shutdown budget scale with the profile
        // count. Bounded like the dashboard's own bulk close.
        const remaining = [...opens];
        const closeNext = async (): Promise<void> => {
          for (let open = remaining.shift(); open; open = remaining.shift()) {
            try {
              const result = await this.close(open.profileId);
              const current = queue.getOpen(open.profileId, accountId);
              if (!current || current.registrationId !== open.registrationId) closedThisPass++;
              if (!result.closed) teardownConfirmed = false;
            } catch {
              teardownConfirmed = false;
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(RELEASE_CLOSE_LIMIT, remaining.length) }, closeNext),
        );
        if (closedThisPass === 0) break;
      }
      if (this.options.accountId() === accountId) {
        await this.submitPending(queue, accountId);
      }
      released = this.options.accountId() === accountId &&
        teardownConfirmed &&
        queue.listOpens(accountId).length === 0 &&
        queue.list(accountId).every((close) => close.readyToSubmit);
      return released;
    } finally {
      if (permanent || this.shuttingDown || released) {
        await this.stopPendingRetry();
      } else {
        this.draining = false;
        this.startPendingRetry();
      }
      // Permanent shutdown and successful sign-out keep lifecycle admission closed.
      // Authentication recovery reopens it in resumeAfterAuthentication().
    }
  }

  private startPendingRetry(): void {
    if (this.heartbeatMs === 0 || this.pendingRetryTimer !== undefined) return;
    const set = this.options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.pendingRetryTimer = set(() => {
      void this.retryPending().catch(() => {});
    }, this.heartbeatMs);
    const timer = this.pendingRetryTimer;
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  private async stopPendingRetry(): Promise<void> {
    if (this.pendingRetryTimer !== undefined) {
      const clear = this.options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(this.pendingRetryTimer);
      this.pendingRetryTimer = undefined;
    }
    await this.pendingRetryInFlight?.catch(() => {});
  }

  private startDirtyMonitor(profileId: string): void {
    if (!this.storageCheckpoints || this.dirtyMonitors.has(profileId)) return;
    let context: { queue: PendingSyncQueue; accountId: string };
    try {
      context = this.requireContext(false);
    } catch {
      return;
    }
    const open = context.queue.getOpen(profileId, context.accountId);
    const launch = this.options.store.getLaunch(profileId);
    if (!open || open.phase !== "running" || open.cleanupMode || !launch
      || !this.isExactRunningLaunch(open, launch)) return;

    const monitor: CloudDirtyMonitor = {
      registrationId: open.registrationId,
      debugPort: launch.debugPort,
      startedAt: launch.startedAt,
      watchers: [],
      watcherGeneration: 0,
      dirty: false,
      captureInFlight: false,
      lastCaptureAt: 0,
      heartbeats: 0,
    };
    this.dirtyMonitors.set(profileId, monitor);
    this.startStorageWatchers(profileId, monitor);
    if (monitor.watchers.length === 0) this.diagnosticEvents.record("dirty_monitor_unavailable");
  }

  private startStorageWatchers(profileId: string, monitor: CloudDirtyMonitor): void {
    const watchPath = this.options.watchPath ?? watchBrowserStorage;
    const generation = ++monitor.watcherGeneration;
    for (const path of this.options.launcher.browserStorageWatchPaths(profileId)) {
      try {
        monitor.watchers.push(watchPath(path, () => {
          if (monitor.watcherGeneration !== generation) return;
          this.markCheckpointDirty(profileId, monitor);
        }));
      } catch {
        // The heartbeat checkpoint remains when a browser storage directory is unavailable.
      }
    }
  }

  private stopStorageWatchers(monitor: CloudDirtyMonitor): void {
    monitor.watcherGeneration++;
    for (const watcher of monitor.watchers.splice(0)) {
      try { watcher.close(); } catch {}
    }
  }

  /**
   * A live metadata edit rewrote the cached profile while its browser is open.
   * The checkpoint signature hashes only the SESSION bundle, so an unchanged
   * session would skip the next capture as "unchanged" and the edit would only
   * sync by luck. Drop the signature — payloads are re-encoded from the store
   * at capture time, so the next checkpoint or close carries the edit — and
   * nudge the dirty monitor so that capture can happen before the next
   * heartbeat.
   */
  noteProfileEdited(profileId: string): void {
    // Blank only the signature: the entry's capture seed must survive, and a
    // DELETED entry would be rebuilt by checkpointState from the queue's last
    // payload — carrying the very signature this is trying to invalidate.
    const state = this.checkpointSignatures.get(profileId);
    if (state) state.signature = "";
    const monitor = this.dirtyMonitors.get(profileId);
    if (monitor) this.markCheckpointDirty(profileId, monitor);
  }

  private markCheckpointDirty(profileId: string, monitor: CloudDirtyMonitor): void {
    if (this.dirtyMonitors.get(profileId) !== monitor) return;
    monitor.dirty = true;
    if (monitor.captureInFlight || monitor.debounceTimer) return;
    const elapsed = Date.now() - monitor.lastCaptureAt;
    const delay = Math.max(this.checkpointDebounceMs, this.checkpointMinIntervalMs - elapsed, 0);
    monitor.debounceTimer = setTimeout(() => {
      monitor.debounceTimer = undefined;
      this.flushDirtyCheckpoint(profileId, monitor);
    }, delay);
    monitor.debounceTimer.unref?.();
  }

  private flushDirtyCheckpoint(profileId: string, monitor: CloudDirtyMonitor): void {
    if (this.dirtyMonitors.get(profileId) !== monitor || monitor.captureInFlight || !monitor.dirty) return;
    monitor.dirty = false;
    monitor.captureInFlight = true;
    void this.withProfileTransition(profileId, async () => {
      if (this.dirtyMonitors.get(profileId) !== monitor) return;
      const { queue, accountId } = this.requireContext(false);
      const open = queue.getOpen(profileId, accountId);
      const launch = this.options.store.getLaunch(profileId);
      if (!open || open.registrationId !== monitor.registrationId || open.cleanupMode || !launch
        || launch.debugPort !== monitor.debugPort || launch.startedAt !== monitor.startedAt) return;
      await this.refreshCheckpoint(open, queue, true);
    }).catch(() => {}).finally(() => {
      if (this.dirtyMonitors.get(profileId) !== monitor) return;
      monitor.lastCaptureAt = Date.now();
      monitor.captureInFlight = false;
      if (monitor.dirty) this.markCheckpointDirty(profileId, monitor);
    });
  }

  private stopDirtyMonitor(profileId: string): void {
    const monitor = this.dirtyMonitors.get(profileId);
    if (!monitor) return;
    this.dirtyMonitors.delete(profileId);
    if (monitor.debounceTimer) clearTimeout(monitor.debounceTimer);
    this.stopStorageWatchers(monitor);
  }

  private confirmNoPageTargets(
    profileId: string,
    registrationId: string,
    hasPageTargets: boolean,
  ): boolean {
    if (hasPageTargets) {
      this.missingPageObservations.delete(profileId);
      return false;
    }
    const previous = this.missingPageObservations.get(profileId);
    const count = previous?.registrationId === registrationId ? previous.count + 1 : 1;
    this.missingPageObservations.set(profileId, { registrationId, count });
    if (count === 1) this.diagnosticEvents.record("no_page_observed");
    return count >= WINDOW_CLOSED_CHECKS;
  }

  /**
   * A browser that outlives its last window (macOS keeps it running; on Windows AliasMode Chromium
   * and on Windows and Linux AliasMode Firefox are told to) is invisible to the user.
   * Save it and stop it as the app's Close does. A script that closes every page and opens a
   * new one at once keeps its browser: the page comes back before the checks in a row end.
   */
  async checkWindowsOnce(profileId: string): Promise<void> {
    if (this.draining || this.shuttingDown || this.closing.has(profileId) || this.windowChecks.has(profileId)) return;
    this.windowChecks.add(profileId);
    try {
      let context: { queue: PendingSyncQueue; accountId: string };
      try {
        context = this.requireContext(false);
      } catch {
        return;
      }
      const open = context.queue.getOpen(profileId, context.accountId);
      const launch = this.options.store.getLaunch(profileId);
      if (!open || open.cleanupMode || !launch || !this.isExactRunningLaunch(open, launch)) return;
      const hasPageTargets = await this.options.launcher.hasPageTargets(profileId).catch(() => true);
      if (this.closing.has(profileId) || !this.confirmNoPageTargets(profileId, open.registrationId, hasPageTargets)) return;
      this.diagnosticEvents.record("no_page_close_requested");
      this.log(`${profileId}: last browser window closed; saving the profile to Cloud`);
      const closed = await this.closeOnce(profileId, false).then((result) => result.closed, () => false);
      if (!closed) await this.stopWithoutCapture(profileId, open.registrationId);
    } finally {
      this.windowChecks.delete(profileId);
    }
  }

  /** The capture failed: stop the windowless browser now and finish with the last saved checkpoint. */
  private async stopWithoutCapture(profileId: string, registrationId: string): Promise<void> {
    await this.withProfileTransition(profileId, async () => {
      const { queue, accountId } = this.requireContext(false);
      const open = queue.getOpen(profileId, accountId);
      const launch = this.options.store.getLaunch(profileId);
      if (
        !open || open.registrationId !== registrationId || open.cleanupMode ||
        !launch || !this.isExactRunningLaunch(open, launch) ||
        // A page came back during the capture: leave that browser open, as the app's Close does.
        await this.options.launcher.hasPageTargets(profileId).catch(() => true) ||
        !this.prepareStopWithoutCapture(open, queue)
      ) return;
      const retained = queue.getOpen(profileId, accountId);
      const stopped = !!retained && await this.retryCleanup(retained, queue);
      if (!stopped) this.startHeartbeat(profileId);
      this.log(stopped
        ? `${profileId}: Cloud capture failed; stopped the browser and kept the last saved copy`
        : `${profileId}: Cloud capture failed and the browser stop is not confirmed; retrying`);
    }).catch(() => {});
  }

  private startHeartbeat(profileId: string): void {
    this.startDirtyMonitor(profileId);
    if (this.heartbeatMs === 0 || this.timers.has(profileId)) return;
    const set = this.options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const timers = [
      set(() => { void this.heartbeatOnce(profileId); }, this.heartbeatMs),
      set(() => { void this.checkWindowsOnce(profileId); }, WINDOW_CHECK_MS),
    ];
    for (const timer of timers) {
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
    }
    this.timers.set(profileId, timers);
  }

  private stopHeartbeatForRegistration(
    profileId: string,
    accountId: string,
    registrationId: string,
  ): Promise<CloudLeaseResult> | null {
    if (this.options.accountId() !== accountId) return null;
    const open = this.options.queue()?.getOpen(profileId, accountId);
    if (!open || open.registrationId !== registrationId) return null;
    return this.stopHeartbeat(profileId);
  }

  private stopHeartbeat(profileId: string): Promise<CloudLeaseResult> | null {
    this.stopDirtyMonitor(profileId);
    this.missingPageObservations.delete(profileId);
    const timers = this.timers.get(profileId);
    if (timers !== undefined) {
      const clear = this.options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      for (const timer of timers) clear(timer);
      this.timers.delete(profileId);
    }
    return this.heartbeatInFlight.get(profileId)?.promise ?? null;
  }

  private async stopHeartbeatAndWait(profileId: string): Promise<void> {
    await this.stopHeartbeat(profileId)?.catch(() => {});
  }

  private requireContext(requireDevice: true): {
    queue: PendingSyncQueue;
    accountId: string;
    deviceId: string;
  };
  private requireContext(requireDevice: false): {
    queue: PendingSyncQueue;
    accountId: string;
    deviceId?: string;
  };
  private requireContext(requireDevice: boolean) {
    const queue = this.options.queue();
    const accountId = this.options.accountId();
    const deviceId = this.options.deviceId();
    if (!queue || !accountId || (requireDevice && !deviceId)) {
      throw new Error("AliasMode Cloud authentication and encrypted pending sync are required");
    }
    return { queue, accountId, ...(deviceId ? { deviceId } : {}) };
  }

  private async withProfileTransition<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.transitions.set(profileId, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      await tail.catch(() => {});
      if (this.transitions.get(profileId) === tail) this.transitions.delete(profileId);
    }
  }
}

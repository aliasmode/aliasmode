import { watch } from "node:fs";
import { CloudApiError, type CloudClient } from "./cloud-client.ts";
import type { CloudProfileSummary, ImportProfilesResponse } from "./contracts/cloud-v1.ts";
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
  type PendingClose,
  type PendingOpenSession,
  type PendingSyncQueue,
  retryPendingSync,
} from "./pending-sync.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { proxyHostPort } from "./proxy.ts";
import {
  bundleHasRestorableLogin,
  bundleTabUrls,
  bundleTelegramClient,
  canonicalUserPageUrl,
  parseCapturedSessionBundle,
  sessionBundleSignature,
  sessionCaptureSeed,
  type SessionCaptureSeed,
  SessionRestoreError,
} from "./session.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

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
}

export type CloudBrowserCloseResult =
  | CloudBrowserClosedResult
  | { closed: false; reason: "teardown_unconfirmed" };

export interface CloudBrowserProfile {
  id: string;
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
  importProfiles(destination: string, profiles: Profile[]): Promise<ImportProfilesResponse>;
  open(profileId: string, launchArgs?: string[], options?: BrowserOpenOptions): Promise<CloudBrowserOpenResult>;
  close(profileId: string): Promise<CloudBrowserCloseResult>;
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
>;

type CloudBrowserLauncher = Pick<
  Launcher,
  "start" | "stop" | "active" | "hasPageTargets" | "verifyRunningIdentity" | "reconcileOrphan" |
  "pageTargetFingerprint" | "browserStorageWatchPaths" | "failedStartGeneration" |
  "matchesCloudSession" | "recordCloudSession"
>;

export interface CloudBrowserOptions {
  cloud: CloudBrowserClient;
  launcher: CloudBrowserLauncher;
  store: ProfileStore;
  queue: () => PendingSyncQueue | undefined;
  accountId: () => string | undefined;
  deviceId: () => string | undefined;
  readSession: (endpoint: string, captureSeed: SessionCaptureSeed) => Promise<string>;
  /** Restore the bundle and open startup pages over ONE CDP attach, then detach. */
  applySession: (endpoint: string, bundle: string, urls: readonly string[]) => Promise<void>;
  heartbeatMs?: number;
  /** Target/storage dirty polling interval; disabled by default, and 0 keeps it disabled. */
  dirtyMonitorMs?: number;
  checkpointDebounceMs?: number;
  checkpointMinIntervalMs?: number;
  watchPath?: (path: string, onDirty: () => void) => { close(): void };
  observeTargets?: (endpoint: string, onTarget: (origin: string | null) => void) => { close(): void };
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  log?: (message: string) => void;
}

const PENDING_SESSION_BASE_VERSION = -1;
/** Proxy-cache backfill: how many uncached profiles one roster poll fetches. */
const PROXY_BACKFILL_BATCH = 8;
/** How long a failed backfill fetch stays quiet before it is retried. */
const PROXY_BACKFILL_RETRY_MS = 300_000;
const DEFAULT_CHECKPOINT_DEBOUNCE_MS = 1_200;
const DEFAULT_CHECKPOINT_MIN_INTERVAL_MS = 3_000;
const CLOUD_PROFILE_OPEN_ERROR =
  "This Cloud profile is open in another session. Close it there, or try again shortly if that browser already closed.";
const TERMINAL_CONFLICT_WARNING =
  "Opened the latest Cloud state. An older conflicting snapshot remains encrypted on this device.";

interface CloudCheckpointState {
  registrationId: string;
  signature: string;
  origins: Set<string>;
  telegramClient?: "a" | "k";
}

interface CloudDirtyMonitor {
  registrationId: string;
  debugPort: number;
  startedAt: number;
  pollTimer?: unknown;
  debounceTimer?: ReturnType<typeof setTimeout>;
  watchers: Array<{ close(): void }>;
  watcherGeneration: number;
  targetObserver?: { close(): void };
  targetFingerprint?: string;
  dirty: boolean;
  captureInFlight: boolean;
  lastCaptureAt: number;
}

interface CloudLeaseResult {
  accountId: string;
  registrationId: string;
  outcome: "ok" | "transient" | "terminal";
  errorCode?: string;
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

function canonicalTargetOrigin(raw: string): string | null {
  const canonical = canonicalUserPageUrl(raw);
  return canonical ? new URL(canonical).origin : null;
}

function targetFingerprintOrigins(fingerprint: string): string[] {
  try {
    const targets = JSON.parse(fingerprint);
    if (!Array.isArray(targets)) return [];
    return [...new Set(targets.flatMap((target) => {
      const origin = typeof target?.url === "string" ? canonicalTargetOrigin(target.url) : null;
      return origin ? [origin] : [];
    }))];
  } catch {
    return [];
  }
}

export function observeBrowserTargets(
  endpoint: string,
  onTarget: (origin: string | null) => void,
): { close(): void } {
  const socket = new WebSocket(endpoint);
  const pageTargets = new Set<string>();
  const onOpen = () => {
    try {
      socket.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
    } catch {}
  };
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      if (message?.method === "Target.targetDestroyed") {
        const targetId = message?.params?.targetId;
        if (typeof targetId === "string" && pageTargets.delete(targetId)) onTarget(null);
        return;
      }
      if (message?.method !== "Target.targetCreated" && message?.method !== "Target.targetInfoChanged") return;
      const info = message?.params?.targetInfo;
      const targetId = info?.targetId;
      if (info?.type !== "page") {
        if (typeof targetId === "string" && pageTargets.delete(targetId)) onTarget(null);
        return;
      }
      if (typeof targetId === "string") pageTargets.add(targetId);
      onTarget(typeof info.url === "string" ? canonicalTargetOrigin(info.url) : null);
    } catch {}
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  return {
    close() {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      try { socket.close(); } catch {}
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof CloudApiError) return error.code;
  if (error instanceof SessionRestoreError) return error.outcome;
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
  if (error instanceof BrowserLaunchError) return "BrowserLaunchError";
  if (error instanceof TypeError) return "TypeError";
  return error instanceof Error ? "Error" : "unknown";
}

function sessionRestoreDiagnostic(error: SessionRestoreError): CloudDiagnosticType {
  return `session_restore_${error.operation}_${error.outcome}` as CloudDiagnosticType;
}

function browserLaunchDiagnostic(error: BrowserLaunchError): CloudDiagnosticType {
  return `browser_launch_${error.failure}_failed` as CloudDiagnosticType;
}

function normalizeBrowserLaunchError(error: unknown): BrowserLaunchError {
  return error instanceof BrowserLaunchError ? error : new BrowserLaunchError("preflight");
}

export class CloudBrowserCoordinator implements CloudBrowserLifecycle {
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, Promise<CloudBrowserOpenResult>>();
  private readonly closing = new Map<string, Promise<CloudBrowserCloseResult>>();
  private readonly timers = new Map<string, unknown>();
  private readonly heartbeatInFlight = new Map<string, CloudLeaseInFlight>();
  private readonly maintenanceInFlight = new Map<string, CloudMaintenanceInFlight>();
  private readonly checkpointSignatures = new Map<string, CloudCheckpointState>();
  private readonly dirtyMonitors = new Map<string, CloudDirtyMonitor>();
  private readonly missingPageObservations = new Map<string, {
    registrationId: string;
    count: number;
  }>();
  private pendingRetryTimer: unknown;
  private pendingRetryInFlight: Promise<void> | null = null;
  private readonly heartbeatMs: number;
  private readonly dirtyMonitorMs: number;
  private readonly checkpointDebounceMs: number;
  private readonly checkpointMinIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly diagnosticEvents = new CloudDiagnostics();
  private shuttingDown = false;
  private draining = false;
  /** Versions this run has decrypted into the local cache, per profile. */
  private readonly proxyCacheVersions = new Map<string, number>();
  /** Last backfill attempt per profile, so a failing fetch is not retried every poll. */
  private readonly proxyCacheAttempts = new Map<string, number>();
  private proxyBackfillTask: Promise<void> | null = null;

  constructor(private readonly options: CloudBrowserOptions) {
    this.heartbeatMs = Math.max(0, options.heartbeatMs ?? 60_000);
    this.dirtyMonitorMs = Math.max(0, options.dirtyMonitorMs ?? 0);
    this.checkpointDebounceMs = Math.max(0, options.checkpointDebounceMs ?? DEFAULT_CHECKPOINT_DEBOUNCE_MS);
    this.checkpointMinIntervalMs = Math.max(0, options.checkpointMinIntervalMs ?? DEFAULT_CHECKPOINT_MIN_INTERVAL_MS);
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
    await this.reconcileClosedBrowsers(queue, accountId);
    const response = await this.options.cloud.listProfiles();
    this.backfillProxyCache(response.profiles);
    const localRegistrations = new Map<string, Set<string>>();
    const rememberRegistration = (profileId: string, registrationId: string) => {
      const registrations = localRegistrations.get(profileId) ?? new Set<string>();
      registrations.add(registrationId);
      localRegistrations.set(profileId, registrations);
    };
    for (const open of queue.listOpens(accountId)) {
      rememberRegistration(open.profileId, open.registrationId);
    }
    for (const summary of queue.list(accountId)) {
      const pending = queue.get(summary.id, accountId);
      if (pending) rememberRegistration(pending.profileId, pending.registrationId);
    }
    return {
      profiles: response.profiles
        .filter((profile) => profile.trashedAt === null)
        .map((profile) => {
          const launch = this.options.store.getLaunch(profile.id);
          const cached = this.options.store.getProfile(profile.id);
          const localRegistrationIds = localRegistrations.get(profile.id);
          const otherActiveOpens = profile.activeOpens.filter(
            (open) => !localRegistrationIds?.has(open.registrationId),
          );
          return {
            id: profile.id,
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
            debugPort: launch?.debugPort,
            startedAt: launch?.startedAt,
            lockedBy: otherActiveOpens.length > 0
              ? `${otherActiveOpens.length} other session(s)`
              : null,
            permission: profile.permission,
            version: profile.version,
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
          this.proxyCacheVersions.set(summary.id, response.profile.version);
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
      payload: encodePortableProfile(profile),
    });
    if (created.profile.id !== profile.id) {
      throw new Error("Cloud returned a mismatched created profile");
    }
    return { id: profile.id };
  }

  async importProfiles(destination: string, profiles: Profile[]): Promise<ImportProfilesResponse> {
    this.requireContext(false);
    const ids = profiles.map((profile) => profile.id);
    const imported = await this.options.cloud.importProfiles({
      destination,
      profiles: profiles.map((profile) => encodePortableProfile(profile)),
    });
    if (
      imported.imported !== ids.length
      || imported.ids.length !== ids.length
      || imported.ids.some((id, index) => id !== ids[index])
    ) {
      throw new Error("Cloud returned a mismatched profile import result");
    }
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
      await retryPendingSync(queue, this.options.cloud, accountId);
      const pendingForProfile = queue.list(accountId)
        .filter((pending) => pending.profileId === profileId);
      if (pendingForProfile.some((pending) => pending.status !== "conflict")) {
        return { ok: false, error: "Pending Cloud synchronization must be resolved before reopening" };
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

      stage = "payload_restore";
      logStage("payload_restore");
      const { profile, sessionBundle } = decodePortableProfile(opened.payload);
      if (profile.id !== profileId) throw new Error("Cloud returned a mismatched profile payload");
      this.options.store.upsertProfile(profile);
      this.proxyCacheVersions.set(profileId, opened.baseVersion);

      stage = "browser_launch";
      logStage("browser_launch");
      const { chromeArgs, startupUrls } = splitLaunchUrls(launchArgs);
      const signature = sessionBundleSignature(sessionBundle);
      const restoreNativeSession = startupUrls.length === 0 &&
        this.options.launcher.matchesCloudSession(profileId, signature);
      // An interrupted restore must not leave partially replaced disk state trusted.
      this.options.launcher.recordCloudSession(profileId, null);
      const startBrowser = async () => {
        return await this.options.launcher.start(profileId, chromeArgs, {
          autoNavigate: false,
          restoreLastSession: restoreNativeSession,
          resetStorage: !restoreNativeSession && bundleHasRestorableLogin(sessionBundle),
          sessionBaseVersion: PENDING_SESSION_BASE_VERSION,
          headless: options.headless,
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

      stage = "lifecycle_restoring";
      logStage("lifecycle_restoring");

      stage = "session_restore";
      logStage("session_restore");
      this.diagnosticEvents.record("session_restore_started");
      await this.options.launcher.verifyRunningIdentity(profileId);
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
      const home = platformHomeUrl(profile.platform, bundleTelegramClient(sessionBundle) ?? "a");
      const savedTabs = bundleTabUrls(sessionBundle);
      const urls = startupUrls.length > 0
        ? startupUrls
        : savedTabs.length === 0 && home
          ? [home]
          : [];
      let navigationWarning: string | undefined;
      try {
        // Portable seeding blanks origin pages and replaces tabs. Native restore
        // already has newer local state and preserves the full Chromium layout.
        if (!restoreNativeSession || !launched.nativeSessionRestored) {
          await this.options.applySession(verifiedLaunch.ws, sessionBundle, urls);
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
      await this.options.launcher.verifyRunningIdentity(profileId);
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
        payload: encodePortableProfile(profile, sessionBundle),
        readyToSubmit: false,
      });
      const captureSeed = sessionCaptureSeed(sessionBundle);
      this.checkpointSignatures.set(profileId, {
        registrationId,
        signature,
        origins: new Set(captureSeed.origins),
        ...(captureSeed.telegramClient ? { telegramClient: captureSeed.telegramClient } : {}),
      });
      if (!navigationWarning) this.recordCloudSessionSignature(profileId, signature);

      // Startup navigation already happened inside the single restore attach above.
      this.diagnosticEvents.record("open_running");
      this.startHeartbeat(profileId);
      const warnings = [
        navigationWarning,
        hasTerminalConflict ? TERMINAL_CONFLICT_WARNING : undefined,
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
      const code = errorCode(error);
      const failureStage = error instanceof SessionRestoreError
        ? `session_restore/${error.operation}`
        : error instanceof BrowserLaunchError
          ? `browser_launch/${error.failure}`
          : stage;
      // Before registration only the local pending-sync queue is touched, so a
      // failure there is a local queue/database error whose message holds no
      // session material and is the only clue an operator gets.
      const localDetail = stage === "pending_sync" && error instanceof Error ? `: ${error.message}` : "";
      this.log(`${profileId}: Cloud open failed at ${failureStage} (${code}, ${safeErrorType(error)})${localDetail}`);
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
          error: `Cloud profile open failed at ${failureStage} (${code}); browser left open`,
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
        error: `Cloud profile open failed at ${failureStage} (${code})`,
      };
    }
  }

  async close(profileId: string): Promise<CloudBrowserCloseResult> {
    const existing = this.closing.get(profileId);
    if (existing) return existing;
    const promise = this.withProfileTransition(profileId, () => this.doClose(profileId));
    this.closing.set(profileId, promise);
    try {
      return await promise;
    } finally {
      if (this.closing.get(profileId) === promise) this.closing.delete(profileId);
    }
  }

  private async doClose(profileId: string): Promise<CloudBrowserCloseResult> {
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

    try {
      const profile = this.options.store.getProfile(profileId);
      if (!profile) throw new Error("Cloud profile cache is missing");
      await this.options.launcher.verifyRunningIdentity(profileId);
      const verifiedLaunch = this.options.store.getLaunch(profileId);
      if (!verifiedLaunch || !this.isExactRunningLaunch(open, verifiedLaunch)) {
        throw new Error("Cloud browser identity changed before session capture");
      }
      const sessionBundle = await this.captureSession(open, queue, verifiedLaunch.ws);
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
      if (!queue.setOpenCleanup(profileId, accountId, open.registrationId, "sync")) {
        this.diagnosticEvents.record("cleanup_retained");
        this.startHeartbeat(profileId);
        return this.teardownUnconfirmed();
      }
    } catch (error) {
      this.diagnosticEvents.record("cleanup_retained");
      this.startHeartbeat(profileId);
      throw new Error(`Cloud session capture failed (${errorCode(error)}); browser left open`);
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

    if (!queue.finalizeOpenCheckpoint(profileId, accountId, open.registrationId)) {
      this.diagnosticEvents.record("cleanup_retained");
      return this.closeResultForOpen(open, queue);
    }
    this.clearCheckpointSignature(open);
    if (this.options.accountId() === accountId) {
      await retryPendingSync(queue, this.options.cloud, accountId);
    }
    const result = this.closeResultForOpen(open, queue);
    this.diagnosticEvents.record(result.sync === "complete" ? "session_synced" : "cleanup_retained");
    return result;
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
    if (captures.some((capture) => capture.status === "conflict")) {
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

  private async finishStoppedOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    current: () => boolean = () => true,
  ): Promise<boolean> {
    const captures = this.pendingCapturesForOpen(open, queue);
    if (captures.length > 0) {
      if (!queue.finalizeOpenCheckpoint(open.profileId, open.accountId, open.registrationId)) return false;
      this.clearCheckpointSignature(open);
      if (current() && this.options.accountId() === open.accountId) {
        await retryPendingSync(queue, this.options.cloud, open.accountId, current);
      }
      const retainedCaptures = this.pendingCapturesForOpen(open, queue);
      if (retainedCaptures.length > 0) {
        this.diagnosticEvents.record(
          retainedCaptures.some((capture) => capture.status === "conflict")
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
  }

  private async captureSession(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    endpoint: string,
  ): Promise<string> {
    const state = this.checkpointState(open, queue);
    const captureSeed: SessionCaptureSeed = {
      origins: [...state.origins].sort(),
      ...(state.telegramClient ? { telegramClient: state.telegramClient } : {}),
    };
    const monitor = this.dirtyMonitors.get(open.profileId);
    const suspended = monitor?.registrationId === open.registrationId ? monitor : undefined;
    if (suspended) this.stopStorageWatchers(suspended);
    try {
      let bundle: string;
      try {
        bundle = await this.options.readSession(endpoint, captureSeed);
      } catch (error) {
        this.diagnosticEvents.record("checkpoint_capture_failed");
        throw error;
      }
      try {
        const captured = parseCapturedSessionBundle(bundle);
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
    this.checkpointSignatures.set(open.profileId, state);
    this.recordCloudSessionSignature(open.profileId, signature);
    this.diagnosticEvents.record("checkpoint_saved");
    return "saved";
  }

  private async refreshCheckpoint(open: PendingOpenSession, queue: PendingSyncQueue): Promise<void> {
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
      const sessionBundle = await this.captureSession(current, queue, verified.ws);
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
    if (!open || (open.phase !== "running" && open.phase !== "restoring")) return null;
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
    if (active) {
      const hasPageTargets = await this.options.launcher.hasPageTargets(profileId).catch(() => true);
      if (this.confirmNoPageTargets(profileId, registrationId, hasPageTargets)) {
        this.diagnosticEvents.record("no_page_close_requested");
        queueMicrotask(() => {
          void this.close(profileId).catch(() => {});
        });
        return;
      }
    }
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
      const open = context.queue.getOpen(profileId, lease.accountId);
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
      const secured = await this.captureAndStopOpen(open, context.queue, true);
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
          if (!await this.captureAndStopOpen(open, queue, true, current)) {
            throw new Error("a Cloud browser survivor could not be captured safely");
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
      await retryPendingSync(queue, this.options.cloud, accountId, current);
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

  private async captureAndStopOpen(
    open: PendingOpenSession,
    queue: PendingSyncQueue,
    submitAfterStop: boolean,
    current: () => boolean = () => true,
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
      const sessionBundle = await this.captureSession(open, queue, verifiedLaunch.ws);
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
    } catch {
      return false;
    }
    if (!current()) return false;
    const stopLaunch = this.options.store.getLaunch(open.profileId);
    if (!stopLaunch || !this.isExactRunningLaunch(open, stopLaunch)) return false;
    if (!await this.options.launcher.stop(open.profileId, {
      debugPort: stopLaunch.debugPort,
      startedAt: stopLaunch.startedAt,
    }).catch(() => false)) return false;
    await this.stopHeartbeatAndWait(open.profileId);
    if (!queue.finalizeOpenCheckpoint(open.profileId, open.accountId, open.registrationId)) return false;
    this.clearCheckpointSignature(open);
    if (
      submitAfterStop && current() &&
      this.options.accountId() === open.accountId
    ) {
      await retryPendingSync(queue, this.options.cloud, open.accountId, current);
      if (current()) this.closeResultForOpen(open, queue);
    }
    return true;
  }

  async retryPending(): Promise<void> {
    if (this.pendingRetryInFlight) return this.pendingRetryInFlight;
    const pending = (async () => {
      const { queue, accountId } = this.requireContext(false);
      await this.reconcileClosedBrowsers(queue, accountId);
      await retryPendingSync(queue, this.options.cloud, accountId);
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
      await retryPendingSync(queue, this.options.cloud, accountId);
      while (true) {
        const opens = queue.listOpens(accountId);
        if (opens.length === 0) break;
        let closedThisPass = 0;
        for (const open of opens) {
          try {
            const result = await this.close(open.profileId);
            const current = queue.getOpen(open.profileId, accountId);
            if (!current || current.registrationId !== open.registrationId) closedThisPass++;
            if (!result.closed) teardownConfirmed = false;
          } catch {
            teardownConfirmed = false;
          }
        }
        if (closedThisPass === 0) break;
      }
      if (this.options.accountId() === accountId) {
        await retryPendingSync(queue, this.options.cloud, accountId);
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
    if (this.dirtyMonitorMs === 0 || this.dirtyMonitors.has(profileId)) return;
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
    const checkpoint = this.checkpointState(open, context.queue);

    const monitor: CloudDirtyMonitor = {
      registrationId: open.registrationId,
      debugPort: launch.debugPort,
      startedAt: launch.startedAt,
      watchers: [],
      watcherGeneration: 0,
      dirty: false,
      captureInFlight: false,
      lastCaptureAt: 0,
    };
    this.dirtyMonitors.set(profileId, monitor);
    const onDirty = () => this.markCheckpointDirty(profileId, monitor);
    const onTarget = (origin: string | null) => {
      if (this.dirtyMonitors.get(profileId) !== monitor) return;
      if (origin) checkpoint.origins.add(origin);
      onDirty();
    };
    try {
      monitor.targetObserver = (this.options.observeTargets ?? observeBrowserTargets)(launch.ws, onTarget);
    } catch {
      // Filesystem watching and target polling remain active when observation is unavailable.
    }
    this.startStorageWatchers(profileId, monitor);
    if (monitor.watchers.length === 0) this.diagnosticEvents.record("dirty_monitor_unavailable");

    const poll = () => {
      void this.options.launcher.pageTargetFingerprint(profileId, {
        debugPort: monitor.debugPort,
        startedAt: monitor.startedAt,
      }).then((fingerprint) => {
        if (this.dirtyMonitors.get(profileId) !== monitor || fingerprint === null) return;
        for (const origin of targetFingerprintOrigins(fingerprint)) checkpoint.origins.add(origin);
        if (monitor.targetFingerprint === undefined) {
          monitor.targetFingerprint = fingerprint;
        } else if (monitor.targetFingerprint !== fingerprint) {
          monitor.targetFingerprint = fingerprint;
          onDirty();
        }
      }).catch(() => {});
    };
    poll();
    const set = this.options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    monitor.pollTimer = set(poll, this.dirtyMonitorMs);
    const timer = monitor.pollTimer;
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  private startStorageWatchers(profileId: string, monitor: CloudDirtyMonitor): void {
    const watchPath = this.options.watchPath ?? ((path: string, dirty: () => void) =>
      watch(path, { recursive: true }, () => dirty())
    );
    const generation = ++monitor.watcherGeneration;
    for (const path of this.options.launcher.browserStorageWatchPaths(profileId)) {
      try {
        monitor.watchers.push(watchPath(path, () => {
          if (monitor.watcherGeneration !== generation) return;
          this.markCheckpointDirty(profileId, monitor);
        }));
      } catch {
        // Target polling remains active when a browser storage directory is unavailable.
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
   * nudge the dirty monitor so that capture happens promptly (seconds), not at
   * the next heartbeat.
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
      await this.refreshCheckpoint(open, queue);
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
    if (monitor.pollTimer !== undefined) {
      const clear = this.options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(monitor.pollTimer);
    }
    if (monitor.debounceTimer) clearTimeout(monitor.debounceTimer);
    try { monitor.targetObserver?.close(); } catch {}
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
    return count >= 2;
  }

  private startHeartbeat(profileId: string): void {
    this.startDirtyMonitor(profileId);
    if (this.heartbeatMs === 0 || this.timers.has(profileId)) return;
    const set = this.options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const timer = set(() => {
      void this.heartbeatOnce(profileId);
    }, this.heartbeatMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    this.timers.set(profileId, timer);
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
    const timer = this.timers.get(profileId);
    if (timer !== undefined) {
      const clear = this.options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(timer);
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

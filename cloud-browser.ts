import { CloudApiError, type CloudClient } from "./cloud-client.ts";
import { platformHomeUrl, splitLaunchUrls, type Launcher } from "./launcher.ts";
import {
  type PendingClose,
  type PendingOpenSession,
  type PendingSyncQueue,
  retryPendingSync,
} from "./pending-sync.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import {
  bundleHasRestorableLogin,
  bundleTelegramClient,
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

export interface CloudBrowserProfile {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  proxy: null;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  has2fa: boolean;
  running: boolean;
  debugPort?: number;
  startedAt?: number;
  lockedBy: string | null;
}

export interface CloudBrowserLifecycle {
  listRoster(): Promise<{ profiles: CloudBrowserProfile[]; healthSources: [] }>;
  create(profile: Profile): Promise<{ id: string }>;
  open(profileId: string, launchArgs?: string[]): Promise<CloudBrowserOpenResult>;
  close(profileId: string): Promise<boolean>;
  secureAfterAuthentication(): Promise<void>;
  resumeAfterAuthentication(): Promise<void>;
  retryPending(): Promise<void>;
  releaseAll(permanent?: boolean): Promise<boolean>;
}

type CloudBrowserClient = Pick<
  CloudClient,
  "listProfiles" | "createProfile" | "openProfile" | "heartbeat" | "closeOpen" | "abandon"
>;

type CloudBrowserLauncher = Pick<
  Launcher,
  "start" | "stop" | "active" | "navigate" | "verifyRunningIdentity"
>;

export interface CloudBrowserOptions {
  cloud: CloudBrowserClient;
  launcher: CloudBrowserLauncher;
  store: ProfileStore;
  queue: () => PendingSyncQueue | undefined;
  accountId: () => string | undefined;
  deviceId: () => string | undefined;
  readSession: (ws: string) => Promise<string>;
  writeSession: (ws: string, bundle: string) => Promise<void>;
  heartbeatMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  log?: (message: string) => void;
}

const PENDING_SESSION_BASE_VERSION = -1;
const TERMINAL_HEARTBEAT_ERRORS = new Set([
  "device_revoked",
  "membership_revoked",
  "version_conflict",
  "profile_not_found",
  "profile_trashed",
]);

function errorCode(error: unknown): string {
  return error instanceof CloudApiError ? error.code : "transport_error";
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
  if (error instanceof TypeError) return "TypeError";
  return error instanceof Error ? "Error" : "unknown";
}

export class CloudBrowserCoordinator implements CloudBrowserLifecycle {
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, Promise<CloudBrowserOpenResult>>();
  private readonly closing = new Map<string, Promise<boolean>>();
  private readonly timers = new Map<string, unknown>();
  private readonly heartbeatInFlight = new Map<string, Promise<void>>();
  private pendingRetryTimer: unknown;
  private pendingRetryInFlight: Promise<void> | null = null;
  private readonly heartbeatMs: number;
  private readonly log: (message: string) => void;
  private shuttingDown = false;
  private draining = false;

  constructor(private readonly options: CloudBrowserOptions) {
    this.heartbeatMs = Math.max(0, options.heartbeatMs ?? 60_000);
    this.log = options.log ?? (() => {});
  }

  async listRoster(): Promise<{ profiles: CloudBrowserProfile[]; healthSources: [] }> {
    this.requireContext(false);
    const response = await this.options.cloud.listProfiles();
    return {
      profiles: response.profiles
        .filter((profile) => profile.trashedAt === null)
        .map((profile) => {
          const launch = this.options.store.getLaunch(profile.id);
          return {
            id: profile.id,
            name: profile.name,
            group: profile.group,
            platform: profile.platform,
            tags: [...profile.tags],
            proxy: null,
            timezone: "",
            cookieCount: 0,
            seeded: false,
            screen: "",
            has2fa: false,
            running: !!launch,
            debugPort: launch?.debugPort,
            startedAt: launch?.startedAt,
            lockedBy: profile.activeOpens.length > 0
              ? `${profile.activeOpens.length} other session(s)`
              : null,
          };
        }),
      healthSources: [],
    };
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

  async open(profileId: string, launchArgs: string[] = []): Promise<CloudBrowserOpenResult> {
    if (this.shuttingDown || this.draining) {
      return { ok: false, error: "Cloud browser coordinator is shutting down" };
    }
    const existing = this.opening.get(profileId);
    if (existing) return existing;
    const promise = this.withProfileTransition(profileId, () => this.doOpen(profileId, launchArgs));
    this.opening.set(profileId, promise);
    try {
      return await promise;
    } finally {
      if (this.opening.get(profileId) === promise) this.opening.delete(profileId);
    }
  }

  private async doOpen(profileId: string, launchArgs: string[]): Promise<CloudBrowserOpenResult> {
    let context: { queue: PendingSyncQueue; accountId: string; deviceId: string };
    try {
      context = this.requireContext(true);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const { queue, accountId, deviceId } = context;
    let stage: CloudOpenStage = "pending_sync";
    let registrationRecorded = false;
    let registrationId: string | undefined;

    try {
      await retryPendingSync(queue, this.options.cloud, accountId);
      if (queue.list(accountId).some((pending) =>
        pending.profileId === profileId && pending.status !== "conflict"
      )) {
        return { ok: false, error: "Pending Cloud synchronization must finish before reopening" };
      }
      if (queue.getOpen(profileId, accountId)) {
        return { ok: false, error: "Cloud profile recovery must finish before opening" };
      }
      if (this.options.store.getLaunch(profileId)) {
        return { ok: false, error: "an unmanaged local browser is already recorded for this profile" };
      }

      stage = "cloud_registration";
      const opened = await this.options.cloud.openProfile(profileId, { deviceId });
      registrationId = opened.registrationId;

      stage = "lifecycle_opening";
      queue.recordOpen({
        accountId,
        profileId,
        registrationId,
        expectedVersion: opened.baseVersion,
      });
      registrationRecorded = true;

      stage = "payload_restore";
      const { profile, sessionBundle } = decodePortableProfile(opened.payload);
      if (profile.id !== profileId) throw new Error("Cloud returned a mismatched profile payload");
      this.options.store.upsertProfile(profile);

      stage = "browser_launch";
      const { chromeArgs, startupUrls } = splitLaunchUrls(launchArgs);
      const startOptions = {
        autoNavigate: false,
        resetStorage: bundleHasRestorableLogin(sessionBundle),
        sessionBaseVersion: PENDING_SESSION_BASE_VERSION,
      };
      let launched: { ws: string; port: number };
      try {
        launched = await this.options.launcher.start(profileId, chromeArgs, startOptions);
      } catch (error) {
        // A failed start can retain exact ownership when an older CloakBrowser still holds the
        // persistent Cloud profile directory. Stop only that recorded launch, require confirmed
        // death, then retry once so Chromium cannot hand the new command line to the stale singleton.
        if (!this.options.store.getLaunch(profileId)) throw error;
        const stopped = await this.options.launcher.stop(profileId).catch(() => false);
        if (!stopped) throw error;
        this.log(`${profileId}: stopped retained browser launch ownership; retrying once`);
        launched = await this.options.launcher.start(profileId, chromeArgs, startOptions);
      }
      const launch = this.options.store.getLaunch(profileId);
      if (!launch) throw new Error("browser launch did not create durable lifecycle state");

      stage = "lifecycle_restoring";
      if (!queue.updateOpen(profileId, accountId, "restoring", {
        debugPort: launch.debugPort,
        startedAt: launch.startedAt,
      })) {
        throw new Error("Cloud open lifecycle state disappeared during launch");
      }

      stage = "session_restore";
      await this.options.writeSession(launched.ws, sessionBundle);

      stage = "version_commit";
      this.options.store.updateLaunchSessionBaseVersion(profileId, opened.baseVersion);

      stage = "lifecycle_running";
      if (!queue.updateOpen(profileId, accountId, "running", {
        debugPort: launch.debugPort,
        startedAt: launch.startedAt,
      })) {
        throw new Error("Cloud open lifecycle state disappeared after restore");
      }

      stage = "navigation";
      const home = platformHomeUrl(profile.platform, bundleTelegramClient(sessionBundle) ?? "a");
      const urls = startupUrls.length > 0 ? startupUrls : home ? [home] : [];
      let navigationWarning: string | undefined;
      if (urls.length > 0) {
        try {
          await this.options.launcher.navigate(launched.ws, urls);
        } catch (error) {
          this.log(
            `${profileId}: Cloud startup navigation failed (${errorCode(error)}, ${safeErrorType(error)}); continuing`,
          );
          navigationWarning = "Profile opened, but startup navigation failed. Open the site manually.";
        }
      }
      this.startHeartbeat(profileId);
      const warnings = [
        opened.activeOpens.length > 0
          ? `This profile is also open in ${opened.activeOpens.length} other session(s).`
          : undefined,
        navigationWarning,
      ].filter((warning): warning is string => !!warning);
      return {
        ok: true,
        ws: launched.ws,
        port: launched.port,
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      };
    } catch (error) {
      this.stopHeartbeat(profileId);
      const code = errorCode(error);
      this.log(`${profileId}: Cloud open failed at ${stage} (${code}, ${safeErrorType(error)})`);
      const stopped = registrationId
        ? await this.options.launcher.stop(profileId).catch(() => false)
        : false;
      if (stopped && registrationId) {
        try {
          await this.options.cloud.abandon(registrationId);
          if (registrationRecorded) queue.removeOpen(profileId, accountId);
        } catch (abandonError) {
          if (
            registrationRecorded &&
            abandonError instanceof CloudApiError &&
            abandonError.code === "profile_not_found"
          ) {
            queue.removeOpen(profileId, accountId);
          }
          // Other failures retain durable metadata for authenticated recovery.
        }
      }
      return {
        ok: false,
        error: `Cloud profile open failed at ${stage} (${code})`,
      };
    }
  }

  async close(profileId: string): Promise<boolean> {
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

  private async doClose(profileId: string): Promise<boolean> {
    const { queue, accountId } = this.requireContext(false);
    const open = queue.getOpen(profileId, accountId);
    const launch = this.options.store.getLaunch(profileId);
    if (!open) {
      if (launch) throw new Error("Cloud open lifecycle state is missing; browser left open");
      return true;
    }

    await this.stopHeartbeat(profileId);
    if (!launch) return this.finishStoppedOpen(open, queue);

    let pendingId: string;
    try {
      const profile = this.options.store.getProfile(profileId);
      if (!profile) throw new Error("Cloud profile cache is missing");
      const sessionBundle = await this.options.readSession(launch.ws);
      pendingId = queue.enqueue({
        accountId,
        profileId,
        registrationId: open.registrationId,
        expectedVersion: open.expectedVersion,
        payload: encodePortableProfile(profile, sessionBundle),
        readyToSubmit: false,
      });
    } catch (error) {
      this.startHeartbeat(profileId);
      throw new Error(`Cloud session capture failed (${errorCode(error)}); browser left open`);
    }

    const stopped = await this.options.launcher.stop(profileId).catch(() => false);
    if (!stopped) {
      this.startHeartbeat(profileId);
      return false;
    }

    queue.markReady(pendingId, accountId);
    queue.removeOpen(profileId, accountId);
    await retryPendingSync(queue, this.options.cloud, accountId);
    return true;
  }

  private async finishStoppedOpen(open: PendingOpenSession, queue: PendingSyncQueue): Promise<boolean> {
    const captures = queue.list(open.accountId)
      .filter((item) => item.profileId === open.profileId)
      .map((item) => queue.get(item.id, open.accountId))
      .filter((item): item is PendingClose => !!item && item.registrationId === open.registrationId);
    if (captures.length > 0) {
      for (const capture of captures) {
        if (!capture.readyToSubmit && capture.status !== "conflict") {
          queue.markReady(capture.id, open.accountId);
        }
      }
      queue.removeOpen(open.profileId, open.accountId);
      await retryPendingSync(queue, this.options.cloud, open.accountId);
      return true;
    }

    try {
      await this.options.cloud.abandon(open.registrationId);
      queue.removeOpen(open.profileId, open.accountId);
      return true;
    } catch (error) {
      if (error instanceof CloudApiError && error.code === "profile_not_found") {
        queue.removeOpen(open.profileId, open.accountId);
        return true;
      }
      return false;
    }
  }

  async heartbeatOnce(profileId: string): Promise<void> {
    const existing = this.heartbeatInFlight.get(profileId);
    if (existing) return existing;
    const promise = this.doHeartbeat(profileId).finally(() => {
      if (this.heartbeatInFlight.get(profileId) === promise) {
        this.heartbeatInFlight.delete(profileId);
      }
    });
    this.heartbeatInFlight.set(profileId, promise);
    return promise;
  }

  private async doHeartbeat(profileId: string): Promise<void> {
    let context: { queue: PendingSyncQueue; accountId: string; deviceId?: string };
    try {
      context = this.requireContext(false);
    } catch {
      return;
    }
    const open = context.queue.getOpen(profileId, context.accountId);
    if (!open || open.phase !== "running") return;
    const active = await this.options.launcher.active(profileId).catch(() => true);
    if (!active) {
      this.stopHeartbeat(profileId);
      const stopped = await this.options.launcher.stop(profileId).catch(() => false);
      if (stopped) await this.finishStoppedOpen(open, context.queue);
      return;
    }
    try {
      await this.options.cloud.heartbeat(open.registrationId);
    } catch (error) {
      if (error instanceof CloudApiError && TERMINAL_HEARTBEAT_ERRORS.has(error.code)) {
        this.stopHeartbeat(profileId);
        const secured = await this.captureAndStopOpen(open, context.queue, true);
        this.log(secured
          ? `${profileId}: Cloud access ended (${error.code}); browser stopped`
          : `${profileId}: Cloud access ended (${error.code}); capture failed and browser was retained`);
        return;
      }
      this.log(`${profileId}: Cloud heartbeat failed (${errorCode(error)})`);
    }
  }

  async secureAfterAuthentication(): Promise<void> {
    this.draining = true;
    try {
      const { queue, accountId } = this.requireContext(false);
      await this.secureForeignAccountBrowsers(queue, accountId);
    } finally {
      if (!this.shuttingDown) this.draining = false;
    }
  }

  async resumeAfterAuthentication(): Promise<void> {
    this.draining = true;
    try {
      const { queue, accountId } = this.requireContext(false);
      await this.secureForeignAccountBrowsers(queue, accountId);

      for (const open of queue.listOpens(accountId)) {
        const launch = this.options.store.getLaunch(open.profileId);
        if (launch && this.isExactRunningLaunch(open, launch)) {
          try {
            await this.options.launcher.verifyRunningIdentity(open.profileId);
            if (await this.options.launcher.active(open.profileId)) {
              this.startHeartbeat(open.profileId);
              continue;
            }
          } catch {
            // Capture the exact Cloud generation before any teardown attempt.
          }
          if (!await this.captureAndStopOpen(open, queue, true)) {
            throw new Error("a Cloud browser survivor could not be captured safely");
          }
          continue;
        }

        const stopped = !launch || await this.options.launcher.stop(open.profileId).catch(() => false);
        if (stopped) await this.finishStoppedOpen(open, queue);
      }
      await retryPendingSync(queue, this.options.cloud, accountId);
      this.startPendingRetry();
    } finally {
      if (!this.shuttingDown) this.draining = false;
    }
  }

  private async secureForeignAccountBrowsers(
    queue: PendingSyncQueue,
    accountId: string,
  ): Promise<void> {
    for (const foreign of queue.listAllOpens().filter((open) => open.accountId !== accountId)) {
      const launch = this.options.store.getLaunch(foreign.profileId);
      if (!launch) continue;
      if (this.isExactRunningLaunch(foreign, launch)) {
        if (!await this.captureAndStopOpen(foreign, queue, false)) {
          throw new Error("a browser from another Cloud account could not be secured");
        }
      } else if (!await this.options.launcher.stop(foreign.profileId).catch(() => false)) {
        throw new Error("a browser from another Cloud account could not be stopped");
      }
    }
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
  ): Promise<boolean> {
    const launch = this.options.store.getLaunch(open.profileId);
    const profile = this.options.store.getProfile(open.profileId);
    if (!launch || !profile) return false;
    let pendingId: string;
    try {
      const sessionBundle = await this.options.readSession(launch.ws);
      pendingId = queue.enqueue({
        accountId: open.accountId,
        profileId: open.profileId,
        registrationId: open.registrationId,
        expectedVersion: open.expectedVersion,
        payload: encodePortableProfile(profile, sessionBundle),
        readyToSubmit: false,
      });
    } catch {
      return false;
    }
    if (!await this.options.launcher.stop(open.profileId).catch(() => false)) return false;
    queue.markReady(pendingId, open.accountId);
    queue.removeOpen(open.profileId, open.accountId);
    if (submitAfterStop) {
      await retryPendingSync(queue, this.options.cloud, open.accountId);
    }
    return true;
  }

  async retryPending(): Promise<void> {
    if (this.pendingRetryInFlight) return this.pendingRetryInFlight;
    const pending = (async () => {
      const { queue, accountId } = this.requireContext(false);
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
    try {
      await this.stopPendingRetry();
      await Promise.allSettled([...this.opening.values()]);
      const queue = this.options.queue();
      const accountId = this.options.accountId();
      if (!queue || !accountId) return true;

      let complete = true;
      while (true) {
        const opens = queue.listOpens(accountId);
        if (opens.length === 0) break;
        let closedThisPass = 0;
        for (const open of opens) {
          try {
            if (await this.close(open.profileId)) closedThisPass++;
            else complete = false;
          } catch {
            complete = false;
          }
        }
        if (closedThisPass === 0) break;
      }
      return complete && queue.listOpens(accountId).length === 0;
    } finally {
      // Keep lifecycle admission closed through credential teardown. A successful
      // authentication recovery reopens it in resumeAfterAuthentication().
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

  private startHeartbeat(profileId: string): void {
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

  private stopHeartbeat(profileId: string): Promise<void> | null {
    const timer = this.timers.get(profileId);
    if (timer !== undefined) {
      const clear = this.options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(timer);
      this.timers.delete(profileId);
    }
    return this.heartbeatInFlight.get(profileId) ?? null;
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

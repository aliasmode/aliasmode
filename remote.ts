/**
 * Remote-mode coordinator — what an operator's AliasMode runs against the hub.
 *
 * Wraps Open/Close with the team contract:
 *   Open  → try to claim the session-writer lease → fetch the full profile +
 *           latest session from the hub → launch locally → inject the roamed
 *           session → start session checkpoints only when this worker owns the lease.
 *           Another writer produces a warning but does not block local launch.
 *   Close → when writer-owned, push the current session before stopping and
 *           releasing; advisory browsers stop locally without touching the lease.
 *
 * The hub is the source of truth; the local store is just a launch cache. CDP
 * read/write live in session.ts (injectable here so this stays unit-testable).
 */

import {
  HubOwnershipLostError,
  type HealthSnapshotCounts,
  type HubClient,
  type RemoteProfile,
  type RemoteRoster,
} from "./hub-client.ts";
import { isTelegramPlatform, splitLaunchUrls, platformHomeUrl, type Launcher } from "./launcher.ts";
import {
  bundleHasRestorableLogin,
  bundleHasTelegramOrigin,
  bundleTabUrls,
  bundleTelegramClient,
  parseCapturedSessionBundle,
  sessionCaptureSeed,
  type SessionCaptureSeed,
  telegramAuthSignature,
} from "./session.ts";
import type { ProfileStore } from "./store.ts";
import type { NewProfileInput } from "./create.ts";
import type { ImportOverrides } from "./inbox.ts";
import type { SessionRecord, AutomationHealthEntry } from "./remote-types.ts";
import type { CookieRecord, Profile } from "./types.ts";
import { Buffer } from "node:buffer";
import type { LifecycleState } from "./lifecycle-admission.ts";

/** Default lease the hub enforces (hub.ts DEFAULT_LEASE_MS). Kept here so heartbeat suspend-detection
 *  can reason about when our lock would have lapsed. Override via RemoteDeps.leaseMs to match the hub. */
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_DRAIN_MS = 15_000;
const DEFAULT_SESSION_READ_TIMEOUT_MS = 90_000;
const DEFAULT_RETAINED_CLEANUP_RETRY_MS = 30_000;
const DEFAULT_RETAINED_CLEANUP_RENEW_MS = 60_000;
const DEFAULT_RETAINED_CLEANUP_ATTEMPT_MS = 20_000;
/** A durable launch row exists, but the authoritative hub bundle has not yet
 *  completed restore. Real hub session versions are non-negative. */
const PENDING_SESSION_BASE_VERSION = -1;

type HubLike = Pick<
  HubClient,
  "owner" | "getRoster" | "getProfile" | "saveProfile" | "claim" | "renew" | "release" | "getSession" | "putSession" | "importFiles" | "move" | "createProfile" | "renameProfile" | "deleteProfiles"
> & Partial<Pick<HubClient, "getRosterSnapshot" | "publishAutomationHealthSnapshot">>;
type LauncherLike = Pick<Launcher, "start" | "active" | "navigate">
  & { stop(profileId: string): Promise<boolean> }
  & Partial<Pick<Launcher, "diagnoseCdp" | "verifyRunningIdentity" | "reconcileOrphan">>;

export interface RemoteDeps {
  hub: HubLike;
  launcher: LauncherLike;
  store: ProfileStore;
  readSession: (ws: string, captureSeed: SessionCaptureSeed) => Promise<string>;
  writeSession: (
    ws: string,
    bundle: string,
    options?: { authoritative?: boolean },
  ) => Promise<void>;
  log?: (msg: string) => void;
  /** Heartbeat interval; 0 disables the auto timer (tests drive heartbeatOnce). */
  heartbeatMs?: number;
  /** Fast Telegram auth checkpoint interval. Defaults to 3s; 0 disables it. */
  sessionSyncMs?: number;
  /** Lease length the hub enforces; a wall-clock gap beyond this between heartbeats means a suspend
   *  (laptop sleep) during which our lock likely lapsed. Defaults to the hub's 5-min lease. */
  leaseMs?: number;
  /** Injectable wall clock (ms) for suspend detection; defaults to Date.now. */
  nowMs?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => any;
  clearIntervalFn?: (h: any) => void;
  /** Bound reopening while a prior scheduled heartbeat is still mutating the hub. */
  heartbeatDrainMs?: number;
  /** End-to-end bound for the injected CDP session reader. */
  sessionReadTimeoutMs?: number;
  /** Retry/renew cadence for a browser whose verified stop returned false. */
  retainedCleanupRetryMs?: number;
  retainedCleanupRenewMs?: number;
  /** Observation bound for one stop attempt; timed-out attempts never overlap. */
  retainedCleanupAttemptMs?: number;
}

export interface OpenResult {
  ok: boolean;
  lockedBy?: string;
  ws?: string;
  port?: number;
  error?: string;
  warning?: string; // opened anyway despite another operator's lock
}

type PushSessionOutcome = "stored" | "declined";

interface BackgroundTaskInFlight {
  token: symbol;
  generation: number;
  promise: Promise<void>;
}

interface RetainedCleanup {
  generation: number;
  ownsLock: boolean;
  timer: any;
  stopInFlight: Promise<boolean> | null;
  renewInFlight: boolean;
  lastStopAt: number;
  lastRenewAt: number;
  releaseBarrier: Promise<void> | null;
  barrierSettled: boolean;
  teardownConfirmed: boolean;
  releaseInFlight: boolean;
  lockReleased: boolean;
}

class SessionReadBusyError extends Error {}

export class RemoteCoordinator {
  private timers = new Map<string, any>();
  /**
   * Per-profile token for the currently running scheduled heartbeat. Tokens,
   * rather than a Set, let stop+reopen forget an old tick immediately while
   * ensuring that old tick's eventual finally cannot clear the new tick.
   */
  private heartbeatTicksInFlight = new Map<string, BackgroundTaskInFlight>();
  private heartbeatGenerations = new Map<string, number>();
  private sessionSyncTimers = new Map<string, any>();
  private sessionSyncsInFlight = new Map<string, BackgroundTaskInFlight>();
  /** The raw reader may outlive its caller's deadline. Retain it until it
   *  actually settles so later heartbeats cannot accumulate CDP clients. */
  private sessionReadsInFlight = new Map<string, Promise<string>>();
  private sessionCapturesStarted = 0;
  private sessionCapturesSettled = 0;
  private sessionCaptureErrors = 0;
  private sessionCaptureBytes = 0;
  private largestSessionCaptureBytes = 0;
  private pushesInFlight = new Map<string, Promise<PushSessionOutcome>>();
  private telegramSignatures = new Map<string, string>();
  private telegramProfiles = new Set<string>(); // only these profiles pay the fast CDP checkpoint cost
  private sessionCaptureSeeds = new Map<string, SessionCaptureSeed>();
  private transitions = new Map<string, Promise<void>>(); // serialize open/close for each profile
  private opening = new Map<string, { promise: Promise<OpenResult>; generation: number }>();
  private lifecycleGenerations = new Map<string, number>();
  private closingTransitions = new Map<string, { promise: Promise<boolean>; generation: number }>();
  private closing = new Set<string>(); // close() has stopped heartbeat but browser/session save may still be live
  private backgroundStopping = new Set<string>(); // heartbeat teardown outside an explicit close()
  private versions = new Map<string, number>(); // last hub session version we know per profile (optimistic-concurrency base)
  private staleReattached = new Set<string>(); // survivors whose persisted base is unknown or older than the hub — must not push until reopened
  /** Locally running profiles that do not own the hub's session-writer lease. */
  private advisoryLaunches = new Map<string, string>();
  /** Wall-clock of the last successful hub claim/renew. An attempted timer tick
   *  is never ownership proof and must not extend this deadline. */
  private lastLeaseConfirmedAt = new Map<string, number>();
  private retainedCleanups = new Map<string, RetainedCleanup>();
  private retainedCleanupGeneration = new Map<string, number>();
  private shuttingDown = false;
  private releaseAllInFlight: Promise<boolean> | null = null;
  private leaseMs: number;
  private heartbeatDrainMs: number;
  private sessionReadTimeoutMs: number;
  private retainedCleanupRetryMs: number;
  private retainedCleanupRenewMs: number;
  private retainedCleanupAttemptMs: number;
  private sessionSyncMs: number;
  private nowMs: () => number;
  private log: (msg: string) => void;

  constructor(private d: RemoteDeps) {
    this.log = d.log ?? ((m) => console.log(`[remote] ${m}`));
    this.leaseMs = d.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatDrainMs = Math.max(1, d.heartbeatDrainMs ?? DEFAULT_HEARTBEAT_DRAIN_MS);
    this.sessionReadTimeoutMs = Math.max(1, d.sessionReadTimeoutMs ?? DEFAULT_SESSION_READ_TIMEOUT_MS);
    this.retainedCleanupRetryMs = Math.max(1, d.retainedCleanupRetryMs ?? DEFAULT_RETAINED_CLEANUP_RETRY_MS);
    this.retainedCleanupRenewMs = Math.max(1, d.retainedCleanupRenewMs ?? DEFAULT_RETAINED_CLEANUP_RENEW_MS);
    this.retainedCleanupAttemptMs = Math.max(1, d.retainedCleanupAttemptMs ?? DEFAULT_RETAINED_CLEANUP_ATTEMPT_MS);
    // Test harnesses conventionally set heartbeatMs=0 to disable background work; preserve that
    // behavior unless they explicitly opt into the fast checkpoint.
    this.sessionSyncMs = d.sessionSyncMs ?? (d.heartbeatMs === 0 ? 0 : 3_000);
    this.nowMs = d.nowMs ?? (() => Date.now());
  }

  private markAdvisory(profileId: string, lockedBy?: string, reason?: string): string {
    const warning = lockedBy
      ? `Possible concurrent use: hub reports this profile in use by ${lockedBy}; session sync is disabled for this browser.`
      : "Possible concurrent use: writer ownership could not be confirmed; session sync is disabled for this browser.";
    this.advisoryLaunches.set(profileId, warning);
    this.lastLeaseConfirmedAt.delete(profileId);
    this.log(`${profileId}: ${reason ?? warning} — running without hub session-write ownership`);
    return warning;
  }

  private downgradeHeartbeat(
    profileId: string,
    lockedBy: string | undefined,
    reason: string,
    currentToken?: symbol,
  ): void {
    this.markAdvisory(profileId, lockedBy, reason);
    const current = this.heartbeatTicksInFlight.get(profileId);
    const exclude = currentToken && current?.token === currentToken ? current.promise : null;
    this.stopHeartbeat(profileId, exclude);
  }

  /** Current remote transition evidence for conservative browser/active responses. */
  lifecycleState(profileId: string): LifecycleState | null {
    if (this.retainedCleanups.has(profileId) || this.closingTransitions.has(profileId)
      || this.closing.has(profileId) || this.backgroundStopping.has(profileId)) {
      return "stopping";
    }
    if (this.opening.has(profileId)) return "starting";
    if (this.transitions.has(profileId)) return "uncertain";
    if (this.timers.has(profileId) && !this.d.store.getLaunch(profileId)) return "uncertain";
    return null;
  }

  private async readSessionWithDeadline(profileId: string, ws: string): Promise<string> {
    if (this.sessionReadsInFlight.has(profileId)) {
      throw new SessionReadBusyError(`prior session capture is still running for ${profileId}`);
    }

    this.sessionCapturesStarted++;
    const read = Promise.resolve().then(async () => {
      const seed = this.sessionCaptureSeeds.get(profileId) ?? { origins: [] };
      const bundle = await this.d.readSession(ws, seed);
      const captured = parseCapturedSessionBundle(bundle);
      const next = sessionCaptureSeed(bundle);
      const origins = new Set(seed.origins);
      for (const origin of next.origins) origins.add(origin);
      this.sessionCaptureSeeds.set(profileId, {
        origins: [...origins].sort(),
        ...(captured.telegramClient ?? seed.telegramClient
          ? { telegramClient: captured.telegramClient ?? seed.telegramClient }
          : {}),
      });
      return bundle;
    });
    this.sessionReadsInFlight.set(profileId, read);
    void read.then((bundle) => {
      const bytes = Buffer.byteLength(bundle);
      this.sessionCaptureBytes += bytes;
      this.largestSessionCaptureBytes = Math.max(this.largestSessionCaptureBytes, bytes);
    }, () => {
      this.sessionCaptureErrors++;
    }).finally(() => {
      this.sessionCapturesSettled++;
      if (this.sessionReadsInFlight.get(profileId) === read) {
        this.sessionReadsInFlight.delete(profileId);
      }
    }).catch(() => {});

    return withDeadline(read, this.sessionReadTimeoutMs, `session capture for ${profileId}`);
  }

  memoryAttribution() {
    return {
      sessionCapturesStarted: this.sessionCapturesStarted,
      sessionCapturesSettled: this.sessionCapturesSettled,
      sessionCaptureErrors: this.sessionCaptureErrors,
      sessionCaptureBytes: this.sessionCaptureBytes,
      largestSessionCaptureBytes: this.largestSessionCaptureBytes,
      pendingSessionReads: this.sessionReadsInFlight.size,
      pendingSessionSyncs: this.sessionSyncsInFlight.size,
      pendingPushes: this.pushesInFlight.size,
      pendingHeartbeats: this.heartbeatTicksInFlight.size,
      opening: this.opening.size,
      closing: this.closing.size,
      retainedCleanups: this.retainedCleanups.size,
      advisoryLaunches: this.advisoryLaunches.size,
      telegramProfiles: this.telegramProfiles.size,
    };
  }

  /**
   * Read the live session over CDP and push it to the hub under optimistic concurrency. We tag the push
   * with the version we last knew; if the hub has moved past it (someone else wrote during a lock gap),
   * the write is refused and we SKIP rather than revert their fresher login. Throws only on a read/hub
   * transport error, which callers treat as best-effort.
   */
  private pushSession(
    profileId: string,
    ws: string,
    capturedBundle?: string,
    stillCurrent: () => boolean = () => true,
  ): Promise<PushSessionOutcome> {
    // The 3-second checkpoint, 2-minute heartbeat, and Close can meet at the same time. Serialize them
    // per profile so two PUTs never race with the same optimistic-concurrency base.
    const previous = this.pushesInFlight.get(profileId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() =>
      this.doPushSession(profileId, ws, capturedBundle, stillCurrent)
    );
    this.pushesInFlight.set(profileId, current);
    void current.finally(() => {
      if (this.pushesInFlight.get(profileId) === current) this.pushesInFlight.delete(profileId);
    }).catch(() => {});
    return current;
  }

  private async doPushSession(
    profileId: string,
    ws: string,
    capturedBundle: string | undefined,
    stillCurrent: () => boolean,
  ): Promise<PushSessionOutcome> {
    if (!stillCurrent() || this.advisoryLaunches.has(profileId)) return "declined";
    if (this.staleReattached.has(profileId)) {
      // Reattached after a restart without proving this browser is based on the hub's current session.
      // Pushing could clobber a fresher bundle; hold until reopen re-injects the authoritative session.
      this.log(`${profileId}: reattached without a current session base — skipping push (reopen to resync)`);
      return "declined";
    }
    if (!this.versions.has(profileId)) {
      this.log(`${profileId}: no session base version known — skipping push (reopen to resync)`);
      return "declined";
    }
    const base = this.versions.get(profileId)!;
    const bundle = capturedBundle ?? await this.readSessionWithDeadline(profileId, ws);
    if (!stillCurrent() || this.advisoryLaunches.has(profileId)) return "declined";
    const r = await this.d.hub.putSession(profileId, bundle, base);
    if (!stillCurrent()) return "declined";
    if (r.conflict) {
      // Leave our known base stale on purpose: keep declining to clobber until the operator reopens
      // (which re-pulls the authoritative session and resets the base).
      this.log(`${profileId}: session version conflict (hub at v${r.version}) — not overwriting; reopen to resync`);
      return "declined";
    }
    if (r.skipped) {
      this.log(`${profileId}: hub declined session checkpoint (${r.skipped})`);
      return "declined";
    }
    this.versions.set(profileId, r.version);
    this.d.store.updateLaunchSessionBaseVersion(profileId, r.version);
    const signature = telegramAuthSignature(bundle);
    if (signature) this.telegramSignatures.set(profileId, signature);
    return "stored";
  }

  /**
   * Lightweight frequent checkpoint for the one state native window-close cannot save afterward.
   * It uploads only when a complete Telegram A/K auth signature differs from the last acknowledged one.
   */
  async sessionSyncOnce(profileId: string, ws: string): Promise<void> {
    const generation = this.heartbeatGenerations.get(profileId) ?? 0;
    return this.runSessionSyncTick(profileId, ws, generation);
  }

  private runSessionSyncTick(profileId: string, ws: string, generation: number): Promise<void> {
    if (this.heartbeatGenerations.get(profileId) !== generation) return Promise.resolve();
    const previous = this.sessionSyncsInFlight.get(profileId);
    if (previous?.generation === generation) return previous.promise;

    const token = Symbol(profileId);
    const stillCurrent = () => this.heartbeatGenerations.get(profileId) === generation;
    const promise = this.sessionSyncOnceGuarded(profileId, ws, stillCurrent)
      .finally(() => {
        if (this.sessionSyncsInFlight.get(profileId)?.token === token) {
          this.sessionSyncsInFlight.delete(profileId);
        }
      });
    this.sessionSyncsInFlight.set(profileId, { token, generation, promise });
    return promise;
  }

  private async sessionSyncOnceGuarded(
    profileId: string,
    ws: string,
    stillCurrent: () => boolean,
  ): Promise<void> {
    if (!stillCurrent() || this.advisoryLaunches.has(profileId)) return;
    try {
      if (this.closing.has(profileId) || this.staleReattached.has(profileId)) return;
      if (!this.versions.has(profileId)) return;
      if (!(await this.d.launcher.active(profileId).catch(() => false))) return;
      if (!stillCurrent()) return;
      const currentWs = this.d.store.getLaunch(profileId)?.ws ?? ws;
      const bundle = await this.readSessionWithDeadline(profileId, currentWs);
      if (!stillCurrent()) return;
      const signature = telegramAuthSignature(bundle);
      if (!signature || signature === this.telegramSignatures.get(profileId)) return;
      if (await this.pushSession(profileId, currentWs, bundle, stillCurrent) !== "stored") return;
      if (!stillCurrent()) return;
      this.log(`${profileId}: checkpointed new Telegram Web ${bundleTelegramClient(bundle)?.toUpperCase() ?? "A/K"} login`);
    } catch (error) {
      if (error instanceof HubOwnershipLostError && stillCurrent()) {
        this.markAdvisory(
          profileId,
          undefined,
          `session writer ownership was lost (${msg(error)}); continuing in advisory mode`,
        );
        this.stopHeartbeat(profileId);
        return;
      }
      if (error instanceof SessionReadBusyError) return;
      if (stillCurrent()) throw error;
    }
  }

  /** " — cdp: <diagnosis>" suffix for a CDP-connect failure log (is the browser alive / port answering /
   *  ws stale?), so a connectOverCDP timeout is actionable. Empty if the launcher can't diagnose. */
  private async cdpDiag(profileId: string): Promise<string> {
    if (!this.d.launcher.diagnoseCdp) return "";
    try {
      const diagnosis = await this.d.launcher.diagnoseCdp(profileId);
      // Preflight can fail before spawn by design. "No launch record" is not a
      // CDP failure and appending it only obscures the actionable root error.
      return diagnosis === "no launch record" ? "" : ` — cdp: ${diagnosis}`;
    } catch {
      return "";
    }
  }

  private async cdpDiagWithin(profileId: string): Promise<string> {
    const observed = await settleWithin(this.cdpDiag(profileId), this.retainedCleanupAttemptMs);
    return observed.settled && observed.ok ? observed.value : "";
  }

  /** Roster for the dashboard — straight from the hub (with lock + session status). Also heals stale
   *  self-locks: a lock I hold for a profile I'm NOT running locally (an ungraceful exit left it) is
   *  released so it stops showing as "in use by me". */
  async listRoster(): Promise<RemoteRoster> {
    const roster = this.d.hub.getRosterSnapshot
      ? await this.d.hub.getRosterSnapshot()
      : { profiles: await this.d.hub.getRoster(), healthSources: [] };
    for (const p of roster.profiles) {
      const staleSelfLock =
        p.lockedBy === this.d.hub.owner &&
        !this.d.store.getLaunch(p.id) &&
        !this.opening.has(p.id) &&
        !this.closingTransitions.has(p.id) &&
        !this.transitions.has(p.id) &&
        !this.closing.has(p.id) &&
        !this.retainedCleanups.has(p.id) &&
        !this.timers.has(p.id);
      if (staleSelfLock) {
        await this.d.hub.release(p.id).catch(() => {});
        p.lockedBy = null;
      }
    }
    return roster;
  }

  async listProfiles(): Promise<RemoteProfile[]> {
    return (await this.listRoster()).profiles;
  }

  publishAutomationHealthSnapshot(profiles: AutomationHealthEntry[]): Promise<HealthSnapshotCounts> {
    if (!this.d.hub.publishAutomationHealthSnapshot) {
      throw new Error("connected hub client does not support health snapshots");
    }
    return this.d.hub.publishAutomationHealthSnapshot(profiles);
  }

  /** Import + group-move + create are central edits — go straight to the hub. */
  importToHub(files: { name: string; bytes: Uint8Array }[], overrides: ImportOverrides = {}): Promise<{ files: number; profiles: number }> {
    return this.d.hub.importFiles(files, overrides);
  }
  move(ids: string[], group: string): Promise<number> {
    return this.d.hub.move(ids, group);
  }
  createProfile(input: NewProfileInput): Promise<{ id: string }> {
    return this.d.hub.createProfile(input);
  }
  renameProfile(id: string, name: string): Promise<void> {
    return this.d.hub.renameProfile(id, name);
  }
  /** Single profile's full detail from the hub (the Edit modal); and saving the edited result back. */
  getProfile(id: string): Promise<Profile> {
    return this.d.hub.getProfile(id);
  }
  saveProfile(profile: Profile): Promise<void> {
    return this.d.hub.saveProfile(profile);
  }
  /** Full profiles for export — the local store is only a launch cache, so each
   *  selected account is pulled from the hub. Bounded fan-out keeps a big
   *  multi-select from opening hundreds of hub connections at once. `withCookies`
   *  (the .txt export, which serializes cookies) overlays the hub's latest roamed
   *  session — the roster profile still carries the stale import-time cookies, so
   *  exporting it verbatim after any roaming would ship an out-of-date login. */
  async getProfiles(ids: string[], withCookies = false): Promise<Profile[]> {
    const out: Profile[] = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = await Promise.all(
        ids.slice(i, i + 8).map(async (id) => {
          const profile = await this.d.hub.getProfile(id);
          if (withCookies) {
            const session = await this.d.hub.getSession(id).catch(() => null);
            const cookies = session && parseBundleCookies(session.bundle);
            if (cookies) profile.cookies = cookies; // no session yet → keep the import cookies
          }
          return profile;
        }),
      );
      out.push(...batch);
    }
    return out;
  }
  deleteProfiles(ids: string[]): Promise<{ deleted: number; locked: string[] }> {
    return this.d.hub.deleteProfiles(ids);
  }

  /**
   * Protect a retained browser after stop() returned false. The lease-renewal
   * cadence is independent from the stop promise, so even a timed-out attempt
   * cannot let the hub lock lapse; the same promise remains single-flight until
   * it actually settles, preventing overlapping cleanup calls.
   */
  private startRetainedCleanup(
    profileId: string,
    ownsLock: boolean,
    releaseBarrier: Promise<void> | null = null,
    stopAttempt: Promise<boolean> | null = null,
  ): void {
    const existing = this.retainedCleanups.get(profileId);
    if (existing) {
      existing.ownsLock ||= ownsLock;
      if (releaseBarrier && existing.releaseBarrier !== releaseBarrier) {
        existing.releaseBarrier = combineBarriers(existing.releaseBarrier, releaseBarrier);
        existing.barrierSettled = false;
        this.observeRetainedCleanupBarrier(profileId, existing.generation, existing.releaseBarrier!);
      }
      return;
    }
    const generation = (this.retainedCleanupGeneration.get(profileId) ?? 0) + 1;
    this.retainedCleanupGeneration.set(profileId, generation);
    const cadence = Math.min(this.retainedCleanupRetryMs, this.retainedCleanupRenewMs);
    const set = this.d.setIntervalFn ?? setInterval;
    const now = this.nowMs();
    const state: RetainedCleanup = {
      generation,
      ownsLock,
      timer: null,
      stopInFlight: stopAttempt,
      renewInFlight: false,
      lastStopAt: stopAttempt ? now : now - this.retainedCleanupRetryMs,
      lastRenewAt: now - this.retainedCleanupRenewMs,
      releaseBarrier,
      barrierSettled: !releaseBarrier,
      teardownConfirmed: false,
      releaseInFlight: false,
      lockReleased: false,
    };
    state.timer = set(() => { void this.tickRetainedCleanup(profileId, generation); }, cadence);
    if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    this.retainedCleanups.set(profileId, state);
    if (releaseBarrier) this.observeRetainedCleanupBarrier(profileId, generation, releaseBarrier);
    if (stopAttempt) {
      void stopAttempt.then(
        (stopped) => this.settleRetainedCleanupAttempt(profileId, generation, stopAttempt, stopped),
        () => this.settleRetainedCleanupAttempt(profileId, generation, stopAttempt, false),
      );
    }
    void this.tickRetainedCleanup(profileId, generation);
  }

  private observeRetainedCleanupBarrier(profileId: string, generation: number, barrier: Promise<void>): void {
    void barrier.then(
      () => this.settleRetainedCleanupBarrier(profileId, generation, barrier),
      () => this.settleRetainedCleanupBarrier(profileId, generation, barrier),
    );
  }

  private settleRetainedCleanupBarrier(profileId: string, generation: number, barrier: Promise<void>): void {
    const state = this.retainedCleanupState(profileId, generation);
    if (!state || state.releaseBarrier !== barrier) return;
    state.barrierSettled = true;
    if (state.teardownConfirmed) this.finishRetainedCleanup(profileId, generation);
  }

  private retainedCleanupState(profileId: string, generation: number): RetainedCleanup | null {
    const state = this.retainedCleanups.get(profileId);
    return state?.generation === generation ? state : null;
  }

  private async tickRetainedCleanup(profileId: string, generation: number): Promise<void> {
    const state = this.retainedCleanupState(profileId, generation);
    if (!state) return;
    const now = this.nowMs();

    if (state.teardownConfirmed && state.barrierSettled) {
      this.finishRetainedCleanup(profileId, generation);
      return;
    }

    if (state.ownsLock && !state.releaseInFlight && !state.lockReleased
      && !state.renewInFlight && now - state.lastRenewAt >= this.retainedCleanupRenewMs) {
      state.lastRenewAt = now;
      state.renewInFlight = true;
      void (async () => {
        try {
          const held = await this.d.hub.renew(profileId);
          const current = this.retainedCleanupState(profileId, generation);
          if (!current || current.releaseInFlight || current.lockReleased) return;
          if (held) {
            this.lastLeaseConfirmedAt.set(profileId, this.nowMs());
          } else {
            // A failed renew is explicit ownership loss. Cleanup remains
            // stop-only from here: never reclaim or release a lock that may now
            // belong to another operator.
            current.ownsLock = false;
            this.log(`${profileId}: ownership was lost during retained cleanup; continuing stop-only`);
          }
        } catch (e) {
          this.log(`${profileId}: retained-cleanup lock renew failed (${msg(e)})`);
          const current = this.retainedCleanupState(profileId, generation);
          const confirmedAt = this.lastLeaseConfirmedAt.get(profileId);
          if (current?.ownsLock && confirmedAt !== undefined && this.nowMs() - confirmedAt >= this.leaseMs) {
            current.ownsLock = false;
            this.log(`${profileId}: retained-cleanup ownership can no longer be confirmed; continuing stop-only`);
          }
        } finally {
          const current = this.retainedCleanupState(profileId, generation);
          if (current) {
            current.renewInFlight = false;
            if (current.teardownConfirmed && current.barrierSettled) {
              this.finishRetainedCleanup(profileId, generation);
            }
          }
        }
      })();
    }

    if (state.teardownConfirmed) {
      if (state.barrierSettled) this.finishRetainedCleanup(profileId, generation);
      return;
    }
    if (state.stopInFlight || now - state.lastStopAt < this.retainedCleanupRetryMs) return;
    state.lastStopAt = now;
    const attempt = Promise.resolve().then(() => this.d.launcher.stop(profileId));
    state.stopInFlight = attempt;
    const observed = await settleWithin(attempt, this.retainedCleanupAttemptMs);
    const current = this.retainedCleanupState(profileId, generation);
    if (!current || current.stopInFlight !== attempt) return;
    if (!observed.settled) {
      this.log(`${profileId}: retained cleanup attempt exceeded ${this.retainedCleanupAttemptMs}ms; keeping it single-flight while lease renewal continues`);
      void attempt.then(
        (stopped) => this.settleRetainedCleanupAttempt(profileId, generation, attempt, stopped),
        () => this.settleRetainedCleanupAttempt(profileId, generation, attempt, false),
      );
      return;
    }
    this.settleRetainedCleanupAttempt(
      profileId,
      generation,
      attempt,
      observed.ok && observed.value,
    );
  }

  private settleRetainedCleanupAttempt(
    profileId: string,
    generation: number,
    attempt: Promise<boolean>,
    stopped: boolean,
  ): void {
    const state = this.retainedCleanupState(profileId, generation);
    if (!state || state.stopInFlight !== attempt) return;
    state.stopInFlight = null;
    if (!stopped) return;

    state.teardownConfirmed = true;
    if (state.barrierSettled) this.finishRetainedCleanup(profileId, generation);
  }

  private finishRetainedCleanup(profileId: string, generation: number): void {
    const state = this.retainedCleanupState(profileId, generation);
    if (!state || !state.teardownConfirmed || !state.barrierSettled) return;

    // Keep the cleanup entry (and therefore the open() guard) until release
    // itself settles. Otherwise an old owner-scoped release can race a new
    // same-owner claim and delete the fresh lease.
    if (state.ownsLock) {
      if (state.lockReleased) {
        this.completeRetainedCleanup(profileId, generation);
        return;
      }
      if (state.releaseInFlight || state.renewInFlight) return;
      state.releaseInFlight = true;
      void this.d.hub.release(profileId).then(
        () => {
          const current = this.retainedCleanupState(profileId, generation);
          if (!current) return;
          current.releaseInFlight = false;
          current.lockReleased = true;
          this.completeRetainedCleanup(profileId, generation);
        },
        (error) => {
          const current = this.retainedCleanupState(profileId, generation);
          if (!current) return;
          current.releaseInFlight = false;
          this.log(`${profileId}: retained-cleanup lock release failed (${msg(error)}); checking ownership`);
          this.verifyRetainedCleanupOwnership(profileId, generation);
        },
      );
      return;
    }

    this.completeRetainedCleanup(profileId, generation);
  }

  private verifyRetainedCleanupOwnership(profileId: string, generation: number): void {
    const state = this.retainedCleanupState(profileId, generation);
    if (!state || state.renewInFlight) return;
    state.renewInFlight = true;
    void this.d.hub.renew(profileId).then(
      (held) => {
        const current = this.retainedCleanupState(profileId, generation);
        if (!current) return;
        current.renewInFlight = false;
        if (held) {
          this.lastLeaseConfirmedAt.set(profileId, this.nowMs());
          this.log(`${profileId}: retained-cleanup writer lease still held; retrying release`);
          return;
        }
        current.ownsLock = false;
        this.log(`${profileId}: retained-cleanup writer ownership was already lost; cleanup complete`);
        this.completeRetainedCleanup(profileId, generation);
      },
      (error) => {
        const current = this.retainedCleanupState(profileId, generation);
        if (current) current.renewInFlight = false;
        this.log(`${profileId}: retained-cleanup ownership check failed (${msg(error)}); retrying`);
      },
    );
  }

  private completeRetainedCleanup(profileId: string, generation: number): void {
    const state = this.retainedCleanupState(profileId, generation);
    if (!state || !state.teardownConfirmed || !state.barrierSettled) return;

    const clear = this.d.clearIntervalFn ?? clearInterval;
    if (state.timer) clear(state.timer);
    this.retainedCleanups.delete(profileId);
    this.retainedCleanupGeneration.set(profileId, generation + 1);
    this.clearProfileState(profileId);
    this.log(`${profileId}: retained browser teardown confirmed${state.ownsLock ? "; released hub lock" : ""}`);
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

  async open(profileId: string, launchArgs: string[] = [], force = false): Promise<OpenResult> {
    if (this.shuttingDown) return { ok: false, error: "remote coordinator is shutting down" };
    const currentGeneration = this.lifecycleGenerations.get(profileId) ?? 0;
    const existing = this.opening.get(profileId);
    // Opens in the same transition generation coalesce. A close is a strict
    // generation boundary, so open -> close -> open queues a fresh launch even
    // while the first open promise is still mapped.
    if (existing?.generation === currentGeneration) return existing.promise;

    const generation = currentGeneration + 1;
    this.lifecycleGenerations.set(profileId, generation);
    const promise = this.withProfileTransition(profileId, () => this.doOpen(profileId, launchArgs, force));
    this.opening.set(profileId, { promise, generation });
    try {
      return await promise;
    } finally {
      if (this.opening.get(profileId)?.promise === promise) this.opening.delete(profileId);
    }
  }

  private async doOpen(profileId: string, launchArgs: string[], _force: boolean): Promise<OpenResult> {
    // A caller deadline cannot cancel Playwright itself. Do not re-inject or
    // reuse this live browser while an older capture still owns its CDP
    // client; keep the current heartbeat/lease intact and let the operator
    // retry after that raw read settles.
    if (this.sessionReadsInFlight.has(profileId)) {
      return {
        ok: false,
        error: "previous browser session capture is still running; reopen refused safely",
      };
    }

    // A stopped heartbeat timer still represents the lease held by the browser
    // we are reopening. If its background work drains successfully but this
    // reopen then fails before claim(), cleanup must keep renewing that prior
    // lease until the browser is confirmed stopped.
    const inheritedOwnedLease = this.timers.has(profileId);
    let priorBackground: Promise<void> | null = null;
    let priorBackgroundDrained = true;
    let lockedBy: string | undefined;
    let ownsWriterLease = false;
    let cleanupOwnsLock = inheritedOwnedLease;
    try {
      // Stop any heartbeat still running for this profile (e.g. a survivor reattached by reclaimSurvivors)
      // BEFORE we clear its stale guard, advance its CAS base, and re-inject. Otherwise a heartbeat tick
      // firing mid-reopen would read the still-stale live browser session and push it under the new base,
      // clobbering the fresher hub session this reopen is about to install. Re-armed at the end of doOpen.
      priorBackground = this.stopHeartbeat(profileId);
      if (priorBackground) {
        priorBackgroundDrained = false;
        const drained = await settleWithin(priorBackground, this.heartbeatDrainMs);
        if (!drained.settled || !drained.ok) {
          throw new Error(`previous background session sync did not drain within ${this.heartbeatDrainMs}ms; reopen refused safely`);
        }
        priorBackgroundDrained = true;
      }

      // An older heartbeat can commit to teardown/release just before the
      // generation is invalidated. Draining waits for that transition; now
      // re-check cleanup ownership and re-claim so it cannot release the lock
      // behind this new open.
      if (this.retainedCleanups.has(profileId)) {
        return { ok: false, error: "verified browser cleanup is still in progress" };
      }
      let claim: { ok: boolean; lockedBy?: string };
      try {
        claim = await this.d.hub.claim(profileId);
      } catch (error) {
        claim = { ok: false };
        this.log(`${profileId}: writer lease claim failed (${msg(error)}); trying advisory launch`);
      }
      lockedBy = claim.lockedBy;
      if (claim.ok) {
        ownsWriterLease = true;
        cleanupOwnsLock = true;
        this.advisoryLaunches.delete(profileId);
        this.lastLeaseConfirmedAt.set(profileId, this.nowMs());
      } else {
        cleanupOwnsLock = false;
        this.markAdvisory(
          profileId,
          lockedBy,
          lockedBy
            ? `writer lease is held by ${lockedBy}; continuing in advisory mode`
            : "writer lease could not be claimed; continuing in advisory mode",
        );
      }

      // Cache the full profile locally so the launcher has its launch data.
      const profile = await this.d.hub.getProfile(profileId);
      this.d.store.upsertProfile(profile);

      // Fetch the authoritative session BEFORE launching. A hub ERROR here must abort the open — it is
      // NOT "never roamed". The old code collapsed a transient hub failure into the first-migration
      // fallback and injected the profile's frozen import cookies over a live/rotated login, which is an
      // immediate logout. A clean null genuinely means "no session yet" (first migration).
      let session: SessionRecord | null;
      try {
        session = await this.d.hub.getSession(profileId);
      } catch (e) {
        throw new Error(`hub session fetch failed (${msg(e)}) — not injecting a possibly-stale session`);
      }
      const baseVersion = session?.version ?? 0;
      this.versions.set(profileId, baseVersion); // optimistic-concurrency base for later pushes
      this.staleReattached.delete(profileId); // a fresh open re-injects the authoritative session below

      // The session we're about to inject: the hub's latest, or the profile's original cookies on first
      // migration. Computed BEFORE launch so we can tell the launcher whether it's SAFE to reset this
      // profile's volatile storage on a crash — only when this bundle can actually restore the login
      // (otherwise a first-migration Telegram open would have its only local auth wiped before we inject).
      const bundle = session?.bundle ?? JSON.stringify({ cookies: profile.cookies });
      this.sessionCaptureSeeds.set(profileId, sessionCaptureSeed(bundle));
      const resetStorage = bundleHasRestorableLogin(bundle);
      const startingTelegramSignature = telegramAuthSignature(bundle);
      const telegramProfile = isTelegramPlatform(profile.platform) || bundleHasTelegramOrigin(bundle);
      if (telegramProfile) this.telegramProfiles.add(profileId);
      else this.telegramProfiles.delete(profileId);
      if (startingTelegramSignature) this.telegramSignatures.set(profileId, startingTelegramSignature);
      else this.telegramSignatures.delete(profileId);

      // launchArgs may contain a platform URL. Do not pass that URL to Chromium
      // yet, and suppress the launcher's own startup navigation: remote mode must
      // write the hub session before the first request hits the platform.
      const { chromeArgs, startupUrls } = splitLaunchUrls(launchArgs);
      const { ws, port } = await this.d.launcher.start(profileId, chromeArgs, {
        autoNavigate: false,
        restoreLastSession: false,
        resetStorage,
        // A manager crash after spawn but before the authoritative restore
        // leaves an unmistakably provisional survivor.
        sessionBaseVersion: PENDING_SESSION_BASE_VERSION,
      });
      // start() may reuse an existing browser and preserve its old launch row.
      // Move that row to the provisional lineage explicitly before restore.
      const provisionalLaunch = this.d.store.getLaunch(profileId);
      if (!provisionalLaunch) throw new Error("launcher returned without a durable launch record");
      this.d.store.recordLaunch({ ...provisionalLaunch, ws, sessionBaseVersion: PENDING_SESSION_BASE_VERSION });

      // Fail closed only on restore failure. Losing the writer lease changes this
      // browser to advisory mode, but no longer blocks or tears down the launch.
      if (ownsWriterLease) ownsWriterLease = await this.confirmWriterOwnership(profileId, "before session restore");
      await this.d.writeSession(ws, bundle, { authoritative: true });
      if (ownsWriterLease) ownsWriterLease = await this.confirmWriterOwnership(profileId, "after session restore");
      // Now that the session is in place, replace stale normal pages with the
      // bundle's saved tabs followed by explicit caller URLs.
      const home = platformHomeUrl(profile.platform, bundleTelegramClient(bundle) ?? "a");
      const savedTabs = bundleTabUrls(bundle);
      const urlsToOpen = savedTabs.length > 0 || startupUrls.length > 0
        ? [...savedTabs, ...startupUrls]
        : home
          ? [home]
          : [];
      await this.d.launcher.navigate(ws, urlsToOpen, true).catch(async (e) => this.log(`navigate failed for ${profileId}: ${msg(e)}${await this.cdpDiagWithin(profileId)}`));
      if (ownsWriterLease) ownsWriterLease = await this.confirmWriterOwnership(profileId, "after startup navigation");
      // Mark ready only after restore and every ownership boundary has passed.
      this.d.store.updateLaunchSessionBaseVersion(profileId, baseVersion);

      if (ownsWriterLease) this.startHeartbeat(profileId, ws);
      return {
        ok: true,
        ws,
        port,
        lockedBy,
        warning: this.advisoryLaunches.get(profileId),
      };
    } catch (e) {
      cleanupOwnsLock &&= this.lastLeaseConfirmedAt.has(profileId);
      if (this.retainedCleanups.has(profileId)) {
        const barrier = combineBarriers(
          priorBackgroundDrained ? null : priorBackground,
          this.stopHeartbeat(profileId),
        );
        this.startRetainedCleanup(profileId, cleanupOwnsLock, barrier);
        return { ok: false, error: `session open failed: ${msg(e)}` };
      }
      const newlyStoppedBackground = this.stopHeartbeat(profileId);
      const cleanupBarrier = combineBarriers(
        priorBackgroundDrained ? null : priorBackground,
        newlyStoppedBackground,
      );
      // A process can exist in the small window before its launch row is
      // durable. Missing metadata is not proof of process death.
      const stopAttempt = Promise.resolve().then(() => this.d.launcher.stop(profileId));
      const observedStop = await settleWithin(stopAttempt, this.retainedCleanupAttemptMs);
      const stopped = observedStop.settled && observedStop.ok && observedStop.value;

      if (cleanupBarrier || !stopped) {
        // start() can intentionally fail while retaining a live/unknown local
        // browser. Keep the hub lock and retry only after any older session
        // upload has drained; releasing here could allow a dual-use profile.
        this.log(`${profileId}: session open failed with cleanup still pending — retaining ownership until confirmed stop`);
        this.startRetainedCleanup(profileId, cleanupOwnsLock, cleanupBarrier, stopAttempt);
      } else {
        this.versions.delete(profileId);
        this.staleReattached.delete(profileId);
        this.advisoryLaunches.delete(profileId);
        this.telegramSignatures.delete(profileId);
        this.telegramProfiles.delete(profileId);
        if (cleanupOwnsLock) {
          try {
            await this.d.hub.release(profileId);
            this.lastLeaseConfirmedAt.delete(profileId);
          } catch (error) {
            // Teardown is confirmed, but shutdown/open accounting must remain
            // unconfirmed until the owner-scoped unlock actually succeeds.
            this.log(`${profileId}: browser stopped after failed open but hub release failed (${msg(error)}); retrying under cleanup guard`);
            this.startRetainedCleanup(profileId, true, null, stopAttempt);
          }
        }
      }
      return { ok: false, error: `session open failed: ${msg(e)}${await this.cdpDiagWithin(profileId)}` };
    }
  }

  /** Re-check writer ownership without ever reclaiming from a newer process.
   *  Any loss or transport ambiguity downgrades the browser to advisory mode. */
  private async confirmWriterOwnership(profileId: string, phase: string): Promise<boolean> {
    if (this.advisoryLaunches.has(profileId)) return false;

    let held: boolean;
    try {
      held = await this.d.hub.renew(profileId);
    } catch (error) {
      this.markAdvisory(
        profileId,
        undefined,
        `writer ownership check failed ${phase} (${msg(error)}); continuing in advisory mode`,
      );
      return false;
    }
    if (held) {
      this.lastLeaseConfirmedAt.set(profileId, this.nowMs());
      return true;
    }

    this.markAdvisory(
      profileId,
      undefined,
      `writer lease was lost ${phase}; continuing in advisory mode`,
    );
    return false;
  }

  private clearProfileState(profileId: string): void {
    this.versions.delete(profileId);
    this.staleReattached.delete(profileId);
    this.advisoryLaunches.delete(profileId);
    this.telegramSignatures.delete(profileId);
    this.telegramProfiles.delete(profileId);
    this.lastLeaseConfirmedAt.delete(profileId);
    // This is called only after browser teardown has been confirmed. A raw
    // reader that ignored its deadline can no longer produce useful state, and
    // must not block a later browser generation forever.
    this.sessionReadsInFlight.delete(profileId);
  }

  async close(profileId: string): Promise<boolean> {
    const currentGeneration = this.lifecycleGenerations.get(profileId) ?? 0;
    const existing = this.closingTransitions.get(profileId);
    // Coalesce only closes in the same lifecycle generation. If an open was
    // admitted behind the mapped close, a later close must queue after that
    // reopen rather than returning the older close's promise.
    if (existing?.generation === currentGeneration) return existing.promise;

    const generation = currentGeneration + 1;
    this.lifecycleGenerations.set(profileId, generation);
    const promise = this.withProfileTransition(profileId, () => this.doClose(profileId));
    this.closingTransitions.set(profileId, { promise, generation });
    try {
      return await promise;
    } finally {
      if (this.closingTransitions.get(profileId)?.promise === promise) this.closingTransitions.delete(profileId);
    }
  }

  private async doClose(profileId: string): Promise<boolean> {
    if (this.retainedCleanups.has(profileId)) return false;

    this.closing.add(profileId);
    try {
      const priorHeartbeat = this.stopHeartbeat(profileId);
      if (priorHeartbeat) {
        const drained = await settleWithin(priorHeartbeat, this.heartbeatDrainMs);
        if (!drained.settled || !drained.ok) {
          this.log(`${profileId}: close could not drain prior heartbeat; retaining browser and lock`);
          this.startRetainedCleanup(profileId, this.lastLeaseConfirmedAt.has(profileId), priorHeartbeat);
          return false;
        }
      }
      if (this.retainedCleanups.has(profileId)) return false;
      const launch = this.d.store.getLaunch(profileId);
      if (this.advisoryLaunches.has(profileId)) {
        const stopped = await this.d.launcher.stop(profileId).catch(() => false);
        if (!stopped) {
          this.log(`${profileId}: advisory browser teardown unconfirmed — retrying local stop only`);
          this.startRetainedCleanup(profileId, false);
          return false;
        }
        this.clearProfileState(profileId);
        return true;
      }
      if (launch) {
        let held: boolean;
        try {
          held = await this.d.hub.renew(profileId);
        } catch (error) {
          this.markAdvisory(
            profileId,
            undefined,
            `writer ownership could not be confirmed while closing (${msg(error)}); stopping locally`,
          );
          return await this.stopCloseWithoutOwnership(
            profileId,
            launch.ws,
            `hub ownership could not be confirmed while closing (${msg(error)})`,
          );
        }
        if (!held) {
          this.markAdvisory(profileId, undefined, "writer lease was lost while closing; stopping locally");
          return await this.stopCloseWithoutOwnership(
            profileId,
            launch.ws,
            "writer lease was lost while closing",
          );
        }
        this.lastLeaseConfirmedAt.set(profileId, this.nowMs());
        try {
          // A declined result is a deliberate no-write: the hub kept a better login, optimistic
          // concurrency found a fresher bundle, or this reattached browser has no safe write base.
          // Those outcomes already preserve the durable source of truth and must not trap the profile
          // open forever. Only a thrown CDP read / hub transport error keeps the live browser around.
          await this.pushSession(profileId, launch.ws);
        } catch (e) {
          if (e instanceof HubOwnershipLostError) {
            this.markAdvisory(
              profileId,
              undefined,
              `session writer ownership was lost while closing (${msg(e)}); stopping locally`,
            );
            return await this.stopCloseWithoutOwnership(
              profileId,
              launch.ws,
              `session writer ownership was lost while closing (${msg(e)})`,
            );
          }
          // Do not destroy the only fresh copy. Re-arm background ownership/sync and surface the failure;
          // the dashboard/API can retry Close after the hub/CDP path recovers.
          this.startHeartbeat(profileId, launch.ws);
          const detail = `session save failed for ${profileId}: ${msg(e)} — browser left open so the login is not lost`;
          this.log(detail);
          throw new Error(detail);
        }
      }
      const stopped = await this.d.launcher.stop(profileId);
      if (!stopped) {
        // Preserve versions/stale state and, critically, the hub lock. The stop
        // HTTP response becomes code -1 so the caller can retry cleanup. A lock
        // release beside an unconfirmed local browser would permit dual-use.
        this.log(`${profileId}: browser teardown unconfirmed — retaining hub lock`);
        this.startRetainedCleanup(profileId, this.lastLeaseConfirmedAt.has(profileId));
        return false;
      }
      if (launch) {
        try {
          await this.d.hub.release(profileId);
        } catch (error) {
          this.log(`${profileId}: browser stopped but hub release failed (${msg(error)}); retaining cleanup guard for retry`);
          this.startRetainedCleanup(profileId, true);
          return false;
        }
      }
      this.clearProfileState(profileId);
      return true;
    } finally {
      this.closing.delete(profileId);
    }
  }

  /** Ownership is absent or no longer provable. Stop locally, never checkpoint,
   *  reclaim, renew, or release a lock that may belong to somebody else. */
  private async stopCloseWithoutOwnership(profileId: string, ws: string, reason: string): Promise<boolean> {
    this.log(`${profileId}: ${reason} — stopping without session push or hub release`);
    this.lastLeaseConfirmedAt.delete(profileId);
    this.staleReattached.add(profileId);
    const stopped = await this.d.launcher.stop(profileId).catch(() => false);
    if (stopped) this.clearProfileState(profileId);
    else this.startRetainedCleanup(profileId, false);
    return stopped;
  }

  /**
   * One heartbeat:
   *   1. Liveness via launcher.active() — the validated /json/version probe (a
   *      plain fetch, immune to the Bun CDP ws-upgrade hiccup that a full session
   *      read can hit). If the browser is gone, stop polling and FREE the lock.
   *   2. renew() — any failure downgrades this browser to advisory mode. It does
   *      not reclaim automatically, because another process with the same owner
   *      identity may hold a newer fence.
   *   3. push the current session (best-effort) only while writer-owned.
   */
  async heartbeatOnce(profileId: string, ws: string): Promise<void> {
    const generation = this.heartbeatGenerations.get(profileId) ?? 0;
    return this.beginHeartbeatTick(profileId, ws, generation);
  }

  private beginHeartbeatTick(profileId: string, ws: string, generation: number): Promise<void> {
    if ((this.heartbeatGenerations.get(profileId) ?? 0) !== generation) return Promise.resolve();
    const previous = this.heartbeatTicksInFlight.get(profileId);
    if (previous?.generation === generation) return previous.promise;
    const token = Symbol(profileId);
    const stillCurrent = () => (this.heartbeatGenerations.get(profileId) ?? 0) === generation;
    const promise = this.heartbeatOnceGuarded(profileId, ws, stillCurrent, token)
      .finally(() => {
        if (this.heartbeatTicksInFlight.get(profileId)?.token === token) {
          this.heartbeatTicksInFlight.delete(profileId);
        }
      });
    this.heartbeatTicksInFlight.set(profileId, { token, generation, promise });
    return promise;
  }

  private async heartbeatOnceGuarded(
    profileId: string,
    ws: string,
    stillCurrent: () => boolean,
    currentToken?: symbol,
  ): Promise<void> {
    if (!stillCurrent() || this.closing.has(profileId) || this.advisoryLaunches.has(profileId)) return;
    // A timer firing is not ownership proof. If successful claims/renews have
    // failed for a whole lease, stop even when the event loop kept ticking.
    const now = this.nowMs();
    const confirmedAt = this.lastLeaseConfirmedAt.get(profileId);
    if (confirmedAt !== undefined && now - confirmedAt >= this.leaseMs) {
      this.downgradeHeartbeat(
        profileId,
        undefined,
        `no confirmed writer ownership for ${Math.round((now - confirmedAt) / 1000)}s; continuing in advisory mode`,
        currentToken,
      );
      return;
    }
    const active = await this.d.launcher.active(profileId).catch(() => true);
    if (!stillCurrent()) return;
    if (!active) {
      const launch = this.d.store.getLaunch(profileId);
      let dead = !launch;
      if (launch && this.d.launcher.reconcileOrphan) {
        try {
          const reconciled = await this.d.launcher.reconcileOrphan(profileId, {
            debugPort: launch.debugPort,
            startedAt: launch.startedAt,
          });
          if (!stillCurrent()) return;
          dead = reconciled === "dead" && !this.d.store.getLaunch(profileId);
        } catch {
          dead = false;
        }
      } else if (launch) {
        this.downgradeHeartbeat(
          profileId,
          undefined,
          "browser liveness could not be reconciled; continuing in advisory mode",
          currentToken,
        );
        return;
      }
      if (dead) {
        this.log(`${profileId}: browser is gone — releasing the lock`);
        await this.stopAfterHeartbeat(profileId, true, currentToken);
        return;
      }
    }
    const currentWs = this.d.store.getLaunch(profileId)?.ws ?? ws;
    let held: boolean;
    try {
      held = await this.d.hub.renew(profileId);
    } catch (e) {
      if (!stillCurrent()) return;
      this.downgradeHeartbeat(
        profileId,
        undefined,
        `writer renew failed (${msg(e)}); continuing in advisory mode`,
        currentToken,
      );
      return;
    }
    if (!stillCurrent() || this.closing.has(profileId)) return;
    if (!held) {
      this.downgradeHeartbeat(
        profileId,
        undefined,
        "writer lease was lost; continuing in advisory mode",
        currentToken,
      );
      return;
    }
    this.lastLeaseConfirmedAt.set(profileId, this.nowMs());
    try {
      await this.pushSession(profileId, currentWs, undefined, stillCurrent);
    } catch (error) {
      if (error instanceof HubOwnershipLostError && stillCurrent()) {
        this.downgradeHeartbeat(
          profileId,
          undefined,
          `session writer ownership was lost (${msg(error)}); continuing in advisory mode`,
          currentToken,
        );
      }
      // Other mid-session capture failures are best-effort; the next heartbeat retries.
    }
  }

  /**
   * Clean shutdown: for every profile we hold open, save its session and stop
   * the browser before releasing the lock — never release while the browser is
   * still running locally (that would let another operator claim a live account
   * and lose the final cookie changes).
   */
  async releaseAll(): Promise<boolean> {
    if (this.releaseAllInFlight) return this.releaseAllInFlight;
    this.shuttingDown = true;
    const current = (async () => {
      const ids = new Set<string>([
        ...this.opening.keys(),
        ...this.closingTransitions.keys(),
        ...this.timers.keys(),
        ...this.transitions.keys(),
        ...this.retainedCleanups.keys(),
        ...this.d.store.listLaunches().map((launch) => launch.profileId),
      ]);
      const failures: string[] = [];
      for (const id of ids) {
        try {
          if (!await this.close(id)) failures.push(`${id}: browser teardown or hub unlock remains unconfirmed`);
        } catch (error) {
          failures.push(`${id}: ${msg(error)}`);
        }
      }
      if (this.retainedCleanups.size > 0 || this.d.store.listLaunches().length > 0) {
        failures.push("remote launches remain after shutdown cleanup");
      }
      if (failures.length > 0) {
        throw new Error(`failed to close remote profiles during shutdown: ${failures.join("; ")}`);
      }
      return true;
    })();
    this.releaseAllInFlight = current;
    try {
      return await current;
    } catch (error) {
      // Cleanup state continues in the background. A later signal/CLI retry
      // must run a fresh pass instead of receiving a permanently rejected cache.
      if (this.releaseAllInFlight === current) this.releaseAllInFlight = null;
      throw error;
    }
  }

  /**
   * After a restart, reconcileOrphans() keeps launch rows for browsers still
   * alive — but their hub lease is unrenewed and will expire, letting another
   * operator open the same account. Re-claim + heartbeat each survivor; if it was
   * already claimed elsewhere during the dark window, stop the local browser.
   */
  async reclaimSurvivors(): Promise<void> {
    for (const originalLaunch of this.d.store.listLaunches()) {
      let launch = originalLaunch;
      // Identity/CDP reattachment may refresh the launch row (and the legacy
      // adapter path calls start()). It must never rewrite the persisted hub
      // lineage that this already-running browser was actually restored from.
      const persistedBaseVersion = originalLaunch.sessionBaseVersion;
      if (isTelegramPlatform(this.d.store.getProfile(launch.profileId)?.platform)) this.telegramProfiles.add(launch.profileId);
      else this.telegramProfiles.delete(launch.profileId);

      if (launch.sessionBaseVersion === PENDING_SESSION_BASE_VERSION) {
        await this.stopSurvivor(
          launch.profileId,
          "authoritative session restore was incomplete — stopping provisional browser before reclaim",
          false,
          true,
        );
        continue;
      }

      let claim: { ok: boolean; lockedBy?: string };
      try {
        claim = await this.d.hub.claim(launch.profileId);
      } catch (e) {
        claim = { ok: false };
        this.log(`${launch.profileId}: survivor writer claim failed (${msg(e)}); verifying for advisory reuse`);
      }
      if (claim.ok) {
        this.lastLeaseConfirmedAt.set(launch.profileId, this.nowMs());
        let currentWs: string;
        try {
          if (this.d.launcher.verifyRunningIdentity) {
            await this.d.launcher.verifyRunningIdentity(launch.profileId);
            currentWs = this.d.store.getLaunch(launch.profileId)?.ws ?? "";
          } else {
            // Small test/adapter launchers predate the explicit certification
            // contract. Their idempotent start remains the compatibility path.
            if (!await this.d.launcher.active(launch.profileId)) throw new Error("browser identity/CDP is unavailable");
            currentWs = (await this.d.launcher.start(launch.profileId, [], {
              autoNavigate: false,
              restoreLastSession: false,
            })).ws;
          }
          if (!await this.confirmWriterOwnership(launch.profileId, "after survivor identity verification")) {
            continue;
          }
        } catch (error) {
          const ownershipConfirmed = this.lastLeaseConfirmedAt.has(launch.profileId);
          await this.stopSurvivor(
            launch.profileId,
            `browser/proxy/ownership verification failed (${msg(error)}) — stopping before exposure`,
            ownershipConfirmed,
            ownershipConfirmed,
          );
          continue;
        }
        // Verification may refresh a stale websocket generation. Re-read the
        // durable row rather than resuming from the startup snapshot.
        const refreshedLaunch = this.d.store.getLaunch(launch.profileId);
        if (!refreshedLaunch?.ws) {
          await this.stopSurvivor(
            launch.profileId,
            "verified launch row is missing a CDP websocket — stopping before exposure",
            true,
            true,
          );
          continue;
        }
        launch = refreshedLaunch;
        currentWs = refreshedLaunch.ws;
        // open() never ran for a reattached survivor, so restore the optimistic-concurrency base before
        // heartbeats can fire. The base must be the version this browser was opened from or last pushed,
        // persisted in the launch row. `updatedBy` alone is not staleness: this browser may legitimately
        // have opened from a bundle another operator authored earlier.
        const baseVersion = persistedBaseVersion;
        let currentVersion: number | undefined;
        let currentBundle: string | undefined;
        let staleReason: string | undefined;
        try {
          const s = await this.d.hub.getSession(launch.profileId);
          currentVersion = s?.version ?? 0;
          currentBundle = s?.bundle;
          if (!await this.confirmWriterOwnership(launch.profileId, "after survivor lineage verification")) {
            continue;
          }
        } catch (e) {
          const ownershipConfirmed = this.lastLeaseConfirmedAt.has(launch.profileId);
          await this.stopSurvivor(
            launch.profileId,
            `couldn't confirm hub session lineage (${msg(e)}) — stopping before exposure`,
            ownershipConfirmed,
            ownershipConfirmed,
          );
          continue;
        }

        this.staleReattached.delete(launch.profileId);
        if (currentVersion === undefined) {
          this.versions.delete(launch.profileId);
        } else if (baseVersion === undefined) {
          if (currentVersion === 0) {
            this.versions.set(launch.profileId, 0);
            this.d.store.updateLaunchSessionBaseVersion(launch.profileId, 0);
          } else {
            this.versions.delete(launch.profileId);
            staleReason = `no persisted session base and hub is at v${currentVersion}`;
          }
        } else {
          this.versions.set(launch.profileId, baseVersion);
          if (currentVersion > baseVersion) {
            staleReason = `hub advanced from v${baseVersion} to v${currentVersion}`;
          } else if (currentVersion < baseVersion) {
            staleReason = `hub version regressed from launch base v${baseVersion} to v${currentVersion}`;
          }
        }

        if (staleReason) {
          // A browser whose durable session lineage differs from the hub is not
          // merely read-only: it is still a usable authenticated account and
          // can invalidate or perturb the newer session. Stop it and release
          // the claim; the next explicit Open restores the authoritative hub
          // bundle into a fresh generation.
          await this.stopSurvivor(
            launch.profileId,
            `${staleReason} — stopping stale authenticated survivor before exposure`,
            true,
            true,
          );
          continue;
        } else {
          this.sessionCaptureSeeds.set(
            launch.profileId,
            currentBundle ? sessionCaptureSeed(currentBundle) : { origins: [] },
          );
          const signature = currentBundle ? telegramAuthSignature(currentBundle) : null;
          if (currentBundle && bundleHasTelegramOrigin(currentBundle)) this.telegramProfiles.add(launch.profileId);
          if (signature) this.telegramSignatures.set(launch.profileId, signature);
          else this.telegramSignatures.delete(launch.profileId);
          this.log(`reattached ${launch.profileId}: reclaimed the lock + resumed heartbeat (session base v${this.versions.get(launch.profileId) ?? 0})`);
        }
        this.startHeartbeat(launch.profileId, currentWs);
      } else {
        try {
          if (this.d.launcher.verifyRunningIdentity) {
            await this.d.launcher.verifyRunningIdentity(launch.profileId);
          } else {
            if (!await this.d.launcher.active(launch.profileId)) {
              throw new Error("browser identity/CDP is unavailable");
            }
            await this.d.launcher.start(launch.profileId, [], {
              autoNavigate: false,
              restoreLastSession: false,
            });
          }
          const refreshedLaunch = this.d.store.getLaunch(launch.profileId);
          if (!refreshedLaunch?.ws) throw new Error("verified launch row is missing a CDP websocket");
          this.versions.delete(launch.profileId);
          this.staleReattached.add(launch.profileId);
          this.markAdvisory(
            launch.profileId,
            claim.lockedBy,
            claim.lockedBy
              ? `surviving browser found another session writer (${claim.lockedBy}); continuing in advisory mode`
              : "survivor writer ownership could not be confirmed; continuing in advisory mode",
          );
        } catch (error) {
          await this.stopSurvivor(
            launch.profileId,
            `browser identity verification failed (${msg(error)}) — stopping local survivor`,
            false,
            false,
          );
        }
      }
    }
  }

  /** Startup adoption is fail-closed. A failed kill enters the existing
   *  stop-only retained-cleanup loop; it may renew only a claim we confirmed. */
  private async stopSurvivor(
    profileId: string,
    reason: string,
    ownsLock: boolean,
    releaseAfterConfirmedStop: boolean,
  ): Promise<boolean> {
    this.log(`reattach ${profileId}: ${reason}`);
    this.stopHeartbeat(profileId);
    this.staleReattached.add(profileId);
    const stopped = await this.d.launcher.stop(profileId).catch(() => false);
    if (!stopped) {
      this.startRetainedCleanup(profileId, ownsLock);
      return false;
    }
    if (releaseAfterConfirmedStop) {
      try {
        await this.d.hub.release(profileId);
      } catch (error) {
        if (ownsLock) {
          this.log(`reattach ${profileId}: hub release failed after stop (${msg(error)}); retrying`);
          this.startRetainedCleanup(profileId, true);
          return false;
        }
      }
    }
    this.clearProfileState(profileId);
    return true;
  }

  private startHeartbeat(profileId: string, ws: string): void {
    this.stopHeartbeat(profileId); // clear any existing timer first — never leak a duplicate
    const generation = this.heartbeatGenerations.get(profileId)!;
    if (this.telegramProfiles.has(profileId)) this.startSessionSync(profileId, ws, generation);
    const ms = this.d.heartbeatMs ?? 120_000;
    if (ms <= 0) {
      this.timers.set(profileId, null); // track ownership without a timer (tests)
      return;
    }
    const set = this.d.setIntervalFn ?? setInterval;
    this.timers.set(profileId, set(() => this.runHeartbeatTick(profileId, ws, generation), ms));
  }

  /**
   * Keep the interval single-flight per profile. A slow hub request or CDP
   * session capture must not let later ticks accumulate more Playwright
   * clients, promises, and serialized session bundles behind it.
   */
  private runHeartbeatTick(profileId: string, ws: string, generation: number): void {
    if (this.heartbeatGenerations.get(profileId) !== generation) return;
    const previous = this.heartbeatTicksInFlight.get(profileId);
    if (previous?.generation === generation) {
      this.log(`${profileId}: previous heartbeat still running — skipping overlapping tick`);
      return;
    }
    void this.beginHeartbeatTick(profileId, ws, generation)
      .catch((e) => this.log(`${profileId}: heartbeat failed (${msg(e)})`));
  }

  private async stopAfterHeartbeat(
    profileId: string,
    ownsLock: boolean,
    currentToken?: symbol,
  ): Promise<void> {
    this.backgroundStopping.add(profileId);
    try {
      const current = this.heartbeatTicksInFlight.get(profileId);
      const exclude = currentToken && current?.token === currentToken ? current.promise : null;
      const barrier = this.stopHeartbeat(profileId, exclude);
      const stopped = await this.d.launcher.stop(profileId).catch(() => false);

      if (!stopped || barrier) {
        if (ownsLock) this.log(`${profileId}: background cleanup still pending — retaining hub lock`);
        this.startRetainedCleanup(profileId, ownsLock, barrier);
        return;
      }
      if (ownsLock) {
        try {
          await this.d.hub.release(profileId);
        } catch (error) {
          this.log(`${profileId}: background browser stopped but hub release failed (${msg(error)}); retrying under cleanup guard`);
          this.startRetainedCleanup(profileId, true, barrier);
          return;
        }
      }
      this.clearProfileState(profileId);
    } finally {
      this.backgroundStopping.delete(profileId);
    }
  }

  private stopHeartbeat(profileId: string, exclude: Promise<void> | null = null): Promise<void> | null {
    const generation = this.heartbeatGenerations.get(profileId) ?? 0;
    const h = this.timers.get(profileId);
    if (h) (this.d.clearIntervalFn ?? clearInterval)(h);
    this.timers.delete(profileId);
    const sync = this.sessionSyncTimers.get(profileId);
    if (sync) (this.d.clearIntervalFn ?? clearInterval)(sync);
    this.sessionSyncTimers.delete(profileId);
    this.heartbeatGenerations.set(profileId, generation + 1);

    // Invalidate first so callbacks already queued by either interval cannot
    // begin new work. Then drain every old producer plus the serialized PUT
    // tail: a checkpoint can still be reading before it reaches pushSession.
    const waits: Promise<unknown>[] = [];
    const heartbeat = this.heartbeatTicksInFlight.get(profileId);
    // Include any still-tracked older generation too. A heartbeat can invalidate
    // itself before awaiting stop/release; a concurrent open/close must still
    // drain that transition (while the caller excludes its own promise).
    if (heartbeat && heartbeat.promise !== exclude) waits.push(heartbeat.promise);
    const checkpoint = this.sessionSyncsInFlight.get(profileId);
    if (checkpoint) waits.push(checkpoint.promise);
    const push = this.pushesInFlight.get(profileId);
    if (push) waits.push(push);
    return waits.length > 0
      ? Promise.allSettled(waits).then(() => {})
      : null;
  }

  private startSessionSync(profileId: string, ws: string, generation: number): void {
    const previous = this.sessionSyncTimers.get(profileId);
    if (previous) (this.d.clearIntervalFn ?? clearInterval)(previous);
    this.sessionSyncTimers.delete(profileId);
    if (this.sessionSyncMs <= 0) return;
    const set = this.d.setIntervalFn ?? setInterval;
    const timer = set(() => {
      void this.runSessionSyncTick(profileId, ws, generation).catch((e) => {
        // Transient reads are retried on the next 3-second tick. Keep this visible for field diagnosis,
        // but never tear down a healthy browser merely because one checkpoint failed.
        this.log(`${profileId}: Telegram auth checkpoint failed (${msg(e)})`);
      });
    }, this.sessionSyncMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    this.sessionSyncTimers.set(profileId, timer);
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<
  { settled: true; ok: true; value: T } | { settled: true; ok: false } | { settled: false }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), Math.max(1, timeoutMs));
  });
  const settled = promise.then(
    (value) => ({ settled: true as const, ok: true as const, value }),
    () => ({ settled: true as const, ok: false as const }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function combineBarriers(...barriers: Array<Promise<void> | null>): Promise<void> | null {
  const unique = [...new Set(barriers.filter((barrier): barrier is Promise<void> => !!barrier))];
  return unique.length > 0 ? Promise.allSettled(unique).then(() => {}) : null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Cookies from a roamed session bundle (`{cookies:[...]}`), or null if it has
 *  none / is unparseable — the caller then keeps the profile's import cookies. */
function parseBundleCookies(bundle: string): CookieRecord[] | null {
  try {
    const cookies = JSON.parse(bundle).cookies;
    return Array.isArray(cookies) ? cookies : null;
  } catch {
    return null;
  }
}

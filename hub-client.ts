/**
 * Client for a remote AliasMode hub, used by operator machines in remote mode.
 * Wraps the token-authenticated hub API. The hub derives lock ownership from
 * the operator-token row; `owner` is retained only as a legacy payload/UI hint.
 */

import type { Profile } from "./types.ts";
import type {
  HealthSource,
  SessionRecord,
  AutomationHealthEntry,
  AutomationHealthStatus,
} from "./remote-types.ts";
import type { NewProfileInput } from "./create.ts";
import type { ImportOverrides } from "./inbox.ts";

export interface RemoteProfile {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  proxy: string | null;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  /** Present on upgraded hubs; absent older hubs remain API-compatible. */
  mobilePersona?: boolean;
  lockedBy: string | null;
  hasSession: boolean;
  /** Absent when connected to an older hub. */
  healthStatus?: AutomationHealthStatus;
  /** Hub receipt time for Alive/Suspended evidence; null when there is no data. */
  healthObservedAt?: number | null;
}

export interface RemoteRoster {
  profiles: RemoteProfile[];
  /** Empty when connected to an older hub. */
  healthSources: HealthSource[];
}

export interface HealthSnapshotCounts {
  profiles: number;
  alive: number;
  suspended: number;
}

export type HubFetch = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_HUB_REQUEST_TIMEOUT_MS = 30_000;

export class HubOwnershipLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubOwnershipLostError";
  }
}

export class HubClient {
  private baseUrl: string;
  private readonly ownerHint: string;
  private authenticatedOwner?: string;
  private leaseFences = new Map<string, number>();
  private claimAttempts = new Map<string, number>();
  constructor(
    baseUrl: string,
    private password: string,
    owner: string,
    private fetchFn: HubFetch = (u, i) => fetch(u, i),
    private requestTimeoutMs: number = DEFAULT_HUB_REQUEST_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.ownerHint = owner;
    this.requestTimeoutMs = Math.max(1, requestTimeoutMs);
  }

  /** Token-derived server identity once learned; local label only as bootstrap. */
  get owner(): string {
    return this.authenticatedOwner ?? this.ownerHint;
  }

  private async readJson(res: Response, path: string): Promise<{ body: any; valid: boolean }> {
    const text = await res.text();
    if (!text.trim()) return { body: {}, valid: true };
    try {
      return { body: JSON.parse(text), valid: true };
    } catch {
      const contentType = res.headers.get("content-type") ?? "unknown content type";
      return {
        valid: false,
        body: {
          ok: false,
          error: `hub ${this.baseUrl}${path} returned non-JSON (${res.status}, ${contentType})`,
        },
      };
    }
  }

  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; body: any }> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.password}`);
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) abortFromUpstream();
    else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`hub request ${path} timed out after ${this.requestTimeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    });

    try {
      // Race as well as abort: injected/test fetch implementations are not
      // required to observe AbortSignal, and must not be able to hang a lease
      // heartbeat or retained-browser cleanup forever.
      const request = Promise.resolve().then(async () => {
        const res = await this.fetchFn(this.baseUrl + path, { ...init, headers, signal: controller.signal });
        const { body, valid } = await this.readJson(res, path);
        return { status: res.status, ok: res.ok && valid, body };
      });
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  }

  async getRosterSnapshot(): Promise<RemoteRoster> {
    const r = await this.call("/hub/profiles");
    if (!r.ok) throw new Error(r.body?.error ?? `hub roster failed (${r.status})`);
    if (!Array.isArray(r.body?.profiles)) throw new Error(r.body?.error ?? "hub roster response missing profiles");
    if (typeof r.body?.owner === "string" && r.body.owner) this.authenticatedOwner = r.body.owner;
    return {
      profiles: r.body.profiles,
      healthSources: Array.isArray(r.body?.healthSources) ? r.body.healthSources : [],
    };
  }

  async getRoster(): Promise<RemoteProfile[]> {
    return (await this.getRosterSnapshot()).profiles;
  }

  async publishAutomationHealthSnapshot(profiles: AutomationHealthEntry[]): Promise<HealthSnapshotCounts> {
    const r = await this.call("/hub/health/xactions-snapshot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-AliasMode-owner": this.owner,
      },
      body: JSON.stringify({ profiles }),
    });
    if (!r.ok) throw new Error(r.body?.error ?? `hub health snapshot failed (${r.status})`);
    return {
      profiles: r.body.profiles ?? 0,
      alive: r.body.alive ?? 0,
      suspended: r.body.suspended ?? 0,
    };
  }

  /** Full profile (with creds + cookies) for launching. */
  async getProfile(profileId: string): Promise<Profile> {
    const r = await this.call(`/hub/profile/${encodeURIComponent(profileId)}`);
    if (!r.ok) throw new Error(r.body?.error ?? `hub getProfile failed (${r.status})`);
    return r.body.profile;
  }

  /** Save an edited profile back to the central roster (name/proxy/group/...). */
  async saveProfile(profile: Profile): Promise<void> {
    const r = await this.call(`/hub/profile/${encodeURIComponent(profile.id)}`, { method: "POST", body: JSON.stringify(profile) });
    if (!r.ok) throw new Error(r.body?.error ?? `hub saveProfile failed (${r.status})`);
  }

  /** Granted → {ok:true}; held by someone else → {ok:false, lockedBy}. */
  async claim(profileId: string): Promise<{ ok: boolean; lockedBy?: string }> {
    const attempt = (this.claimAttempts.get(profileId) ?? 0) + 1;
    this.claimAttempts.set(profileId, attempt);
    const r = await this.call("/hub/lock/claim", { method: "POST", body: JSON.stringify({ profile_id: profileId, owner: this.owner }) });
    if (r.ok) {
      const fence = r.body?.lock?.fence;
      const authenticatedOwner = r.body?.lock?.owner;
      if (typeof authenticatedOwner === "string" && authenticatedOwner) {
        this.authenticatedOwner = authenticatedOwner;
      }
      if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence <= 0) {
        if (this.claimAttempts.get(profileId) === attempt) this.leaseFences.delete(profileId);
        throw new Error("hub claim response missing a valid lease fence");
      }
      // Fence values are monotonic server-side, so an out-of-order response can
      // never replace a newer generation already learned by this client.
      const current = this.leaseFences.get(profileId);
      if (current === undefined || fence > current) this.leaseFences.set(profileId, fence);
      return { ok: true };
    }
    if (r.status === 409) {
      const observedFence = r.body?.lock?.fence;
      const current = this.leaseFences.get(profileId);
      if (typeof observedFence === "number" && Number.isSafeInteger(observedFence) && observedFence > 0) {
        // A later successful claim may already have returned even if this older
        // denial was delayed on the wire. Preserve it when its fence is newer
        // than the lock generation observed by the denial.
        if (current !== undefined && current <= observedFence) this.leaseFences.delete(profileId);
      } else if (this.claimAttempts.get(profileId) === attempt) {
        this.leaseFences.delete(profileId);
      }
      return { ok: false, lockedBy: r.body?.lockedBy };
    }
    throw new Error(r.body?.error ?? `hub claim failed (${r.status})`);
  }

  async renew(profileId: string): Promise<boolean> {
    const fence = this.leaseFences.get(profileId);
    const r = await this.call("/hub/lock/renew", {
      method: "POST",
      body: JSON.stringify({ profile_id: profileId, owner: this.owner, fence: fence ?? null }),
    });
    if (r.ok) return true;
    if (r.status === 409) {
      this.clearFenceIfCurrent(profileId, fence);
      return false;
    }
    throw new Error(r.body?.error ?? `hub renew failed (${r.status})`);
  }

  async release(profileId: string): Promise<void> {
    const fence = this.leaseFences.get(profileId);
    const r = await this.call("/hub/lock/release", {
      method: "POST",
      body: JSON.stringify({ profile_id: profileId, owner: this.owner, fence: fence ?? null }),
    });
    if (r.ok) {
      // A delayed release for an old fence may return after a newer claim. Do
      // not erase that newer generation from this client's local state.
      this.clearFenceIfCurrent(profileId, fence);
      return;
    }
    if (r.status === 409) this.clearFenceIfCurrent(profileId, fence);
    if (!r.ok) throw new Error(r.body?.error ?? `hub release failed (${r.status})`);
  }

  async getSession(profileId: string): Promise<SessionRecord | null> {
    const r = await this.call(`/hub/session/${encodeURIComponent(profileId)}`);
    if (!r.ok) throw new Error(r.body?.error ?? `hub getSession failed (${r.status})`);
    return r.body.session ?? null;
  }

  /**
   * Save the current session bundle. Pass `baseVersion` (the stored version this bundle was derived
   * from) to opt into optimistic concurrency: if the hub has since moved past it — someone else wrote
   * during a lock gap — the write is refused with a 409 "version conflict" and returned as
   * `{ conflict: true }` (the hub's current version) rather than thrown, so the caller can SKIP the push
   * instead of reverting a fresher session. Omitting `baseVersion` keeps last-writer-wins.
   */
  async putSession(profileId: string, bundle: string, baseVersion?: number): Promise<{ version: number; conflict: boolean; skipped?: string }> {
    const fence = this.leaseFences.get(profileId);
    const payload: Record<string, unknown> = { bundle, owner: this.owner, fence: fence ?? null };
    if (baseVersion !== undefined) payload.baseVersion = baseVersion;
    const r = await this.call(`/hub/session/${encodeURIComponent(profileId)}`, { method: "PUT", body: JSON.stringify(payload) });
    if (r.status === 409 && r.body?.error === "version conflict") return { version: r.body.currentVersion ?? 0, conflict: true };
    if (r.status === 409) {
      this.clearFenceIfCurrent(profileId, fence);
      throw new HubOwnershipLostError(r.body?.error ?? "hub session writer ownership was lost");
    }
    if (!r.ok) throw new Error(r.body?.error ?? `hub putSession failed (${r.status})`);
    return { version: r.body.version, conflict: false, ...(typeof r.body.skipped === "string" ? { skipped: r.body.skipped } : {}) };
  }

  private clearFenceIfCurrent(profileId: string, expected: number | undefined): void {
    if (expected !== undefined && this.leaseFences.get(profileId) === expected) this.leaseFences.delete(profileId);
  }

  async importFiles(files: { name: string; bytes: Uint8Array }[], overrides: ImportOverrides = {}): Promise<{ files: number; profiles: number }> {
    const form = new FormData();
    for (const f of files) form.append("files", new File([f.bytes as BlobPart], f.name));
    if (overrides.group !== undefined) form.set("group", overrides.group);
    if (overrides.platform !== undefined) form.set("platform", overrides.platform);
    const r = await this.call("/hub/import", { method: "POST", body: form });
    if (!r.ok) throw new Error(r.body?.error ?? `hub import failed (${r.status})`);
    return r.body;
  }

  async move(ids: string[], group: string): Promise<number> {
    const r = await this.call("/hub/profiles/move", { method: "POST", body: JSON.stringify({ ids, group }) });
    if (!r.ok) throw new Error(r.body?.error ?? `hub move failed (${r.status})`);
    return r.body.moved;
  }

  async createProfile(input: NewProfileInput): Promise<{ id: string }> {
    const r = await this.call("/hub/profiles", { method: "POST", body: JSON.stringify(input) });
    if (!r.ok) throw new Error(r.body?.error ?? `hub createProfile failed (${r.status})`);
    return { id: r.body.id };
  }

  async renameProfile(id: string, name: string): Promise<void> {
    const r = await this.call("/hub/profiles/rename", { method: "POST", body: JSON.stringify({ id, name }) });
    if (!r.ok) throw new Error(r.body?.error ?? `hub renameProfile failed (${r.status})`);
  }

  /** Delete profiles centrally. `locked` lists any refused because in use. */
  async deleteProfiles(ids: string[]): Promise<{ deleted: number; locked: string[] }> {
    const r = await this.call("/hub/profiles/delete", { method: "POST", body: JSON.stringify({ ids }) });
    if (!r.ok) throw new Error(r.body?.error ?? `hub delete failed (${r.status})`);
    return { deleted: r.body.deleted ?? 0, locked: r.body.locked ?? [] };
  }
}

import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { attachTimezones } from "./geoip.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import { CloudApiError } from "./cloud-client.ts";
import {
  CloudProfileEditor,
  CloudProfileEditorError,
} from "./cloud-profile-editor.ts";
import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import {
  BrowserLaunchError,
  type BrowserOpenOptions,
  type Launcher,
} from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { ProfileStore } from "./store.ts";

export const AGENT_CONTROL_PROTOCOL = "aliasmode-agent-v1";
export const AGENT_CONTROL_PATH = "/api/agent/v1/connect";
export const AGENT_CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface AgentControlRequest {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentControlResponse {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AgentControlDeps {
  launcher: Launcher;
  store: ProfileStore;
  admission: LifecycleAdmissionController;
  remote?: RemoteCoordinator | null;
  cloudBrowser?: CloudBrowserLifecycle;
  cloudConnection?: CloudConnectionRuntime;
  log?: (message: string) => void;
}

type SafeProfile = {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  running: boolean;
  debugPort?: number;
  headless?: boolean;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentError("invalid_request", "request parameters must be an object");
  }
  return value as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw agentError("invalid_request", `${name} must be a non-empty string`);
  }
  return value.trim();
}

class AgentControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentControlError";
  }
}

function agentError(code: string, message: string): AgentControlError {
  return new AgentControlError(code, message);
}

function errorResponse(id: number, error: unknown): AgentControlResponse {
  if (error instanceof AgentControlError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  if (error instanceof BrowserLaunchError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error.failure === "mode_conflict" ? "mode_conflict" : "browser_launch_failed",
        message: error.message,
      },
    };
  }
  return {
    protocol: AGENT_CONTROL_PROTOCOL,
    id,
    ok: false,
    error: {
      code: "operation_failed",
      message: error instanceof Error ? error.message : "AliasMode operation failed",
    },
  };
}

export function parseAgentControlRequest(raw: string | Uint8Array): AgentControlRequest {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes === 0 || bytes > AGENT_CONTROL_MAX_MESSAGE_BYTES) {
    throw agentError("invalid_request", "agent request size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw agentError("invalid_request", "agent request must be valid JSON");
  }
  const request = object(value);
  if (
    request.protocol !== AGENT_CONTROL_PROTOCOL ||
    !Number.isSafeInteger(request.id) ||
    Number(request.id) < 1 ||
    typeof request.method !== "string" ||
    !request.method
  ) {
    throw agentError("invalid_request", "agent request has an invalid protocol shape");
  }
  if (request.params !== undefined) object(request.params);
  return request as unknown as AgentControlRequest;
}

export function validAgentAuthorization(header: string | null, nonce: string): boolean {
  return /^[a-f0-9]{64}$/.test(nonce) && header === `Bearer ${nonce}`;
}

export class AgentControlSession {
  private readonly openedByConnection = new Set<string>();
  private readonly attachedExisting = new Set<string>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private cleanup?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps) {}

  enqueue(raw: string | Uint8Array): Promise<AgentControlResponse> {
    let request: AgentControlRequest;
    try {
      request = parseAgentControlRequest(raw);
    } catch (error) {
      return Promise.resolve(errorResponse(1, error));
    }
    const run = this.queue.then(async () => {
      if (this.closed) throw agentError("connection_closed", "agent connection is closing");
      try {
        return {
          protocol: AGENT_CONTROL_PROTOCOL,
          id: request.id,
          ok: true,
          result: await this.dispatch(request.method, request.params ?? {}),
        } satisfies AgentControlResponse;
      } catch (error) {
        return errorResponse(request.id, error);
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  disconnect(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.cleanup = this.queue.then(async () => {
      for (const profileId of [...this.openedByConnection]) {
        await this.closeProfile(profileId).catch((error) => {
          this.deps.log?.(`agent cleanup for ${profileId} remains unconfirmed (${error instanceof Error ? error.message : "failed"})`);
        });
      }
    });
    return this.cleanup;
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "profiles.list":
        return { profiles: await this.listProfiles() };
      case "profiles.create":
        return await this.createProfile(params);
      case "profiles.delete":
        return await this.deleteProfile(stringParam(params, "profileId"));
      case "browser.open":
        return await this.openProfile(params);
      case "browser.status":
        return await this.profileStatus(stringParam(params, "profileId"));
      case "browser.detach":
        return this.detachProfile(stringParam(params, "profileId"));
      case "browser.close":
        return await this.closeProfile(stringParam(params, "profileId"));
      default:
        throw agentError("unknown_method", `unknown agent method: ${method}`);
    }
  }

  private async listProfiles(): Promise<SafeProfile[]> {
    await this.deps.launcher.reconcileOrphans();
    if (this.deps.cloudBrowser) {
      const roster = await this.deps.cloudBrowser.listRoster();
      return roster.profiles.map((profile) => {
        const launch = this.deps.store.getLaunch(profile.id);
        return {
          id: profile.id,
          name: profile.name,
          group: profile.group,
          platform: profile.platform ?? "",
          tags: profile.tags,
          running: !!launch,
          ...(launch ? { debugPort: launch.debugPort, headless: launch.headless } : {}),
        };
      });
    }
    if (this.deps.remote) {
      const roster = await this.deps.remote.listRoster();
      return roster.profiles.map((profile) => {
        const launch = this.deps.store.getLaunch(profile.id);
        return {
          id: profile.id,
          name: profile.name,
          group: profile.group,
          platform: profile.platform ?? "",
          tags: profile.tags ?? [],
          running: !!launch,
          ...(launch ? { debugPort: launch.debugPort, headless: launch.headless } : {}),
        };
      });
    }
    return this.deps.store.listProfiles().map((profile) => {
      const launch = this.deps.store.getLaunch(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        group: profile.group,
        platform: profile.platform ?? "",
        tags: profile.tags ?? [],
        running: !!launch,
        ...(launch ? { debugPort: launch.debugPort, headless: launch.headless } : {}),
      };
    });
  }

  private async createProfile(params: Record<string, unknown>): Promise<{ id: string; temporary: boolean }> {
    const input = object(params.input ?? {});
    const temporary = params.temporary === true;
    let id: string;
    if (this.deps.remote) {
      id = (await this.deps.remote.createProfile(input as NewProfileInput)).id;
    } else {
      const profile = buildNewProfile(input as NewProfileInput, (candidate) => !!this.deps.store.getProfile(candidate));
      if (profile.proxy) await attachTimezones([profile]).catch(() => {});
      if (this.deps.cloudBrowser) {
        id = (await this.deps.cloudBrowser.create(profile)).id;
      } else {
        this.deps.store.upsertProfile(profile);
        id = profile.id;
      }
    }
    if (temporary) this.deps.store.markAgentTemporary(id);
    return { id, temporary };
  }

  private async openProfile(params: Record<string, unknown>): Promise<{
    profileId: string;
    ws: string;
    port: number;
    headless: boolean;
    alreadyOpen: boolean;
    ownedByConnection: boolean;
  }> {
    const profileId = stringParam(params, "profileId");
    const options: BrowserOpenOptions = {};
    if (params.headless !== undefined) {
      if (typeof params.headless !== "boolean") throw agentError("invalid_request", "headless must be boolean");
      options.headless = params.headless;
    }
    const startupUrls = params.startupUrls === undefined
      ? []
      : Array.isArray(params.startupUrls) && params.startupUrls.every((value) => typeof value === "string" && /^https?:\/\//.test(value))
        ? params.startupUrls as string[]
        : (() => { throw agentError("invalid_request", "startupUrls must contain only HTTP(S) URLs"); })();

    const opened = await this.deps.admission.run(
      { kind: "start", profileIds: [profileId] },
      async () => {
        const alreadyOpen = await this.deps.launcher.certifiedActive(profileId).catch(() => false);
        const existing = alreadyOpen ? this.deps.store.getLaunch(profileId) : null;
        if (existing) {
          if (options.headless !== undefined && existing.headless !== options.headless) {
            throw new BrowserLaunchError("mode_conflict");
          }
          return { ws: existing.ws, port: existing.debugPort, alreadyOpen, headless: existing.headless ?? false };
        }

        if (this.deps.cloudBrowser) {
          const result = await this.deps.cloudBrowser.open(profileId, startupUrls, options);
          if (!result.ok || !result.ws || !result.port) {
            throw agentError("open_failed", result.error ?? "Cloud browser open failed");
          }
          return { ws: result.ws, port: result.port, alreadyOpen: false, headless: options.headless ?? false };
        }
        if (this.deps.remote) {
          const result = await this.deps.remote.open(profileId, startupUrls, false, options);
          if (!result.ok || !result.ws || !result.port) {
            throw agentError("open_failed", result.error ?? "remote browser open failed");
          }
          return { ws: result.ws, port: result.port, alreadyOpen: false, headless: options.headless ?? false };
        }
        const result = await this.deps.launcher.start(profileId, startupUrls, options);
        const launch = this.deps.store.getLaunch(profileId);
        return {
          ws: result.ws,
          port: result.port,
          alreadyOpen: false,
          headless: launch?.headless ?? options.headless ?? false,
        };
      },
    );

    if (opened.alreadyOpen) this.attachedExisting.add(profileId);
    else this.openedByConnection.add(profileId);
    if (this.closed && !opened.alreadyOpen) await this.closeProfile(profileId);
    return {
      profileId,
      ws: opened.ws,
      port: opened.port,
      headless: opened.headless,
      alreadyOpen: opened.alreadyOpen,
      ownedByConnection: !opened.alreadyOpen,
    };
  }

  private detachProfile(profileId: string): { profileId: string; detached: true } {
    if (!this.openedByConnection.delete(profileId)) {
      throw agentError("not_owned", "this agent connection does not own the browser");
    }
    this.attachedExisting.add(profileId);
    return { profileId, detached: true };
  }

  private async profileStatus(profileId: string): Promise<unknown> {
    const running = await this.deps.launcher.certifiedActive(profileId).catch(() => false);
    const launch = this.deps.store.getLaunch(profileId);
    return {
      profileId,
      running,
      state: running ? "running" : launch ? "uncertain" : "closed",
      ...(running && launch ? {
        ws: launch.ws,
        port: launch.debugPort,
        headless: launch.headless ?? false,
      } : {}),
      ownedByConnection: this.openedByConnection.has(profileId),
      attachedExisting: this.attachedExisting.has(profileId),
    };
  }

  private async closeProfile(profileId: string): Promise<{ profileId: string; closed: true; deleted: boolean }> {
    return await this.deps.admission.run(
      { kind: "stop", profileIds: [profileId] },
      async () => {
        let closed: boolean;
        if (this.deps.cloudBrowser) closed = await this.deps.cloudBrowser.close(profileId);
        else if (this.deps.remote) closed = await this.deps.remote.close(profileId);
        else closed = await this.deps.launcher.stop(profileId);
        if (!closed) throw agentError("close_unconfirmed", `browser teardown is unconfirmed: ${profileId}`);

        this.openedByConnection.delete(profileId);
        this.attachedExisting.delete(profileId);
        const temporary = this.deps.store.listAgentTemporary().includes(profileId);
        let deleted = false;
        if (temporary) deleted = await this.deleteClosedProfile(profileId);
        return { profileId, closed: true as const, deleted };
      },
    );
  }

  private async deleteProfile(profileId: string): Promise<{ profileId: string; deleted: boolean }> {
    return await this.deps.admission.run(
      { kind: "cleanup", profileIds: [profileId] },
      async () => {
        if (this.deps.store.getLaunch(profileId)) {
          throw agentError("profile_open", "close the profile before deleting it");
        }
        return { profileId, deleted: await this.deleteClosedProfile(profileId) };
      },
    );
  }

  private async deleteClosedProfile(profileId: string): Promise<boolean> {
    if (this.deps.cloudBrowser) {
      if (!this.deps.cloudConnection) throw agentError("cloud_unavailable", "Cloud connection is unavailable");
      try {
        const editor = new CloudProfileEditor(this.deps.cloudConnection.client, this.deps.store);
        const expectedVersion = await editor.closedProfileVersion(profileId);
        await this.deps.cloudConnection.client.trashProfile(profileId, { expectedVersion });
        this.deps.store.clearAgentTemporary(profileId);
        return true;
      } catch (error) {
        if (
          error instanceof CloudProfileEditorError && error.status === 409 ||
          error instanceof CloudApiError && error.status === 409 && error.code === "profile_open"
        ) {
          throw agentError("profile_open", "close the profile before deleting it");
        }
        throw error;
      }
    }
    if (this.deps.remote) {
      const result = await this.deps.remote.deleteProfiles([profileId]);
      if (result.locked.includes(profileId)) throw agentError("profile_open", "close the profile before deleting it");
      const deleted = result.deleted > 0;
      if (deleted) this.deps.store.clearAgentTemporary(profileId);
      return deleted;
    }
    if (!this.deps.store.getProfile(profileId)) {
      this.deps.store.clearAgentTemporary(profileId);
      return false;
    }
    if (this.deps.launcher.profileDeletionBlocked(profileId)) {
      throw agentError("profile_open", "close the profile before deleting it");
    }
    this.deps.launcher.removeUserDataDir(profileId);
    return this.deps.store.deleteProfile(profileId);
  }
}

export class AgentControlHub {
  private cleanupInFlight?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps) {}

  connect(): AgentControlSession {
    return new AgentControlSession(this.deps);
  }

  cleanupTemporaryProfiles(): Promise<void> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    this.cleanupInFlight = this.doCleanupTemporaryProfiles().finally(() => {
      this.cleanupInFlight = undefined;
    });
    return this.cleanupInFlight;
  }

  private async doCleanupTemporaryProfiles(): Promise<void> {
    for (const profileId of this.deps.store.listAgentTemporary()) {
      if (this.deps.store.getLaunch(profileId)) continue;
      const session = new AgentControlSession(this.deps);
      await session.enqueue(JSON.stringify({
        protocol: AGENT_CONTROL_PROTOCOL,
        id: 1,
        method: "profiles.delete",
        params: { profileId },
      })).catch(() => undefined);
    }
  }
}

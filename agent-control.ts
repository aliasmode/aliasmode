import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { waitForHostGpu } from "./host-gpu.ts";
import { syncFirefoxTimezone } from "./firefox-config.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import { attachTimezones, lookupExitLocation } from "./geoip.ts";
import { localeAfterProxyExit } from "./profile-locale.ts";
import { decodePortableProfile } from "./portable-profile.ts";
import { proxyHostPort, proxyLegacyString } from "./proxy.ts";
import type { ProxySpec } from "./types.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import { CloudApiError } from "./cloud-client.ts";
import {
  CloudProfileEditor,
  CloudProfileEditorError,
  applyProfileEdits,
} from "./cloud-profile-editor.ts";
import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import {
  BrowserLaunchError,
  type BrowserOpenOptions,
  type Launcher,
} from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import type { RemoteCoordinator } from "./remote.ts";
import { ProxyReplacementInputError, runProxyReplacements } from "./proxy-replacements.ts";
import { NewIdentityError, startNewIdentity } from "./new-identity.ts";
import type { ProfileStore } from "./store.ts";
import { CREDENTIAL_FIELDS, LOG_READ_BYTES, maskProfiles, maskSecrets, maskableSecrets } from "./script-secrets.ts";
import type { ScriptLibrary, ScriptRun, ScriptSupervisor } from "./scripts.ts";
import type { Scheduler } from "./scheduler.ts";
import type { ScriptInput } from "./contracts/cloud-v1.ts";

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
  firefoxCall?: (owner: FirefoxOwner, operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  remote?: RemoteCoordinator | null;
  cloudBrowser?: CloudBrowserLifecycle;
  cloudConnection?: CloudConnectionRuntime;
  scripts?: { library: ScriptLibrary; runner: ScriptSupervisor; scheduler?: Pick<Scheduler, "list" | "save" | "remove" | "setOnOpen"> };
  log?: (message: string) => void;
}

const FIREFOX_CAPABILITIES = ["firefox-native", "cookies", "navigation", "sessions", "mcp", "scripts", "playwright"] as const;

type FirefoxLaunch = { engine?: "chromium" | "firefox"; firefoxOwner?: FirefoxOwner };

function isFirefoxEngine(launch: unknown): launch is FirefoxLaunch & { engine: "firefox" } {
  return (launch as FirefoxLaunch | null)?.engine === "firefox";
}

function isFirefoxLaunch(launch: unknown): launch is FirefoxLaunch & { engine: "firefox"; firefoxOwner: FirefoxOwner } {
  return isFirefoxEngine(launch) && !!launch.firefoxOwner;
}

function firefoxPublicFields(): { engine: "firefox"; capabilities: readonly string[] } {
  return { engine: "firefox", capabilities: FIREFOX_CAPABILITIES };
}

type SafeProfile = {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  /** "host:port" only, never the user or password. */
  proxy?: string | null;
  running: boolean;
  engine?: "firefox";
  capabilities?: readonly string[];
  debugPort?: number;
  headless?: boolean;
  expectedVersion?: number;
  permission?: "view" | "edit";
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
  if (error instanceof AgentControlError || error instanceof ProxyReplacementInputError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error instanceof AgentControlError ? error.code : "invalid_request",
        message: error.message,
      },
    };
  }
  if (error instanceof BrowserLaunchError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error.failure === "mode_conflict" ? "mode_conflict" : "browser_launch_failed",
        // The guidance says what to fix, so an AI client can tell the user instead of guessing.
        message: error.guidance ? `${error.message}: ${error.guidance}` : error.message,
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
  private readonly openedEndpoints = new Map<string, string>();
  private readonly attachedExisting = new Set<string>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private cleanup?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps, private readonly openSignal?: AbortSignal) {}

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
      case "profiles.replaceProxies":
        return await this.replaceProfileProxies(params);
      case "profiles.create":
        return await this.createProfile(params);
      case "profiles.update":
        return await this.updateProfile(params);
      case "profiles.delete":
        return await this.deleteProfile(stringParam(params, "profileId"));
      case "profiles.newIdentity":
        return await this.newIdentity(stringParam(params, "profileId"));
      case "browser.open":
        return await this.openProfile(params);
      case "browser.status":
        return await this.profileStatus(stringParam(params, "profileId"));
      case "firefox.tools.list":
        return { tools: await this.firefoxCall(stringParam(params, "profileId"), "mcp-list", {}) };
      case "firefox.tools.call":
        return await this.firefoxCall(stringParam(params, "profileId"), "mcp-call", {
          name: stringParam(params, "name"),
          ...(params.arguments === undefined ? {} : { arguments: object(params.arguments) }),
        });
      case "firefox.playwrightEndpoint":
        return await this.firefoxCall(stringParam(params, "profileId"), "playwright-endpoint", {});
      case "browser.detach":
        return this.detachProfile(stringParam(params, "profileId"));
      case "browser.close":
        return await this.closeProfile(stringParam(params, "profileId"),
          params.expectedEndpoint === undefined ? undefined : stringParam(params, "expectedEndpoint"));
      case "scripts.list":
        return { scripts: (await this.scriptTools().library.list()).map(({ id, name, language, description }) => ({ id, name, language, description })) };
      case "scripts.get":
        return { script: await this.scriptTools().library.get(stringParam(params, "scriptId")) };
      case "scripts.save":
        return await this.saveScript(params);
      case "scripts.run":
        return { run: this.scriptTools().runner.start({
          scriptId: stringParam(params, "scriptId"),
          profileIds: Array.isArray(params.profileIds) ? params.profileIds as string[] : [],
          inputs: params.inputs === undefined ? {} : object(params.inputs),
          useCredentials: params.useCredentials === undefined ? false : params.useCredentials as boolean,
          ...(params.headless === undefined ? {} : { headless: params.headless as boolean }),
        }) };
      case "scripts.status":
        return { run: this.maskedRun(this.scriptTools().runner.status()) };
      case "scripts.log":
        return this.scriptLog(stringParam(params, "runId"), params.offset === undefined ? 0 : Number(params.offset));
      case "scripts.stop":
        return { run: this.maskedRun(await this.scriptTools().runner.stop()) };
      case "scripts.onOpen":
        return await this.setScriptOnOpen(params);
      case "schedules.list": {
        const state = this.schedules().list();
        return { ...state, history: state.history.map((entry) => {
          const secrets = this.secrets(entry.runId, entry.profiles.map((item) => item.id));
          return { ...entry, ...(entry.error === undefined ? {} : { error: maskSecrets(entry.error, secrets) }), profiles: maskProfiles(entry.profiles, secrets) };
        }) };
      }
      case "schedules.save":
        return await this.saveSchedule(params);
      case "schedules.delete": {
        const scheduleId = stringParam(params, "scheduleId");
        this.schedules().remove(scheduleId);
        return { scheduleId, deleted: true as const };
      }
      case "mcp.connectors.create":
        return await this.createMcpConnector(stringParam(params, "label"));
      case "mcp.connectors.list":
        return await this.listMcpConnectors();
      case "mcp.connectors.revoke":
        return await this.revokeMcpConnector(stringParam(params, "connectorId"));
      default:
        throw agentError("unknown_method", `unknown agent method: ${method}`);
    }
  }

  private scriptTools(): NonNullable<AgentControlDeps["scripts"]> {
    if (!this.deps.scripts) throw agentError("scripts_unavailable", "Scripts are not available here; use the AliasMode desktop app");
    return this.deps.scripts;
  }

  /** Creates a script, or updates the one named by scriptId; omitted fields keep their current value. */
  private async saveScript(params: Record<string, unknown>) {
    const { library } = this.scriptTools();
    const current = params.scriptId === undefined ? undefined : await library.get(stringParam(params, "scriptId"));
    const field = (name: "name" | "description" | "language" | "source") => params[name] ?? current?.[name] ?? (name === "description" ? "" : undefined);
    const { source: _source, ...saved } = await library.save(
      { name: field("name"), description: field("description"), language: field("language"), source: field("source") } as ScriptInput,
      current?.id,
      current && (params.expectedRevision === undefined ? current.revision : Number(params.expectedRevision)),
    );
    return { script: saved };
  }

  /** The saved login values of a run's profiles, and of `profileIds` as stored now, which AI clients never see. */
  private secrets(runId: string, profileIds: string[] = []): string[] {
    const values = new Set(this.scriptTools().runner.secrets(runId));
    for (const id of profileIds) {
      const profile = this.deps.store?.getProfile(id) as unknown as Record<string, unknown> | null | undefined;
      for (const key of CREDENTIAL_FIELDS) if (typeof profile?.[key] === "string") values.add(profile[key] as string);
    }
    return maskableSecrets(values);
  }

  private maskedRun(run: ScriptRun | null): ScriptRun | null {
    return run && { ...run, profiles: maskProfiles(run.profiles, this.secrets(run.id)) };
  }

  private scriptLog(runId: string, offset: number) {
    const { runner } = this.scriptTools();
    // Read before the log, so output written after this check is never taken for the end.
    const finished = runner.status()?.status === "finished";
    const secrets = this.secrets(runId);
    const longest = Math.max(0, ...secrets.map((secret) => Buffer.byteLength(secret)));
    // An offset inside a saved value moves back to the value's start, so no part of it is returned.
    let start = offset;
    for (let moved = longest > 1; moved;) {
      moved = false;
      const from = Math.max(0, start - longest + 1);
      const around = runner.logBytes(runId, from, start - from + longest - 1);
      for (const secret of secrets.map((value) => Buffer.from(value))) {
        for (let at = around.indexOf(secret); at >= 0; at = around.indexOf(secret, at + 1)) {
          if (from + at < start && from + at + secret.length > start) { start = from + at; moved = true; }
        }
      }
    }
    const log = runner.log(runId, start);
    const text = maskSecrets(log.text, secrets);
    // UTF-8 trimming can end a full read up to 3 bytes early.
    if (finished && log.nextOffset - start <= LOG_READ_BYTES - 4) return { text, nextOffset: log.nextOffset };
    // A value cut off at the end of this read is held back, so the next read masks it whole.
    const held = Math.max(0, ...secrets.map((secret) => {
      for (let length = secret.length - 1; length > 0; length--) if (text.endsWith(secret.slice(0, length))) return length;
      return 0;
    }));
    return { text: text.slice(0, text.length - held), nextOffset: log.nextOffset - Buffer.byteLength(text.slice(text.length - held)) };
  }

  private schedules(): NonNullable<NonNullable<AgentControlDeps["scripts"]>["scheduler"]> {
    const scheduler = this.deps.scripts?.scheduler;
    if (!scheduler) throw agentError("schedules_unavailable", "Schedules are not available here; use the AliasMode desktop app");
    return scheduler;
  }

  /** Creates a schedule, or updates the one named by scheduleId; omitted fields keep their current value. */
  private async saveSchedule(params: Record<string, unknown>) {
    const scheduler = this.schedules();
    const { scheduleId, ...fields } = params;
    const current = scheduleId === undefined ? undefined : scheduler.list().jobs.find((job) => job.id === scheduleId);
    if (scheduleId !== undefined && !current) throw agentError("schedule_not_found", "Schedule not found");
    const { id: _id, nextRun: _nextRun, lastRun: _lastRun, everyHours, dailyAt, ...kept } = current ?? {};
    // A new cadence replaces the old one; only one of everyHours and dailyAt may be set.
    const cadence = fields.everyHours !== undefined || fields.dailyAt !== undefined ? {} : { ...(everyHours === undefined ? {} : { everyHours }), ...(dailyAt === undefined ? {} : { dailyAt }) };
    const job = { inputs: {}, ...kept, ...cadence, ...fields };
    if (typeof job.scriptId === "string") await this.scriptTools().library.get(job.scriptId);
    return { job: scheduler.save(job, current?.id) };
  }

  private async setScriptOnOpen(params: Record<string, unknown>) {
    const profileId = stringParam(params, "profileId");
    const scriptId = params.scriptId === undefined || params.scriptId === null ? null : stringParam(params, "scriptId");
    const scheduler = this.schedules();
    if (scriptId) await this.scriptTools().library.get(scriptId);
    scheduler.setOnOpen(profileId, scriptId);
    return { profileId, scriptId };
  }

  private cloudMcpConnection(): { connection: CloudConnectionRuntime; deviceId: string } {
    const connection = this.deps.cloudConnection;
    const deviceId = connection?.deviceId();
    if (!connection || !deviceId) {
      throw agentError("cloud_unavailable", "Sign in to AliasMode Cloud on this device first");
    }
    return { connection, deviceId };
  }

  private async createMcpConnector(label: string) {
    const { connection, deviceId } = this.cloudMcpConnection();
    const created = await connection.client.createMcpConnector(label);
    return {
      connectorId: created.connector.id,
      deviceId,
      url: connection.client.remoteMcpUrl(deviceId),
      token: created.token,
    };
  }

  private async listMcpConnectors() {
    const { connection, deviceId } = this.cloudMcpConnection();
    const listed = await connection.client.listMcpConnectors();
    return {
      deviceId,
      url: connection.client.remoteMcpUrl(deviceId),
      connectors: listed.connectors,
    };
  }

  private async revokeMcpConnector(connectorId: string) {
    const { connection } = this.cloudMcpConnection();
    await connection.client.revokeMcpConnector(connectorId);
    return { connectorId, revoked: true as const };
  }

  private async replaceProfileProxies(params: Record<string, unknown>) {
    if (!this.deps.cloudBrowser) {
      throw agentError("cloud_unavailable", "Switch to AliasMode Cloud and sign in on this device first");
    }
    const { connection } = this.cloudMcpConnection();
    return runProxyReplacements(connection.client, params);
  }

  private async updateProfile(params: Record<string, unknown>) {
    if (!this.deps.cloudBrowser && this.deps.remote) {
      throw agentError("cloud_unavailable", "Switch to AliasMode Cloud and sign in on this device first");
    }
    const profileId = stringParam(params, "profileId");
    const set = { ...object(params.set ?? {}) };
    if (params.proxyFrom !== undefined) {
      const proxy = await this.proxyOf(stringParam(params, "proxyFrom"));
      set.proxy = proxy ? proxyLegacyString(proxy) : "";
      if (proxy) set.proxyType = proxy.type;
    }
    const stringFields = ["name", "group", "platform", "username", "password", "email", "emailPassword", "twofa", "proxy", "proxyType", "resolution"];
    if (!Object.keys(set).length) throw agentError("invalid_request", "set must contain an editable field");
    for (const [field, value] of Object.entries(set)) {
      const valid = stringFields.includes(field) ? typeof value === "string"
        : field === "extensions" || field === "tags"
          ? (field === "tags" && typeof value === "string") || Array.isArray(value) && value.every((item) => typeof item === "string")
          : field === "blockMedia" ? typeof value === "boolean"
          : false;
      if (!valid) throw agentError("invalid_request", `invalid editable field: ${field}`);
    }
    if (!this.deps.cloudBrowser) return this.updateLocalProfile(profileId, set);
    const { connection } = this.cloudMcpConnection();
    try {
      const editor = new CloudProfileEditor(connection.client, this.deps.store);
      await editor.save(profileId, params.expectedVersion as number, set);
      return { profileId, updated: true as const };
    } catch (error) {
      if (error instanceof CloudApiError) throw agentError(error.code, error.message);
      if (error instanceof CloudProfileEditorError) {
        throw agentError(error.status === 409 ? "conflict" : "invalid_request", error.message);
      }
      throw error;
    }
  }

  private async updateLocalProfile(profileId: string, set: Record<string, unknown>) {
    return await this.deps.admission.run({ kind: "cleanup", profileIds: [profileId] }, async () => {
      const profile = this.deps.store.getProfile(profileId);
      if (!profile) throw agentError("profile_not_found", `profile ${profileId} was not found`);
      if (this.deps.store.getLaunch(profileId)) throw agentError("profile_open", "close the profile before editing it");
      let proxyChanged: boolean;
      try {
        proxyChanged = applyProfileEdits(profile, set);
      } catch (error) {
        throw agentError("invalid_request", error instanceof Error ? error.message : String(error));
      }
      if (proxyChanged && profile.proxy && !("timezone" in set) && !profile.timezoneManual) {
        const exit = await lookupExitLocation(profile.proxy).catch(() => null);
        if (exit) { profile.locale = localeAfterProxyExit(profile, exit); profile.timezone = exit.timezone; }
        syncFirefoxTimezone(profile);
      }
      this.deps.store.upsertProfile(profile);
      return { profileId, updated: true as const };
    });
  }

  private async firefoxCall(profileId: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
    const launch = this.deps.store.getLaunch(profileId) as (ReturnType<ProfileStore["getLaunch"]> & FirefoxLaunch) | null;
    if (!isFirefoxLaunch(launch)) throw agentError("browser_not_firefox", "This profile is not running in Firefox");
    if (!(await this.deps.launcher.certifiedActive(profileId).catch(() => false))) {
      throw agentError("browser_not_running", "This Firefox profile is not safely running");
    }
    return await (this.deps.firefoxCall ?? callFirefoxOwner)(launch.firefoxOwner, operation, payload);
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
          proxy: profile.proxy,
          expectedVersion: profile.version,
          permission: profile.permission,
          running: !!launch,
          ...(launch ? { ...(isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
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
          ...(launch ? { ...(isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
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
        proxy: profile.proxy ? proxyHostPort(profile.proxy) : null,
        running: !!launch,
        ...(launch ? { ...(isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
      };
    });
  }

  /** The full proxy of another profile, so the agent can reuse it without ever seeing the credentials. */
  private async proxyOf(profileId: string): Promise<ProxySpec | null> {
    if (this.deps.cloudBrowser) {
      const { connection } = this.cloudMcpConnection();
      const authoritative = await connection.client.getProfile(profileId);
      return decodePortableProfile(authoritative.payload).profile.proxy;
    }
    if (this.deps.remote) throw agentError("invalid_request", "proxyFrom is unavailable in legacy Remote mode");
    const profile = this.deps.store.getProfile(profileId);
    if (!profile) throw agentError("profile_not_found", `profile ${profileId} was not found`);
    return profile.proxy;
  }

  private async createProfile(params: Record<string, unknown>): Promise<{ id: string; temporary: boolean }> {
    const input = { ...object(params.input ?? {}) };
    const temporary = params.temporary === true;
    if (params.proxyFrom !== undefined) {
      const proxy = await this.proxyOf(stringParam(params, "proxyFrom"));
      input.proxy = proxy ? { type: proxy.type, host: proxy.host, port: String(proxy.port), user: proxy.user ?? "", pass: proxy.pass ?? "" } : null;
    }
    let id: string;
    if (this.deps.remote && input.chromiumRuntime) throw new Error("AliasMode Chromium is unavailable in legacy Remote mode");
    if (this.deps.remote) {
      id = (await this.deps.remote.createProfile(input as NewProfileInput)).id;
    } else {
      await waitForHostGpu();
      const profile = buildNewProfile(input as NewProfileInput, (candidate) => !!this.deps.store.getProfile(candidate));
      if (profile.proxy) {
        await attachTimezones([profile], undefined, true).catch(() => {});
        syncFirefoxTimezone(profile);
      }
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

  private async openProfile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
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
      { kind: "start", profileIds: [profileId], signal: this.openSignal },
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
          return { ws: result.ws, port: result.port, alreadyOpen: false, headless: options.headless ?? false, warning: result.warning };
        }
        if (this.deps.remote) {
          const result = await this.deps.remote.open(profileId, startupUrls, false, options);
          if (!result.ok || !result.ws || !result.port) {
            throw agentError("open_failed", result.error ?? "remote browser open failed");
          }
          return { ws: result.ws, port: result.port, alreadyOpen: false, headless: options.headless ?? false, warning: result.warning };
        }
        const result = await this.deps.launcher.start(profileId, startupUrls, options);
        const launch = this.deps.store.getLaunch(profileId);
        return {
          ws: result.ws,
          port: result.port,
          // A browser that was running before this call (a busy one can fail the check above) is the
          // user's, unless this connection opened it; this connection must not close the user's.
          alreadyOpen: !!result.reattached && !this.openedByConnection.has(profileId),
          headless: launch?.headless ?? options.headless ?? false,
          warning: result.warning,
        };
      },
    );

    if (opened.alreadyOpen) this.attachedExisting.add(profileId);
    else {
      this.openedByConnection.add(profileId);
      this.openedEndpoints.set(profileId, opened.ws);
    }
    if (this.closed && !opened.alreadyOpen) await this.closeProfile(profileId);
    const launch = this.deps.store.getLaunch(profileId) as (ReturnType<ProfileStore["getLaunch"]> & FirefoxLaunch) | null;
    const firefox = isFirefoxEngine(launch) || opened.ws.startsWith("firefox://");
    return {
      profileId,
      ...(firefox
        ? firefoxPublicFields()
        : { ws: opened.ws, port: opened.port }),
      headless: opened.headless,
      alreadyOpen: opened.alreadyOpen,
      ownedByConnection: !opened.alreadyOpen,
      ...(opened.warning ? { warning: opened.warning } : {}),
    };
  }

  private detachProfile(profileId: string): { profileId: string; detached: true } {
    if (!this.openedByConnection.delete(profileId)) {
      throw agentError("not_owned", "this agent connection does not own the browser");
    }
    this.openedEndpoints.delete(profileId);
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
      ...(running && launch ? (
        isFirefoxEngine(launch)
          ? { ...firefoxPublicFields(), headless: launch.headless ?? false }
          : { ws: launch.ws, port: launch.debugPort, headless: launch.headless ?? false }
      ) : {}),
      ownedByConnection: this.openedByConnection.has(profileId),
      attachedExisting: this.attachedExisting.has(profileId),
    };
  }

  private async closeProfile(profileId: string, expectedEndpoint?: string): Promise<{
    profileId: string;
    closed: true;
    sync?: "complete" | "pending" | "conflict";
    deleted: boolean;
  }> {
    return await this.deps.admission.run(
      { kind: "stop", profileIds: [profileId] },
      async () => {
        const expected = expectedEndpoint ?? this.openedEndpoints.get(profileId);
        if (expected && this.deps.store.getLaunch(profileId)?.ws !== expected) {
          this.openedByConnection.delete(profileId);
          this.openedEndpoints.delete(profileId);
          throw agentError("browser_changed", "The browser instance changed; the current browser was left open");
        }
        let closed: boolean;
        let sync: "complete" | "pending" | "conflict" | undefined;
        if (this.deps.cloudBrowser) {
          const result = await this.deps.cloudBrowser.close(profileId);
          closed = result.closed;
          if (result.closed) sync = result.sync;
        } else if (this.deps.remote) {
          closed = await this.deps.remote.close(profileId);
        } else {
          closed = await this.deps.launcher.stop(profileId);
        }
        if (!closed) throw agentError("close_unconfirmed", `browser teardown is unconfirmed: ${profileId}`);

        this.openedByConnection.delete(profileId);
        this.openedEndpoints.delete(profileId);
        this.attachedExisting.delete(profileId);
        const temporary = this.deps.store.listAgentTemporary().includes(profileId);
        let deleted = false;
        if (temporary && (sync === undefined || sync === "complete")) {
          deleted = await this.deleteClosedProfile(profileId);
        }
        return {
          profileId,
          closed: true as const,
          ...(sync ? { sync } : {}),
          deleted,
        };
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
        // A Local profile goes to Trash like the dashboard's Delete; only the user empties Trash.
        if (!this.deps.cloudBrowser && !this.deps.remote && !this.deps.store.listAgentTemporary().includes(profileId)) {
          return { profileId, deleted: this.deps.store.trashProfile(profileId) };
        }
        return { profileId, deleted: await this.deleteClosedProfile(profileId) };
      },
    );
  }

  private async newIdentity(profileId: string) {
    return await this.deps.admission.run({ kind: "cleanup", profileIds: [profileId] }, async () => {
      let result;
      try {
        result = await startNewIdentity({
          launcher: this.deps.launcher,
          store: this.deps.store,
          remote: this.deps.remote,
          cloudBrowser: this.deps.cloudBrowser,
          cloudClient: this.deps.cloudConnection?.client,
          scriptBusy: (id) => this.deps.scripts?.runner.usesProfile(id) ?? false,
        }, profileId);
      } catch (error) {
        if (error instanceof CloudApiError) throw agentError(error.code, error.message);
        if (error instanceof NewIdentityError || error instanceof CloudProfileEditorError) {
          const codes: Record<number, string> = { 400: "invalid_request", 404: "profile_not_found", 409: "conflict", 503: "cloud_unavailable" };
          throw agentError(codes[error.status] ?? "operation_failed", error.message);
        }
        throw error;
      }
      // The browser opened again has a new endpoint; a connection that owned the old one owns it.
      const launch = result.reopened ? this.deps.store.getLaunch(profileId) : null;
      if (launch && this.openedEndpoints.has(profileId)) this.openedEndpoints.set(profileId, launch.ws);
      if (!launch) {
        this.openedByConnection.delete(profileId);
        this.openedEndpoints.delete(profileId);
        this.attachedExisting.delete(profileId);
      }
      return result;
    });
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
    // The cache delete after a close runs on after stop() returns; the profile is closed, so wait for it.
    await this.deps.launcher.cacheCleanupSettled(profileId);
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

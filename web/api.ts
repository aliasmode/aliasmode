/** Typed client for the dashboard's /ui/api/* endpoints. */

import {
  CLOUD_DIAGNOSTIC_TYPES,
  type CloudDiagnosticEvent,
} from "../cloud-diagnostics.ts";

export type { CloudDiagnosticEvent } from "../cloud-diagnostics.ts";

export type HealthStatus = "suspended" | "alive" | "no_data";

export interface UiProfile {
  id: string;
  name: string;
  group: string;
  /** Canonical account platform domain, or "" (none). */
  platform: string;
  /** Free-form custom tags. */
  tags: string[];
  proxy: string | null;
  proxyError?: string;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  mobilePersona?: boolean;
  has2fa: boolean;
  running: boolean;
  debugPort?: number;
  startedAt?: number;
  /** Remote (hub) mode only: who currently has it open elsewhere, if anyone. */
  lockedBy?: string | null;
  permission?: "view" | "edit";
  version?: number;
  hasSession?: boolean;
  healthStatus?: HealthStatus;
  healthObservedAt?: number | null;
}

export interface HealthSource {
  sourceId: string;
  lastSnapshotAt: number;
  stale: boolean;
}

export interface UiRoster {
  profiles: UiProfile[];
  healthSources: HealthSource[];
}

export interface DiagnoseReport {
  generatedAt: number;
  analysis: { verdicts: string[] };
}

export interface HealthResult { ok: boolean; version: string; root: string; logDir?: string; }

export interface AppModeConfig {
  version: 1;
  mode: "unconfigured" | "local" | "cloud";
  cloudUrl?: string;
  localAnalytics: boolean;
  restartRequired?: boolean;
}

export async function fetchAppMode(): Promise<AppModeConfig> {
  const path = "/ui/api/app-mode";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (body.mode !== "unconfigured" && body.mode !== "local" && body.mode !== "cloud") {
    throw new Error(body.error || "AliasMode returned an invalid application mode");
  }
  return body as AppModeConfig;
}

export async function selectAppMode(mode: "local" | "cloud"): Promise<any> {
  const path = "/ui/api/app-mode";
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const body = await apiJson(response, path);
  if (!response.ok || body.ok !== true) throw new Error(body.error || "Could not save AliasMode mode");
  return body;
}

export async function fetchCloudEvents(): Promise<CloudDiagnosticEvent[]> {
  const path = "/ui/api/cloud-events";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (!response.ok || !Array.isArray(body.events)) {
    throw new Error("Cloud diagnostics are unavailable");
  }
  const knownTypes = new Set<string>(CLOUD_DIAGNOSTIC_TYPES);
  return body.events.map((event: unknown) => {
    if (!event || typeof event !== "object") throw new Error("Cloud diagnostics returned invalid data");
    const keys = Object.keys(event as object).sort();
    const timestamp = (event as any).timestamp;
    const type = (event as any).type;
    if (
      keys.join(",") !== "timestamp,type" ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(new Date(timestamp).getTime()) ||
      !knownTypes.has(type)
    ) {
      throw new Error("Cloud diagnostics returned invalid data");
    }
    return { timestamp, type } as CloudDiagnosticEvent;
  });
}

export interface CloudLegalState {
  current: { terms: string; privacy: string; acceptableUse: string };
  accepted: ({ terms: string; privacy: string; acceptableUse: string; acceptedAt: number }) | null;
}

export interface CloudAuthState {
  authenticated: boolean;
  expiresAt?: number;
  user?: { id: string; email?: string };
  workspace?: { id: string; name: string; ownerAccountId: string; role: "owner" | "admin" | "member" };
  legal?: CloudLegalState;
}

export function cloudSessionContextReady(state: CloudAuthState): boolean {
  return state.authenticated && !!state.workspace && !!state.legal;
}

export function cloudWorkspaceReady(state: CloudAuthState | null): boolean {
  const legal = state?.legal;
  return state?.authenticated === true && !!legal?.accepted &&
    legal.accepted.terms === legal.current.terms &&
    legal.accepted.privacy === legal.current.privacy &&
    legal.accepted.acceptableUse === legal.current.acceptableUse;
}

export async function fetchCloudAuth(): Promise<CloudAuthState> {
  const path = "/ui/api/cloud-auth";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (!response.ok || body.ok !== true) throw new Error(body.error || "Cloud authentication is unavailable");
  return {
    authenticated: body.authenticated === true,
    expiresAt: body.expiresAt,
    user: body.user,
    workspace: body.workspace,
    legal: body.legal,
  };
}

export type CloudRestoreStage = "auth_refresh" | "cloud_status" | "lifecycle_resume";
export type CloudRestoreCategory = "network" | "service" | "authentication";
export type CloudRestoreCode =
  | "network_unavailable"
  | "service_unavailable"
  | "authentication_invalid"
  | "authentication_required"
  | "email_not_verified"
  | "device_revoked"
  | "membership_revoked"
  | "response_invalid";

export class CloudSessionRestoreError extends Error {
  constructor(
    message: string,
    readonly stage: CloudRestoreStage,
    readonly retryable: boolean,
    readonly category: CloudRestoreCategory,
    readonly code: CloudRestoreCode,
  ) {
    super(message);
    this.name = "CloudSessionRestoreError";
  }
}

const CLOUD_RESTORE_STAGES = new Set<CloudRestoreStage>(["auth_refresh", "cloud_status", "lifecycle_resume"]);
const CLOUD_RESTORE_CATEGORIES = new Set<CloudRestoreCategory>(["network", "service", "authentication"]);
const CLOUD_RESTORE_CODES = new Set<CloudRestoreCode>([
  "network_unavailable",
  "service_unavailable",
  "authentication_invalid",
  "authentication_required",
  "email_not_verified",
  "device_revoked",
  "membership_revoked",
  "response_invalid",
]);

async function cloudAuthAction(action: string, input: Record<string, string | boolean>): Promise<any> {
  const path = `/ui/api/cloud-auth/${action}`;
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await apiJson(response, path);
  if (!response.ok || body.ok !== true) {
    if (
      action === "restore"
      && typeof body.error === "string"
      && CLOUD_RESTORE_STAGES.has(body.stage)
      && typeof body.retryable === "boolean"
      && CLOUD_RESTORE_CATEGORIES.has(body.category)
      && CLOUD_RESTORE_CODES.has(body.code)
    ) {
      throw new CloudSessionRestoreError(body.error, body.stage, body.retryable, body.category, body.code);
    }
    throw new Error(body.error || "Cloud authentication failed");
  }
  return body;
}

export const signUpCloud = (email: string, password: string) =>
  cloudAuthAction("signup", { email, password });
export const resendCloudSignUp = (email: string) => cloudAuthAction("resend-signup", { email });
export const signInCloud = (email: string, password: string, queueKey?: string) =>
  cloudAuthAction("signin", { email, password, ...(queueKey ? { queueKey } : {}) });
export const restoreCloudSession = (
  refreshToken: string,
  deviceCredential: string,
  queueKey: string,
  resumeLifecycle = false,
) => cloudAuthAction("restore", {
  refreshToken,
  deviceCredential,
  queueKey,
  ...(resumeLifecycle ? { resumeLifecycle: true } : {}),
});
export const forgetCloudSession = () => cloudAuthAction("forget", {});
export const signOutCloud = () => cloudAuthAction("signout", {});
export const acceptCloudLegal = () => cloudAuthAction("accept-legal", {});
export const acceptCloudInvitation = (code: string) => cloudAuthAction("accept-invitation", { code });

export interface CloudTeamState {
  folders: Array<{ name: string; archivedAt: number | null; permission: "view" | "edit" }>;
  members: Array<{
    accountId: string; email: string; role: "owner" | "admin" | "member"; joinedAt: number;
    grants: Array<{ folderName: string; accountId: string; permission: "view" | "edit" }>;
  }>;
  invitations: Array<{
    id: string; email: string; role: "admin" | "member"; expiresAt: number;
    acceptedAt: number | null; revokedAt: number | null; createdAt: number;
  }>;
}

export async function fetchCloudTeam(): Promise<CloudTeamState> {
  const path = "/ui/api/cloud-workspace";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (!response.ok || body.ok !== true) throw new Error(body.error || "Cloud team is unavailable");
  return { folders: body.folders, members: body.members, invitations: body.invitations };
}

export async function cloudWorkspaceAction(action: string, input: Record<string, string>): Promise<any> {
  const path = "/ui/api/cloud-workspace";
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }),
  });
  const body = await apiJson(response, path);
  if (!response.ok || body.ok !== true) throw new Error(body.error || "Cloud workspace action failed");
  return body;
}

export async function fetchLogs(): Promise<{ file: string; content: string }> {
  const path = "/ui/api/logs";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (body.ok !== true) throw new Error(body.error || "logs are unavailable");
  return { file: String(body.file), content: String(body.content ?? "") };
}

export async function fetchHealth(): Promise<HealthResult> {
  const path = "/ui/api/health";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (body.ok !== true) throw new Error(body.error || "AliasMode health check failed");
  return { ok: true, version: String(body.version ?? "unknown"), root: String(body.root ?? ""), ...(typeof body.logDir === "string" ? { logDir: body.logDir } : {}) };
}

/** Never leak an HTML fallback into a raw JSON.parse SyntaxError. A dashboard
 * bundle and its local server can briefly differ after an update/restart. */
async function apiJson(response: Response, path: string): Promise<any> {
  const text = await response.text();
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    const contentType = response.headers.get("content-type") || "unknown content type";
    const guidance = response.status >= 500
      ? "The local server failed before it could return JSON; check aliasmode.log, restart AliasMode, then reload this page."
      : "The dashboard and local server may be on different versions; stop AliasMode, update it, restart it, then reload this page.";
    throw new Error(
      `AliasMode API ${path} returned non-JSON (${response.status}, ${contentType}). ` +
      guidance,
    );
  }
}

async function post(path: string): Promise<any> {
  const r = await fetch(path, { method: "POST" });
  return apiJson(r, path);
}

export async function fetchProfiles(): Promise<UiRoster> {
  const path = "/ui/api/profiles";
  const r = await fetch(path);
  const body = await apiJson(r, path);
  if (!Array.isArray(body.profiles)) throw new Error(body.error || "AliasMode API returned no profile roster");
  return {
    profiles: body.profiles,
    healthSources: Array.isArray(body.healthSources) ? body.healthSources : [],
  };
}

export const openProfile = (id: string, force = false) =>
  post(`/ui/api/profiles/${encodeURIComponent(id)}/open${force ? "?force=1" : ""}`);
export const closeProfile = (id: string) => post(`/ui/api/profiles/${encodeURIComponent(id)}/close`);
export const raiseProfile = (id: string) => post(`/ui/api/profiles/${encodeURIComponent(id)}/raise`);
export const importInbox = () => post("/ui/api/import");

// ---- Extensions registry ----------------------------------------------------
export interface Extension { id: string; name: string; }
export async function fetchExtensions(): Promise<Extension[]> {
  const path = "/ui/api/extensions";
  const r = await fetch(path);
  const b = await apiJson(r, path);
  return b.ok ? b.extensions : [];
}
export async function uploadExtensions(files: FileList | File[]): Promise<any> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append("files", f);
  const path = "/ui/api/extensions/upload";
  const r = await fetch(path, { method: "POST", body: form });
  return apiJson(r, path);
}
export async function removeExtension(id: string): Promise<any> {
  const r = await fetch("/ui/api/extensions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return apiJson(r, "/ui/api/extensions/delete");
}

/** Bulk add/remove one extension across the selected profiles. */
export async function assignExtensionBulk(ids: string[], extensionId: string, op: "add" | "remove"): Promise<any> {
  const r = await fetch("/ui/api/profiles/extensions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, extensionId, op }),
  });
  return apiJson(r, "/ui/api/profiles/extensions");
}

export async function uploadExports(
  files: FileList | File[],
  assign?: { group?: string; platform?: string },
): Promise<any> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append("files", f);
  if (assign?.group) form.append("group", assign.group);
  if (assign?.platform) form.append("platform", assign.platform);
  const path = "/ui/api/import/upload";
  const r = await fetch(path, { method: "POST", body: form });
  return apiJson(r, path);
}

export async function moveProfiles(ids: string[], group: string): Promise<any> {
  const r = await fetch("/ui/api/profiles/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, group }),
  });
  return apiJson(r, "/ui/api/profiles/move");
}

export async function deleteProfiles(ids: string[]): Promise<any> {
  const r = await fetch("/ui/api/profiles/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return apiJson(r, "/ui/api/profiles/delete");
}

export interface NewProfileInput {
  name?: string;
  group?: string;
  platform?: string;
  proxy?: { type: string; host: string; port: string; user: string; pass: string } | null;
  screen?: string;
}

export async function createProfile(input: NewProfileInput): Promise<any> {
  const r = await fetch("/ui/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return apiJson(r, "/ui/api/profiles");
}

export async function fetchDiagnose(): Promise<DiagnoseReport | null> {
  const path = "/ui/api/diagnose/latest";
  const r = await fetch(path);
  return (await apiJson(r, path)).report;
}

// ---- Edit one profile (full detail, incl. secrets — loopback-only) ----------
export interface EditProfile {
  id: string;
  name: string;
  group: string;
  platform: string;
  proxyType: string;
  /** Full "host:port[:user:pass]". */
  proxy: string;
  proxyError?: string;
  username: string;
  password: string;
  email: string;
  emailPassword: string;
  twofa: string;
  /** "1920*1080". */
  resolution: string;
  /** Ids of extensions assigned to this profile. */
  extensions: string[];
  /** Comma-separated custom tags. */
  tags: string;
  cookieCount: number;
  seeded: boolean;
  mobilePersona: boolean;
  desktopConversion?: {
    platform: "windows" | "macos";
    resolution: string;
    screenChanged: boolean;
  };
  /** Present only for Cloud profiles and required for optimistic saves. */
  expectedVersion?: number;
}

// ---- 2FA authenticator: current TOTP code (never the secret) ----------------
export interface TotpResult { code: string | null; secondsRemaining?: number; period?: number; }
export async function fetchTotp(id: string): Promise<TotpResult> {
  const path = `/ui/api/profiles/${encodeURIComponent(id)}/totp`;
  const r = await fetch(path);
  const body = await apiJson(r, path);
  if (!body.ok) throw new Error(body.error || "2FA failed");
  return { code: body.code, secondsRemaining: body.secondsRemaining, period: body.period };
}

export async function fetchProfileEdit(id: string): Promise<EditProfile> {
  const path = `/ui/api/profiles/${encodeURIComponent(id)}`;
  const r = await fetch(path);
  const body = await apiJson(r, path);
  if (!body.ok) throw new Error(body.error || "load failed");
  return body.profile;
}

export async function updateProfile(id: string, set: Record<string, unknown>, expectedVersion?: number): Promise<any> {
  const r = await fetch(`/ui/api/profiles/${encodeURIComponent(id)}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ set, ...(expectedVersion === undefined ? {} : { expectedVersion }) }),
  });
  const body = await apiJson(r, `/ui/api/profiles/${encodeURIComponent(id)}/update`);
  return { ...body, status: r.status };
}

export async function convertMobileProfile(id: string): Promise<any> {
  return post(`/ui/api/profiles/${encodeURIComponent(id)}/convert-mobile`);
}

// ---- Export selected → download a CSV / AdsPower .txt ------------------------
export async function exportProfiles(ids: string[], format: "csv" | "txt"): Promise<void> {
  const r = await fetch("/ui/api/profiles/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, format }),
  });
  if (!r.ok) throw new Error("export failed");
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aliasmode-export.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- File-based bulk update (re-upload an edited export) ---------------------
export async function updateFromFile(files: FileList | File[]): Promise<any> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append("files", f);
  const path = "/ui/api/profiles/update-file";
  const r = await fetch(path, { method: "POST", body: form });
  return apiJson(r, path);
}

// ---- Group rename / delete --------------------------------------------------
export async function renameGroup(from: string, to: string): Promise<any> {
  const r = await fetch("/ui/api/groups/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  return apiJson(r, "/ui/api/groups/rename");
}

export async function deleteGroup(name: string): Promise<any> {
  const r = await fetch("/ui/api/groups/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return apiJson(r, "/ui/api/groups/delete");
}

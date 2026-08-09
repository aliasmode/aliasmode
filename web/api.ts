/** Typed client for the dashboard's /ui/api/* endpoints. */

export type HealthStatus = "suspended" | "alive" | "no_data";

export interface UiProfile {
  id: string;
  name: string;
  group: string;
  /** Account platform: "x.com", "telegram.org", or "" (none). */
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

export interface HealthResult { ok: boolean; version: string; root: string; }

export async function fetchHealth(): Promise<HealthResult> {
  const path = "/ui/api/health";
  const response = await fetch(path);
  const body = await apiJson(response, path);
  if (body.ok !== true) throw new Error(body.error || "AliasMode health check failed");
  return { ok: true, version: String(body.version ?? "unknown"), root: String(body.root ?? "") };
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

export async function updateProfile(id: string, set: Record<string, unknown>): Promise<any> {
  const r = await fetch(`/ui/api/profiles/${encodeURIComponent(id)}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ set }),
  });
  return apiJson(r, `/ui/api/profiles/${encodeURIComponent(id)}/update`);
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

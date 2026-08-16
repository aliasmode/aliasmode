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

import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { AutomationHealthStatus } from "./remote-types.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { AppConfigStore } from "./app-config.ts";
import type { CloudAuthRuntime } from "./cloud-auth.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import { normalizeCloudDiagnostics } from "./cloud-diagnostics.ts";
import { CloudApiError } from "./cloud-client.ts";
import {
  CloudProfileEditor,
  CloudProfileEditorError,
  cloudProfileEditorErrorStatus,
} from "./cloud-profile-editor.ts";
import type { PendingSyncRuntime } from "./pending-sync.ts";
import type { StatePaths } from "./paths.ts";
import type { Profile } from "./types.ts";
import { importInbox, importBuffers, type ImportOverrides } from "./inbox.ts";
import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { attachTimezones } from "./geoip.ts";
import { parseUpdateFile, serializeCsv, serializeAdsTxt, parseStrictProxy, parseStrictResolution, decodeText } from "./parse.ts";
import { generateTotp } from "./totp.ts";
import { installExtension, removeExtensionFiles } from "./extensions.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "./profile-id.ts";
import { proxyHostPort, proxyLegacyString } from "./proxy.ts";
import { convertMobilePersonaToDesktop, isMobileUserAgent } from "./fingerprint.ts";
import { join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

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
  running: boolean;
  debugPort?: number;
  startedAt?: number;
  healthStatus?: AutomationHealthStatus;
  healthObservedAt?: number | null;
}

/**
 * Map the store into redacted UiProfiles joined with running state. Status comes
 * from the launches table, which is authoritative for every browser THIS manager
 * started — campaign-launched or dashboard-launched alike (one manager per box).
 */
export function listUiProfiles(store: ProfileStore): UiProfile[] {
  const launches = new Map(store.listLaunches().map((l) => [l.profileId, l]));
  return store.listProfiles().map((p) => {
    const l = launches.get(p.id);
    return {
      id: p.id,
      name: p.name,
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
      mobilePersona: isMobileUserAgent(p.ua),
      running: !!l,
      debugPort: l?.debugPort,
      startedAt: l?.startedAt,
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
function profileEditView(p: Profile) {
  const px = p.proxy;
  const proxy = px ? proxyLegacyString(px) : "";
  const conversion = isMobileUserAgent(p.ua) ? convertMobilePersonaToDesktop(p) : null;
  return {
    id: p.id, name: p.name, group: p.group, platform: p.platform ?? "",
    proxyType: px?.type ?? "http", proxy,
    ...(p.proxyError ? { proxyError: p.proxyError } : {}),
    username: p.username, password: p.password,
    email: p.email ?? "", emailPassword: p.emailPassword ?? "", twofa: p.twofa,
    resolution: `${p.screenWidth}*${p.screenHeight}`,
    extensions: p.extensions ?? [],
    tags: (p.tags ?? []).join(", "),
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

/**
 * Apply a partial field set onto a profile in place. Only keys present in `set`
 * change — everything else (cookies, fingerprint seed, seeded) is preserved.
 * This is what makes single-edit and file bulk-update safe. Shared by both.
 */
function applyEdits(p: Profile, set: Record<string, unknown>): void {
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
    p.screenWidth = r.width;
    p.screenHeight = r.height;
  }
  if ("proxy" in set) {
    p.proxy = parseStrictProxy(set.proxyType ?? p.proxy?.type ?? "http", set.proxy);
    delete p.proxyError;
    // A timezone belongs to a particular egress. Passing an empty value lets
    // store persistence preserve it only when the canonical proxy is unchanged.
    p.timezone = "";
  }
  if ("extensions" in set) {
    p.extensions = Array.isArray(set.extensions) ? set.extensions.map(String) : [];
  }
  if ("tags" in set) {
    p.tags = Array.isArray(set.tags)
      ? set.tags.map(String)
      : String(set.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  }
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
  appConfig?: AppConfigStore;
  paths?: StatePaths;
  defaultCloudUrl?: string;
  cloudAuth?: CloudAuthRuntime;
  cloudConnection?: CloudConnectionRuntime;
  pendingSync?: PendingSyncRuntime;
  cloudBrowser?: CloudBrowserLifecycle;
  health?: UiHealthMetadata | null;
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

  // Dependency-free readiness probe for the Windows updater. Unlike the
  // profile roster it does not touch CDP, the process scanner, SQLite rows, or
  // the remote hub, so an upstream outage cannot masquerade as a failed update.
  if (pathname === "/ui/api/health" && req.method === "GET") {
    const logDir = options.paths ? join(options.paths.root, "logs") : undefined;
    return Response.json(options.health
      ? { ok: true, ...options.health, ...(logDir ? { logDir } : {}) }
      : { ok: true, version: await appVersion(), root: APPLICATION_ROOT, ...(logDir ? { logDir } : {}) });
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
      ...(options.runtimeMode ? { restartRequired: config.mode !== options.runtimeMode } : {}),
    });
  }

  if (pathname === "/ui/api/cloud-events" && req.method === "GET") {
    return Response.json(
      { events: normalizeCloudDiagnostics(options.cloudBrowser?.diagnostics?.() ?? []) },
      { headers: { "Cache-Control": "no-store" } },
    );
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
    try {
      const body = await req.json() as {
        email?: unknown;
        password?: unknown;
        refreshToken?: unknown;
        deviceId?: unknown;
        deviceCredential?: unknown;
        queueKey?: unknown;
        code?: unknown;
      };
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
      if (pathname === "/ui/api/cloud-auth/signin") {
        if (typeof body.email !== "string" || typeof body.password !== "string") {
          return Response.json({ ok: false, error: "email and password are required" }, { status: 400 });
        }
        if (!options.cloudConnection || !options.pendingSync) {
          return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
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
          const bootstrap = await options.cloudConnection.bootstrap();
          const initialized = pending ?? options.pendingSync.initialize();
          if (legalAcceptanceIsCurrent(bootstrap.legal)) {
            await options.cloudBrowser?.resumeAfterAuthentication();
          } else {
            await options.cloudBrowser?.secureAfterAuthentication();
          }
          return Response.json({
            ok: true,
            authenticated: true,
            refreshToken: result.refreshToken,
            deviceId: bootstrap.device.id,
            deviceCredential: bootstrap.deviceCredential,
            ...(initialized.createdKey ? { queueKey: initialized.createdKey } : {}),
            expiresAt: result.expiresAt,
            legal: bootstrap.legal,
            workspace: bootstrap.workspace,
            user: { id: result.user?.id, email: result.user?.email },
          });
        } catch (error) {
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
        try {
          const queueWasInitialized = !!options.pendingSync.queue();
          if (!queueWasInitialized) options.pendingSync.initialize(body.queueKey);
          const priorAccountId = options.cloudConnection.accountId();
          const result = await options.cloudAuth.restore(body.refreshToken);
          options.cloudConnection.restoreCredential(body.deviceCredential);
          const status = await options.cloudConnection.client.status();
          options.cloudConnection.restoreAccount(status.account.id);
          options.cloudConnection.restoreDevice(status.device.id, body.deviceCredential);
          if (
            legalAcceptanceIsCurrent(status.legal) &&
            (!queueWasInitialized || (priorAccountId && priorAccountId !== status.account.id))
          ) {
            await options.cloudBrowser?.resumeAfterAuthentication();
          } else {
            await options.cloudBrowser?.secureAfterAuthentication();
          }
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
          options.pendingSync.close();
          options.cloudAuth.clear();
          options.cloudConnection.clearDevice();
          throw error;
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
        const accepted = await options.cloudConnection.client.acceptLegal({ versions: status.legal.current });
        await options.cloudBrowser?.resumeAfterAuthentication();
        return Response.json({
          ok: true,
          legal: { current: status.legal.current, accepted: accepted.accepted },
        });
      }
      if (pathname === "/ui/api/cloud-auth/signout") {
        if (options.cloudBrowser && !await options.cloudBrowser.releaseAll()) {
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
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
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
      if (action === "create-folder") return Response.json(await cloud.createFolder(String(body.name ?? "")));
      if (action === "resend") return Response.json(await cloud.resendInvitation(String(body.id ?? "")));
      if (action === "revoke") return Response.json(await cloud.revokeInvitation(String(body.id ?? "")));
      if (action === "role") return Response.json(await cloud.changeMemberRole(String(body.accountId ?? ""), body.role === "admin" ? "admin" : "member"));
      if (action === "remove-member") return Response.json(await cloud.removeMember(String(body.accountId ?? "")));
      if (action === "grant") return Response.json(await cloud.setFolderGrant(String(body.folderName ?? ""), String(body.accountId ?? ""), body.permission === "edit" ? "edit" : "view"));
      if (action === "remove-grant") return Response.json(await cloud.removeFolderGrant(String(body.folderName ?? ""), String(body.accountId ?? "")));
      return Response.json({ ok: false, error: "unknown Cloud workspace action" }, { status: 400 });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }

  if (options.appConfig?.read().mode === "cloud" && !remote && !options.cloudBrowser) {
    return Response.json(
      { ok: false, error: "AliasMode Cloud authentication is required" },
      { status: 503 },
    );
  }

  const cloudLifecycleRoute =
    (pathname === "/ui/api/profiles" && (req.method === "GET" || req.method === "POST")) ||
    (pathname === "/ui/api/profiles/move" && req.method === "POST") ||
    (pathname === "/ui/api/profiles/delete" && req.method === "POST") ||
    (pathname === "/ui/api/groups/rename" && req.method === "POST") ||
    (req.method === "POST" && /^\/ui\/api\/profiles\/[^/]+\/(open|close|clear-cache)$/.test(pathname));
  const cloudEditorRoute =
    (req.method === "GET" && /^\/ui\/api\/profiles\/[^/]+$/.test(pathname)) ||
    (req.method === "POST" && /^\/ui\/api\/profiles\/[^/]+\/update$/.test(pathname));
  if (
    options.appConfig?.read().mode === "cloud" &&
    options.cloudBrowser &&
    !remote &&
    !cloudLifecycleRoute &&
    !cloudEditorRoute
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
          const l = store.getLaunch(p.id);
          return { ...p, running: !!l, debugPort: l?.debugPort };
        });
        return Response.json({ profiles, healthSources: roster.healthSources });
      }
      // Probe live CDP ports and clear stale launch rows first: a crash or an
      // external debug-port teardown leaves the row in SQLite, which would
      // otherwise show "running" forever and hide the Open action. reconcileOrphans
      // probes active() per launch and drops dead rows (it never kills processes).
      await launcher.reconcileOrphans();
      return Response.json({ profiles: listUiProfiles(store), healthSources: [] });
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
      if (remote) {
        const { id } = await remote.createProfile(input);
        return Response.json({ ok: true, id });
      }
      const profile = buildNewProfile(input, (id) => !!store.getProfile(id));
      if (profile.proxy) await attachTimezones([profile]).catch(() => {}); // best-effort tz
      if (options.cloudBrowser) {
        return Response.json({ ok: true, ...await options.cloudBrowser.create(profile) });
      }
      store.upsertProfile(profile);
      return Response.json({ ok: true, id: profile.id });
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
        const editor = new CloudProfileEditor(options.cloudConnection!.client, store);
        const locked: string[] = [];
        const failed: string[] = [];
        let deleted = 0;
        for (const id of ids) {
          try {
            const expectedVersion = await editor.closedProfileVersion(id);
            await options.cloudConnection!.client.trashProfile(id, { expectedVersion });
            deleted++;
          } catch (error) {
            if (
              error instanceof CloudProfileEditorError && error.status === 409 ||
              error instanceof CloudApiError && error.status === 409 && error.code === "profile_open"
            ) {
              locked.push(id);
            } else {
              failed.push(id);
            }
          }
        }
        return Response.json({ ok: true, deleted, locked, failed });
      }
      if (remote) {
        const r = await remote.deleteProfiles(ids);
        return Response.json({ ok: true, ...r });
      }
      // Standalone deletion never closes a browser implicitly. Preflight the
      // full selection before mutation so a mixed open/closed batch is atomic.
      const existing = ids.filter((id) => store.getProfile(id));
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
        launcher.removeUserDataDir(id);
        store.deleteProfile(id);
        deleted++;
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
      for (const [, value] of form) {
        if (value instanceof File) uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
      if (uploads.length === 0) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });
      const r = remote ? await remote.importToHub(uploads, override) : await importBuffers(store, uploads, console.log, override);
      return Response.json({ ok: true, ...r });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
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

  if (pathname === "/ui/api/profiles/export" && req.method === "POST") {
    // Export selected profiles for offline editing. Returns the file directly
    // (not JSON) so the browser saves it. Both formats carry `id` so the file
    // can be re-uploaded through /ui/api/profiles/update-file.
    try {
      const body = (await req.json()) as { ids?: unknown; format?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const format = body.format === "txt" ? "txt" : "csv";
      // Remote mode: the roster (and the secrets export needs) live on the hub —
      // the local store is just a launch cache, so reading it here would silently
      // drop every selected account that wasn't opened on this machine. Pull each
      // from the hub instead, the same full-fidelity fetch Open/Edit already use.
      const profiles = remote
        ? await remote.getProfiles(ids, format === "txt")
        : ids.map((id) => store.getProfile(id)).filter((p): p is Profile => !!p);
      const text = format === "txt" ? serializeAdsTxt(profiles) : serializeCsv(profiles);
      return new Response(text, {
        headers: {
          "content-type": `${format === "txt" ? "text/plain" : "text/csv"}; charset=utf-8`,
          "content-disposition": `attachment; filename=aliasmode-export.${format}`,
        },
      });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
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
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const summary = parseUpdateFile(decodeText(new Uint8Array(await value.arrayBuffer())));
        skipped += summary.skipped;
        for (const u of summary.updates) {
          if (!isSafeProfileId(u.id)) {
            errors.push({ id: u.id, error: PROFILE_ID_ERROR });
            continue;
          }
          const p = pending.get(u.id) ?? store.getProfile(u.id);
          if (!p) { notFound.push(u.id); continue; }
          try {
            applyEdits(p, u.set);
            pending.set(u.id, p);
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
      const liveIds = [...pending.keys()].filter((id) => !!store.getLaunch(id));
      if (liveIds.length > 0) {
        return Response.json(
          { ok: false, error: `profile(s) ${liveIds.join(", ")} are currently open; no profiles were changed` },
          { status: 409 },
        );
      }
      store.upsertProfiles([...pending.values()]);
      updated = pending.size;
      return Response.json({ ok: true, updated, skipped, notFound, errors: [] });
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
      return Response.json({ ok: true, moved: store.renameGroup(from, to) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
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

  // --- Extensions registry (upload / list / delete) ---
  if (pathname === "/ui/api/extensions" && req.method === "GET") {
    return Response.json({ ok: true, extensions: store.listExtensions().map((e) => ({ id: e.id, name: e.name })) });
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
      if (add && !store.getExtension(extId)) return Response.json({ ok: false, error: "unknown extension" }, { status: 404 });
      const liveIds = [...new Set(ids.filter((id) => !!store.getLaunch(id)))];
      if (liveIds.length > 0) {
        return Response.json(
          { ok: false, error: `profile(s) ${liveIds.join(", ")} are currently open; no extension assignments were changed` },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, updated: store.assignExtension(ids, extId, add) });
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
      await launcher.bringToFront(decodeURIComponent(raise[1]!));
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
      if (!options.cloudConnection) {
        return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
      }
      try {
        const editor = new CloudProfileEditor(options.cloudConnection.client, store);
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
        if (!options.cloudConnection) {
          return Response.json({ ok: false, error: "AliasMode Cloud connection is unavailable" }, { status: 503 });
        }
        const body = (await req.json()) as { expectedVersion?: unknown; set?: unknown };
        const set = body.set && typeof body.set === "object" && !Array.isArray(body.set)
          ? body.set as Record<string, unknown>
          : {};
        const editor = new CloudProfileEditor(options.cloudConnection.client, store);
        await editor.save(id, body.expectedVersion as number, set);
        return Response.json({ ok: true });
      }
      const body = (await req.json()) as { set?: unknown };
      const set = body.set && typeof body.set === "object" ? (body.set as Record<string, unknown>) : {};
      // Remote: fetch the live profile from the hub, apply the edits, save it back. Local: the store.
      const p = remote ? await remote.getProfile(id).catch(() => null) : store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (!remote && store.getLaunch(id)) {
        return Response.json(
          { ok: false, error: "profile is currently open; close it before editing identity fields" },
          { status: 409 },
        );
      }
      applyEdits(p, set);
      if (remote) await remote.saveProfile(p);
      else store.upsertProfile(p);
      return Response.json({ ok: true });
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

  const action = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/(open|close|clear-cache)$/);
  if (action && req.method === "POST") {
    const id = decodeURIComponent(action[1]!);
    if (options.cloudBrowser) {
      try {
        if (action[2] === "open") {
          const result = await options.cloudBrowser.open(id);
          return result.ok
            ? Response.json({ ok: true, port: result.port, warning: result.warning })
            : Response.json({ ok: false, error: result.error ?? "open failed" }, { status: 500 });
        }
        if (action[2] === "close") {
          return await options.cloudBrowser.close(id)
            ? Response.json({ ok: true })
            : Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
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
          const r = await remote.open(id, [], force);
          if (r.ok) return Response.json({ ok: true, port: r.port, warning: r.warning });
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
    if (!store.getProfile(id)) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    try {
      if (action[2] === "open") {
        const r = await launcher.start(id);
        return Response.json({ ok: true, port: r.port });
      }
      if (action[2] === "close") {
        return (await launcher.stop(id))
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
      }
      const r = await launcher.clearCache(id);
      return Response.json({ ok: true, cleared: r.cleared });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
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

/**
 * AdsPower-shaped HTTP facade over the CloakBrowser Launcher.
 *
 * Automation clients can use this exactly as they use AdsPower's local API — same
 * routes, same JSON envelope — so `startAdsPowerProfile(profileId, baseUrl)`
 * works unchanged when `baseUrl` points here. The shapes below are dictated by
 * what src/browser.ts parses:
 *   start  -> data.data.ws.puppeteer, data.data.debug_port
 *   active -> data.data.status === "Inactive"
 *   status -> data.code === 0 (health)
 */

import type { Launcher } from "./launcher.ts";
import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import {
  normalizeProfileIds,
  type LifecycleAdmissionController,
  type LifecycleState,
} from "./lifecycle-admission.ts";
import { harvestCookies } from "./session.ts";
import { isSafeProfileId } from "./profile-id.ts";
import type { AutomationHealthEntry } from "./remote-types.ts";

function ok(data?: unknown) {
  return Response.json({ code: 0, msg: "success", data: data ?? {} });
}
function fail(msg: string) {
  return Response.json({ code: -1, msg, data: {} });
}

export interface BrowserLifecycleContext {
  admission?: LifecycleAdmissionController;
  remote?: Pick<RemoteCoordinator, "lifecycleState" | "publishAutomationHealthSnapshot">;
}

function currentLifecycle(profileId: string, lifecycle?: BrowserLifecycleContext): LifecycleState | null {
  const states = [
    lifecycle?.admission?.lifecycleState(profileId),
    lifecycle?.remote?.lifecycleState(profileId),
  ];
  if (states.includes("stopping")) return "stopping";
  if (states.includes("uncertain")) return "uncertain";
  return states.includes("starting") ? "starting" : null;
}

async function activeResponse(
  profileId: string,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const beforeState = currentLifecycle(profileId, lifecycle);
  if (beforeState) return ok({ status: "Active", lifecycle: beforeState });

  // Durable ownership is intentionally checked before certification. In the
  // confirmed-absence case there is nothing to probe or wait behind.
  if (!store.getLaunch(profileId)) return ok({ status: "Inactive" });

  const alive = await launcher.certifiedActive(profileId).catch(() => false);
  const afterState = currentLifecycle(profileId, lifecycle);
  if (afterState) return ok({ status: "Active", lifecycle: afterState });

  const launch = store.getLaunch(profileId);
  if (alive && launch?.ws) {
    return ok({ status: "Active", lifecycle: "running", ws: { puppeteer: launch.ws, selenium: "" } });
  }
  // Certification can fail while ownership-safe teardown remains unconfirmed.
  // Keep that durable generation visible without exposing an uncertified CDP URL.
  if (launch) return ok({ status: "Active", lifecycle: "uncertain" });
  return ok({ status: "Inactive" });
}

function parseLaunchArgs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function healthSnapshotEntries(value: unknown): AutomationHealthEntry[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ["profiles"]) || !Array.isArray(body.profiles)) return null;
  const profiles: AutomationHealthEntry[] = [];
  for (const value of body.profiles) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const profile = value as Record<string, unknown>;
    if (!exactKeys(profile, ["profileId", "suspended"])) return null;
    if (typeof profile.profileId !== "string" || !isSafeProfileId(profile.profileId)) return null;
    if (typeof profile.suspended !== "boolean") return null;
    profiles.push({ profileId: profile.profileId, suspended: profile.suspended });
  }
  return profiles;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  return !!address && (address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127."));
}

export function isAllowedHealthOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export async function handleAutomationHealthSnapshot(
  req: Request,
  remote: Pick<RemoteCoordinator, "publishAutomationHealthSnapshot">,
): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }
  const contentType = (req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ ok: false, error: "content-type must be application/json" }, { status: 415 });
  }
  if (!isAllowedHealthOrigin(req.headers.get("origin"))) {
    return Response.json({ ok: false, error: "non-local origin forbidden" }, { status: 403 });
  }
  const profiles = healthSnapshotEntries(await req.json().catch(() => null));
  if (!profiles) {
    return Response.json(
      { ok: false, error: "body must be exactly { profiles: [{ profileId, suspended }] }" },
      { status: 400 },
    );
  }
  try {
    const counts = await remote.publishAutomationHealthSnapshot(profiles);
    return Response.json({ ok: true, ...counts });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

/** Handle one request. Exposed so the dashboard server (web.ts) and tests can call it directly. */
export async function handleRequest(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;
  const userId = searchParams.get("user_id") ?? "";

  if (pathname === "/api/xactions/health-snapshot") {
    if (!lifecycle?.remote) {
      return Response.json({ ok: false, error: "remote hub is not configured" }, { status: 503 });
    }
    return handleAutomationHealthSnapshot(req, lifecycle.remote);
  }

  // `/status` is the path AdsPower's own local API serves; `/api/v1/status`
  // is accepted for compatibility, so any AdsPower REST client is a base-URL flip.
  if (pathname === "/api/v1/status" || pathname === "/status") {
    return lifecycle?.admission
      ? ok({ admission: lifecycle.admission.stats() })
      : ok();
  }

  if (pathname === "/api/v1/browser/start") {
    if (!userId) return fail("missing user_id");
    if (!store.getProfile(userId)) return fail(`no such profile: ${userId}`);
    try {
      const launchArgs = parseLaunchArgs(searchParams.get("launch_args"));
      const { ws, port } = await launcher.start(userId, launchArgs);
      return ok({
        ws: { puppeteer: ws, selenium: "" },
        debug_port: String(port),
        webdriver: "",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (pathname === "/api/v1/browser/stop") {
    if (!userId) return fail("missing user_id");
    return (await launcher.stop(userId))
      ? ok()
      : fail(`browser teardown unconfirmed: ${userId}`);
  }

  // Cookie harvest is an AliasMode extension to the AdsPower API. The browser
  // can reject raw CDP cookie reads, so this route uses Playwright's
  // context.cookies() and returns the result as JSON.
  //   GET /api/v1/browser/cookies?user_id=<id>&urls=https://x.com,https://twitter.com
  //   -> { code:0, data:{ cookies:[{name,value,domain,path,httpOnly,secure,expires,sameSite}, ...] } }
  if (pathname === "/api/v1/browser/cookies") {
    if (!userId) return fail("missing user_id");
    if (!(await launcher.certifiedActive(userId))) return fail(`profile not safely running: ${userId}`);
    const launch = store.getLaunch(userId);
    if (!launch || !launch.ws) return fail(`profile not running: ${userId}`);
    const urlsParam = searchParams.get("urls");
    const urls = urlsParam
      ? urlsParam.split(",").map((u) => u.trim()).filter(Boolean)
      : ["https://x.com", "https://twitter.com"];
    try {
      const cookies = await harvestCookies(launch.ws, urls);
      return ok({ cookies });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (pathname === "/api/v1/browser/active") {
    if (!userId) return fail("missing user_id");
    return activeResponse(userId, launcher, store, lifecycle);
  }

  if (pathname === "/api/v2/browser-profile/delete-cache") {
    // Compatibility clients may fire-and-forget this after each session:
    //   POST { profile_id: [id], type: ["image_file"] }
    // Trim the profile's disk caches so user-data dirs don't grow unbounded.
    let ids: string[] = [];
    try {
      const body = (await req.json()) as { profile_id?: unknown };
      ids = normalizeProfileIds(body?.profile_id);
    } catch {
      /* missing/invalid body → nothing to clear */
    }
    for (const id of ids) await launcher.clearCache(id);
    return ok();
  }

  return fail(`unknown route: ${pathname}`);
}

/**
 * True for the AdsPower browser-control routes that remote mode must NOT serve
 * locally — doing so would bypass hub session roaming and writer coordination.
 * `status` and `delete-cache` are intentionally excluded (safe to pass through).
 */
export function isAdsPowerBrowserControl(pathname: string): boolean {
  return /^\/api\/v1\/browser\/(start|stop|active)$/.test(pathname);
}

/**
 * Remote-mode AdsPower control: serve compatible start/stop/active calls through
 * the coordinator so launches restore the roamed session. A competing writer
 * produces a successful launch with a warning; only the lease owner checkpoints
 * the session. Same wire shapes as handleRequest, so clients work unchanged.
 */
export async function handleRemoteBrowserControl(
  req: Request,
  coord: RemoteCoordinator,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id") ?? "";
  if (!userId) return fail("missing user_id");

  // A thrown error here (hub unreachable, token revoked, unknown profile —
  // coord.open() throws on a failed hub call before it can return {ok:false})
  // must NOT bubble as a 500/non-JSON: startAdsPowerProfile() parses the body
  // and code unconditionally, so it has to be a clean AdsPower {code:-1}.
  try {
    if (pathname === "/api/v1/browser/start") {
      const r = await coord.open(userId, parseLaunchArgs(searchParams.get("launch_args")));
      if (r.ok) {
        return ok({
          ws: { puppeteer: r.ws, selenium: "" },
          debug_port: String(r.port),
          webdriver: "",
          ...(r.warning ? { warning: r.warning } : {}),
        });
      }
      return fail(r.lockedBy ? `in use by ${r.lockedBy}` : (r.error ?? "open failed"));
    }
    if (pathname === "/api/v1/browser/stop") {
      return (await coord.close(userId))
        ? ok()
        : fail(`browser teardown unconfirmed: ${userId}`);
    }
    return activeResponse(userId, launcher, store, {
      ...lifecycle,
      remote: coord,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Cloud-mode AdsPower control backed by the same lifecycle used by the dashboard. */
export async function handleCloudBrowserControl(
  req: Request,
  cloudBrowser: CloudBrowserLifecycle,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id") ?? "";
  if (!userId) return fail("missing user_id");

  try {
    if (pathname === "/api/v1/browser/start") {
      const result = await cloudBrowser.open(userId, parseLaunchArgs(searchParams.get("launch_args")));
      if (!result.ok) return fail(result.error ?? "open failed");
      if (!result.ws || result.port === undefined) return fail("open returned no browser connection");
      return ok({
        ws: { puppeteer: result.ws, selenium: "" },
        debug_port: String(result.port),
        webdriver: "",
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
    if (pathname === "/api/v1/browser/stop") {
      return (await cloudBrowser.close(userId)).closed
        ? ok()
        : fail(`browser teardown unconfirmed: ${userId}`);
    }
    return activeResponse(userId, launcher, store, lifecycle);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

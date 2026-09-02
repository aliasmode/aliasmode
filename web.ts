/**
 * Dashboard + API server. Serves the Phase A web UI at "/" and routes
 * `/ui/api/*` to the dashboard API, with the AdsPower-compatible API
 * (handleRequest) as the fallback — so automation `/api/v1|v2/*` calls are
 * unaffected. The HTML import lives only here so unit tests (which import
 * server.ts / ui.ts) never trigger React bundling.
 */

import index from "./web/index.html";
import { profileDisplayNo, type Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { AppConfigStore } from "./app-config.ts";
import type { CloudAuthRuntime } from "./cloud-auth.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import type { McpTunnelLifecycle } from "./mcp-tunnel.ts";
import type { PendingSyncRuntime } from "./pending-sync.ts";
import type { StatePaths } from "./paths.ts";
import {
  handleRequest,
  handleRemoteBrowserControl,
  handleCloudBrowserControl,
  handleAutomationHealthSnapshot,
  isAdsPowerBrowserControl,
  isLoopbackAddress,
  type BrowserLifecycleContext,
} from "./server.ts";
import { handleUiRequest, type UiHealthMetadata } from "./ui.ts";
import { handleUserApi } from "./adspower-users.ts";
import {
  AGENT_CONTROL_MAX_MESSAGE_BYTES,
  AGENT_CONTROL_PATH,
  AGENT_CONTROL_PROTOCOL,
  AgentControlHub,
  type AgentControlSession,
  validAgentAuthorization,
} from "./agent-control.ts";
import {
  LifecycleAdmissionController,
  dispatchWithLifecycleAdmission,
  type LifecycleAdmissionOptions,
} from "./lifecycle-admission.ts";

export interface DashboardServerOptions {
  launcher: Launcher;
  store: ProfileStore;
  /** When set, the dashboard routes profiles/open/close/import/move via the hub. */
  remote?: RemoteCoordinator | null;
  appConfig?: AppConfigStore;
  paths?: StatePaths;
  defaultCloudUrl?: string;
  cloudAuth?: CloudAuthRuntime;
  cloudConnection?: CloudConnectionRuntime;
  pendingSync?: PendingSyncRuntime;
  cloudBrowser?: CloudBrowserLifecycle;
  mcpTunnel?: McpTunnelLifecycle;
  port?: number;
  /**
   * Bind address. Loopback only by default — the dashboard and API are
   * unauthenticated and can start/stop browsers, so they must not be reachable
   * from other hosts. Remote access is Phase B (VPS behind Tailscale + auth).
   */
  hostname?: string;
  log?: (msg: string) => void;
  lifecycleAdmissionOptions?: LifecycleAdmissionOptions;
  lifecycleAdmission?: LifecycleAdmissionController;
  health?: UiHealthMetadata | null;
  /** Desktop-generated nonce used by the installed agent adapter. */
  agentNonce?: string;
}

type AgentSocketData = {
  session: AgentControlSession;
};

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c]!);
}

/**
 * AdsPower-style identity card for one profile: Name / Profile-No / Group / Platform /
 * Proxy, plus the live egress IP + geo (fetched by the page THROUGH the browser's proxy,
 * so it shows the account's real exit IP). Served over loopback, which Chromium reaches
 * directly (localhost bypasses the proxy), while ip-api goes out through the proxy.
 */
function renderProfileCard(store: ProfileStore, id: string): Response {
  const p = store.getProfile(id);
  if (!p) return new Response("unknown profile", { status: 404, headers: { "content-type": "text/plain" } });
  // Same number the browser window title and identity bookmark show: the
  // operator's custom NO. first, the store serial as fallback.
  const no = profileDisplayNo(p.customNo, store.getSerial(id)) ?? "?";
  const proxy = p.proxy ? `${p.proxy.type}://${p.proxy.host}:${p.proxy.port}` : "none";
  const title = `${p.name || "profile"} · #${no}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
  .hero{background:linear-gradient(135deg,#1d4ed8,#2563eb);padding:26px;text-align:center}
  .ip{font-size:32px;font-weight:700;letter-spacing:.5px} .geo{opacity:.9;margin-top:4px}
  .card{max-width:640px;margin:22px auto;background:#1e293b;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  h2{padding:16px 20px 6px;margin:0;font-size:15px;letter-spacing:.5px;opacity:.6;text-transform:uppercase}
  .row{display:flex;justify-content:space-between;gap:16px;padding:13px 20px;border-top:1px solid #334155}
  .k{opacity:.65} .v{font-weight:600;text-align:right;word-break:break-all}
</style></head>
<body>
  <div class="hero"><div class="ip" id="ip">…</div><div class="geo" id="geo">checking egress IP…</div></div>
  <div class="card">
    <h2>Account</h2>
    <div class="row"><span class="k">Name</span><span class="v">${escapeHtml(p.name)}</span></div>
    <div class="row"><span class="k">Profile No / ID</span><span class="v">${escapeHtml(no)} / ${escapeHtml(id)}</span></div>
    <div class="row"><span class="k">Group</span><span class="v">${escapeHtml(p.group) || "—"}</span></div>
    <div class="row"><span class="k">Platform</span><span class="v">${escapeHtml(p.platform) || "—"}</span></div>
    <div class="row"><span class="k">Proxy</span><span class="v">${escapeHtml(proxy)}</span></div>
  </div>
  <script>
    fetch("http://ip-api.com/json/?fields=query,country,regionName,city")
      .then(function(r){return r.json()})
      .then(function(d){
        document.getElementById('ip').textContent = d.query || 'unknown';
        document.getElementById('geo').textContent = [d.country,d.regionName,d.city].filter(Boolean).join(' / ') || '';
      })
      .catch(function(){ document.getElementById('ip').textContent='—'; document.getElementById('geo').textContent='(could not read egress IP)'; });
  </script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function cloudAutomationError(req: Request, opts: DashboardServerOptions): Response | null {
  if (opts.appConfig?.read().mode !== "cloud" || opts.remote) return null;
  const pathname = new URL(req.url).pathname;
  if (
    opts.cloudBrowser &&
    (pathname === "/api/v1/status" || pathname === "/status" || isAdsPowerBrowserControl(pathname))
  ) {
    return null;
  }
  return Response.json(
    { ok: false, error: "AliasMode Cloud does not expose this local API route" },
    { status: 503 },
  );
}

function automationHealthResponse(
  req: Request,
  clientAddress: string | undefined,
  remote: RemoteCoordinator | null | undefined,
): Response | Promise<Response> | null {
  if (new URL(req.url).pathname !== "/api/xactions/health-snapshot") return null;
  if (!isLoopbackAddress(clientAddress)) {
    return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
  }
  if (!remote) {
    return Response.json({ ok: false, error: "remote hub is not configured" }, { status: 503 });
  }
  return handleAutomationHealthSnapshot(req, remote);
}

async function handleAutomationRequest(
  req: Request,
  opts: DashboardServerOptions,
  lifecycle: BrowserLifecycleContext,
): Promise<Response> {
  const { launcher, store } = opts;
  const users = await handleUserApi(req, launcher, store, opts.remote);
  if (users) return users;
  const pathname = new URL(req.url).pathname;
  if (opts.remote && isAdsPowerBrowserControl(pathname)) {
    return handleRemoteBrowserControl(req, opts.remote, launcher, store, lifecycle);
  }
  if (opts.cloudBrowser && isAdsPowerBrowserControl(pathname)) {
    return handleCloudBrowserControl(req, opts.cloudBrowser, launcher, store, lifecycle);
  }
  return handleRequest(req, launcher, store, lifecycle);
}

export function serveAutomationApi(opts: Omit<DashboardServerOptions, "hostname">) {
  const { port = 50400 } = opts;
  const hostname = "127.0.0.1";
  const log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  const admission = opts.lifecycleAdmission ?? new LifecycleAdmissionController(opts.lifecycleAdmissionOptions);
  const lifecycle = { admission };
  try {
    const server = Bun.serve({
      port,
      hostname,
      idleTimeout: 240,
      fetch: async (req, server) => {
        const health = automationHealthResponse(req, server.requestIP(req)?.address, opts.remote);
        if (health) return health;
        return dispatchWithLifecycleAdmission(req, admission, async () => {
          const cloudError = cloudAutomationError(req, opts);
          if (cloudError) return cloudError;
          return handleAutomationRequest(req, opts, lifecycle);
        });
      },
    });
    log(`automation API on http://${hostname}:${server.port}`);
    return server;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `automation API could not bind to http://${hostname}:${port}: ${detail}`;
    log(message);
    throw new Error(message);
  }
}

export function serveDesktopAutomationApi(opts: Omit<DashboardServerOptions, "hostname" | "port">) {
  try {
    return serveAutomationApi({ ...opts, port: 50400 });
  } catch {
    return undefined;
  }
}

export function serveDashboard(opts: DashboardServerOptions) {
  const { launcher, store, port = 50400, hostname = "127.0.0.1" } = opts;
  const runtimeMode = opts.appConfig?.read().mode;
  const log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  const admission = opts.lifecycleAdmission ?? new LifecycleAdmissionController(opts.lifecycleAdmissionOptions);
  const lifecycle = { admission };
  const agentNonce = opts.agentNonce;
  const agentHub = agentNonce
    ? new AgentControlHub({
        launcher,
        store,
        admission,
        remote: opts.remote,
        cloudBrowser: opts.cloudBrowser,
        cloudConnection: opts.cloudConnection,
        log,
      })
    : undefined;
  const server = Bun.serve<AgentSocketData>({
    port,
    hostname,
    // Queue wait plus a complete remote restore can legitimately hold a lifecycle
    // response for several minutes while the shared transition cap does its job.
    idleTimeout: 240,
    routes: { "/": index },
    websocket: {
      maxPayloadLength: AGENT_CONTROL_MAX_MESSAGE_BYTES,
      message(socket, message) {
        const raw = typeof message === "string" ? message : new Uint8Array(message);
        void socket.data.session.enqueue(raw).then((response) => {
          socket.send(JSON.stringify(response));
        });
      },
      close(socket) {
        void socket.data.session.disconnect();
      },
    },
    fetch: async (req, server) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname === AGENT_CONTROL_PATH) {
        if (!isLoopbackAddress(server.requestIP(req)?.address)) {
          return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
        }
        if (!agentHub || !agentNonce) {
          return Response.json({ ok: false, error: "agent control is unavailable" }, { status: 503 });
        }
        if (req.headers.get("sec-websocket-protocol") !== AGENT_CONTROL_PROTOCOL) {
          return Response.json({ ok: false, error: "agent protocol mismatch" }, { status: 426 });
        }
        if (!validAgentAuthorization(req.headers.get("authorization"), agentNonce)) {
          return Response.json({ ok: false, error: "agent authorization failed" }, { status: 401 });
        }
        const session = agentHub.connect();
        const upgraded = server.upgrade(req, {
          data: { session },
        });
        if (!upgraded) {
          void session.disconnect();
          return Response.json({ ok: false, error: "WebSocket upgrade failed" }, { status: 400 });
        }
        return undefined;
      }
      // The automation client publishes through this local coordinator without entering the
      // browser lifecycle admission queue. Even if the dashboard is deliberately
      // bound beyond loopback, this ingestion route remains local-only.
      const health = automationHealthResponse(req, server.requestIP(req)?.address, opts.remote);
      if (health) return health;

      return dispatchWithLifecycleAdmission(req, admission, async () => {
        const ui = await handleUiRequest(req, launcher, store, opts.remote, {
          appConfig: opts.appConfig,
          paths: opts.paths,
          defaultCloudUrl: opts.defaultCloudUrl,
          cloudAuth: opts.cloudAuth,
          cloudConnection: opts.cloudConnection,
          pendingSync: opts.pendingSync,
          cloudBrowser: opts.cloudBrowser,
          mcpTunnel: opts.mcpTunnel,
          health: opts.health,
          runtimeMode,
        });
        if (ui) return ui;
        const cloudError = cloudAutomationError(req, opts);
        if (cloudError) return cloudError;
        // Per-profile identity "card" (AdsPower-style landing page). Opened as a tab and
        // pointed to by the bookmark, so an operator can always see which account a window is.
        if (reqUrl.pathname === "/card") return renderProfileCard(store, reqUrl.searchParams.get("id") ?? "");
        return handleAutomationRequest(req, opts, lifecycle);
      });
    },
  });
  void agentHub?.cleanupTemporaryProfiles();
  log(`dashboard + API on http://${hostname}:${server.port}  (UI at /, AdsPower API under /api)`);
  return server;
}

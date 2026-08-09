/**
 * Dashboard + API server. Serves the Phase A web UI at "/" and routes
 * `/ui/api/*` to the dashboard API, with the AdsPower-compatible API
 * (handleRequest) as the fallback — so automation `/api/v1|v2/*` calls are
 * unaffected. The HTML import lives only here so unit tests (which import
 * server.ts / ui.ts) never trigger React bundling.
 */

import index from "./web/index.html";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import {
  handleRequest,
  handleRemoteBrowserControl,
  handleAutomationHealthSnapshot,
  isAdsPowerBrowserControl,
  isLoopbackAddress,
} from "./server.ts";
import { handleUiRequest } from "./ui.ts";
import { handleUserApi } from "./adspower-users.ts";
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
  port?: number;
  /**
   * Bind address. Loopback only by default — the dashboard and API are
   * unauthenticated and can start/stop browsers, so they must not be reachable
   * from other hosts. Remote access is Phase B (VPS behind Tailscale + auth).
   */
  hostname?: string;
  log?: (msg: string) => void;
  lifecycleAdmissionOptions?: LifecycleAdmissionOptions;
}

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
  const serial = store.getSerial(id);
  const proxy = p.proxy ? `${p.proxy.type}://${p.proxy.host}:${p.proxy.port}` : "none";
  const title = `${p.name || "profile"} · #${serial ?? "?"}`;
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
    <div class="row"><span class="k">Profile No / ID</span><span class="v">${escapeHtml(serial ?? "?")} / ${escapeHtml(id)}</span></div>
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

export function serveDashboard(opts: DashboardServerOptions) {
  const { launcher, store, port = 50400, hostname = "127.0.0.1" } = opts;
  const log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  const admission = new LifecycleAdmissionController(opts.lifecycleAdmissionOptions);
  const lifecycle = { admission };
  const server = Bun.serve({
    port,
    hostname,
    // Queue wait plus a complete remote restore can legitimately hold a lifecycle
    // response for several minutes while the shared transition cap does its job.
    idleTimeout: 240,
    routes: { "/": index },
    fetch: async (req, server) => {
      const reqUrl = new URL(req.url);
      // The automation client publishes through this local coordinator without entering the
      // browser lifecycle admission queue. Even if the dashboard is deliberately
      // bound beyond loopback, this ingestion route remains local-only.
      if (reqUrl.pathname === "/api/xactions/health-snapshot") {
        if (!isLoopbackAddress(server.requestIP(req)?.address)) {
          return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
        }
        if (!opts.remote) {
          return Response.json({ ok: false, error: "remote hub is not configured" }, { status: 503 });
        }
        return handleAutomationHealthSnapshot(req, opts.remote);
      }

      return dispatchWithLifecycleAdmission(req, admission, async () => {
        // Per-profile identity "card" (AdsPower-style landing page). Opened as a tab and
        // pointed to by the bookmark, so an operator can always see which account a window is.
        if (reqUrl.pathname === "/card") return renderProfileCard(store, reqUrl.searchParams.get("id") ?? "");
        const ui = await handleUiRequest(req, launcher, store, opts.remote);
        if (ui) return ui;
        // AdsPower-compatible profile management (create/list/delete/update +
        // group/list) so a full AdsPower REST client works by repointing its base
        // URL alone. Served in BOTH modes: in remote mode it routes create/list/
        // delete/group through the hub coordinator (the same central roster as the
        // dashboard + automation), not the local launch cache.
        const users = await handleUserApi(req, launcher, store, opts.remote);
        if (users) return users;
        // In remote mode, route automation AdsPower browser-control calls through
        // the hub coordinator so every launch restores the roamed session and only
        // the current writer lease owner checkpoints changes. status/delete-cache
        // aren't control routes, so they pass through.
        if (opts.remote && isAdsPowerBrowserControl(new URL(req.url).pathname)) {
          return handleRemoteBrowserControl(req, opts.remote, launcher, store, lifecycle);
        }
        return handleRequest(req, launcher, store, lifecycle);
      });
    },
  });
  log(`dashboard + API on http://${hostname}:${server.port}  (UI at /, AdsPower API under /api)`);
  return server;
}

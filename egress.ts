/** Shared relay/direct egress lookup and validation. */

import net from "node:net";
import tls from "node:tls";
import { canonicalIp } from "./ip.ts";

export const DEFAULT_EGRESS_ENDPOINTS = [
  "https://ipinfo.io/json",
  "https://api.ipify.org?format=json",
] as const;

export interface EgressInfo {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  org?: string;
}

export interface EgressLookupOptions {
  endpoints?: readonly string[];
  timeoutMs?: number;
  /** Injectable tunnel fetch for deterministic tests. */
  fetchThroughRelay?: (relayPort: number, endpoint: string, timeoutMs: number) => Promise<EgressInfo | null>;
}

/**
 * Resolve the lookup list. Operators whose proxy pools block the defaults may
 * set ALIASMODE_EGRESS_ENDPOINTS to a comma-separated list of HTTP(S) endpoints.
 */
export function resolveEgressEndpoints(
  configured: string | undefined = process.env.ALIASMODE_EGRESS_ENDPOINTS,
): string[] {
  const endpoints = configured === undefined
    ? [...DEFAULT_EGRESS_ENDPOINTS]
    : configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (endpoints.length === 0) throw new Error("ALIASMODE_EGRESS_ENDPOINTS must contain at least one URL");
  for (const endpoint of endpoints) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`invalid egress endpoint URL: ${endpoint}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`egress endpoint must use http or https: ${endpoint}`);
    }
  }
  return endpoints;
}

/** Parse the JSON/plaintext shapes returned by common egress services. */
export function parseEgressResponse(body: string): EgressInfo | null {
  const raw = body.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      const candidate = [parsed.ip, parsed.query]
        .find((value) => typeof value === "string" && canonicalIp(value));
      if (typeof candidate === "string") {
        const info: EgressInfo = { ip: canonicalIp(candidate)! };
        for (const key of ["country", "region", "city", "org"] as const) {
          if (typeof parsed[key] === "string") info[key] = parsed[key];
        }
        return info;
      }
    }
  } catch {
    // Plain-text endpoint response.
  }
  const ip = canonicalIp(raw);
  return ip ? { ip } : null;
}

/** Fetch this machine's direct egress using the same endpoints/parser. */
export async function fetchDirectEgress(
  opts: EgressLookupOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<EgressInfo | null> {
  const endpoints = opts.endpoints ? [...opts.endpoints] : resolveEgressEndpoints();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  for (const endpoint of endpoints) {
    try {
      const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) continue;
      const info = parseEgressResponse(await response.text());
      if (info) return info;
    } catch {
      // Try the next independent endpoint.
    }
  }
  return null;
}

/**
 * Prove the configured proxy works BEFORE the browser launches, using only the
 * loopback relay — no CDP, no Playwright, no browser tab. The browser is always
 * launched with `--proxy-server=http://127.0.0.1:<relay>` and the relay never
 * falls back to a direct connection, so a relay that answers an HTTPS request
 * through the authenticated upstream is the same path the browser will use.
 */
export async function verifyRelayEgress(
  relayPort: number,
  opts: EgressLookupOptions = {},
): Promise<EgressInfo> {
  const endpoints = opts.endpoints ? [...opts.endpoints] : resolveEgressEndpoints();
  for (const endpoint of endpoints) {
    if (new URL(endpoint).protocol !== "https:") {
      throw new Error(`proxy verification endpoint must use HTTPS: ${endpoint}`);
    }
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fetcher = opts.fetchThroughRelay ?? fetchRelayEgress;
  // Fixed failure reason codes (safe to log/display: no hosts, ports, or credentials).
  const reasons: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const info = await fetcher(relayPort, endpoint, timeoutMs);
      if (info) return info;
      reasons.push("relay_egress_unparseable");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      reasons.push(/^[a-z_]+$/.test(message) ? message : "relay_unknown_error");
    }
  }
  throw new Error(`proxy verification failed before account traffic [${reasons.join(",") || "relay_unknown_error"}]`);
}

/** One HTTPS GET through the loopback relay: CONNECT via the relay, then TLS to the origin. */
async function fetchRelayEgress(relayPort: number, endpoint: string, timeoutMs: number): Promise<EgressInfo | null> {
  const url = new URL(endpoint);
  const host = url.hostname;
  const target = `${host}:${url.port || 443}`;
  const socket = net.connect({ host: "127.0.0.1", port: relayPort });
  const deadline = Date.now() + Math.max(1, timeoutMs);
  try {
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay_connection_timeout")), remaining(deadline));
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      // Socket errors can embed host/port — normalize to a fixed safe code.
      socket.once("error", () => { clearTimeout(timer); reject(new Error("relay_connection_refused")); });
    });
    const established = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay_connect_timeout")), remaining(deadline));
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buf.length > 16 * 1024) { clearTimeout(timer); reject(new Error("relay_connect_oversize")); }
          return;
        }
        clearTimeout(timer);
        socket.removeListener("data", onData);
        const status = buf.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
        if (!/\s2\d\d\s/.test(status)) { reject(new Error("relay_connect_refused")); return; }
        resolve(buf.subarray(end + 4));
      };
      socket.on("data", onData);
      socket.once("error", () => { clearTimeout(timer); reject(new Error("relay_socket_error")); });
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    // Any bytes the upstream already pushed inside the tunnel (rare for a fresh
    // CONNECT) must seed the TLS socket — but TLS handshakes start client-side,
    // so a well-behaved relay/upstream has sent nothing yet.
    if (established.length) throw new Error("relay_unexpected_tunnel_bytes");
    const body = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay_https_timeout")), remaining(deadline));
      // The response is only an IP echo used for a liveness/egress check; the
      // authoritative proxy-auth proof is the relay's own upstream handshake.
      // Skip origin cert validation so private/self-signed egress endpoints work.
      const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false });
      let buf = Buffer.alloc(0);
      tlsSocket.once("secureConnect", () => {
        tlsSocket.write(
          `GET ${url.pathname || "/"}${url.search} HTTP/1.1\r\nHost: ${target}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
        );
      });
      tlsSocket.on("data", (chunk: Buffer) => { buf = Buffer.concat([buf, chunk]); });
      tlsSocket.once("error", () => { clearTimeout(timer); reject(new Error("relay_tls_error")); });
      tlsSocket.once("close", () => {
        clearTimeout(timer);
        const text = buf.toString("latin1");
        const headEnd = text.indexOf("\r\n\r\n");
        if (headEnd === -1) { reject(new Error("relay_https_incomplete")); return; }
        const status = text.slice(0, headEnd).split("\r\n")[0] ?? "";
        if (!/\s2\d\d\s/.test(status)) { reject(new Error("relay_egress_not_ok")); return; }
        let body = text.slice(headEnd + 4);
        if (/^transfer-encoding:\s*chunked/im.test(text.slice(0, headEnd))) body = decodeChunked(body);
        resolve(body);
      });
    });
    return parseEgressResponse(body);
  } finally {
    socket.destroy();
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** Minimal chunked-transfer decoder for the small JSON egress payloads. */
function decodeChunked(raw: string): string {
  let out = "";
  let rest = raw;
  while (rest.length) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) break;
    const size = parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
  return out;
}

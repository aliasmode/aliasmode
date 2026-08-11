/** Shared browser/direct egress lookup and validation. */

import { withCdpPage } from "./cdp.ts";
import { canonicalIp } from "./ip.ts";

export const DEFAULT_EGRESS_ENDPOINTS = [
  "https://ipinfo.io/json",
  "https://api.ipify.org?format=json",
] as const;

// Playwright force-terminates a stalled CDP transport after five seconds.
// The mandatory proxy probe must wait beyond that boundary before handoff.
const PROXY_PROBE_CLEANUP_TIMEOUT_MS = 6_000;

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

/** Fetch egress through an already-connected Playwright page. */
export async function fetchPageEgress(page: any, opts: EgressLookupOptions = {}): Promise<EgressInfo | null> {
  const endpoints = opts.endpoints ? [...opts.endpoints] : resolveEgressEndpoints();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  for (const endpoint of endpoints) {
    try {
      const response = await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!response?.ok()) continue;
      const info = parseEgressResponse(await page.locator("body").innerText({ timeout: Math.min(timeoutMs, 5_000) }));
      if (info) return info;
    } catch {
      // Try the next independent endpoint.
    }
  }
  return null;
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

/** Prove that the configured browser proxy can reach public HTTPS before account traffic. */
export async function verifyBrowserProxy(
  ws: string,
  opts: EgressLookupOptions = {},
): Promise<EgressInfo> {
  const endpoints = opts.endpoints ? [...opts.endpoints] : resolveEgressEndpoints();
  for (const endpoint of endpoints) {
    if (new URL(endpoint).protocol !== "https:") {
      throw new Error(`proxy verification endpoint must use HTTPS: ${endpoint}`);
    }
  }
  try {
    const egress = await withCdpPage(
      ws,
      (page) => fetchPageEgress(page, { ...opts, endpoints }),
      {
        timeoutMs: opts.timeoutMs ?? 15_000,
        cleanupTimeoutMs: PROXY_PROBE_CLEANUP_TIMEOUT_MS,
        temporaryPage: true,
        requireConfirmedCleanup: true,
      },
    );
    if (!egress) {
      throw new Error("no egress endpoint was reachable");
    }
    return egress;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Proxy verification failed before account traffic: ${message}`, { cause: error });
  }
}

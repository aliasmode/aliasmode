/** Shared direct/browser diagnostic egress lookup and validation. */

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

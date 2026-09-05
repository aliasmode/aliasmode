/** Pre-save proxy connectivity checks through the same relay used by launched browsers. */

import { fetchDirectEgress, type EgressInfo, type EgressLookupOptions } from "./egress.ts";
import { normalizeProxySpec, type ProxyInput } from "./proxy.ts";
import { startProxyRelay, type ProxyRelay, type RelayOptions, type UpstreamProxy } from "./proxy-relay.ts";
import type { ProxySpec } from "./types.ts";

const ATTEMPT_COUNT = 3;

export type ProxyCheckStatus = "working" | "unstable" | "failed" | "unavailable";
export type ProxyCheckReason =
  | "authentication_failed"
  | "timeout"
  | "dns_failed"
  | "unreachable"
  | "connection_failed"
  | "intermittent"
  | "proxy_bypassed"
  | "check_unavailable";

type ProxyConnectionFailureReason = Exclude<
  ProxyCheckReason,
  "intermittent" | "proxy_bypassed" | "check_unavailable"
>;

export interface ProxyCheckAttempt {
  info: EgressInfo | null;
  reason?: ProxyConnectionFailureReason | "check_unavailable";
}

export interface ProxyCheckResult {
  status: ProxyCheckStatus;
  attempts: number;
  successes: number;
  reason?: ProxyCheckReason;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  rotating?: boolean;
}

type RelayFactory = (upstream: UpstreamProxy, options?: RelayOptions) => Promise<ProxyRelay>;

export interface ProxyCheckOptions extends EgressLookupOptions {
  fetchFn?: typeof fetch;
  relayFactory?: RelayFactory;
}

function safeFailureReason(logs: readonly string[]): ProxyConnectionFailureReason {
  const text = logs.join("\n");
  if (/\b407\b|auth(?:entication)?|credential/i.test(text)) return "authentication_failed";
  if (/timed?\s*out|timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|name.+resolv/i.test(text)) return "dns_failed";
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|refused/i.test(text)) return "unreachable";
  return "connection_failed";
}

function egressFields(info: EgressInfo): Pick<ProxyCheckResult, "ip" | "country" | "region" | "city"> {
  return {
    ip: info.ip,
    ...(info.country ? { country: info.country } : {}),
    ...(info.region ? { region: info.region } : {}),
    ...(info.city ? { city: info.city } : {}),
  };
}

function preferredFailureReason(attempts: readonly ProxyCheckAttempt[]): ProxyConnectionFailureReason {
  const reasons = attempts.map((attempt) => attempt.reason).filter(Boolean);
  for (const candidate of ["authentication_failed", "timeout", "dns_failed", "unreachable"] as const) {
    if (reasons.includes(candidate)) return candidate;
  }
  return "connection_failed";
}

export function classifyProxyAttempts(
  attempts: readonly ProxyCheckAttempt[],
  direct: EgressInfo | null,
): ProxyCheckResult {
  const successful = attempts.flatMap((attempt) => attempt.info ? [attempt.info] : []);
  const failed = attempts.filter((attempt) => !attempt.info);
  const base = { attempts: attempts.length, successes: successful.length };

  if (direct && successful.some((info) => info.ip === direct.ip)) {
    return { ...base, status: "failed", reason: "proxy_bypassed" };
  }
  if (successful.length > 0 && failed.every((attempt) => attempt.reason === "check_unavailable")) {
    return {
      ...base,
      status: "working",
      ...egressFields(successful[0]!),
      rotating: new Set(successful.map((info) => info.ip)).size > 1,
    };
  }
  if (successful.length > 0) {
    return {
      ...base,
      status: "unstable",
      reason: "intermittent",
      ...egressFields(successful[0]!),
      rotating: new Set(successful.map((info) => info.ip)).size > 1,
    };
  }
  const objectiveFailure = failed.some((attempt) =>
    attempt.reason === "authentication_failed" ||
    attempt.reason === "dns_failed" ||
    attempt.reason === "unreachable"
  );
  if (objectiveFailure) {
    return { ...base, status: "failed", reason: preferredFailureReason(attempts) };
  }
  if (failed.some((attempt) => attempt.reason === "check_unavailable")) {
    return { ...base, status: "unavailable", reason: "check_unavailable" };
  }
  if (direct) {
    return { ...base, status: "failed", reason: preferredFailureReason(attempts) };
  }
  return { ...base, status: "unavailable", reason: "check_unavailable" };
}

async function proxyAttempt(
  proxy: ProxySpec,
  options: Required<Pick<ProxyCheckOptions, "fetchFn" | "relayFactory">> & EgressLookupOptions,
): Promise<ProxyCheckAttempt> {
  const logs: string[] = [];
  let relay: ProxyRelay | undefined;
  try {
    relay = await options.relayFactory({
      type: proxy.type === "socks5" ? "socks5" : "http",
      host: proxy.host,
      port: Number(proxy.port),
      user: proxy.user,
      pass: proxy.pass,
    }, { log: (message) => logs.push(message) });
    const proxyUrl = `http://127.0.0.1:${relay.port}`;
    const proxiedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      options.fetchFn(input, { ...init, proxy: proxyUrl })) as typeof fetch;
    let serviceFailed = false;
    let authenticationFailed = false;
    const info = await fetchDirectEgress({
      endpoints: options.endpoints,
      timeoutMs: options.timeoutMs,
    }, proxiedFetch, (failure) => {
      if (failure === "service_failed") serviceFailed = true;
      if (failure === "proxy_authentication_failed") authenticationFailed = true;
    });
    return info
      ? { info }
      : {
          info: null,
          reason: authenticationFailed
            ? "authentication_failed"
            : serviceFailed ? "check_unavailable" : safeFailureReason(logs),
        };
  } catch {
    return { info: null, reason: safeFailureReason(logs) };
  } finally {
    relay?.close();
  }
}

/** Check unsaved proxy settings without storing them or launching a browser. */
export async function checkProxy(
  input: ProxyInput | ProxySpec | null | undefined,
  options: ProxyCheckOptions = {},
): Promise<ProxyCheckResult> {
  const proxy = normalizeProxySpec(input);
  if (!proxy) throw new Error("proxy is required");
  if (proxy.type !== "http" && proxy.type !== "socks5") {
    throw new Error("unsupported proxy type (use http or socks5)");
  }

  const fetchFn = options.fetchFn ?? fetch;
  const relayFactory = options.relayFactory ?? startProxyRelay;
  const lookupOptions = { endpoints: options.endpoints, timeoutMs: options.timeoutMs };
  const [direct, attempts] = await Promise.all([
    fetchDirectEgress(lookupOptions, fetchFn),
    Promise.all(Array.from(
      { length: ATTEMPT_COUNT },
      () => proxyAttempt(proxy, { ...lookupOptions, fetchFn, relayFactory }),
    )),
  ]);
  return classifyProxyAttempts(attempts, direct);
}

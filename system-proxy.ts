import { execFileSync } from "node:child_process";

export interface SystemProxy {
  host: string;
  port: number;
  bypass: string[];
}

export function normalizeProxyAddress(raw: string): { host: string; port: number } | null {
  let value = raw.trim();
  if (!value) return null;
  const entries = value.split(";").map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry.includes("="))) {
    value = entries.find((entry) => /^https\s*=/i.test(entry))?.split("=").slice(1).join("=")?.trim()
      ?? entries.find((entry) => /^http\s*=/i.test(entry))?.split("=").slice(1).join("=")?.trim()
      ?? "";
  }
  if (!value) return null;
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const parsed = new URL(hasScheme ? value : `http://${value}`);
    if (!hasScheme && !parsed.port) return null;
    const port = Number(parsed.port || 80);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

export function matchesBypass(host: string, bypass: string[]): boolean {
  const name = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!name) return false;
  return bypass.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "<local>") return !name.includes(".");
    const normalized = pattern.replace(/^\*\.?/, "");
    return pattern.startsWith("*.") ? (name === normalized || name.endsWith(`.${normalized}`)) : name === pattern;
  });
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function parseWindowsProxySettings(output: string): {
  enabled: boolean;
  proxy: string | null;
  bypass: string[];
  pac: boolean;
} {
  const read = (name: string): string | undefined =>
    output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, "im"))?.[1]?.trim();
  const proxyEnable = read("ProxyEnable");
  const proxy = read("ProxyServer") ?? null;
  const bypass = (read("ProxyOverride") ?? "").split(";").map((value) => value.trim()).filter(Boolean);
  const pac = Boolean(read("AutoConfigURL"));
  return { enabled: proxyEnable === "0x1" || proxyEnable === "1", proxy, bypass, pac };
}

function readWindowsProxy(): SystemProxy | null | "pac" {
  if (process.platform !== "win32") return null;
  let output: string;
  try {
    output = execFileSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const settings = parseWindowsProxySettings(output);
  if (settings.pac) return "pac";
  if (!settings.enabled || !settings.proxy) return null;
  const proxy = normalizeProxyAddress(settings.proxy);
  return proxy ? { ...proxy, bypass: settings.bypass } : null;
}

export function getSystemProxy(): SystemProxy | null {
  const windows = readWindowsProxy();
  if (windows === "pac") return null;
  if (windows) return windows;
  const proxy = normalizeProxyAddress(
    process.env.HTTPS_PROXY ?? process.env.https_proxy
      ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? "",
  );
  if (!proxy) return null;
  return {
    ...proxy,
    bypass: (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
  };
}

export type SystemProxyFetch = (url: string, init?: RequestInit) => Promise<Response>;

let cachedSystemProxy: SystemProxy | null | undefined;

/** Detect once per process: the setting rarely changes mid-session, and on
 *  Windows detection shells out to `reg query`. */
export function detectSystemProxy(): SystemProxy | null {
  if (cachedSystemProxy === undefined) cachedSystemProxy = getSystemProxy();
  return cachedSystemProxy;
}

function proxyAppliesTo(url: string, proxy: SystemProxy): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return !isLoopbackHost(host) && !matchesBypass(host, proxy.bypass);
}

/** How long a direct attempt gets to produce response headers before the
 *  request is retried through the system proxy instead. The timer stops the
 *  moment fetch settles, so it never cuts into a body already streaming. */
const DIRECT_ATTEMPT_TIMEOUT_MS = 3000;

type OriginRoute = "direct" | "proxy";

/** One direct attempt under the probe timeout. A caller-provided abort
 *  signal is forwarded into the attempt, so a rejection can still mean "the
 *  caller gave up" rather than "direct is unreachable". */
async function attemptDirect(
  baseFetch: typeof fetch,
  url: string,
  init: RequestInit | undefined,
): Promise<Response> {
  const callerSignal = init?.signal ?? undefined;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), DIRECT_ATTEMPT_TIMEOUT_MS);
  try {
    return await baseFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * fetch that prefers a direct connection and falls back to the detected
 * system proxy, decided per origin: an origin's first request tries direct
 * under a short header timeout, any HTTP response (even an error status)
 * proves the direct route works, and a connection failure retries once
 * through the proxy. The winning route is remembered for the rest of the
 * process, and a remembered direct origin that starts failing flips to the
 * proxy the same way. When no proxy is detected — or for bypassed and
 * loopback hosts — requests go direct exactly like plain fetch, and when
 * both routes fail the direct error is the one reported.
 */
export function createSystemProxyFetch(
  baseFetch: typeof fetch = fetch,
  detect: () => SystemProxy | null = detectSystemProxy,
): SystemProxyFetch {
  const routes = new Map<string, OriginRoute>();
  return async (url, init) => {
    const proxy = detect();
    if (!proxy || !proxyAppliesTo(url, proxy)) return baseFetch(url, init);
    const proxyInit = { ...init, proxy: `http://${proxy.host}:${proxy.port}` };
    // proxyAppliesTo only returns true for a URL that parses.
    const origin = new URL(url).origin;
    if (routes.get(origin) === "proxy") return baseFetch(url, proxyInit);
    let directError: unknown;
    try {
      const response = await attemptDirect(baseFetch, url, init);
      routes.set(origin, "direct");
      return response;
    } catch (error) {
      // A caller-driven abort is not a connectivity failure: never reroute.
      if (init?.signal?.aborted) throw error;
      directError = error;
    }
    try {
      const response = await baseFetch(url, proxyInit);
      routes.set(origin, "proxy");
      return response;
    } catch {
      throw directError;
    }
  };
}

/** fetch that tries direct first and falls back to the detected system proxy. */
export const systemProxyFetch: SystemProxyFetch = createSystemProxyFetch();

/** Extra curl arguments that route this URL through the system proxy. */
export function systemProxyCurlArgs(
  url: string,
  detect: () => SystemProxy | null = detectSystemProxy,
): string[] {
  const proxy = detect();
  if (!proxy || !proxyAppliesTo(url, proxy)) return [];
  return ["--proxy", `http://${proxy.host}:${proxy.port}`];
}

/** curl exit codes that mean the connection stage itself failed: 7 could not
 *  connect, 28 timed out. Any other outcome is a result worth reporting. */
const CURL_CONNECTION_FAILURES: ReadonlySet<number> = new Set([7, 28]);

/** Runs one curl invocation with the given routing arguments spliced into
 *  the command line and resolves with curl's exit code. */
export type CurlAttempt = (routingArgs: string[]) => Promise<number>;

/**
 * Run a curl download direct-first, mirroring createSystemProxyFetch: the
 * direct attempt gets a short connect timeout, and if it fails at the
 * connection stage while a system proxy applies to the URL, the download
 * runs once more through the proxy. Resolves with the final exit code.
 */
export async function runCurlDirectFirst(
  url: string,
  run: CurlAttempt,
  detect: () => SystemProxy | null = detectSystemProxy,
): Promise<number> {
  const proxyArgs = systemProxyCurlArgs(url, detect);
  if (proxyArgs.length === 0) return run([]);
  const directCode = await run(["--connect-timeout", "5"]);
  if (!CURL_CONNECTION_FAILURES.has(directCode)) return directCode;
  return run(proxyArgs);
}

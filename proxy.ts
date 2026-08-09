/**
 * Canonical proxy parsing and rendering.
 *
 * Every proxy ingress (UI, AdsPower import/API, hub, and persisted profiles)
 * must pass through this module. Launch routing must never guess a protocol
 * from an arbitrary string: a malformed/unknown type is rejected before any
 * account traffic can start.
 */

import type { ProxySpec, ProxyType } from "./types.ts";
import { isIP } from "node:net";

export type ProxyInput = {
  type?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  pass?: unknown;
};

const PROXY_TYPES = new Set<ProxyType>(["http", "https", "socks5"]);

export function normalizeProxyType(value: unknown, fallback: ProxyType = "http"): ProxyType {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "socks") return "socks5";
  if (PROXY_TYPES.has(raw as ProxyType)) return raw as ProxyType;
  throw new Error(`unsupported proxy type: ${raw} (use http, https, or socks5)`);
}

export function isSocksProxyType(type: ProxyType): boolean {
  return type === "socks5";
}

export function isHttpProxyType(type: ProxyType): boolean {
  return type === "http" || type === "https";
}

function normalizeHost(value: unknown): string {
  const raw = String(value ?? "").trim();
  const hasOpeningBracket = raw.startsWith("[");
  const hasClosingBracket = raw.endsWith("]");
  if (hasOpeningBracket !== hasClosingBracket) throw new Error("proxy host has invalid bracket syntax");
  const host = hasOpeningBracket && hasClosingBracket ? raw.slice(1, -1) : raw;
  if (!host) throw new Error("proxy host is empty");
  if (hasOpeningBracket && isIP(host) !== 6) {
    throw new Error("proxy host brackets are only valid around an IPv6 address");
  }
  if (/[\s\u0000-\u001f\u007f]/.test(host)) throw new Error("proxy host contains whitespace or control characters");
  if (/[\[\]\\/@?#%]/.test(host)) throw new Error("proxy host contains a URL delimiter or invalid bracket");
  if (host.includes(":")) {
    if (isIP(host) !== 6) throw new Error("proxy host contains an invalid IPv6 address");
  } else {
    try {
      const parsed = new URL(`http://${host}/`);
      if (!parsed.hostname || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/") {
        throw new Error("invalid");
      }
    } catch {
      throw new Error("proxy host is not a valid hostname or IP address");
    }
  }
  return host;
}

function normalizePort(value: unknown): string {
  const port = String(value ?? "").trim();
  const portNumber = Number(port);
  if (!/^\d+$/.test(port) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error(`invalid proxy port: ${port || "(empty)"}`);
  }
  return String(portNumber);
}

/** Normalize an object-shaped proxy. A fully blank object means no proxy. */
export function normalizeProxySpec(input: ProxyInput | ProxySpec | null | undefined): ProxySpec | null {
  if (!input) return null;
  const hostRaw = String(input.host ?? "").trim();
  const portRaw = String(input.port ?? "").trim();
  if (!hostRaw && !portRaw) return null;
  if (!hostRaw) throw new Error("proxy host is empty");
  if (!portRaw) throw new Error("invalid proxy port: (empty)");
  const user = String(input.user ?? "").trim();
  const pass = String(input.pass ?? "");
  if (!user && pass) throw new Error("proxy password requires a non-empty username");
  return {
    type: normalizeProxyType(input.type),
    host: normalizeHost(hostRaw),
    port: normalizePort(portRaw),
    user,
    pass,
  };
}

function decodeCredential(value: string, label: "username" | "password"): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`proxy ${label} has invalid percent-encoding`);
  }
}

function parseProxyUrl(raw: string): ProxySpec {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid proxy URL");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("proxy URL must not contain a path, query, or fragment");
  }
  return normalizeProxySpec({
    type: url.protocol.replace(/:$/, ""),
    host: url.hostname,
    port: url.port,
    user: decodeCredential(url.username, "username"),
    pass: decodeCredential(url.password, "password"),
  })!;
}

/**
 * Parse either a standard proxy URL or AdsPower's legacy
 * `host:port[:user:password]` representation. An explicit URL scheme wins over
 * `type`, which lets header-less imports safely carry their own protocol.
 */
export function parseProxySpec(type: unknown, value: unknown): ProxySpec | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return parseProxyUrl(raw);

  // Bracketed IPv6 legacy form: [2001:db8::1]:1080:user:password.
  const ipv6 = raw.match(/^\[([^\]]+)]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    return normalizeProxySpec({
      type,
      host: ipv6[1],
      port: ipv6[2],
      user: ipv6[3] ?? "",
      pass: ipv6[4] ?? "",
    });
  }

  const parts = raw.split(":");
  if (parts.length < 2) throw new Error("proxy must be host:port[:user:password] or a proxy URL");
  return normalizeProxySpec({
    type,
    host: parts[0],
    port: parts[1],
    user: parts[2] ?? "",
    // Passwords may contain colons; preserve everything after the user field.
    pass: parts.slice(3).join(":"),
  });
}

function authorityHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Host/port form for redacted displays; brackets make IPv6 unambiguous. */
export function proxyHostPort(proxy: ProxySpec): string {
  return `${authorityHost(proxy.host)}:${proxy.port}`;
}

/** AdsPower-compatible editable/export form, including optional credentials. */
export function proxyLegacyString(proxy: ProxySpec): string {
  const base = proxyHostPort(proxy);
  return proxy.user ? `${base}:${proxy.user}:${proxy.pass}` : base;
}

/** Render a canonical proxy URL suitable for CloakBrowser's --proxy-server. */
export function proxyUrl(proxy: ProxySpec): string {
  const auth = proxy.user
    ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@`
    : "";
  return `${proxy.type}://${auth}${proxyHostPort(proxy)}`;
}

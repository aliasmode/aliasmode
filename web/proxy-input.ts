export interface ParsedProxyInput {
  type: "http" | "socks5";
  host: string;
  port: string;
  user: string;
  pass: string;
}

function proxyType(value: string, fallback: "http" | "socks5"): "http" | "socks5" {
  const normalized = value.trim().toLowerCase().replace(/:$/, "");
  if (!normalized) return fallback;
  if (normalized === "socks" || normalized === "socks5") return "socks5";
  if (normalized === "http") return "http";
  throw new Error(`unsupported proxy type “${normalized}” (use http or socks5)`);
}

function decoded(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`proxy ${label} has invalid percent-encoding`);
  }
}

function validate(result: ParsedProxyInput): ParsedProxyInput {
  if (!result.host.trim()) throw new Error("proxy host is empty");
  const port = Number(result.port);
  if (!/^\d+$/.test(result.port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid proxy port: ${result.port || "(empty)"}`);
  }
  if (!result.user && result.pass) throw new Error("proxy password requires a username");
  return { ...result, host: result.host.trim(), port: String(port) };
}

/** Browser-side convenience parser; the API performs authoritative validation again. */
export function parsePastedProxy(
  value: string,
  fallbackType: "http" | "socks5" = "http",
): ParsedProxyInput {
  const raw = value.trim();
  if (!raw) throw new Error("paste a proxy first");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("invalid proxy URL");
    }
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new Error("proxy URL must not contain a path, query, or fragment");
    }
    return validate({
      type: proxyType(url.protocol, fallbackType),
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port,
      user: decoded(url.username, "username"),
      pass: decoded(url.password, "password"),
    });
  }

  const ipv6 = raw.match(/^\[([^\]]+)]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    return validate({
      type: fallbackType,
      host: ipv6[1]!,
      port: ipv6[2]!,
      user: ipv6[3] ?? "",
      pass: ipv6[4] ?? "",
    });
  }

  const parts = raw.split(":");
  if (parts.length < 2) throw new Error("proxy must be host:port:username:password or a proxy URL");
  return validate({
    type: fallbackType,
    host: parts[0]!,
    port: parts[1]!,
    user: parts[2] ?? "",
    // Passwords can contain colons; everything after the username belongs to it.
    pass: parts.slice(3).join(":"),
  });
}

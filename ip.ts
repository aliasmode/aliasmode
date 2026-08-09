import { isIP } from "node:net";

/**
 * Return one stable representation for an IP literal.
 *
 * IPv6 has many equivalent textual forms. URL's IPv6 parser gives us a
 * standards-based compressed form, and IPv4-mapped IPv6 addresses are folded
 * to IPv4 so `::ffff:192.0.2.1` compares equal to `192.0.2.1`.
 */
export function canonicalIp(raw: string): string | null {
  const trimmed = raw.trim();
  const value = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const version = isIP(value);
  if (version === 0) return null;
  if (version === 4) return value.split(".").map((part) => String(Number(part))).join(".");

  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    const normalized = hostname.slice(1, -1).toLowerCase();
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!mapped) return normalized;
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  } catch {
    return null;
  }
}

/** Compare two validated address literals by address value, not spelling. */
export function sameIp(left: string, right: string): boolean {
  const a = canonicalIp(left);
  const b = canonicalIp(right);
  return a !== null && b !== null && a === b;
}

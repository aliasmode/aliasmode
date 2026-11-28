/** Best-effort import- and launch-time timezone enrichment and shared SOCKS5 tunneling. */

import { connect as netConnect, type Socket } from "node:net";
import { startProxyRelay, type ProxyRelay } from "./proxy-relay.ts";
import type { ProxySpec } from "./types.ts";
import { localeForCountry, localeForTimezone } from "./profile-locale.ts";
import { canonicalIp } from "./ip.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<{ json(): Promise<any> }>;

function readExactly(socket: Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onClose);
      socket.off("close", onClose);
      socket.pause();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    // A proxy that rejects the handshake by simply closing the connection (no
    // SOCKS error reply, no socket error) would otherwise leave this read
    // pending until the full timeout. Fail fast on end/close instead.
    const onClose = () => {
      cleanup();
      reject(new Error("SOCKS5 proxy closed the connection before the expected response"));
    };
    const onData = (raw: Buffer | Uint8Array) => {
      const chunk = Buffer.from(raw);
      const needed = length - received;
      if (chunk.length <= needed) {
        chunks.push(chunk);
        received += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, needed));
        received += needed;
        socket.pause();
        socket.unshift(chunk.subarray(needed));
      }
      if (received === length) {
        cleanup();
        resolve(Buffer.concat(chunks, length));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SOCKS5 proxy response timed out"));
    }, timeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onClose);
    socket.on("close", onClose);
    socket.resume();
  });
}

/** Open an RFC 1928/1929 TCP tunnel, keeping DNS resolution at the proxy. */
export async function openSocks5Tunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
  onSocket?: (socket: Socket) => void,
): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: Number(proxy.port) });
  onSocket?.(socket);
  socket.setNoDelay(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SOCKS5 proxy connection timed out")), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });

    const wantsAuth = !!proxy.user;
    // Credentials are an identity boundary: never advertise NO AUTH alongside
    // username/password, because a proxy selecting it would silently downgrade
    // an authenticated (often geo-targeted) session.
    socket.write(Buffer.from(wantsAuth ? [5, 1, 2] : [5, 1, 0]));
    const greeting = await readExactly(socket, 2, timeoutMs);
    if (greeting[0] !== 5 || greeting[1] === 0xff) throw new Error("SOCKS5 proxy rejected all authentication methods");
    if (wantsAuth) {
      if (greeting[1] !== 2) {
        throw new Error(`SOCKS5 proxy refused required username/password authentication (selected ${greeting[1]})`);
      }
      const user = Buffer.from(proxy.user, "utf8");
      const pass = Buffer.from(proxy.pass, "utf8");
      if (!user.length || user.length > 255 || pass.length > 255) throw new Error("invalid SOCKS5 username/password length");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await readExactly(socket, 2, timeoutMs);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS5 proxy authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error(`SOCKS5 proxy selected unsupported authentication method ${greeting[1]}`);
    }

    const domain = Buffer.from(host, "ascii");
    if (!domain.length || domain.length > 255) throw new Error("invalid SOCKS5 destination hostname");
    socket.write(Buffer.concat([
      Buffer.from([5, 1, 0, 3, domain.length]),
      domain,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const reply = await readExactly(socket, 4, timeoutMs);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 CONNECT failed with status ${reply[1]}`);
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3
      ? (await readExactly(socket, 1, timeoutMs))[0]!
      : -1;
    if (addressLength < 0) throw new Error(`SOCKS5 CONNECT returned unknown address type ${reply[3]}`);
    await readExactly(socket, addressLength + 2, timeoutMs);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export type ExitLocation = { timezone: string; country?: string; ip?: string };

/** Location and address of the connection's exit IP, using the profile proxy when present. */
export async function lookupExitLocation(
  proxy: ProxySpec | null,
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): Promise<ExitLocation | null> {
  let relay: ProxyRelay | undefined;
  try {
    if (proxy) {
      relay = await startProxyRelay({
        type: proxy.type === "socks5" ? "socks5" : "http",
        host: proxy.host,
        port: Number(proxy.port),
        user: proxy.user,
        pass: proxy.pass,
      });
    }
    const init = {
      ...(relay ? { proxy: `http://127.0.0.1:${relay.port}` } : {}),
      signal: AbortSignal.timeout(10_000),
    } as RequestInit;
    const ask = async (url: string, signal: AbortSignal, read: (row: any) => ExitLocation | null) => {
      try {
        return read(await (await fetchFn(url, { ...init, signal })).json());
      } catch {
        return null;
      }
    };
    // IP check sites mostly locate an address with MaxMind's data, and ip-api.com, the app's first
    // source, names another zone for some addresses. GeoJS answers from MaxMind's free GeoLite2
    // City data, keyless over HTTPS, so both are asked at once and GeoJS's zone wins when it has
    // one. Its shorter timeout leaves a launch's 5 s wait for ip-api.com's answer if GeoJS hangs.
    const maxMind = ask("https://get.geojs.io/v1/ip/geo.json", AbortSignal.timeout(4_000), (row) =>
      typeof row?.timezone === "string" && row.timezone ? withIp({ timezone: row.timezone, country: row.country_code }, row.ip) : null);
    const ipApi = ask("http://ip-api.com/json/?fields=status,timezone,countryCode,query", init.signal!, (row) =>
      row?.status === "success" && row.timezone ? withIp({ timezone: row.timezone, country: row.countryCode }, row.query) : null);
    const found = await maxMind ?? await ipApi;
    if (found) return found;
    // ip-api.com is IPv4-only; an IPv6-only exit falls through to v6.ipinfo.io.
    const res = await fetchFn("https://v6.ipinfo.io/json", { ...init, signal: AbortSignal.timeout(10_000) });
    const row = (await res.json()) as { timezone?: string; country?: string; ip?: string } | null;
    return typeof row?.timezone === "string" && row.timezone ? withIp({ timezone: row.timezone, country: row.country }, row.ip) : null;
  } catch {
    return null;
  } finally {
    relay?.close();
  }
}

function withIp<T extends object>(location: T, raw: unknown): T & { ip?: string } {
  const ip = typeof raw === "string" ? canonicalIp(raw) : null;
  return ip ? { ...location, ip } : location;
}

// Profiles that share a proxy often open together, and ip-api.com answers 45 requests a minute
// per address, so one answer serves each proxy for a minute. A failed lookup is kept for the same
// minute: a lookup service that hangs would otherwise add its full wait to every open.
const EXIT_REUSE_MS = 60_000;
const exits = new Map<string, { at: number; location: Promise<ExitLocation | null> }>();

/**
 * Where a proxy's traffic leaves from (timezone, country and address), looked up through the
 * proxy and never directly. Waits at most `waitMs`; an answer that comes later still serves the
 * next launch. A changed proxy (type, host, port or login) gets its own lookup.
 */
export async function lookupProxyExitLocation(
  proxy: ProxySpec,
  opts: { fetchFn?: FetchLike; waitMs?: number; now?: () => number } = {},
): Promise<ExitLocation | null> {
  const now = opts.now ?? Date.now;
  const key = JSON.stringify([proxy.type, proxy.host, String(proxy.port), proxy.user ?? "", proxy.pass ?? ""]);
  let entry = exits.get(key);
  if (!entry || now() - entry.at >= EXIT_REUSE_MS) {
    for (const [old, value] of exits) if (now() - value.at >= EXIT_REUSE_MS) exits.delete(old);
    const created = { at: now(), location: lookupExitLocation(proxy, opts.fetchFn) };
    exits.set(key, created);
    entry = created;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      entry.location,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.waitMs ?? 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupExitTimezone(proxy: ProxySpec | null, fetchFn?: FetchLike): Promise<string | null> {
  return (await lookupExitLocation(proxy, fetchFn))?.timezone ?? null;
}

/**
 * Resolve and attach `timezone` to each profile from its proxy's exit IP, so
 * gateway/rotating proxies get the timezone they actually exit in. Mutates and
 * returns the same array. Profiles without a proxy (or unresolved) keep
 * whatever timezone they already had. A gateway's location is not its exit.
 */
export async function attachTimezones<T extends { proxy: ProxySpec | null; timezone: string; locale?: string }>(
  profiles: T[],
  fetchFn: FetchLike = (url, init) => fetch(url, init),
  refreshLocale = false,
): Promise<{ profiles: T[]; resolved: number }> {
  const withProxy = profiles.filter((p) => p.proxy?.host);
  if (withProxy.length === 0) return { profiles, resolved: 0 };
  let resolved = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, withProxy.length) }, async () => {
    while (next < withProxy.length) {
      const p = withProxy[next++]!;
      const location = await lookupExitLocation(p.proxy!, fetchFn);
      if (location) {
        p.timezone = location.timezone;
        if (refreshLocale || !p.locale) p.locale = localeForCountry(location.country) ?? localeForTimezone(location.timezone);
        resolved++;
      }
    }
  }));
  return { profiles, resolved };
}

/** Best-effort import-time timezone enrichment and shared SOCKS5 tunneling. */

import { connect as netConnect, type Socket } from "node:net";
import type { ProxySpec } from "./types.ts";

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

/** Map of proxy host/IP → IANA timezone for the ones that resolved. */
export async function lookupTimezones(
  hosts: string[],
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(hosts.filter((h) => h && h.trim()))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const res = await fetchFn("http://ip-api.com/batch?fields=query,timezone,status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((q) => ({ query: q }))),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as Array<{ query?: string; timezone?: string; status?: string }>;
      for (const row of Array.isArray(data) ? data : []) {
        if (row.status === "success" && row.query && row.timezone) out.set(row.query, row.timezone);
      }
    } catch {
      /* offline / blocked / rate-limited → leave this chunk unresolved */
    }
  }
  return out;
}

/**
 * Resolve and attach `timezone` to each profile from its proxy host. Mutates
 * and returns the same array. Profiles without a proxy (or unresolved) keep
 * whatever timezone they already had (default "").
 */
export async function attachTimezones<T extends { proxy: { host: string } | null; timezone: string }>(
  profiles: T[],
  fetchFn?: FetchLike,
): Promise<{ profiles: T[]; resolved: number }> {
  const hosts = profiles.map((p) => p.proxy?.host).filter((h): h is string => !!h);
  if (hosts.length === 0) return { profiles, resolved: 0 };
  const tz = await lookupTimezones(hosts, fetchFn);
  let resolved = 0;
  for (const p of profiles) {
    const host = p.proxy?.host;
    if (host && tz.has(host)) {
      p.timezone = tz.get(host)!;
      resolved++;
    }
  }
  return { profiles, resolved };
}

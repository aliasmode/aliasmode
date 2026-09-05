/**
 * Local auth-injecting proxy relay.
 *
 * aliasmode launches the CloakBrowser binary as a raw process with `--proxy-server`, but Chromium
 * ignores credentials on that flag. The previous fix — a generated MV3 extension answering
 * `chrome.webRequest.onAuthRequired` — is unreliable: the service worker can't answer the proxy
 * challenge fast enough during a page-load burst, so some requests fail proxy auth
 * (ERR_INVALID_AUTH_CREDENTIALS) and a SPA like LinkedIn drops the session a few seconds after it
 * loads.
 *
 * Instead the browser points at this loopback HTTP relay with NO auth. For an HTTP upstream, the
 * relay injects `Proxy-Authorization` when credentials are configured. For SOCKS5, it performs RFC 1928/1929 itself and carries the
 * browser's HTTP/CONNECT traffic through that tunnel. The latter is important for packaged kernels
 * older than CloakBrowser 0.3.24, where inline SOCKS credentials are ignored by Chromium.
 */

import net from "node:net";
import { openSocks5Tunnel } from "./geoip.ts";
import type { ProxySpec } from "./types.ts";

export interface UpstreamProxy {
  /** Omitted for backward-compatible HTTP relay callers. */
  type?: "http" | "socks5";
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface ProxyRelay {
  /** Loopback port the browser's `--proxy-server` points at. */
  port: number;
  close(): void;
}

export interface RelayOptions {
  /** Bind to this exact loopback port (omitted/0 = ephemeral). Used to re-bind a survivor after a
   *  manager restart, since the running browser's `--proxy-server` still points at the old port. */
  port?: number;
  log?: (msg: string) => void;
}

const MAX_HEAD = 64 * 1024; // cap a request/response head so a never-terminating head can't grow unbounded

type TrackSocket = (socket: net.Socket) => net.Socket;

/** Start a loopback relay that forwards to `up`, injecting its credentials. Resolves once listening. */
export function startProxyRelay(up: UpstreamProxy, opts: RelayOptions = {}): Promise<ProxyRelay> {
  const auth = up.user ? "Basic " + Buffer.from(`${up.user}:${up.pass}`).toString("base64") : null;
  const log = opts.log ?? (() => {});
  // server.close() only stops accepting new clients; it deliberately waits for
  // existing sockets and does not destroy them. Track both sides of every relay
  // connection so closing a profile cannot leave a stalled CONNECT/upstream
  // socket keeping the Bun process and its buffers alive indefinitely.
  const sockets = new Set<net.Socket>();
  const track: TrackSocket = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = net.createServer((client) => handleClient(track(client), up, auth, log, track));
  server.on("error", (e) => log(`proxy relay server error: ${e.message}`));
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    server.once("error", onErr);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onErr);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      let closed = false;
      resolve({
        port,
        close: () => {
          if (closed) return;
          closed = true;
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close();
        },
      });
    });
  });
}

function handleClient(
  client: net.Socket,
  up: UpstreamProxy,
  auth: string | null,
  log: (m: string) => void,
  track: TrackSocket,
): void {
  client.on("error", () => client.destroy());
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const headEnd = buf.indexOf("\r\n\r\n");
    if (headEnd === -1) {
      if (buf.length > MAX_HEAD) client.destroy();
      return;
    }
    client.removeListener("data", onData);
    const head = buf.subarray(0, headEnd + 4).toString("latin1");
    const rest = buf.subarray(headEnd + 4); // bytes already past the head (a plain-HTTP body, usually empty)
    const firstLine = head.split("\r\n")[0] ?? "";
    if (/^CONNECT\s/i.test(firstLine)) connectTunnel(client, up, auth, firstLine, rest, log, track);
    else plainHttp(client, up, auth, head, rest, log, track);
  };
  client.on("data", onData);
}

/** HTTPS: open the upstream tunnel with auth, then pipe raw bytes (TLS is opaque). */
function connectTunnel(
  client: net.Socket,
  up: UpstreamProxy,
  auth: string | null,
  firstLine: string,
  rest: Buffer,
  log: (m: string) => void,
  track: TrackSocket,
): void {
  const target = firstLine.split(/\s+/)[1] ?? ""; // "host:port"
  if (up.type === "socks5") {
    void connectSocksTunnel(client, up, target, rest, log, track);
    return;
  }
  const upSock = track(net.connect({ host: up.host, port: up.port }));
  upSock.on("error", (e) => { log(`upstream CONNECT error for ${target}: ${e.message}`); client.destroy(); });
  client.on("error", () => upSock.destroy());
  // In particular, cover a browser abandoning CONNECT before the upstream has
  // replied: the streams are not piped yet, so normal pipe end-propagation does
  // not exist and the upstream socket otherwise survives the client.
  client.once("close", () => upSock.destroy());
  upSock.on("connect", () => {
    const headers = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
      "",
      "",
    ];
    upSock.write(headers.join("\r\n"));
  });
  let rbuf = Buffer.alloc(0);
  const onUpData = (chunk: Buffer) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    const end = rbuf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (rbuf.length > MAX_HEAD) { client.destroy(); upSock.destroy(); }
      return;
    }
    upSock.removeListener("data", onUpData);
    const status = (rbuf.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "");
    if (!/\s2\d\d\s/.test(status)) { // not 2xx (e.g. 407) → auth/connect failed
      log(`upstream refused CONNECT ${target}: ${status}`);
      client.destroy();
      upSock.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const extra = rbuf.subarray(end + 4); // any tunnel bytes that arrived with the response
    if (extra.length) client.write(extra);
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  };
  upSock.on("data", onUpData);
  upSock.on("close", () => client.destroy());
}

function parseAuthority(raw: string, defaultPort: number): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    throw new Error("invalid proxy target authority");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password) {
    throw new Error("invalid proxy target authority");
  }
  return { host, port };
}

function socksSpec(up: UpstreamProxy): ProxySpec {
  return {
    type: "socks5",
    host: up.host,
    port: String(up.port),
    user: up.user,
    pass: up.pass,
  };
}

async function connectSocksTunnel(
  client: net.Socket,
  up: UpstreamProxy,
  target: string,
  rest: Buffer,
  log: (m: string) => void,
  track: TrackSocket,
): Promise<void> {
  let upSock: net.Socket | undefined;
  try {
    const destination = parseAuthority(target, 443);
    client.once("close", () => upSock?.destroy());
    client.on("error", () => upSock?.destroy());
    upSock = await openSocks5Tunnel(
      socksSpec(up),
      destination.host,
      destination.port,
      10_000,
      (socket) => { upSock = track(socket); },
    );
    if (client.destroyed) {
      upSock.destroy();
      return;
    }
    upSock.on("error", (error) => {
      log(`SOCKS5 tunnel error for ${target}: ${error.message}`);
      client.destroy();
    });
    upSock.on("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  } catch (error) {
    log(`SOCKS5 CONNECT failed for ${target}: ${error instanceof Error ? error.message : error}`);
    upSock?.destroy();
    client.destroy();
  }
}

/** Plain HTTP: inject auth into the request head and force the connection closed after one response,
 *  so the browser opens a fresh (re-injected) connection for any follow-up request. */
function plainHttp(
  client: net.Socket,
  up: UpstreamProxy,
  auth: string | null,
  head: string,
  rest: Buffer,
  log: (m: string) => void,
  track: TrackSocket,
): void {
  if (up.type === "socks5") {
    void plainHttpViaSocks(client, up, head, rest, log, track);
    return;
  }
  const lines = head.split("\r\n");
  const reqLine = lines[0] ?? "";
  const headers = lines
    .slice(1)
    .filter((l) => l !== "" && !/^(proxy-authorization|connection|proxy-connection)\s*:/i.test(l));
  const rebuilt = [
    reqLine,
    ...headers,
    ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
    "Connection: close",
    "Proxy-Connection: close",
    "",
    "",
  ].join("\r\n");

  const upSock = track(net.connect({ host: up.host, port: up.port }));
  upSock.on("error", (e) => { log(`upstream HTTP error: ${e.message}`); client.destroy(); });
  client.on("error", () => upSock.destroy());
  client.once("close", () => upSock.destroy());
  upSock.on("connect", () => {
    upSock.write(rebuilt);
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  });
  upSock.on("close", () => client.destroy());
}

async function plainHttpViaSocks(
  client: net.Socket,
  up: UpstreamProxy,
  head: string,
  rest: Buffer,
  log: (m: string) => void,
  track: TrackSocket,
): Promise<void> {
  let upSock: net.Socket | undefined;
  try {
    const lines = head.split("\r\n");
    const match = (lines[0] ?? "").match(/^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/i);
    if (!match) throw new Error("invalid HTTP proxy request line");
    const [, method, requestTarget, version] = match;
    const hostHeader = lines.slice(1).find((line) => /^host\s*:/i.test(line))?.replace(/^host\s*:\s*/i, "") ?? "";
    let destination: { host: string; port: number };
    let originTarget = requestTarget!;
    if (/^http:\/\//i.test(requestTarget!)) {
      const url = new URL(requestTarget!);
      destination = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
      originTarget = `${url.pathname || "/"}${url.search}`;
    } else {
      destination = parseAuthority(hostHeader, 80);
    }
    const headers = lines
      .slice(1)
      .filter((line) => line !== "" && !/^(proxy-authorization|connection|proxy-connection)\s*:/i.test(line));
    const rebuilt = [
      `${method} ${originTarget} ${version}`,
      ...headers,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    client.once("close", () => upSock?.destroy());
    client.on("error", () => upSock?.destroy());
    upSock = await openSocks5Tunnel(
      socksSpec(up),
      destination.host,
      destination.port,
      10_000,
      (socket) => { upSock = track(socket); },
    );
    if (client.destroyed) {
      upSock.destroy();
      return;
    }
    upSock.on("error", (error) => {
      log(`SOCKS5 HTTP tunnel error: ${error.message}`);
      client.destroy();
    });
    upSock.on("close", () => client.destroy());
    upSock.write(rebuilt);
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  } catch (error) {
    log(`SOCKS5 HTTP request failed: ${error instanceof Error ? error.message : error}`);
    upSock?.destroy();
    client.destroy();
  }
}

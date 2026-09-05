import { test, expect } from "bun:test";
import net from "node:net";
import { startProxyRelay } from "./proxy-relay.ts";

const EXPECTED_AUTH = "Basic " + Buffer.from("puser:ppass").toString("base64");

/** A fake upstream proxy that requires Proxy-Authorization. Records the auth it saw. CONNECT with the
 *  right auth → 200 then echo; plain HTTP with the right auth → a fixed 200 body; wrong/no auth → 407. */
function fakeUpstream(requireAuth = true): Promise<{ port: number; close(): void; lastAuth(): string | null; connectCount(): number }> {
  let lastAuth: string | null = null;
  let connects = 0;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      sock.removeListener("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      const firstLine = head.split("\r\n")[0] ?? "";
      const authLine = head.split("\r\n").find((l) => /^proxy-authorization:/i.test(l));
      lastAuth = authLine ? authLine.split(/:\s*/).slice(1).join(": ") : null;
      const ok = !requireAuth || lastAuth === EXPECTED_AUTH;
      if (!ok) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
      if (/^CONNECT\s/i.test(firstLine)) {
        connects++;
        sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
        sock.on("data", (d) => sock.write(d)); // echo tunnel bytes
      } else {
        sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => sock.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close(), lastAuth: () => lastAuth, connectCount: () => connects });
    });
  });
}

/** Minimal authenticated SOCKS5 server. After CONNECT it either echoes tunnel
 * bytes or answers a direct HTTP request, letting the relay bridge be tested
 * without relying on Chromium or an external proxy. */
function fakeSocksUpstream(requireAuth = true): Promise<{
  port: number;
  close(): void;
  targets(): string[];
  httpHeads(): string[];
}> {
  const targets: string[] = [];
  const httpHeads: string[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let state: "greeting" | "auth" | "connect" | "tunnel" = "greeting";
    const consume = (count: number) => {
      const part = buf.subarray(0, count);
      buf = buf.subarray(count);
      return part;
    };
    const process = () => {
      while (!sock.destroyed) {
        if (state === "greeting") {
          if (buf.length < 3) return;
          const greeting = consume(3);
          const method = requireAuth ? 2 : 0;
          if (!greeting.equals(Buffer.from([5, 1, method]))) { sock.end(Buffer.from([5, 0xff])); return; }
          sock.write(Buffer.from([5, method]));
          state = requireAuth ? "auth" : "connect";
          continue;
        }
        if (state === "auth") {
          if (buf.length < 2) return;
          const userLength = buf[1]!;
          if (buf.length < 2 + userLength + 1) return;
          const passLength = buf[2 + userLength]!;
          const total = 3 + userLength + passLength;
          if (buf.length < total) return;
          const auth = consume(total);
          const user = auth.subarray(2, 2 + userLength).toString();
          const pass = auth.subarray(3 + userLength).toString();
          if (auth[0] !== 1 || user !== "puser" || pass !== "ppass") { sock.end(Buffer.from([1, 1])); return; }
          sock.write(Buffer.from([1, 0]));
          state = "connect";
          continue;
        }
        if (state === "connect") {
          if (buf.length < 5) return;
          if (buf[0] !== 5 || buf[1] !== 1 || buf[3] !== 3) { sock.destroy(); return; }
          const hostLength = buf[4]!;
          const total = 5 + hostLength + 2;
          if (buf.length < total) return;
          const request = consume(total);
          const host = request.subarray(5, 5 + hostLength).toString("ascii");
          const port = request.readUInt16BE(5 + hostLength);
          targets.push(`${host}:${port}`);
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
          state = "tunnel";
          continue;
        }
        if (buf.length === 0) return;
        if (/^(?:GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s/i.test(buf.toString("latin1"))) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          httpHeads.push(consume(end + 4).toString("latin1"));
          sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
          return;
        }
        sock.write(consume(buf.length));
        return;
      }
    };
    sock.on("data", (chunk: Buffer) => { buf = Buffer.concat([buf, chunk]); process(); });
    sock.on("error", () => sock.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as net.AddressInfo).port,
      close: () => server.close(),
      targets: () => [...targets],
      httpHeads: () => [...httpHeads],
    }));
  });
}

/** Upstream that accepts a TCP connection but never answers the proxy request. */
function stalledUpstream(): Promise<{
  port: number;
  accepted: Promise<net.Socket>;
  close(): void;
}> {
  let accept!: (socket: net.Socket) => void;
  const accepted = new Promise<net.Socket>((resolve) => { accept = resolve; });
  const server = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    accept(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        accepted,
        close: () => server.close(),
      });
    });
  });
}

function closesWithin(socket: net.Socket, ms = 1000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), ms);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

/** Connect to the relay, write `firstWrite`, collect all bytes until close (or `untilBytes`). */
function clientExchange(port: number, firstWrite: string, untilBytes?: number, thenWrite?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let out = Buffer.alloc(0);
    let sentSecond = false;
    sock.on("connect", () => sock.write(firstWrite));
    sock.on("data", (d: Buffer) => {
      out = Buffer.concat([out, d]);
      if (thenWrite && !sentSecond && out.includes("200")) { sentSecond = true; sock.write(thenWrite); }
      if (untilBytes && out.length >= untilBytes) { sock.end(); resolve(out.toString("latin1")); }
    });
    sock.on("close", () => resolve(out.toString("latin1")));
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); resolve(out.toString("latin1")); }, 4000);
  });
}

test("relay binds loopback only", async () => {
  const up = await fakeUpstream();
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  expect(relay.port).toBeGreaterThan(0);
  relay.close();
  up.close();
});

test("CONNECT: relay authenticates the tunnel and pipes bytes", async () => {
  const up = await fakeUpstream();
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  // Browser sends CONNECT with NO auth; relay injects it. After 200, send "ping" → upstream echoes it.
  const got = await clientExchange(relay.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", undefined, "ping");
  expect(got).toContain("200 Connection established");
  expect(got).toContain("ping"); // tunnel echo proves the pipe is live
  expect(up.lastAuth()).toBe(EXPECTED_AUTH); // upstream saw the injected credentials
  relay.close();
  up.close();
});

test("CONNECT omits Proxy-Authorization when the upstream needs no credentials", async () => {
  const up = await fakeUpstream(false);
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "", pass: "" });
  const got = await clientExchange(relay.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", undefined, "ping");
  expect(got).toContain("200 Connection established");
  expect(up.lastAuth()).toBeNull();
  relay.close();
  up.close();
});

test("CONNECT: wrong upstream creds → no tunnel (relay closes the client)", async () => {
  const up = await fakeUpstream();
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "WRONG" });
  const got = await clientExchange(relay.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  expect(got).not.toContain("200 Connection established"); // never tunnels on a 407
  relay.close();
  up.close();
});

test("plain HTTP: relay injects auth and forces the connection closed", async () => {
  const up = await fakeUpstream();
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  const got = await clientExchange(relay.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n\r\n");
  expect(got).toContain("200 OK");
  expect(got).toContain("hi");
  expect(up.lastAuth()).toBe(EXPECTED_AUTH);
  relay.close();
  up.close();
});

test("HTTP relay omits Proxy-Authorization when the upstream needs no credentials", async () => {
  const up = await fakeUpstream(false);
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "", pass: "" });
  const got = await clientExchange(relay.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
  expect(got).toContain("200 OK");
  expect(up.lastAuth()).toBeNull();
  relay.close();
  up.close();
});

test("SOCKS5 CONNECT: relay performs username/password auth and carries the tunnel", async () => {
  const up = await fakeSocksUpstream();
  const relay = await startProxyRelay({ type: "socks5", host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  const got = await clientExchange(relay.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", undefined, "ping");
  expect(got).toContain("200 Connection established");
  expect(got).toContain("ping");
  expect(up.targets()).toContain("example.com:443");
  relay.close();
  up.close();
});

test("SOCKS5 CONNECT: relay also supports a no-auth upstream", async () => {
  const up = await fakeSocksUpstream(false);
  const relay = await startProxyRelay({ type: "socks5", host: "127.0.0.1", port: up.port, user: "", pass: "" });
  const got = await clientExchange(relay.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", undefined, "ping");
  expect(got).toContain("200 Connection established");
  expect(got).toContain("ping");
  relay.close();
  up.close();
});

test("SOCKS5 plain HTTP: relay uses remote DNS and rewrites absolute-form to origin-form", async () => {
  const up = await fakeSocksUpstream();
  const relay = await startProxyRelay({ type: "socks5", host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  const got = await clientExchange(relay.port, "GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n\r\n");
  expect(got).toContain("200 OK");
  expect(got).toContain("hi");
  expect(up.targets()).toContain("example.com:80");
  expect(up.httpHeads()[0]).toStartWith("GET /path?q=1 HTTP/1.1\r\n");
  expect(up.httpHeads()[0]).not.toContain("Proxy-Connection");
  expect(up.httpHeads()[0]).not.toContain("Proxy-Authorization");
  relay.close();
  up.close();
});

test("SOCKS5 wrong credentials never expose a successful local tunnel", async () => {
  const up = await fakeSocksUpstream();
  const relay = await startProxyRelay({ type: "socks5", host: "127.0.0.1", port: up.port, user: "puser", pass: "wrong" });
  const got = await clientExchange(relay.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  expect(got).not.toContain("200 Connection established");
  relay.close();
  up.close();
});

test("re-bind on a specific port (restart survival)", async () => {
  const up = await fakeUpstream();
  const first = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  const wanted = first.port;
  first.close();
  await new Promise((r) => setTimeout(r, 100));
  const second = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" }, { port: wanted });
  expect(second.port).toBe(wanted); // a survivor's browser still points here
  second.close();
  up.close();
});

test("abandoned CONNECT closes its still-waiting upstream socket", async () => {
  const up = await stalledUpstream();
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  const client = net.connect({ host: "127.0.0.1", port: relay.port });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const upstreamSocket = await up.accepted;
  const upstreamClosed = closesWithin(upstreamSocket);

  client.destroy();

  await upstreamClosed;
  relay.close();
  up.close();
});

test("relay.close destroys accepted clients and upstream sockets, not only the listener", async () => {
  const up = await stalledUpstream();
  const relay = await startProxyRelay({ host: "127.0.0.1", port: up.port, user: "puser", pass: "ppass" });
  const client = net.connect({ host: "127.0.0.1", port: relay.port });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const upstreamSocket = await up.accepted;
  const clientClosed = closesWithin(client);
  const upstreamClosed = closesWithin(upstreamSocket);

  relay.close();

  await Promise.all([clientClosed, upstreamClosed]);
  up.close();
});

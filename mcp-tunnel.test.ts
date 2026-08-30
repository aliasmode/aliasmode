import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { WebSocket } from "ws";
import { MCP_TUNNEL_PROTOCOL } from "./contracts/cloud-v1.ts";
import { McpTunnelRuntime } from "./mcp-tunnel.ts";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = null;
  input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk) => { this.input += chunk.toString("utf8"); });
  }

  output(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  finish(code = 0): void {
    this.stdout.end();
    this.emit("close", code);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for tunnel event");
    await Bun.sleep(5);
  }
}

test("remote MCP tunnel owns one safely-closing child per Cloud session", async () => {
  const sockets: FakeSocket[] = [];
  const children: FakeChild[] = [];
  const runtime = new McpTunnelRuntime({
    baseUrl: "https://cloud.example.test",
    accessToken: () => "access-token",
    deviceId: () => "device-id",
    deviceCredential: () => "device-credential",
    reconnectDelayMs: 1,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as any;
    },
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child as any;
    },
  });

  runtime.start();
  await waitFor(() => sockets.length === 1);
  const socket = sockets[0]!;
  socket.open();
  socket.emit("message", Buffer.from(JSON.stringify({
    protocol: MCP_TUNNEL_PROTOCOL,
    type: "open",
    sessionId: "session-1",
  })));
  socket.emit("message", Buffer.from(JSON.stringify({
    protocol: MCP_TUNNEL_PROTOCOL,
    type: "open",
    sessionId: "session-2",
  })));
  expect(children).toHaveLength(2);

  socket.emit("message", Buffer.from(JSON.stringify({
    protocol: MCP_TUNNEL_PROTOCOL,
    type: "message",
    sessionId: "session-1",
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  })));
  await waitFor(() => children[0]!.input.includes("tools/list"));

  children[0]!.output({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  await waitFor(() => socket.sent.some((line) => line.includes('"type":"message"')));

  socket.emit("message", Buffer.from(JSON.stringify({
    protocol: MCP_TUNNEL_PROTOCOL,
    type: "close",
    sessionId: "session-1",
  })));
  expect(children[0]!.stdin.writableEnded).toBe(true);
  expect(socket.sent.some((line) => line.includes('"type":"closed"') && line.includes("session-1"))).toBe(false);
  children[0]!.finish();
  await waitFor(() => socket.sent.some((line) => line.includes('"type":"closed"') && line.includes("session-1")));

  socket.close();
  await waitFor(() => children[1]!.stdin.writableEnded);
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await Bun.sleep(10);
  expect(stopped).toBe(false);
  children[1]!.finish();
  await stopping;
  expect(stopped).toBe(true);
});

test("disconnect prevents a late authentication refresh from reconnecting", async () => {
  const sockets: FakeSocket[] = [];
  let tokenRequested = false;
  let resolveToken!: (token: string) => void;
  const token = new Promise<string>((resolve) => { resolveToken = resolve; });
  const runtime = new McpTunnelRuntime({
    baseUrl: "https://cloud.example.test",
    accessToken: () => {
      tokenRequested = true;
      return token;
    },
    deviceId: () => "device-id",
    deviceCredential: () => "device-credential",
    reconnectDelayMs: 1,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as any;
    },
    spawnChild: () => new FakeChild() as any,
  });

  runtime.start();
  await waitFor(() => tokenRequested);
  await runtime.disconnect();
  resolveToken("access-token");
  await Bun.sleep(10);
  expect(sockets).toHaveLength(0);
  await runtime.stop();
});

test("disconnect pauses the tunnel until authentication refresh", async () => {
  const sockets: FakeSocket[] = [];
  const runtime = new McpTunnelRuntime({
    baseUrl: "https://cloud.example.test",
    accessToken: () => "access-token",
    deviceId: () => "device-id",
    deviceCredential: () => "device-credential",
    reconnectDelayMs: 1,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as any;
    },
    spawnChild: () => new FakeChild() as any,
  });
  runtime.start();
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  await runtime.disconnect();
  await Bun.sleep(10);
  expect(sockets).toHaveLength(1);
  runtime.refresh();
  await waitFor(() => sockets.length === 2);
  await runtime.stop();
});

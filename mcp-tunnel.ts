import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { WebSocket, type RawData } from "ws";
import { normalizeSecureServiceUrl } from "./app-config.ts";
import {
  MCP_TUNNEL_PROTOCOL,
  type McpTunnelToCloud,
  type McpTunnelToDevice,
} from "./contracts/cloud-v1.ts";

interface TunnelChild extends ChildProcessByStdio<Writable, Readable, null> {}

interface TunnelSocket {
  readonly readyState: number;
  on(event: "message", listener: (data: RawData) => void): unknown;
  once(event: "open" | "close" | "error", listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
}

interface ChildSession {
  child: TunnelChild;
  closing: boolean;
  writeQueue: Promise<void>;
  exited: Promise<void>;
  resolveExit: () => void;
}

export interface McpTunnelLifecycle {
  refresh(): void;
  disconnect(): Promise<void>;
}

export interface McpTunnelOptions {
  baseUrl: string;
  accessToken: () => string | undefined | Promise<string | undefined>;
  deviceId: () => string | undefined;
  deviceCredential: () => string | undefined;
  helperPath?: string;
  connect?: (url: string, headers: Record<string, string>) => TunnelSocket;
  spawnChild?: () => TunnelChild;
  reconnectDelayMs?: number;
  log?: (message: string) => void;
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH",
    "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function defaultHelperPath(): string {
  return join(dirname(process.execPath), process.platform === "win32" ? "aliasmode-mcp.exe" : "aliasmode-mcp");
}

function tunnelUrl(baseUrl: string): string {
  const url = new URL("/v1/mcp/tunnel", normalizeSecureServiceUrl(baseUrl, "AliasMode Cloud"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class McpTunnelRuntime implements McpTunnelLifecycle {
  private readonly url: string;
  private readonly sessions = new Map<string, ChildSession>();
  private socket: TunnelSocket | undefined;
  private loop: Promise<void> | undefined;
  private running = false;
  private paused = true;
  private wakeWait: (() => void) | undefined;

  constructor(private readonly options: McpTunnelOptions) {
    this.url = tunnelUrl(options.baseUrl);
  }

  start(): void {
    this.paused = false;
    if (this.running) {
      this.wake();
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  refresh(): void {
    this.paused = false;
    this.resetSocket();
    this.wake();
  }

  async disconnect(): Promise<void> {
    this.paused = true;
    this.resetSocket();
    this.wake();
    await this.closeAllChildren();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.paused = true;
    this.resetSocket();
    this.wake();
    await this.closeAllChildren();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    const reconnectDelayMs = Math.max(1, this.options.reconnectDelayMs ?? 2_000);
    while (this.running) {
      if (this.paused) {
        await this.wait(reconnectDelayMs);
        continue;
      }
      let accessToken: string | undefined;
      try {
        accessToken = await this.options.accessToken();
      } catch {
        this.options.log?.("remote MCP authentication refresh failed");
      }
      if (!this.running || this.paused) continue;
      const deviceId = this.options.deviceId();
      const deviceCredential = this.options.deviceCredential();
      if (!accessToken || !deviceId || !deviceCredential) {
        await this.wait(reconnectDelayMs);
        continue;
      }

      try {
        await this.connectOnce(accessToken, deviceCredential);
      } catch {
        this.options.log?.("remote MCP tunnel connection failed");
      }
      await this.closeAllChildren();
      if (this.running && !this.paused) await this.wait(reconnectDelayMs);
    }
  }

  private async connectOnce(accessToken: string, deviceCredential: string): Promise<void> {
    const socket = (this.options.connect ?? ((url, headers) => new WebSocket(url, { headers })))(this.url, {
      Authorization: `Bearer ${accessToken}`,
      "X-AliasMode-Device": deviceCredential,
    });
    this.socket = socket;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = undefined;
        resolve();
      };
      socket.once("open", () => this.options.log?.("remote MCP tunnel connected"));
      socket.on("message", (data) => this.receive(socket, data));
      socket.once("close", finish);
      socket.once("error", finish);
    });
  }

  private receive(socket: TunnelSocket, data: RawData): void {
    if (socket !== this.socket || this.paused) return;
    let frame: McpTunnelToDevice;
    try {
      frame = JSON.parse(data.toString()) as McpTunnelToDevice;
    } catch {
      this.resetSocket();
      return;
    }
    if (frame.protocol !== MCP_TUNNEL_PROTOCOL || typeof frame.sessionId !== "string") {
      this.resetSocket();
      return;
    }
    if (frame.type === "open") {
      this.openChild(frame.sessionId);
      return;
    }
    if (frame.type === "close") {
      this.closeChild(frame.sessionId);
      return;
    }
    if (frame.type === "message") {
      this.writeChild(frame.sessionId, frame.payload);
      return;
    }
    this.resetSocket();
  }

  private openChild(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.send({
        protocol: MCP_TUNNEL_PROTOCOL,
        type: "error",
        sessionId,
        code: "session_exists",
        message: "The remote MCP session already exists.",
      });
      return;
    }

    const spawnChild = this.options.spawnChild ?? (() => spawn(
      this.options.helperPath ?? defaultHelperPath(),
      ["serve"],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: helperEnvironment(),
      },
    ));
    let child: TunnelChild;
    try {
      child = spawnChild();
    } catch {
      this.send({
        protocol: MCP_TUNNEL_PROTOCOL,
        type: "error",
        sessionId,
        code: "host_start_failed",
        message: "The AliasMode MCP host could not start.",
      });
      return;
    }

    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const session: ChildSession = {
      child,
      closing: false,
      writeQueue: Promise.resolve(),
      exited,
      resolveExit,
    };
    this.sessions.set(sessionId, session);

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const payload = JSON.parse(line) as unknown;
        this.send({ protocol: MCP_TUNNEL_PROTOCOL, type: "message", sessionId, payload });
      } catch {
        this.closeChild(sessionId);
      }
    });
    child.once("error", () => this.finishChild(sessionId, false));
    child.once("close", (code) => this.finishChild(sessionId, code === 0));
  }

  private writeChild(sessionId: string, payload: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return;
    session.writeQueue = session.writeQueue.then(() => new Promise<void>((resolve, reject) => {
      session.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    })).catch(() => {
      this.closeChild(sessionId);
    });
  }

  private closeChild(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    if (!session.closing) {
      session.closing = true;
      session.child.stdin.end();
    }
    return session.exited;
  }

  private finishChild(sessionId: string, clean: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.resolveExit();
    if (session.closing || clean) {
      this.send({ protocol: MCP_TUNNEL_PROTOCOL, type: "closed", sessionId });
    } else {
      this.send({
        protocol: MCP_TUNNEL_PROTOCOL,
        type: "error",
        sessionId,
        code: "host_exited",
        message: "The AliasMode MCP host exited unexpectedly.",
      });
    }
  }

  private async closeAllChildren(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeChild(sessionId)));
  }

  private send(frame: McpTunnelToCloud): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      this.resetSocket();
    }
  }

  private resetSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try {
      socket.close(1000, "AliasMode tunnel reset");
      socket.terminate?.();
    } catch {
      socket.terminate?.();
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeWait === done) this.wakeWait = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeWait = done;
    });
  }

  private wake(): void {
    this.wakeWait?.();
  }
}

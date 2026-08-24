import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import NodeWebSocket from "ws";

export const RUNTIME_PROTOCOL = "aliasmode-runtime-v1";
export const AGENT_PROTOCOL = "aliasmode-agent-v1";
export const AGENT_PATH = "/api/agent/v1/connect";
const VERSION = process.env.ALIASMODE_APP_VERSION || "0.1.0-beta.32";
const STARTUP_WAIT_MS = 180_000;
const execFileAsync = promisify(execFile);

function validNonce(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateRuntimeDescriptor(value, expectedVersion = VERSION) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime descriptor is invalid");
  const ready = new Set(["local", "cloud_authenticated", "sign_in_required"]);
  if (
    value.protocol !== RUNTIME_PROTOCOL ||
    value.appVersion !== expectedVersion ||
    !validNonce(value.generation) ||
    !validNonce(value.nonce) ||
    !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535 ||
    !Number.isInteger(value.desktopPid) || value.desktopPid < 1 ||
    !Number.isInteger(value.sidecarPid) || value.sidecarPid < 1 ||
    typeof value.desktopStartedAt !== "string" || !/^\d+$/.test(value.desktopStartedAt) ||
    !ready.has(value.readiness) ||
    !Number.isInteger(value.createdAt) || value.createdAt < 1
  ) {
    throw new Error("runtime descriptor did not match this AliasMode adapter");
  }
  return value;
}

export function defaultRuntimeDescriptorPath(env = process.env) {
  if (env.ALIASMODE_RUNTIME_DESCRIPTOR) return env.ALIASMODE_RUNTIME_DESCRIPTOR;
  if (!env.APPDATA) throw new Error("APPDATA is required to discover AliasMode");
  return join(env.APPDATA, "com.aliasmode.desktop", "agent-runtime.json");
}

export function windowsProcessIdentityCommand(pid, env = process.env) {
  const executable = env.SYSTEMROOT
    ? win32.join(env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return {
    executable,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`,
    ],
  };
}

async function processStartIdentity(pid) {
  if (process.platform === "win32") {
    const command = windowsProcessIdentityCommand(pid);
    const { stdout } = await execFileAsync(
      command.executable,
      command.args,
      { windowsHide: true, timeout: 5_000, maxBuffer: 1024 },
    );
    const value = stdout.trim();
    if (!/^\d+$/.test(value)) throw new Error("desktop process identity is invalid");
    return value;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const value = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/)[19] : undefined;
  if (!value || !/^\d+$/.test(value)) throw new Error("desktop process identity is invalid");
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifyHealth(descriptor) {
  if (!processExists(descriptor.desktopPid) || !processExists(descriptor.sidecarPid)) {
    throw new Error("AliasMode runtime processes are not active");
  }
  if (await processStartIdentity(descriptor.desktopPid) !== descriptor.desktopStartedAt) {
    throw new Error("AliasMode desktop process identity changed");
  }
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/ui/api/health`, {
    signal: AbortSignal.timeout(2_000),
    redirect: "error",
  });
  if (!response.ok || Number(response.headers.get("content-length") || 0) > 16 * 1024) {
    throw new Error("AliasMode health proof failed");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 16 * 1024) throw new Error("AliasMode health proof is oversized");
  const health = JSON.parse(new TextDecoder().decode(bytes));
  if (
    health.ok !== true ||
    health.version !== descriptor.appVersion ||
    health.instance !== descriptor.generation
  ) {
    throw new Error("AliasMode health proof did not match the discovered runtime");
  }
}

function listen(socket, event, handler, once = false) {
  const method = once ? "once" : "on";
  if (typeof socket[method] === "function") {
    socket[method](event, handler);
    return;
  }
  socket.addEventListener(event, (value) => {
    handler(event === "message" ? value.data : value);
  }, { once });
}

function terminate(socket) {
  if (typeof socket.terminate === "function") socket.terminate();
  else socket.close();
}

export class AgentRuntimeClient {
  constructor(socket) {
    this.socket = socket;
    this.nativeSocket = typeof socket.on !== "function";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    listen(socket, "message", (data) => this.#onMessage(data));
    listen(socket, "close", () => this.#onClose(new Error("AliasMode agent connection closed")));
    listen(socket, "error", () => this.#onClose(new Error("AliasMode agent connection failed")));
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("AliasMode agent connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ protocol: AGENT_PROTOCOL, id, method, params });
      if (this.nativeSocket) {
        try {
          this.socket.send(payload);
        } catch {
          this.pending.delete(id);
          reject(new Error("AliasMode agent request could not be sent"));
        }
        return;
      }
      this.socket.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new Error("AliasMode agent request could not be sent"));
      });
    });
  }

  close() {
    if (this.socket.readyState === 1) this.socket.close();
    else if (this.socket.readyState === 0) terminate(this.socket);
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending(new Error("AliasMode agent connection closed"));
  }

  #onMessage(data) {
    let value;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      this.#onClose(new Error("AliasMode returned malformed agent data"));
      return;
    }
    if (
      value?.protocol !== AGENT_PROTOCOL ||
      !Number.isSafeInteger(value.id) ||
      typeof value.ok !== "boolean"
    ) {
      this.#onClose(new Error("AliasMode returned an invalid agent response"));
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.ok) pending.resolve(value.result);
    else {
      const error = new Error(value.error?.message || "AliasMode operation failed");
      error.code = value.error?.code || "operation_failed";
      pending.reject(error);
    }
  }

  #onClose(error) {
    if (this.socket.readyState === 1 || this.socket.readyState === 0) {
      terminate(this.socket);
    }
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function connectAgent(descriptor) {
  await verifyHealth(descriptor);
  const url = `ws://127.0.0.1:${descriptor.port}${AGENT_PATH}`;
  const bunNative = typeof process.versions.bun === "string";
  const socket = bunNative
    ? new globalThis.WebSocket(url, {
        protocol: AGENT_PROTOCOL,
        headers: { Authorization: `Bearer ${descriptor.nonce}` },
      })
    : new NodeWebSocket(url, AGENT_PROTOCOL, {
        headers: { Authorization: `Bearer ${descriptor.nonce}` },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 5_000,
        followRedirects: false,
      });
  await new Promise((resolve, reject) => {
    let settled = false;
    const failed = (message) => {
      if (settled) return;
      settled = true;
      terminate(socket);
      reject(new Error(message));
    };
    listen(socket, "open", () => {
      if (settled) return;
      settled = true;
      resolve();
    }, true);
    listen(socket, "error", (error) => {
      failed(`AliasMode agent handshake failed: ${error?.message || "connection error"}`);
    }, true);
    if (!bunNative) {
      listen(socket, "unexpected-response", (_request, response) => {
        failed(`AliasMode agent handshake was rejected with status ${response.statusCode}`);
      }, true);
    }
  });
  if (!bunNative && socket.protocol !== AGENT_PROTOCOL) {
    socket.close();
    throw new Error("AliasMode agent protocol negotiation failed");
  }
  return new AgentRuntimeClient(socket);
}

function defaultDesktopExecutable(env = process.env) {
  if (env.ALIASMODE_DESKTOP_EXE) return env.ALIASMODE_DESKTOP_EXE;
  if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required to start AliasMode");
  return join(env.LOCALAPPDATA, "AliasMode", "AliasMode.exe");
}

function launchBackground(executable) {
  if (!existsSync(executable)) throw new Error("AliasMode is not installed at the expected path");
  const child = spawn(executable, ["--background"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function readRuntimeDescriptor(path, version) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("AliasMode runtime descriptor is unavailable");
  }
  try {
    return validateRuntimeDescriptor(JSON.parse(text), version);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("AliasMode runtime descriptor is malformed");
    throw error;
  }
}

export async function discoverRuntime(options = {}) {
  const descriptorPath = options.descriptorPath || defaultRuntimeDescriptorPath(options.env);
  const desktopExecutable = options.desktopExecutable || defaultDesktopExecutable(options.env);
  const deadline = Date.now() + (options.waitMs ?? STARTUP_WAIT_MS);
  let launched;
  let lastError = new Error("AliasMode runtime is not ready");

  while (Date.now() < deadline) {
    try {
      const descriptor = await readRuntimeDescriptor(
        descriptorPath,
        options.version || VERSION,
      );
      const client = await connectAgent(descriptor);
      return { client, descriptor };
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
      if (launched?.exitCode !== null && launched?.exitCode !== undefined) {
        throw new Error(`AliasMode desktop exited before runtime readiness with code ${launched.exitCode}`);
      }
      if (!launched) launched = launchBackground(desktopExecutable);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`AliasMode did not become ready: ${lastError.message}`);
}

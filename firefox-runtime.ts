import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  PLAYWRIGHT_MAX_MESSAGE_BYTES,
  PLAYWRIGHT_PROTOCOL_VERSION,
  playwrightWorkerEnvironment,
  resolvePlaywrightRuntime,
} from "./playwright-runtime.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface FirefoxOwner {
  endpoint: string;
  token: string;
  pid: number;
  browserPid: number;
  generation: string;
  binaryPath?: string;
}

export interface FirefoxReservation {
  endpoint: string;
  token: string;
  generation: string;
}

export interface StartFirefoxOwnerInput {
  profileId: string;
  executablePath: string;
  executableSha256: string;
  userDataDir: string;
  config: Record<string, JsonValue>;
  proxy?: { server: string; username?: string; password?: string; bypass?: string };
  headless?: boolean;
  args?: string[];
  restoreLastSession?: boolean;
  timeoutMs?: number;
}

export interface FirefoxOwnerCallbacks {
  reservation?: FirefoxReservation;
  onSpawn?: (owner: FirefoxOwner) => void | Promise<void>;
  onReady?: (owner: FirefoxOwner) => void | Promise<void>;
}

export interface FirefoxOwnerErrorDetails {
  operation?: string;
  outcome?: string;
}

export class FirefoxOwnerError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_response" | "operation_failed" | "runtime_unavailable" | "timeout",
    message: string,
    readonly details?: FirefoxOwnerErrorDetails,
  ) {
    super(message);
    this.name = "FirefoxOwnerError";
  }
}

const owners = new Map<string, FirefoxOwner>();

function endpointUrl(endpoint: string): URL {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new FirefoxOwnerError("invalid_request", "Firefox owner endpoint is invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/") {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner endpoint is invalid");
  }
  return parsed;
}

function endpointKey(endpoint: string, generation: string): string {
  const parsed = endpointUrl(endpoint);
  return `firefox://127.0.0.1:${parsed.port}/${encodeURIComponent(generation)}`;
}

function responseError(code: string, message: string, details?: FirefoxOwnerErrorDetails): FirefoxOwnerError {
  const valid = ["invalid_request", "invalid_response", "operation_failed", "runtime_unavailable", "timeout"] as const;
  return new FirefoxOwnerError(valid.includes(code as typeof valid[number]) ? code as typeof valid[number] : "operation_failed", message, details);
}

function requestSignal(options: { signal?: AbortSignal; timeoutMs?: number }) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner timeout is invalid");
  }
  if (!options.signal && options.timeoutMs === undefined) return { signal: undefined, dispose() {}, timedOut: () => false };
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
    timedOut: () => timedOut,
  };
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PLAYWRIGHT_MAX_MESSAGE_BYTES) throw new FirefoxOwnerError("invalid_response", "Firefox owner response exceeded its limit");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port)) {
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner port is unavailable");
  }
  return address.port;
}

export async function reserveFirefoxOwner(): Promise<FirefoxReservation> {
  const port = await freeLoopbackPort();
  return {
    endpoint: `http://127.0.0.1:${port}/`,
    token: randomBytes(32).toString("hex"),
    generation: randomBytes(16).toString("hex"),
  };
}

export function firefoxOwnerReady(response: unknown): FirefoxOwner {
  const value: any = response;
  if (value?.version !== PLAYWRIGHT_PROTOCOL_VERSION) {
    throw new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid");
  }
  if (value.ok === false) {
    throw responseError(value.error?.code, "Firefox owner failed before ready");
  }
  if (value.ok !== true
    || typeof value.result?.endpoint !== "string" || typeof value.result?.generation !== "string"
    || !Number.isSafeInteger(value.result?.pid) || !Number.isSafeInteger(value.result?.browserPid)) {
    throw new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid");
  }
  return value.result;
}

function readReady(child: ChildProcess, timeoutMs?: number): Promise<FirefoxOwner> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      try { child.kill(); } catch {}
      fail(new FirefoxOwnerError("timeout", "Firefox owner readiness timed out"));
    }, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const succeed = (owner: FirefoxOwner) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(owner);
    };
    child.once("error", () => fail(new FirefoxOwnerError("runtime_unavailable", "Firefox owner could not start")));
    child.once("close", () => fail(new FirefoxOwnerError("runtime_unavailable", "Firefox owner stopped before ready")));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
        fail(new FirefoxOwnerError("invalid_response", "Firefox owner readiness exceeded its limit"));
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      let response: any;
      try { response = JSON.parse(output.slice(0, newline)); } catch { fail(new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid")); return; }
      try { succeed(firefoxOwnerReady(response)); }
      catch (error) { fail(error instanceof Error ? error : new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid")); }
    });
  });
}

export async function startFirefoxOwner(
  input: StartFirefoxOwnerInput,
  callbacks: FirefoxOwnerCallbacks = {},
): Promise<FirefoxOwner> {
  if (!input || typeof input.profileId !== "string" || !input.profileId
    || typeof input.executablePath !== "string" || !input.executablePath
    || typeof input.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.executableSha256)
    || typeof input.userDataDir !== "string" || !input.userDataDir
    || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || (input.restoreLastSession !== undefined && typeof input.restoreLastSession !== "boolean")
    || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1))) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner input is invalid");
  }
  try { JSON.stringify(input.config); } catch { throw new FirefoxOwnerError("invalid_request", "Firefox owner input is invalid"); }
  if (await sha256File(input.executablePath) !== input.executableSha256) {
    throw new FirefoxOwnerError("operation_failed", "Firefox executable changed before launch");
  }
  const reservation = callbacks.reservation ?? await reserveFirefoxOwner();
  endpointUrl(reservation.endpoint);
  if (typeof reservation.token !== "string" || !reservation.token || typeof reservation.generation !== "string" || !reservation.generation) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner reservation is invalid");
  }
  const runtime = resolvePlaywrightRuntime();
  const workerPath = runtime.kind === "source"
    ? join(import.meta.dir, "firefox-worker.mjs")
    : join(runtime.root, "firefox-worker.mjs");
  let child: ChildProcess;
  try {
    child = spawn(runtime.nodeExecutable, [workerPath, `--aliasmode-firefox-owner=${reservation.generation}`], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: playwrightWorkerEnvironment(),
    });
  } catch {
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner could not start");
  }
  if (!child.pid || !child.stdin) {
    child.kill();
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner could not start");
  }
  const provisional: FirefoxOwner = {
    endpoint: reservation.endpoint,
    token: reservation.token,
    generation: reservation.generation,
    pid: child.pid,
    browserPid: 0,
    binaryPath: child.spawnfile,
  };
  try {
    await callbacks.onSpawn?.(provisional);
  } catch {
    child.kill();
    throw new FirefoxOwnerError("operation_failed", "Firefox owner reservation was not saved");
  }
  const ready = readReady(child, input.timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ version: PLAYWRIGHT_PROTOCOL_VERSION, ...input, owner: reservation }));
  let owner: FirefoxOwner;
  try {
    const result = await ready;
    if (result.endpoint !== reservation.endpoint || result.generation !== reservation.generation || result.pid !== child.pid) {
      throw new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid");
    }
    owner = { ...provisional, browserPid: result.browserPid };
    firefoxEndpoint(owner);
    await callbacks.onReady?.(owner);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.unref();
  (child.stdout as any)?.unref?.();
  return owner;
}

export function firefoxEndpoint(owner: FirefoxOwner): string {
  const endpoint = endpointKey(owner.endpoint, owner.generation);
  owners.set(endpoint, owner);
  return endpoint;
}

export function firefoxOwnerForEndpoint(endpoint: string): FirefoxOwner | undefined {
  return owners.get(endpoint);
}

export function forgetFirefoxOwner(owner: FirefoxOwner): void {
  owners.delete(endpointKey(owner.endpoint, owner.generation));
}

export async function callFirefoxOwner<T>(
  owner: FirefoxOwner,
  operation: string,
  payload: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  if (typeof operation !== "string" || !operation || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner request is invalid");
  }
  const request = JSON.stringify({
    version: PLAYWRIGHT_PROTOCOL_VERSION,
    operation,
    payload: { ...(payload as Record<string, unknown>), ownerGeneration: owner.generation },
  });
  if (Buffer.byteLength(request) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner request exceeded its limit");
  }
  const abort = requestSignal(options);
  let response: Response;
  try {
    response = await fetch(owner.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: request,
      signal: abort.signal,
    });
    const body = await readResponse(response);
    let value: any;
    try { value = JSON.parse(body); } catch { throw new FirefoxOwnerError("invalid_response", "Firefox owner response is invalid"); }
    if (value?.version !== PLAYWRIGHT_PROTOCOL_VERSION || typeof value.ok !== "boolean") {
      throw new FirefoxOwnerError("invalid_response", "Firefox owner response is invalid");
    }
    if (!value.ok) throw responseError(value.error?.code, value.error?.message || "Firefox owner operation failed", value.error?.details);
    if (!response.ok) throw new FirefoxOwnerError("operation_failed", "Firefox owner operation failed");
    return value.result as T;
  } catch (error) {
    if (error instanceof FirefoxOwnerError) throw error;
    if (abort.timedOut()) throw new FirefoxOwnerError("timeout", "Firefox owner operation timed out");
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner is unavailable");
  } finally { abort.dispose(); }
}

export async function closeFirefoxOwner(owner: FirefoxOwner, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  await callFirefoxOwner(owner, "close", {}, options);
  forgetFirefoxOwner(owner);
}

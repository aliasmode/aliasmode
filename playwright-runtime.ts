import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PLAYWRIGHT_PROTOCOL_VERSION = 1;
export const PLAYWRIGHT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type PlaywrightWorkerOperation =
  | "page"
  | "search-provider"
  | "profile-card"
  | "navigate"
  | "label-window"
  | "ensure-cookies"
  | "session-capture"
  | "session-restore"
  | "cookie-harvest"
  | "diagnostics";

export interface PlaywrightWorkerErrorDetails {
  operation?: string;
  outcome?: string;
  workerOperation?: PlaywrightWorkerOperation;
  responseCategory?: "empty_stdout" | "malformed_json" | "wrong_protocol_shape" | "stdout_overflow" | "stdout_read_failed" | "success_nonzero_exit";
  stdoutBytes?: number;
  exitCode?: number;
  stderrPresent?: boolean;
}

export class PlaywrightWorkerError extends Error {
  override readonly name = "PlaywrightWorkerError";

  constructor(
    readonly code: "invalid_request" | "invalid_response" | "operation_failed" | "timeout" | "runtime_unavailable",
    message: string,
    readonly details?: PlaywrightWorkerErrorDetails,
  ) {
    super(message);
  }
}

interface WorkerResponse<T> {
  version: 1;
  ok: true;
  result: T;
}

interface WorkerErrorResponse {
  version: 1;
  ok: false;
  error: {
    code: PlaywrightWorkerError["code"];
    message: string;
    details?: PlaywrightWorkerErrorDetails;
  };
}

interface WorkerProcess {
  stdin: { write(value: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): unknown;
}

export interface PlaywrightWorkerOptions {
  timeoutMs?: number;
  runtimeRoot?: string;
  spawn?: (argv: string[]) => WorkerProcess;
}

function runtimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALIASMODE_PLAYWRIGHT_RUNTIME?.trim() || defaultPlaywrightRuntimeRoot();
}

export function playwrightWorkerCommand(root = runtimeRoot()): string[] {
  return [join(root, "node", "node.exe"), join(root, "worker.mjs")];
}

interface BoundedOutput {
  text: string;
  bytes: number;
}

class OutputLimitError extends Error {
  constructor(readonly bytes: number) {
    super("output limit exceeded");
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<BoundedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new OutputLimitError(total);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), bytes: total };
}

function responseFailure(
  code: PlaywrightWorkerError["code"],
  operation: PlaywrightWorkerOperation,
  outcome: NonNullable<PlaywrightWorkerErrorDetails["responseCategory"]>,
  stdoutBytes: number,
  exit: PromiseSettledResult<number>,
  stderr: PromiseSettledResult<BoundedOutput>,
): PlaywrightWorkerError {
  const exitCode = exit.status === "fulfilled" ? exit.value : undefined;
  const stderrPresent = stderr.status === "rejected" || stderr.value.bytes > 0;
  const exitLabel = exitCode === undefined ? "unavailable" : String(exitCode);
  return new PlaywrightWorkerError(
    code,
    `Playwright worker ${operation} failed: ${outcome}, ${stdoutBytes} stdout bytes, exit ${exitLabel}, stderr ${stderrPresent ? "present" : "absent"}`,
    { workerOperation: operation, responseCategory: outcome, stdoutBytes, exitCode, stderrPresent },
  );
}

export async function runPlaywrightWorker<T>(
  operation: PlaywrightWorkerOperation,
  payload: unknown,
  options: PlaywrightWorkerOptions = {},
): Promise<T> {
  const request = JSON.stringify({ version: PLAYWRIGHT_PROTOCOL_VERSION, operation, payload });
  if (Buffer.byteLength(request) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
    throw new PlaywrightWorkerError("invalid_request", "Playwright worker request exceeded its limit");
  }
  const root = options.runtimeRoot ?? runtimeRoot();
  const spawn = options.spawn ?? ((argv: string[]) => Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
    ),
  }) as unknown as WorkerProcess);
  let child: WorkerProcess;
  try {
    child = spawn(playwrightWorkerCommand(root));
  } catch {
    throw new PlaywrightWorkerError("runtime_unavailable", "Playwright worker could not start");
  }
  child.stdin.write(request);
  child.stdin.end();
  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch {}
  }, timeoutMs);
  const stdout = readBounded(child.stdout, PLAYWRIGHT_MAX_MESSAGE_BYTES);
  // Drain stderr so a child cannot block. Keep only its presence for diagnostics.
  const stderr = readBounded(child.stderr, 64 * 1024);
  const [output, errorOutput, exit] = await Promise.allSettled([stdout, stderr, child.exited]);
  clearTimeout(timer);
  if (timedOut) throw new PlaywrightWorkerError("timeout", "Playwright worker timed out");
  if (output.status === "rejected") {
    if (output.reason instanceof OutputLimitError) {
      throw responseFailure("invalid_response", operation, "stdout_overflow", output.reason.bytes, exit, errorOutput);
    }
    throw responseFailure("runtime_unavailable", operation, "stdout_read_failed", 0, exit, errorOutput);
  }
  if (output.value.bytes === 0) {
    throw responseFailure("runtime_unavailable", operation, "empty_stdout", 0, exit, errorOutput);
  }
  let response: WorkerResponse<T> | WorkerErrorResponse;
  try {
    response = JSON.parse(output.value.text);
  } catch {
    throw responseFailure("invalid_response", operation, "malformed_json", output.value.bytes, exit, errorOutput);
  }
  if (response?.version !== PLAYWRIGHT_PROTOCOL_VERSION || typeof response.ok !== "boolean") {
    throw responseFailure("invalid_response", operation, "wrong_protocol_shape", output.value.bytes, exit, errorOutput);
  }
  if (!response.ok) {
    const code = response.error?.code;
    const valid = ["invalid_request", "invalid_response", "operation_failed", "timeout", "runtime_unavailable"].includes(code);
    throw new PlaywrightWorkerError(
      valid ? code : "operation_failed",
      response.error?.message || "Playwright operation failed",
      response.error?.details,
    );
  }
  if (exit.status === "rejected" || exit.value !== 0) {
    throw responseFailure("operation_failed", operation, "success_nonzero_exit", output.value.bytes, exit, errorOutput);
  }
  return response.result;
}

export async function verifyPlaywrightRuntime(root: string): Promise<void> {
  const playwright = JSON.parse(await readFile(join(root, "node_modules", "playwright-core", "package.json"), "utf8"));
  const ws = JSON.parse(await readFile(join(root, "node_modules", "ws", "package.json"), "utf8"));
  if (playwright?.name !== "playwright-core" || playwright?.version !== "1.58.2"
      || ws?.name !== "ws" || ws?.version !== "8.21.0") {
    throw new Error("packaged Playwright runtime has unexpected dependencies");
  }
  for (const path of [join(root, "worker.mjs"), join(root, "node", "node.exe")]) {
    try { await readFile(path); } catch { throw new Error("packaged Playwright runtime is incomplete"); }
  }
}

export function defaultPlaywrightRuntimeRoot(): string {
  return join(dirname(process.execPath), "playwright");
}

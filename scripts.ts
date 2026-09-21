import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentControlSession, AGENT_CONTROL_PROTOCOL, type AgentControlDeps } from "./agent-control.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import { CloudClient } from "./cloud-client.ts";
import type { ScriptInput, ScriptLanguage, ScriptRecord, ScriptSummary, PublishedScript, PublishScriptInput, PublishedScriptsQuery, ListPublishedScriptsResponse } from "./contracts/cloud-v1.ts";
import { resolvePlaywrightRuntime } from "./playwright-runtime.ts";

export class ScriptError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function scriptInput(value: any): ScriptInput {
  if (!value || typeof value.name !== "string" || !value.name.trim()
    || typeof value.description !== "string" || typeof value.source !== "string" || !value.source.trim()
    || !["javascript", "python"].includes(value.language)) {
    throw new ScriptError("A name, description, source, and supported language are required");
  }
  return { name: value.name.trim(), description: value.description, language: value.language, source: value.source };
}

function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ScriptError("A valid expected revision is required");
}

export class ScriptLibrary {
  readonly directory: string;
  private readonly catalog?: CloudClient;
  constructor(root: string, readonly cloudMode: boolean, private readonly cloud?: CloudConnectionRuntime, catalogUrl?: string) {
    this.directory = join(root, "custom-scripts");
    this.catalog = cloud?.client ?? (catalogUrl ? new CloudClient({ baseUrl: catalogUrl, accessToken: () => undefined }) : undefined);
  }

  scope(): string {
    if (!this.cloudMode) return "local";
    const account = this.cloud?.accountId();
    if (!account) throw new ScriptError("Sign in to AliasMode Cloud first", 401);
    return `account-${createHash("sha256").update(account).digest("hex")}`;
  }

  assertScope(scope: string): void {
    if (this.scope() !== scope) throw new ScriptError("The signed-in account changed", 409);
  }

  private cached(scope: string): ScriptRecord[] {
    const path = join(this.directory, `${scope}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  }

  private write(scope: string, scripts: ScriptRecord[]): void {
    this.assertScope(scope);
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${scope}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(scripts), { mode: 0o600 });
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  }

  private cache(scope: string, script: ScriptRecord): ScriptRecord {
    this.write(scope, [...this.cached(scope).filter((item) => item.id !== script.id), script]);
    return script;
  }

  async list(): Promise<ScriptSummary[]> {
    return (await this.info()).scripts;
  }

  async info(): Promise<{ scripts: ScriptSummary[]; canPublish: boolean; publicationDefaults?: { authorName: string } }> {
    const scope = this.scope();
    const response = this.cloudMode ? await this.cloud!.client.listScripts() : { scripts: this.cached(scope), publicationDefaults: undefined };
    this.assertScope(scope);
    return {
      scripts: response.scripts.map(({ source: _source, ...summary }: ScriptRecord | (ScriptSummary & { source?: string })) => summary),
      canPublish: this.cloudMode && !!this.cloud?.accountId(),
      ...(response.publicationDefaults ? { publicationDefaults: response.publicationDefaults } : {}),
    };
  }

  async browse(query: PublishedScriptsQuery = {}): Promise<ListPublishedScriptsResponse> {
    if (!this.catalog) throw new ScriptError("The public library URL is unavailable", 503);
    return this.catalog.listPublishedScripts(query);
  }

  async viewPublished(id: string): Promise<PublishedScript> {
    if (!this.catalog) throw new ScriptError("The public library URL is unavailable", 503);
    return (await this.catalog.getPublishedScript(id)).script;
  }

  async importPublished(id: string): Promise<ScriptRecord> {
    const scope = this.scope();
    const script = await this.viewPublished(id);
    this.assertScope(scope);
    return this.save(scriptInput(script));
  }

  async publish(id: string, input: PublishScriptInput): Promise<PublishedScript> {
    if (!this.cloudMode) throw new ScriptError("Sign in using Cloud mode to publish scripts", 403);
    const scope = this.scope();
    const response = await this.cloud!.client.publishScript(id, input);
    this.assertScope(scope);
    return response.script;
  }

  async unpublish(id: string): Promise<void> {
    if (!this.cloudMode) throw new ScriptError("Sign in using Cloud mode to publish scripts", 403);
    const scope = this.scope();
    await this.cloud!.client.unpublishScript(id);
    this.assertScope(scope);
  }

  async get(id: string): Promise<ScriptRecord> {
    const scope = this.scope();
    if (this.cloudMode) return this.cache(scope, (await this.cloud!.client.getScript(id)).script);
    const script = this.cached(scope).find((item) => item.id === id);
    if (!script) throw new ScriptError("Script not found", 404);
    return script;
  }

  async save(value: ScriptInput, id?: string, expectedRevision?: number): Promise<ScriptRecord> {
    const input = scriptInput(value);
    const scope = this.scope();
    if (id) revision(expectedRevision);
    if (this.cloudMode) {
      const response = id
        ? await this.cloud!.client.updateScript(id, { ...input, expectedRevision: expectedRevision! })
        : await this.cloud!.client.createScript(input);
      return this.cache(scope, response.script);
    }
    const previous = id ? this.cached(scope).find((item) => item.id === id) : undefined;
    if (id && !previous) throw new ScriptError("Script not found", 404);
    if (previous && previous.revision !== expectedRevision) throw new ScriptError("Script changed; reload before saving", 409);
    const now = new Date().toISOString();
    return this.cache(scope, { ...input, id: id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now });
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    revision(expectedRevision);
    const scope = this.scope();
    if (this.cloudMode) await this.cloud!.client.deleteScript(id, expectedRevision);
    else {
      const script = this.cached(scope).find((item) => item.id === id);
      if (!script) throw new ScriptError("Script not found", 404);
      if (script.revision !== expectedRevision) throw new ScriptError("Script changed; reload before deleting", 409);
    }
    this.write(scope, this.cached(scope).filter((script) => script.id !== id));
  }
}

export interface ScriptRun {
  id: string;
  scriptName: string;
  status: "running" | "stopping" | "finished";
  profiles: Array<{ id: string; name: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; error?: string; warning?: string }>;
}

interface RunRequest { scriptId: string; profileIds: string[]; inputs: Record<string, unknown>; useCredentials: boolean }
interface RunnerInput {
  endpoint: string;
  profile: { id: string; name: string; group: string; platform: string };
  inputs: Record<string, unknown>;
  credentials: Record<string, string> | null;
}
export type ScriptExecution = (options: { scriptPath: string; language: ScriptLanguage; input: RunnerInput; logFd: number; signal: AbortSignal }) => Promise<void>;

export const executeScript: ScriptExecution = async ({ scriptPath, language, input, logFd, signal }) => {
  signal.throwIfAborted();
  const runtime = resolvePlaywrightRuntime();
  if (runtime.kind !== "packaged") throw new ScriptError("Scripts require the packaged desktop runtime", 503);
  const executable = language === "python" ? join(runtime.root, "python", "python.exe") : runtime.nodeExecutable;
  const runner = join(runtime.root, "agent", language === "python" ? "script-runner.py" : "script-runner.mjs");
  if (!existsSync(executable) || !existsSync(runner)) throw new ScriptError("The script runtime is missing; update AliasMode", 503);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(executable, [...(language === "python" ? ["-u", "-X", "utf8"] : []), runner, scriptPath], {
    windowsHide: true, detached: process.platform !== "win32", env, stdio: ["pipe", logFd, logFd],
  });
  let termination: Promise<void> | undefined;
  const stop = () => {
    termination ??= (async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
        if (await kill.exited !== 0 && child.exitCode === null && child.signalCode === null) throw new Error("Script process termination was not confirmed");
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
      }
    })().catch((error) => {
      // Keep waiting for exit; browser cleanup must not race a live script.
      writeFileSync(logFd, `\nCould not stop script: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  signal.addEventListener("abort", stop, { once: true });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  // EOF is reserved for parent death; the runner reads its input from the first line.
  child.stdin!.on("error", () => {});
  child.stdin!.write(`${JSON.stringify(input)}\n`);
  if (signal.aborted) stop();
  try {
    const code = await exited;
    await termination;
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`Script exited with code ${code ?? "unknown"}; see its log`);
  } finally {
    signal.removeEventListener("abort", stop);
    child.stdin!.destroy();
  }
};

interface ActiveRun {
  view: ScriptRun;
  scope: string;
  directory: string;
  logPath: string;
  abort: AbortController;
  done: Promise<void>;
}

export class ScriptSupervisor {
  private active?: ActiveRun;
  private closing = false;
  private pauses = 0;
  constructor(private readonly options: AgentControlDeps & { root: string; library: ScriptLibrary; execute?: ScriptExecution }) {}

  pause(): () => void {
    this.pauses++;
    return () => { this.pauses--; };
  }

  status(): ScriptRun | null {
    if (!this.active) return null;
    try {
      return this.active.scope === this.options.library.scope() ? structuredClone(this.active.view) : null;
    } catch (error) {
      if (error instanceof ScriptError && error.status === 401) return null;
      throw error;
    }
  }

  start(request: RunRequest): ScriptRun {
    if (this.closing || this.pauses) throw new ScriptError("Script execution is paused while AliasMode changes accounts or shuts down", 409);
    if (this.active && this.active.view.status !== "finished") throw new ScriptError("A script is already running", 409);
    if (!request || typeof request.scriptId !== "string" || !request.scriptId
      || !Array.isArray(request.profileIds) || !request.profileIds.length || !request.profileIds.every((id) => typeof id === "string" && id)
      || !request.inputs || typeof request.inputs !== "object" || Array.isArray(request.inputs) || typeof request.useCredentials !== "boolean") {
      throw new ScriptError("Choose a script, profiles, and a JSON object for inputs");
    }
    const scope = this.options.library.scope();
    if (this.active) rmSync(this.active.directory, { recursive: true, force: true });
    mkdirSync(this.options.library.directory, { recursive: true });
    const directory = mkdtempSync(join(this.options.library.directory, "run-"));
    const run: ActiveRun = {
      view: { id: randomUUID(), scriptName: "Script", status: "running", profiles: [...new Set(request.profileIds)].map((id) => ({ id, name: id, status: "queued" })) },
      scope, directory, logPath: join(directory, "output.log"), abort: new AbortController(), done: Promise.resolve(),
    };
    writeFileSync(run.logPath, "", { mode: 0o600 });
    this.active = run;
    run.done = this.run(run, request);
    return structuredClone(run.view);
  }

  async stop(): Promise<ScriptRun | null> {
    const run = this.active;
    if (run && run.view.status !== "finished") {
      run.view.status = "stopping";
      run.abort.abort();
      await run.done;
    }
    return this.status();
  }

  settled(): Promise<void> { return this.active?.done ?? Promise.resolve(); }

  async shutdown(): Promise<void> {
    this.closing = true;
    const run = this.active;
    if (run) { run.abort.abort(); await run.done; rmSync(run.directory, { recursive: true, force: true }); }
  }

  log(id: string, offset: number): { text: string; nextOffset: number } {
    const run = this.active;
    if (!run || run.scope !== this.options.library.scope() || run.view.id !== id) throw new ScriptError("Run not found", 404);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ScriptError("Invalid log offset");
    const fd = openSync(run.logPath, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const length = readSync(fd, buffer, 0, buffer.length, offset);
      // Keep an incomplete UTF-8 character for the next poll.
      let end = length;
      let start = length - 1;
      while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
      const lead = buffer[start] ?? 0;
      const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (start >= 0 && length - start < width && (length === buffer.length || run.view.status !== "finished")) end = start;
      return { text: buffer.subarray(0, end).toString("utf8"), nextOffset: offset + end };
    } finally { closeSync(fd); }
  }

  private async run(run: ActiveRun, request: RunRequest): Promise<void> {
    const signal = run.abort.signal;
    const fd = openSync(run.logPath, "a");
    try {
      const script = await this.options.library.get(request.scriptId);
      this.options.library.assertScope(run.scope);
      if (!this.options.execute && resolvePlaywrightRuntime().kind !== "packaged") {
        throw new ScriptError("Scripts require the packaged desktop runtime", 503);
      }
      run.view.scriptName = script.name;
      const path = join(run.directory, script.language === "python" ? "script.py" : "script.mjs");
      writeFileSync(path, script.source, { mode: 0o600 });
      for (const item of run.view.profiles) {
        if (signal.aborted) { item.status = "cancelled"; continue; }
        const session = new AgentControlSession(this.options);
        let owned = false;
        let endpoint: string | undefined;
        const call = async (method: string) => {
          const response = await session.enqueue(JSON.stringify({
            protocol: AGENT_CONTROL_PROTOCOL, id: 1, method,
            params: { profileId: item.id, ...(method === "browser.close" ? { expectedEndpoint: endpoint } : {}) },
          }));
          if (!response.ok) throw new Error(response.error?.message ?? "Browser operation failed");
          return response.result as { ws: string; ownedByConnection: boolean; sync?: string };
        };
        try {
          this.options.library.assertScope(run.scope);
          let cloudProfile;
          if (this.options.library.cloudMode) {
            const response = await this.options.cloudConnection!.client.getProfile(item.id);
            if (response.profile.permission !== "edit") throw new ScriptError("Profile edit access is required", 403);
            cloudProfile = response.payload.profile;
          }
          signal.throwIfAborted();
          this.options.library.assertScope(run.scope);
          item.status = "running";
          const opened = await call("browser.open") as { ws?: string; engine?: string; ownedByConnection: boolean };
          owned = opened.ownedByConnection;
          endpoint = opened.ws;
          signal.throwIfAborted();
          this.options.library.assertScope(run.scope);
          const profile = this.options.store.getProfile(item.id) ?? cloudProfile;
          if (!profile) throw new ScriptError("Profile not found", 404);
          item.name = profile.name;
          writeFileSync(fd, `\n--- ${profile.name || item.id} ---\n`);
          const input = {
            profile: { id: item.id, name: profile.name, group: profile.group, platform: profile.platform ?? "" },
            inputs: request.inputs,
            credentials: request.useCredentials ? Object.fromEntries(["username", "password", "email", "emailPassword", "twofa"].map((key) => [key, (profile as unknown as Record<string, string>)[key] ?? ""])) : null,
          };
          if (opened.engine === "firefox") {
            if (script.language !== "javascript") throw new ScriptError("Firefox supports JavaScript scripts only", 400);
            const launch = this.options.store.getLaunch(item.id) as { firefoxOwner?: FirefoxOwner } | null;
            if (!launch?.firefoxOwner) throw new ScriptError("Firefox browser owner is unavailable", 503);
            const result = await callFirefoxOwner<{ logs?: unknown }>(launch.firefoxOwner, "run-script", {
              scriptPath: path,
              input,
            }, { signal });
            if (Array.isArray(result.logs) && result.logs.length) {
              writeFileSync(fd, `${result.logs.map(String).join("\n")}\n`);
            }
          } else {
            await (this.options.execute ?? executeScript)({
              scriptPath: path, language: script.language, logFd: fd, signal,
              input: { endpoint: opened.ws!, ...input },
            });
          }
          item.status = signal.aborted ? "cancelled" : "succeeded";
        } catch (error) {
          item.status = signal.aborted ? "cancelled" : "failed";
          if (!signal.aborted) item.error = error instanceof Error ? error.message : "Script failed";
        } finally {
          if (owned) {
            try {
              const closed = await call("browser.close");
              if (closed.sync && closed.sync !== "complete") item.warning = `Profile session save: ${closed.sync}`;
            } catch (error) {
              item.warning = error instanceof Error ? error.message : "Browser cleanup was not confirmed";
              // Durable browser ownership remains with the launcher; do not retry against a replacement browser.
              await call("browser.detach").catch(() => {});
            }
          }
          await session.disconnect();
        }
      }
    } catch (error) {
      for (const item of run.view.profiles.filter((item) => item.status === "queued")) {
        item.status = signal.aborted ? "cancelled" : "failed";
        if (!signal.aborted) item.error = error instanceof Error ? error.message : "Script could not start";
      }
    } finally {
      closeSync(fd);
      run.view.status = "finished";
    }
  }
}

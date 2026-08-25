import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { discoverRuntime } from "./runtime-client.mjs";
import { configureClients, type SetupClient } from "./setup.ts";
import { ALIASMODE_VERSION } from "../version.ts";

const VERSION = ALIASMODE_VERSION;

class SetupFailure extends Error {
  constructor(readonly result: unknown) {
    super("one or more installed MCP clients could not be configured");
  }
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function values(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === `--${name}` && args[index + 1]) result.push(args[++index]!);
  }
  return result;
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function runtimeRoot(): string {
  if (process.env.ALIASMODE_PLAYWRIGHT_RUNTIME) return resolve(process.env.ALIASMODE_PLAYWRIGHT_RUNTIME);
  return join(dirname(process.execPath), "playwright");
}

function desktopExecutable(): string {
  return process.env.ALIASMODE_DESKTOP_EXE || join(dirname(process.execPath), "AliasMode.exe");
}

function nodeExecutable(root: string): string {
  return join(root, "node", process.platform === "win32" ? "node.exe" : "node");
}

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const keys = [
    "ALIASMODE_MCP_DIAGNOSTICS",
    "APPDATA",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function diagnose(message: string): void {
  if (process.env.ALIASMODE_MCP_DIAGNOSTICS === "1") {
    process.stderr.write(`[aliasmode-mcp] ${message}\n`);
  }
}

async function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolveCode, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit", "pipe"],
      windowsHide: true,
      env,
    });
    diagnose(`child started pid=${child.pid ?? 0}`);
    const childInput = child.stdin!;
    let childInputEnded = false;
    const endChildInput = (event: string) => {
      diagnose(`stdin ${event}`);
      if (childInputEnded) return;
      childInputEnded = true;
      childInput.end();
    };
    process.stdin.pipe(childInput, { end: false });
    process.stdin.once("end", () => endChildInput("end"));
    process.stdin.once("close", () => endChildInput("close"));
    childInput.once("finish", () => diagnose("child stdin finish"));
    child.once("error", reject);
    child.once("exit", (code) => {
      diagnose(`child exited code=${code ?? 1}`);
      resolveCode(code ?? 1);
    });
  });
}

async function serve(): Promise<never> {
  const root = runtimeRoot();
  const node = nodeExecutable(root);
  const host = join(root, "agent", "mcp-host.mjs");
  if (!existsSync(node) || !existsSync(host)) throw new Error("packaged AliasMode MCP runtime is incomplete");
  const code = await runProcess(node, [host], childEnvironment({
    ALIASMODE_APP_VERSION: VERSION,
    ALIASMODE_DESKTOP_EXE: desktopExecutable(),
    ALIASMODE_PARENT_WATCH_FD: "3",
  }));
  process.exit(code);
}

async function withRuntime<T>(operation: (client: any) => Promise<T>): Promise<T> {
  const { client } = await discoverRuntime({
    desktopExecutable: desktopExecutable(),
    version: VERSION,
  });
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

function requireProfile(args: string[]): string {
  const profileId = value(args, "profile");
  if (!profileId) throw new Error("--profile is required");
  return profileId;
}

async function profiles(args: string[]): Promise<unknown> {
  const [action, ...rest] = args;
  if (action === "list") return await withRuntime((client) => client.call("profiles.list"));
  if (action === "create") {
    const input = {
      ...(value(rest, "name") ? { name: value(rest, "name") } : {}),
      ...(value(rest, "group") ? { group: value(rest, "group") } : {}),
      ...(value(rest, "platform") ? { platform: value(rest, "platform") } : {}),
      ...(value(rest, "screen") ? { screen: value(rest, "screen") } : {}),
    };
    return await withRuntime((client) => client.call("profiles.create", {
      input,
      temporary: has(rest, "temporary"),
    }));
  }
  if (action === "delete") {
    const profileId = requireProfile(rest);
    return await withRuntime((client) => client.call("profiles.delete", { profileId }));
  }
  throw new Error("profiles requires list, create, or delete");
}

async function browser(args: string[]): Promise<unknown> {
  const [action, ...rest] = args;
  const profileId = requireProfile(rest);
  if (action === "status") {
    return await withRuntime(async (client) => {
      const { ws: _ws, ...status } = await client.call("browser.status", { profileId });
      return status;
    });
  }
  if (action === "close") {
    return await withRuntime((client) => client.call("browser.close", { profileId }));
  }
  if (action === "open") {
    return await withRuntime(async (client) => {
      const opened = await client.call("browser.open", {
        profileId,
        ...(has(rest, "headless") ? { headless: true } : {}),
        ...(values(rest, "url").length ? { startupUrls: values(rest, "url") } : {}),
      });
      await client.call("browser.detach", { profileId });
      return {
        profileId: opened.profileId,
        port: opened.port,
        headless: opened.headless,
        alreadyOpen: opened.alreadyOpen,
      };
    });
  }
  throw new Error("browser requires open, status, or close");
}

async function playwright(args: string[]): Promise<unknown> {
  const [action, ...rest] = args;
  if (action !== "run") throw new Error("playwright requires run");
  const profileId = requireProfile(rest);
  const file = value(rest, "file");
  if (!file) throw new Error("--file is required");
  const root = runtimeRoot();
  const node = nodeExecutable(root);
  const runner = join(root, "agent", "playwright-runner.mjs");
  return await withRuntime(async (client) => {
    const opened = await client.call("browser.open", {
      profileId,
      headless: has(rest, "headless"),
    });
    try {
      const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(node, [runner, resolve(file)], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnvironment({ ALIASMODE_CDP_ENDPOINT: opened.ws }),
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", () => {});
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) reject(new Error("Playwright script failed"));
          else resolveOutput(stdout);
        });
      });
      return JSON.parse(output);
    } finally {
      if (opened.ownedByConnection) {
        await client.call("browser.close", { profileId });
      }
    }
  });
}

async function setup(args: string[]): Promise<unknown> {
  if (!has(args, "yes")) throw new Error("setup requires --yes for noninteractive configuration");
  const requested = value(args, "client") ?? "auto";
  const supported: SetupClient[] = ["claude", "codex", "openclaw", "hermes"];
  let clients: SetupClient[];
  if (requested === "auto") clients = supported;
  else if (requested === "generic") clients = [];
  else if (supported.includes(requested as SetupClient)) clients = [requested as SetupClient];
  else throw new Error("--client must be auto, claude, codex, openclaw, hermes, or generic");
  const result = await configureClients({
    helper: resolve(process.execPath),
    clients,
  });
  if (result.clients.some((client) => client.status === "failed")) {
    throw new SetupFailure(result);
  }
  return result;
}

async function main(): Promise<void> {
  const [command = "serve", ...args] = process.argv.slice(2);
  if (command === "serve") return await serve();
  if (command === "version") {
    process.stdout.write(`${JSON.stringify({ ok: true, result: { version: VERSION } })}\n`);
    return;
  }
  let result: unknown;
  if (command === "setup") result = await setup(args);
  else if (command === "profiles") result = await profiles(args);
  else if (command === "browser") result = await browser(args);
  else if (command === "playwright") result = await playwright(args);
  else throw new Error(`unknown AliasMode MCP command: ${command}`);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch((error) => {
  const raw = error instanceof Error ? error.message : "AliasMode command failed";
  const message = raw.replace(/wss?:\/\/\S+/gi, "CDP endpoint").slice(0, 500);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: message,
    ...(error instanceof SetupFailure ? { result: error.result } : {}),
  })}\n`);
  process.exitCode = 1;
});

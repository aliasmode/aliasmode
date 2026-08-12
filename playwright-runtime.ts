import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface PlaywrightRuntime {
  chromium: {
    connectOverCDP(endpoint: string, options?: { timeout?: number }): Promise<any>;
  };
}

let runtime: Promise<PlaywrightRuntime> | undefined;

function runtimeRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ALIASMODE_PLAYWRIGHT_RUNTIME?.trim();
  return value || undefined;
}

export function playwrightFromModule(module: any): PlaywrightRuntime {
  const loaded = module?.chromium ? module : module?.default;
  if (typeof loaded?.chromium?.connectOverCDP !== "function") {
    throw new Error("AliasMode Playwright runtime is invalid");
  }
  return loaded;
}

export async function loadPlaywrightFromRoot(root: string): Promise<PlaywrightRuntime> {
  const specifier = pathToFileURL(join(
    root,
    "node_modules",
    "playwright-core",
    "index.mjs",
  )).href;
  return playwrightFromModule(await import(specifier));
}

export async function loadPlaywright(): Promise<PlaywrightRuntime> {
  if (!runtime) {
    runtime = (async () => {
      const root = runtimeRoot();
      if (root) return loadPlaywrightFromRoot(root);
      return playwrightFromModule(await import("playwright-core"));
    })();
  }
  return runtime;
}

export async function loadPlaywrightStorageScript(): Promise<string> {
  const root = runtimeRoot();
  const specifier = pathToFileURL(join(
    root ?? import.meta.dir,
    "node_modules",
    "playwright-core",
    "lib",
    "generated",
    "storageScriptSource.js",
  )).href;
  const loaded = await import(specifier);
  const source = loaded?.source ?? loaded?.default?.source;
  if (typeof source !== "string") throw new Error("AliasMode Playwright storage runtime is invalid");
  return source;
}

export async function verifyPlaywrightRuntime(root: string): Promise<void> {
  const packageRoot = join(root, "node_modules", "playwright-core");
  const playwright = JSON.parse(await readFile(
    join(packageRoot, "package.json"),
    "utf8",
  ));
  const ws = JSON.parse(await readFile(join(root, "node_modules", "ws", "package.json"), "utf8"));
  if (playwright?.name !== "playwright-core" || playwright?.version !== "1.58.2"
      || ws?.name !== "ws" || ws?.version !== "8.21.0") {
    throw new Error("packaged Playwright runtime has unexpected dependencies");
  }
  try {
    await readFile(join(packageRoot, "index.mjs"));
  } catch {
    throw new Error("packaged Playwright runtime is incomplete");
  }
}

export function defaultPlaywrightRuntimeRoot(): string {
  return join(dirname(process.execPath), "playwright");
}

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { installCloakBrowser } from "./browser-install.ts";
import { installFirefox } from "./firefox-install.ts";
import { verifyPlaywrightRuntime } from "./playwright-runtime.ts";
import { extractZipTo } from "./unzip.ts";

interface BrowserPin { path: string; sha256: string }
export interface SourceRuntime {
  version: 1;
  node: string;
  chromium: BrowserPin;
  firefox: BrowserPin;
}

const NODE_VERSION = "22.23.2";
const NODE_BUILDS = [
  { platform: "darwin", arch: "arm64", target: "darwin-arm64", sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6" },
  { platform: "linux", arch: "x64", target: "linux-x64", sha256: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a" },
  { platform: "win32", arch: "x64", target: "win-x64", sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97" },
] as const;

export async function installSourceNode(
  root: string,
  options: { platform?: NodeJS.Platform; arch?: string; fetch?: (url: string) => Promise<Response> } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const build = NODE_BUILDS.find((value) => value.platform === platform && value.arch === (options.arch ?? process.arch));
  if (!build) throw new Error("Source setup host is unsupported; use macOS arm64, Linux x64, or Windows x64");
  const name = `node-v${NODE_VERSION}-${build.target}`;
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const response = await (options.fetch ?? fetch)(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.${extension}`);
  if (!response.ok) throw new Error("Official Node runtime download failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== build.sha256) {
    throw new Error("Official Node runtime SHA-256 mismatch");
  }
  const destination = join(root, "node");
  mkdirSync(destination, { recursive: true });
  if (platform === "win32") {
    await extractZipTo(bytes, destination);
  } else {
    const archive = join(root, `${name}.${extension}`);
    try {
      writeFileSync(archive, bytes);
      const child = Bun.spawn(["tar", "-xzf", archive, "-C", destination], { stdout: "ignore", stderr: "inherit" });
      if (await child.exited !== 0) throw new Error("Official Node runtime extraction failed");
    } finally {
      rmSync(archive, { force: true });
    }
  }
  const executable = join(destination, name, platform === "win32" ? "node.exe" : "bin/node");
  accessSync(executable, platform === "win32" ? constants.F_OK : constants.X_OK);
  return executable;
}

function prependNode(node: string, env: NodeJS.ProcessEnv): void {
  env.PATH = [dirname(node), env.PATH].filter(Boolean).join(delimiter);
}

/** Load only non-secret setup metadata. An explicit override owns its entire engine pair. */
export function applySourceRuntime(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = join(root, "browser-runtime.json");
  if (!existsSync(path)) return;
  let runtime: SourceRuntime;
  try {
    runtime = JSON.parse(readFileSync(path, "utf8"));
    const pin = (value: BrowserPin) => typeof value?.path === "string" && isAbsolute(value.path)
      && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
    if (runtime?.version !== 1 || typeof runtime.node !== "string" || !isAbsolute(runtime.node)
      || !pin(runtime.chromium) || !pin(runtime.firefox)) throw new Error("invalid source runtime");
  } catch {
    throw new Error("Source runtime configuration is invalid; run bun cli.ts setup");
  }
  for (const [prefix, pin] of [["CLOAKBROWSER", runtime.chromium], ["ALIASMODE_FIREFOX", runtime.firefox]] as const) {
    const pathKey = `${prefix}_BINARY_PATH`;
    const hashKey = `${prefix}_BINARY_SHA256`;
    if (env[pathKey] !== undefined || env[hashKey] !== undefined) continue;
    env[pathKey] = pin.path;
    env[hashKey] = pin.sha256;
  }
  prependNode(runtime.node, env);
}

interface SetupDependencies {
  installNode?: (root: string) => Promise<string>;
  installChromium?: typeof installCloakBrowser;
  installFirefox?: typeof installFirefox;
  verify?: () => Promise<unknown>;
}

/** Explicit setup is the only download path. Publish metadata after every runtime is verified. */
export async function setupSourceRuntime(root: string, dependencies: SetupDependencies = {}): Promise<void> {
  root = resolve(root);
  const cache = join(root, "runtime");
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(cache, "source-"));
  const previousPath = process.env.PATH;
  try {
    const node = await (dependencies.installNode ?? installSourceNode)(staging);
    prependNode(node, process.env);
    const chromium = await (dependencies.installChromium ?? installCloakBrowser)({
      cwd: staging, cacheDir: join(staging, "browser"), writeEnv: false,
    });
    const firefox = await (dependencies.installFirefox ?? installFirefox)({ cwd: staging, writeEnv: false });
    await (dependencies.verify ?? verifyPlaywrightRuntime)();
    const runtime: SourceRuntime = { version: 1, node, chromium, firefox };
    const temporary = join(staging, "browser-runtime.json");
    writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, join(root, "browser-runtime.json"));
    // Superseded copies are ~1 GB each. Best effort: a locked file (a browser still
    // running on Windows) must not fail an already-published setup.
    try {
      for (const entry of readdirSync(cache)) {
        const previous = join(cache, entry);
        if (!entry.startsWith("source-") || previous === staging) continue;
        try { rmSync(previous, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

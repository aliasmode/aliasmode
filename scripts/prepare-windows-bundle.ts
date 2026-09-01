import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CLOAKBROWSER_WRAPPER_VERSION, installCloakBrowser } from "../browser-install.ts";
import { extractZipTo } from "../unzip.ts";
import { ALIASMODE_VERSION } from "../version.ts";

export const NODE_WINDOWS_X64_VERSION = "22.23.2";
export const NODE_WINDOWS_X64_SHA256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
export const NODE_WINDOWS_X64_URL = `https://nodejs.org/dist/v${NODE_WINDOWS_X64_VERSION}/node-v${NODE_WINDOWS_X64_VERSION}-win-x64.zip`;

export interface PreparedBrowserMetadata {
  executable: string;
  sha256: string;
  wrapperVersion: typeof CLOAKBROWSER_WRAPPER_VERSION;
}

export interface PrepareWindowsBundleOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  compileSidecar?: (output: string) => Promise<void>;
  compileAgent?: (output: string) => Promise<void>;
  installBrowser?: (cwd: string, cacheDir: string) => Promise<{ path: string; sha256: string }>;
  hashFile?: (path: string) => Promise<string>;
  downloadNode?: () => Promise<Uint8Array>;
  installNode?: (playwrightRoot: string) => Promise<void>;
}

async function sha256File(path: string): Promise<string> {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export const WINDOWS_SIDECAR_TARGET = "bun-windows-x64-baseline";

async function compileSidecar(cwd: string, output: string): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    `--target=${WINDOWS_SIDECAR_TARGET}`,
    "--define=ALIASMODE_COMPILED=true",
    "--external=playwright-core",
    "--external=chromium-bidi",
    "--external=electron",
    "cli.ts",
    "--outfile",
    output,
  ], { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`sidecar compilation exited with code ${code}`);
}

async function compileAgent(cwd: string, output: string): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    `--target=${WINDOWS_SIDECAR_TARGET}`,
    "agent/aliasmode-mcp.ts",
    "--outfile",
    output,
  ], { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`agent helper compilation exited with code ${code}`);
}

const AGENT_PACKAGE_VERSIONS: Record<string, string> = {
  "@modelcontextprotocol/sdk": "1.30.0",
  "@playwright/mcp": "0.0.56",
  "playwright": "1.58.0-alpha-2026-01-16",
  "playwright-core": "1.58.2",
};

function packageDirectory(root: string, name: string): string {
  return join(root, "node_modules", ...name.split("/"));
}

function copyRuntimePackage(
  cwd: string,
  destinationRoot: string,
  name: string,
  copied = new Set<string>(),
): void {
  if (copied.has(name)) return;
  const source = packageDirectory(cwd, name);
  const manifestPath = join(source, "package.json");
  if (!statSync(source).isDirectory() || !statSync(manifestPath).isFile()) {
    throw new Error(`desktop dependency is missing: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  const expected = AGENT_PACKAGE_VERSIONS[name];
  if (expected && manifest.version !== expected) {
    throw new Error(`desktop dependency version mismatch: ${name}`);
  }
  const destination = packageDirectory(destinationRoot, name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  copied.add(name);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (statSync(join(source, "node_modules", ...dependency.split("/")), { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    copyRuntimePackage(cwd, destinationRoot, dependency, copied);
  }
}

export async function prepareWindowsBundle(
  options: PrepareWindowsBundleOptions = {},
): Promise<PreparedBrowserMetadata> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if ((options.platform ?? process.platform) !== "win32" || (options.arch ?? process.arch) !== "x64") {
    throw new Error("desktop bundle preparation requires Windows x64");
  }

  const tauri = join(cwd, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-staging");
  const browserCache = join(tauri, "target", "cloakbrowser-cache");
  const resourceRoot = join(resources, "cloakbrowser");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, "aliasmode-sidecar-x86_64-pc-windows-msvc.exe");
  const agentHelper = join(binaries, "aliasmode-mcp-x86_64-pc-windows-msvc.exe");

  rmSync(staging, { recursive: true, force: true });
  rmSync(resourceRoot, { recursive: true, force: true });
  rmSync(playwrightRoot, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(browserCache, { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  mkdirSync(resources, { recursive: true });

  await (options.compileSidecar ?? ((output) => compileSidecar(cwd, output)))(sidecar);
  if (!statSync(sidecar).isFile()) throw new Error("sidecar compiler did not create the expected Windows executable");
  await (options.compileAgent ?? ((output) => compileAgent(cwd, output)))(agentHelper);
  if (!statSync(agentHelper).isFile()) throw new Error("agent helper compiler did not create the expected Windows executable");

  if (options.installNode) {
    await options.installNode(playwrightRoot);
  } else {
    const nodeStaging = join(staging, "node");
    const nodeBytes = await (options.downloadNode ?? (async () => {
      const response = await fetch(NODE_WINDOWS_X64_URL, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("official Node runtime download failed");
      return new Uint8Array(await response.arrayBuffer());
    }))();
    const nodeHash = createHash("sha256").update(nodeBytes).digest("hex");
    if (nodeHash !== NODE_WINDOWS_X64_SHA256) throw new Error("official Node runtime SHA-256 mismatch");
    await extractZipTo(nodeBytes, nodeStaging);
    const extractedNode = join(nodeStaging, `node-v${NODE_WINDOWS_X64_VERSION}-win-x64`, "node.exe");
    if (!statSync(extractedNode).isFile()) throw new Error("official Node runtime archive is incomplete");
    mkdirSync(join(playwrightRoot, "node"), { recursive: true });
    cpSync(extractedNode, join(playwrightRoot, "node", "node.exe"));
  }
  if (!statSync(join(playwrightRoot, "node", "node.exe")).isFile()) throw new Error("official Node runtime is incomplete");
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "worker.mjs"));

  const agentRoot = join(playwrightRoot, "agent");
  mkdirSync(agentRoot, { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "runtime-client.mjs",
  ]) {
    cpSync(join(cwd, "agent", file), join(agentRoot, file));
  }
  const copied = new Set<string>();
  for (const dependency of [
    "playwright-core",
    "ws",
    "@modelcontextprotocol/sdk",
    "@playwright/mcp",
    "playwright",
  ]) {
    copyRuntimePackage(cwd, playwrightRoot, dependency, copied);
  }

  const installed = await (options.installBrowser ?? ((dir, cacheDir) => installCloakBrowser({ cwd: dir, cacheDir })))(
    staging,
    browserCache,
  );
  const cacheReal = realpathSync(browserCache);
  const installedReal = realpathSync(installed.path);
  if (!statSync(installedReal).isFile() || !isWithin(cacheReal, installedReal)) {
    throw new Error("official CloakBrowser installer reported a path outside its cache directory");
  }

  const runtimeRoot = dirname(installedReal);
  const executableRelative = relative(runtimeRoot, installedReal).replaceAll("\\", "/");
  if (executableRelative !== "chrome.exe") {
    throw new Error("official CloakBrowser installer did not provide Windows chrome.exe");
  }
  cpSync(runtimeRoot, resourceRoot, { recursive: true, errorOnExist: false });
  rmSync(join(resourceRoot, "chromedriver.exe"), { force: true });
  const copiedExecutable = join(resourceRoot, executableRelative);
  const copiedHash = (await (options.hashFile ?? sha256File)(copiedExecutable)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(copiedHash) || copiedHash !== installed.sha256.toLowerCase()) {
    throw new Error("packaged CloakBrowser executable does not match the installed SHA-256");
  }

  const metadata: PreparedBrowserMetadata = {
    executable: executableRelative,
    sha256: copiedHash,
    wrapperVersion: CLOAKBROWSER_WRAPPER_VERSION,
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  try {
    const metadata = await prepareWindowsBundle();
    console.log(`prepared AliasMode Windows bundle with CloakBrowser SHA-256 ${metadata.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

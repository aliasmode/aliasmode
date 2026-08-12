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
import { installCloakBrowser } from "../browser-install.ts";
import { extractZipTo } from "../unzip.ts";
import { ALIASMODE_VERSION } from "../version.ts";

export const NODE_WINDOWS_X64_VERSION = "22.23.2";
export const NODE_WINDOWS_X64_SHA256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
export const NODE_WINDOWS_X64_URL = `https://nodejs.org/dist/v${NODE_WINDOWS_X64_VERSION}/node-v${NODE_WINDOWS_X64_VERSION}-win-x64.zip`;

export interface PreparedBrowserMetadata {
  executable: string;
  sha256: string;
  wrapperVersion: "0.4.11";
}

export interface PrepareWindowsBundleOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  compileSidecar?: (output: string) => Promise<void>;
  installBrowser?: (cwd: string) => Promise<{ path: string; sha256: string }>;
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

async function compileSidecar(cwd: string, output: string): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    "--target=bun-windows-x64",
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
  const resourceRoot = join(resources, "cloakbrowser");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, "aliasmode-sidecar-x86_64-pc-windows-msvc.exe");

  rmSync(staging, { recursive: true, force: true });
  rmSync(resourceRoot, { recursive: true, force: true });
  rmSync(playwrightRoot, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  mkdirSync(resources, { recursive: true });

  await (options.compileSidecar ?? ((output) => compileSidecar(cwd, output)))(sidecar);
  if (!statSync(sidecar).isFile()) throw new Error("sidecar compiler did not create the expected Windows executable");

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

  for (const dependency of ["playwright-core", "ws"]) {
    const source = join(cwd, "node_modules", dependency);
    if (!statSync(source).isDirectory()) throw new Error(`desktop dependency is missing: ${dependency}`);
    cpSync(source, join(playwrightRoot, "node_modules", dependency), { recursive: true });
  }

  const installed = await (options.installBrowser ?? ((dir) => installCloakBrowser({ cwd: dir, cacheDir: dir })))(staging);
  const stagingReal = realpathSync(staging);
  const installedReal = realpathSync(installed.path);
  if (!statSync(installedReal).isFile() || !isWithin(stagingReal, installedReal)) {
    throw new Error("official CloakBrowser installer reported a path outside its staging directory");
  }

  const runtimeRoot = dirname(installedReal);
  cpSync(runtimeRoot, resourceRoot, { recursive: true, errorOnExist: false });
  const executableRelative = relative(runtimeRoot, installedReal);
  const copiedExecutable = join(resourceRoot, executableRelative);
  const copiedHash = (await (options.hashFile ?? sha256File)(copiedExecutable)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(copiedHash) || copiedHash !== installed.sha256.toLowerCase()) {
    throw new Error("packaged CloakBrowser executable does not match the installed SHA-256");
  }

  const metadata: PreparedBrowserMetadata = {
    executable: executableRelative.replaceAll("\\", "/"),
    sha256: copiedHash,
    wrapperVersion: "0.4.11",
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  prepareWindowsBundle()
    .then((metadata) => {
      console.log(`prepared AliasMode Windows bundle with CloakBrowser SHA-256 ${metadata.sha256}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

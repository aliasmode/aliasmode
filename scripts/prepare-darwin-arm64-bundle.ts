import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { installCloakBrowser } from "../browser-install.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import type { PreparedBrowserMetadata } from "./prepare-windows-bundle.ts";

export const NODE_DARWIN_ARM64_VERSION = "22.23.2";
export const NODE_DARWIN_ARM64_SHA256 = "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6";
export const NODE_DARWIN_ARM64_URL = `https://nodejs.org/dist/v${NODE_DARWIN_ARM64_VERSION}/node-v${NODE_DARWIN_ARM64_VERSION}-darwin-arm64.tar.gz`;
export const DARWIN_ARM64_SIDECAR_TARGET = "bun-darwin-arm64";
const DARWIN_BROWSER_EXECUTABLE = "Chromium.app/Contents/MacOS/Chromium";

export interface PrepareDarwinArm64BundleOptions {
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
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function verifyContainedSymlinks(root: string): void {
  const rootReal = realpathSync(root);
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(path); } catch { throw new Error("packaged CloakBrowser contains an unsafe symlink"); }
        if (!isWithin(rootReal, target)) throw new Error("packaged CloakBrowser contains an unsafe symlink");
      } else if (stat.isDirectory()) {
        visit(path);
      }
    }
  };
  visit(rootReal);
}

async function compileSidecar(cwd: string, output: string): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    `--target=${DARWIN_ARM64_SIDECAR_TARGET}`,
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

async function installNodeRuntime(
  nodeBytes: Uint8Array,
  staging: string,
  playwrightRoot: string,
): Promise<void> {
  const nodeHash = createHash("sha256").update(nodeBytes).digest("hex");
  if (nodeHash !== NODE_DARWIN_ARM64_SHA256) throw new Error("official Node runtime SHA-256 mismatch");
  const archive = join(staging, `node-v${NODE_DARWIN_ARM64_VERSION}-darwin-arm64.tar.gz`);
  const extracted = join(staging, "node");
  writeFileSync(archive, nodeBytes);
  mkdirSync(extracted, { recursive: true });
  const child = Bun.spawn(["/usr/bin/tar", "-xzf", archive, "-C", extracted], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`official Node runtime extraction exited with code ${code}`);
  const node = join(extracted, `node-v${NODE_DARWIN_ARM64_VERSION}-darwin-arm64`, "bin", "node");
  if (!statSync(node).isFile()) throw new Error("official Node runtime archive is incomplete");
  mkdirSync(join(playwrightRoot, "node"), { recursive: true });
  cpSync(node, join(playwrightRoot, "node", "node"));
}

export async function prepareDarwinArm64Bundle(
  options: PrepareDarwinArm64BundleOptions = {},
): Promise<PreparedBrowserMetadata> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if ((options.platform ?? process.platform) !== "darwin" || (options.arch ?? process.arch) !== "arm64") {
    throw new Error("desktop bundle preparation requires macOS arm64");
  }

  const tauri = join(cwd, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-staging");
  const resourceRoot = join(resources, "cloakbrowser");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, "aliasmode-sidecar-aarch64-apple-darwin");

  rmSync(staging, { recursive: true, force: true });
  rmSync(resourceRoot, { recursive: true, force: true });
  rmSync(playwrightRoot, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  mkdirSync(resources, { recursive: true });

  await (options.compileSidecar ?? ((output) => compileSidecar(cwd, output)))(sidecar);
  if (!statSync(sidecar).isFile()) throw new Error("sidecar compiler did not create the expected macOS executable");

  if (options.installNode) {
    await options.installNode(playwrightRoot);
  } else {
    const nodeBytes = await (options.downloadNode ?? (async () => {
      const response = await fetch(NODE_DARWIN_ARM64_URL, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("official Node runtime download failed");
      return new Uint8Array(await response.arrayBuffer());
    }))();
    await installNodeRuntime(nodeBytes, staging, playwrightRoot);
  }
  if (!statSync(join(playwrightRoot, "node", "node")).isFile()) throw new Error("official Node runtime is incomplete");
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

  const runtimeRoot = resolve(dirname(installedReal), "..", "..", "..");
  const executableRelative = relative(runtimeRoot, installedReal).replaceAll("\\", "/");
  if (!isWithin(stagingReal, runtimeRoot) || executableRelative !== DARWIN_BROWSER_EXECUTABLE) {
    throw new Error("official CloakBrowser installer did not provide Chromium.app");
  }
  cpSync(runtimeRoot, resourceRoot, {
    recursive: true,
    errorOnExist: false,
    verbatimSymlinks: true,
  });
  verifyContainedSymlinks(resourceRoot);
  const copiedExecutable = join(resourceRoot, executableRelative);
  const copiedHash = (await (options.hashFile ?? sha256File)(copiedExecutable)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(copiedHash) || copiedHash !== installed.sha256.toLowerCase()) {
    throw new Error("packaged CloakBrowser executable does not match the installed SHA-256");
  }

  const metadata: PreparedBrowserMetadata = {
    executable: executableRelative,
    sha256: copiedHash,
    wrapperVersion: "0.4.11",
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  prepareDarwinArm64Bundle()
    .then((metadata) => {
      console.log(`prepared AliasMode macOS arm64 bundle with CloakBrowser SHA-256 ${metadata.sha256}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

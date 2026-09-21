import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CLOAKBROWSER_WRAPPER_VERSION, installCloakBrowser } from "../browser-install.ts";
import { extractZipTo } from "../unzip.ts";
import { ALIASMODE_VERSION } from "../version.ts";

export const NODE_WINDOWS_X64_VERSION = "22.23.2";
export const NODE_WINDOWS_X64_SHA256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
export const NODE_WINDOWS_X64_URL = `https://nodejs.org/dist/v${NODE_WINDOWS_X64_VERSION}/node-v${NODE_WINDOWS_X64_VERSION}-win-x64.zip`;

export const PYTHON_WINDOWS_X64_VERSION = "3.13.7";
export const PYTHON_WINDOWS_X64_URL = `https://www.python.org/ftp/python/${PYTHON_WINDOWS_X64_VERSION}/python-${PYTHON_WINDOWS_X64_VERSION}-embed-amd64.zip`;
export const PYTHON_WINDOWS_X64_SHA256 = "f6cca216a359be84797cabb54149ce5e062afb16cc7567eb7fc51cacb2d86b65";

export const ALIASMODE_FIREFOX_VERSION = "152.0.4-beta.30";
export const ALIASMODE_FIREFOX_ARCHIVE_NAME = "aliasmode-152.0.4-beta.30-win.x86_64.zip";
export const ALIASMODE_FIREFOX_EXECUTABLE_NAME = "aliasmode.exe";

const PYTHON_WHEELS = [
  {
    name: "playwright",
    url: "https://files.pythonhosted.org/packages/41/f8/5ec599c5e59d2f2f336a05b4f318e733077cd5044f24adb6f86900c3e6a7/playwright-1.58.0-py3-none-win_amd64.whl",
    sha256: "a2bf639d0ce33b3ba38de777e08697b0d8f3dc07ab6802e4ac53fb65e3907af8",
  },
  {
    name: "pyee",
    url: "https://files.pythonhosted.org/packages/9b/4d/b9add7c84060d4c1906abe9a7e5359f2a60f7a9a4f67268b2766673427d8/pyee-13.0.0-py3-none-any.whl",
    sha256: "48195a3cddb3b1515ce0695ed76036b5ccc2ef3a9f963ff9f77aec0139845498",
  },
  {
    name: "greenlet",
    url: "https://files.pythonhosted.org/packages/1f/1b/54336d876186920e185066d8c3024ad55f21d7cc3683c856127ddb7b13ce/greenlet-3.1.1-cp313-cp313-win_amd64.whl",
    sha256: "b42703b1cf69f2aa1df7d1030b9d77d3e584a70755674d60e710f0af570f3761",
  },
  {
    name: "typing_extensions",
    url: "https://files.pythonhosted.org/packages/18/67/36e9267722cc04a6b9f15c7f3441c2363321a3ea07da7ae0c0707beb2a9c/typing_extensions-4.15.0-py3-none-any.whl",
    sha256: "f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548",
  },
] as const;

export interface PreparedFirefoxMetadata {
  executable: string;
  sha256: string;
  version: typeof ALIASMODE_FIREFOX_VERSION;
  archiveSha256: string;
}

export interface PreparedBrowserMetadata {
  executable: string;
  sha256: string;
  wrapperVersion: typeof CLOAKBROWSER_WRAPPER_VERSION;
  firefox: PreparedFirefoxMetadata;
}

export interface FirefoxArchive {
  bytes: Uint8Array;
  archiveSha256: string;
  executableSha256: string;
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
  installPython?: (playwrightRoot: string) => Promise<void>;
  downloadPython?: (url: string) => Promise<Uint8Array>;
  downloadPythonWheel?: (url: string) => Promise<Uint8Array>;
  firefoxArchive?: FirefoxArchive;
}

async function sha256File(path: string): Promise<string> {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadBytes(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} download failed`);
  return new Uint8Array(await response.arrayBuffer());
}

async function installPythonRuntime(
  playwrightRoot: string,
  downloadPython: (url: string) => Promise<Uint8Array>,
  downloadWheel: (url: string) => Promise<Uint8Array>,
): Promise<void> {
  const pythonRoot = join(playwrightRoot, "python");
  const python = await downloadPython(PYTHON_WINDOWS_X64_URL);
  const pythonHash = createHash("sha256").update(python).digest("hex");
  if (pythonHash !== PYTHON_WINDOWS_X64_SHA256) throw new Error("official Python runtime SHA-256 mismatch");
  await extractZipTo(python, pythonRoot);
  if (!statSync(join(pythonRoot, "python.exe"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("official Python runtime archive is incomplete");
  }

  const pth = join(pythonRoot, "python313._pth");
  const pthContents = readFileSync(pth, "utf8");
  writeFileSync(pth, `${pthContents.trimEnd()}\nLib/site-packages\n`, "utf8");
  const sitePackages = join(pythonRoot, "Lib", "site-packages");
  mkdirSync(sitePackages, { recursive: true });
  for (const wheel of PYTHON_WHEELS) {
    const bytes = await downloadWheel(wheel.url);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== wheel.sha256) throw new Error(`official Python ${wheel.name} wheel SHA-256 mismatch`);
    await extractZipTo(bytes, sitePackages);
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expectedSha256(value: string | undefined, label: string): string {
  const hash = value?.toLowerCase();
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${label} SHA-256 is missing or invalid`);
  }
  return hash;
}

function configuredFirefoxArchive(): FirefoxArchive {
  const archivePath = process.env.ALIASMODE_FIREFOX_ARCHIVE;
  if (!archivePath) {
    throw new Error("AliasMode Firefox archive is required; set ALIASMODE_FIREFOX_ARCHIVE to the verified CI artifact");
  }
  if (basename(archivePath) !== ALIASMODE_FIREFOX_ARCHIVE_NAME) {
    throw new Error("AliasMode Firefox archive has an unexpected filename");
  }
  const archiveReal = realpathSync(archivePath);
  if (!statSync(archiveReal).isFile()) throw new Error("AliasMode Firefox archive is not a regular file");
  return {
    bytes: readFileSync(archiveReal),
    archiveSha256: expectedSha256(process.env.ALIASMODE_FIREFOX_ARCHIVE_SHA256, "AliasMode Firefox archive"),
    executableSha256: expectedSha256(process.env.ALIASMODE_FIREFOX_EXECUTABLE_SHA256, "AliasMode Firefox executable"),
  };
}

function findFirefoxExecutable(root: string): string {
  const matches: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === ALIASMODE_FIREFOX_EXECUTABLE_NAME) matches.push(path);
    }
  };
  visit(root);
  if (matches.length !== 1) {
    throw new Error("AliasMode Firefox archive must contain exactly one aliasmode.exe executable");
  }
  return matches[0]!;
}

async function installFirefoxRuntime(
  archive: FirefoxArchive,
  staging: string,
  resourceRoot: string,
  hashFile: (path: string) => Promise<string>,
): Promise<PreparedFirefoxMetadata> {
  const archiveSha256 = createHash("sha256").update(archive.bytes).digest("hex");
  const expectedArchiveSha256 = expectedSha256(archive.archiveSha256, "AliasMode Firefox archive");
  const expectedExecutableSha256 = expectedSha256(archive.executableSha256, "AliasMode Firefox executable");
  if (archiveSha256 !== expectedArchiveSha256) {
    throw new Error("AliasMode Firefox archive SHA-256 does not match the approved CI artifact");
  }

  const extractedRoot = join(staging, "firefox");
  await extractZipTo(archive.bytes, extractedRoot);
  const extractedExecutable = findFirefoxExecutable(extractedRoot);
  const extractedReal = realpathSync(extractedExecutable);
  const extractedRootReal = realpathSync(extractedRoot);
  if (!statSync(extractedReal).isFile() || !isWithin(extractedRootReal, extractedReal)) {
    throw new Error("AliasMode Firefox archive executable escaped its engine directory");
  }
  cpSync(extractedRootReal, resourceRoot, { recursive: true, errorOnExist: false });
  const executable = relative(extractedRootReal, extractedReal).replaceAll("\\", "/");
  const copiedExecutable = join(resourceRoot, executable);
  const copiedSha256 = (await hashFile(copiedExecutable)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(copiedSha256) || copiedSha256 !== expectedExecutableSha256) {
    throw new Error("packaged AliasMode Firefox executable does not match the approved SHA-256");
  }
  return {
    executable,
    sha256: copiedSha256,
    version: ALIASMODE_FIREFOX_VERSION,
    archiveSha256,
  };
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
  const firefoxRoot = join(resources, "firefox");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, "aliasmode-sidecar-x86_64-pc-windows-msvc.exe");
  const agentHelper = join(binaries, "aliasmode-mcp-x86_64-pc-windows-msvc.exe");

  rmSync(staging, { recursive: true, force: true });
  rmSync(resourceRoot, { recursive: true, force: true });
  rmSync(firefoxRoot, { recursive: true, force: true });
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

  const firefox = await installFirefoxRuntime(
    options.firefoxArchive ?? configuredFirefoxArchive(),
    staging,
    firefoxRoot,
    options.hashFile ?? sha256File,
  );

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
  if (options.installPython) {
    await options.installPython(playwrightRoot);
  } else {
    await installPythonRuntime(
      playwrightRoot,
      options.downloadPython ?? ((url) => downloadBytes(url, "official Python runtime")),
      options.downloadPythonWheel ?? ((url) => downloadBytes(url, "official Python wheel")),
    );
  }
  if (!statSync(join(playwrightRoot, "python", "python.exe"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("official Python runtime is incomplete");
  }
  if (!statSync(join(playwrightRoot, "python", "Lib", "site-packages", "playwright", "driver", "node.exe"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("official Python Playwright wheel is incomplete");
  }
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "worker.mjs"));
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "playwright-worker.mjs"));
  cpSync(join(cwd, "firefox-worker.mjs"), join(playwrightRoot, "firefox-worker.mjs"));

  const agentRoot = join(playwrightRoot, "agent");
  mkdirSync(agentRoot, { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-runner.mjs",
    "script-runner.py",
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
    firefox,
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  try {
    const metadata = await prepareWindowsBundle();
    console.log(`prepared AliasMode Windows bundle with CloakBrowser SHA-256 ${metadata.sha256} and Firefox SHA-256 ${metadata.firefox.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

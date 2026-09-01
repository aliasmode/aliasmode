import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CLOAKBROWSER_WRAPPER_VERSION = "0.4.11";
export const CLOAKBROWSER_VERSION = "146.0.7680.177.5";
export const CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256 = "b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe";
export const CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256 = "03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80";
const WINDOWS_ARCHIVE_NAME = "cloakbrowser-windows-x64.zip";
const WINDOWS_ARCHIVE_URLS = [
  `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_VERSION}/${WINDOWS_ARCHIVE_NAME}`,
  `https://cloakbrowser.dev/chromium-v${CLOAKBROWSER_VERSION}/${WINDOWS_ARCHIVE_NAME}`,
];
const PATH_KEY = "CLOAKBROWSER_BINARY_PATH";
const HASH_KEY = "CLOAKBROWSER_BINARY_SHA256";

export interface BrowserInstallOptions {
  cwd?: string;
  cacheDir?: string;
  runInstaller?: () => Promise<{ code: number; output: string }>;
  exists?: (path: string) => boolean;
  hashFile?: (path: string) => Promise<string>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveDone, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveDone);
  });
  return hash.digest("hex");
}

async function preparePinnedWindowsArchive(cacheDir: string): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, `${CLOAKBROWSER_VERSION}-${WINDOWS_ARCHIVE_NAME}`);
  const archiveIsPinned = existsSync(archivePath) &&
    await sha256File(archivePath) === CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256;
  if (!archiveIsPinned) {
    rmSync(archivePath, { force: true });
    let downloaded = false;
    for (const url of WINDOWS_ARCHIVE_URLS) {
      try {
        const download = Bun.spawn([
          "curl.exe",
          "--fail",
          "--location",
          "--retry",
          "2",
          "--retry-all-errors",
          "--output",
          archivePath,
          url,
        ], { stdout: "inherit", stderr: "inherit" });
        if (await download.exited === 0 &&
          await sha256File(archivePath) === CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256) {
          downloaded = true;
          break;
        }
      } catch {
        // Try the signed release origin.
      }
      rmSync(archivePath, { force: true });
    }
    if (!downloaded) throw new Error("official CloakBrowser archive did not match the pinned Windows x64 SHA-256");
  }

  const extractRoot = join(cacheDir, `_aliasmode_extract_${process.pid}`);
  const binaryDir = join(cacheDir, `chromium-${CLOAKBROWSER_VERSION}`);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  try {
    const extraction = Bun.spawn(["tar.exe", "-xf", archivePath, "-C", extractRoot], {
      stdout: "ignore",
      stderr: "inherit",
    });
    if (await extraction.exited !== 0) throw new Error("pinned CloakBrowser archive extraction failed");
    const executable = join(extractRoot, "chrome.exe");
    if (!existsSync(executable) || await sha256File(executable) !== CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256) {
      throw new Error("pinned CloakBrowser archive contained an unexpected Windows x64 executable");
    }
    rmSync(binaryDir, { recursive: true, force: true });
    renameSync(extractRoot, binaryDir);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

async function runOfficialInstaller(cwd: string, cacheDir?: string): Promise<{ code: number; output: string }> {
  // This command exists to repair a missing/stale deployment. Do not let the
  // wrapper treat a local CloakBrowser override as its install target.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CLOAKBROWSER_")),
  );
  env.CLOAKBROWSER_VERSION = CLOAKBROWSER_VERSION;
  env.CLOAKBROWSER_AUTO_UPDATE = "false";
  if (cacheDir) env.CLOAKBROWSER_CACHE_DIR = cacheDir;
  const child = Bun.spawn(
    [process.execPath, "x", `cloakbrowser@${CLOAKBROWSER_WRAPPER_VERSION}`, "install"],
    { cwd, env, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  process.stdout.write(output);
  return { code: await child.exited, output };
}

function installedPath(output: string, exists: (path: string) => boolean): string | null {
  const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const lines = output.split(/\r?\n/).map((line) => line.replace(ansi, "").trim()).filter(Boolean);
  return lines.reverse().find((line) => exists(line)) ?? null;
}

export function browserEnvText(current: string, binaryPath: string, sha256: string, newline = "\n"): string {
  const owned = new RegExp(`^\\s*(?:${PATH_KEY}|${HASH_KEY})\\s*=.*$`, "i");
  const kept = current.split(/\r?\n/).filter((line) => !owned.test(line));
  while (kept.length && !kept.at(-1)?.trim()) kept.pop();
  if (kept.length) kept.push("");
  kept.push(`${PATH_KEY}=${binaryPath}`, `${HASH_KEY}=${sha256.toLowerCase()}`, "");
  return kept.join(newline);
}

/** Download the official signed binary, pin its exact path/hash, and return both. */
export async function installCloakBrowser(opts: BrowserInstallOptions = {}): Promise<{ path: string; sha256: string }> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  let cacheDir = opts.cacheDir ? resolve(opts.cacheDir) : undefined;
  if (process.platform === "win32" && !opts.runInstaller) {
    cacheDir ??= join(homedir(), ".cloakbrowser");
    await preparePinnedWindowsArchive(cacheDir);
  }
  const run = opts.runInstaller ?? (() => runOfficialInstaller(cwd, cacheDir));
  const exists = opts.exists ?? existsSync;
  const result = await run();
  if (result.code !== 0) throw new Error(`official CloakBrowser installer exited with code ${result.code}`);
  const path = installedPath(result.output, exists);
  if (!path) throw new Error("official CloakBrowser installer completed but did not report a readable binary path");

  const sha256 = (await (opts.hashFile ?? sha256File)(path)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("installed CloakBrowser returned an invalid SHA-256");
  if (process.platform === "win32" && sha256 !== CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256) {
    throw new Error("installed CloakBrowser did not match the pinned Windows x64 executable");
  }

  const envPath = resolve(cwd, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const newline = current.includes("\r\n") || process.platform === "win32" ? "\r\n" : "\n";
  writeFileSync(envPath, browserEnvText(current, path, sha256, newline), "utf8");
  return { path, sha256 };
}

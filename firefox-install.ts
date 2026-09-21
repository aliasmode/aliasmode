import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserEnvText, sha256File } from "./browser-install.ts";

export interface FirefoxRuntimeBuild {
  platform: NodeJS.Platform;
  arch: string;
  executablePath: string;
  archiveSha256: string;
  executableSha256: string;
}

export const FIREFOX_RUNTIME_BUILDS: readonly FirefoxRuntimeBuild[] = [
  {
    platform: "win32", arch: "x64", executablePath: "aliasmode.exe",
    archiveSha256: "af5d8ec61f6805048564932ef49837353993df88e7b62db0dd67011904cfc1c7",
    executableSha256: "6685cbdcb0da2a129a5e25bd91e4cd3eb79ad3b557d45841537e04cf273deeaa",
  },
];

export function firefoxBuildForHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  builds = FIREFOX_RUNTIME_BUILDS,
): FirefoxRuntimeBuild {
  const build = builds.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!build) {
    const host = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
    throw new Error(`No approved AliasMode Firefox archive is available for ${host} ${arch}`);
  }
  return build;
}

async function extractFirefoxArchive(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === "darwin" ? ["ditto", "-x", "-k", archive, destination]
    : platform === "win32" ? ["tar.exe", "-xf", archive, "-C", destination]
      : ["unzip", "-q", archive, "-d", destination];
  if (!Bun.which(command[0]!)) throw new Error(`Firefox setup requires ${command[0]} on PATH`);
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("AliasMode Firefox archive extraction failed");
}

export async function installFirefox(
  options: { archive: string; cwd?: string; platform?: NodeJS.Platform; arch?: string },
  dependencies: {
    builds?: readonly FirefoxRuntimeBuild[];
    extract?: (archive: string, destination: string, platform: NodeJS.Platform) => Promise<void>;
  } = {},
): Promise<{ path: string; sha256: string }> {
  const platform = options.platform ?? process.platform;
  const build = firefoxBuildForHost(platform, options.arch ?? process.arch, dependencies.builds);
  const archive = resolve(options.archive);
  if (await sha256File(archive) !== build.archiveSha256) {
    throw new Error("AliasMode Firefox archive does not match the approved host build SHA-256");
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const cache = join(cwd, "browser");
  mkdirSync(cache, { recursive: true });
  // A new directory leaves any previously installed, running browser untouched.
  const root = mkdtempSync(join(cache, `firefox-${platform}-${build.arch}-`));
  try {
    await (dependencies.extract ?? extractFirefoxArchive)(archive, root, platform);
    const path = join(root, build.executablePath);
    const sha256 = await sha256File(path);
    if (sha256 !== build.executableSha256) throw new Error("AliasMode Firefox executable does not match its approved SHA-256");
    if (platform !== "win32") accessSync(path, constants.X_OK);
    const envPath = join(cwd, ".env");
    const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const newline = current.includes("\r\n") || platform === "win32" ? "\r\n" : "\n";
    writeFileSync(envPath, browserEnvText(current, path, sha256, newline, "ALIASMODE_FIREFOX"), "utf8");
    return { path, sha256 };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

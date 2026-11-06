import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { browserEnvText, sha256File, windowsSystemTool } from "./browser-install.ts";

export interface FirefoxRuntimeBuild {
  platform: NodeJS.Platform;
  arch: string;
  executablePath: string;
  archiveSha256: string;
  executableSha256: string;
}

export const FIREFOX_RUNTIME_VERSION = "156.0.1-beta.36";
const FIREFOX_RUNTIME_RELEASE = `aliasmode-runtime-${FIREFOX_RUNTIME_VERSION}-r14`;
const FIREFOX_RELEASE_BASE = `https://github.com/aliasmode/aliasmode-firefox/releases/download/${FIREFOX_RUNTIME_RELEASE}`;

export const FIREFOX_RUNTIME_BUILDS: readonly FirefoxRuntimeBuild[] = [
  {
    platform: "linux", arch: "x64", executablePath: "aliasmode",
    archiveSha256: "33c976a7015a468f647e4cdd71c064e5a6e58c75d960ad74d48de755b4212f4b",
    executableSha256: "fba911c6baa1e73d19187bf5242faf42d33c22d5204ec761cb913f8818816bb7",
  },
  {
    platform: "darwin", arch: "arm64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "64b56f0c6a8aa0a9e4ec2ffe058060131dfd385692747a717fabea6c4d2424bc",
    executableSha256: "2ae46440c758f1dfc74c2be6f5fd95f9bc85f60cab6ae8afbc2e4c4762ff3c05",
  },
  {
    platform: "darwin", arch: "x64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "ce4cca8228ab48fb711166be8933b6cb118dfa5660f87eed16a3334d64a9c42f",
    executableSha256: "6dddcdbb8c93f1b9bc3f57276c1846f11df5b3cd7a63869489db393e6a402edf",
  },
  {
    platform: "win32", arch: "x64", executablePath: "aliasmode.exe",
    archiveSha256: "23d2531f5a72dbfde049319259bcee55407a2ba7afc570398446da5c1f20cfcb",
    executableSha256: "1a031ad448359f65b299634dd6fd0027c556f4c7807c2e0fb17f48a76fba7337",
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

export function firefoxReleaseArchiveUrl(build: FirefoxRuntimeBuild): string {
  const name = build.platform === "linux" && build.arch === "x64"
    ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-lin.x86_64.zip`
    : build.platform === "darwin" && build.arch === "arm64"
      ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-mac.arm64.zip`
      : build.platform === "darwin" && build.arch === "x64"
        ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-mac.x86_64.zip`
        : build.platform === "win32" && build.arch === "x64"
          ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-win.x86_64.zip`
          : "";
  if (!name) throw new Error(`No approved AliasMode Firefox release archive is available for ${build.platform} ${build.arch}`);
  return `${FIREFOX_RELEASE_BASE}/${name}`;
}

async function downloadFirefoxArchive(
  build: FirefoxRuntimeBuild,
  cwd: string,
  fetcher: (input: string) => Promise<Response>,
): Promise<{ archive: string; cleanup: () => void }> {
  const directory = mkdtempSync(join(cwd, ".aliasmode-firefox-download-"));
  const archive = join(directory, firefoxReleaseArchiveUrl(build).split("/").at(-1)!);
  try {
    const response = await fetcher(firefoxReleaseArchiveUrl(build));
    if (!response.ok) throw new Error("approved AliasMode Firefox release download failed");
    // Bun 1.2.21 can leave Bun.write(Response) pending for streamed redirects.
    await pipeline(response.body as unknown as import("node:stream/web").ReadableStream, createWriteStream(archive));
    return { archive, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function extractFirefoxArchive(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === "darwin" ? ["ditto", "-x", "-k", archive, destination]
    : platform === "win32" ? [windowsSystemTool("tar.exe"), "-xf", archive, "-C", destination]
      : ["unzip", "-q", archive, "-d", destination];
  if (!(platform === "win32" ? existsSync(command[0]!) : Bun.which(command[0]!))) throw new Error(`Firefox setup requires ${command[0]}`);
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("AliasMode Firefox archive extraction failed");
}

export async function installFirefox(
  options: { archive?: string; cwd?: string; platform?: NodeJS.Platform; arch?: string; writeEnv?: boolean },
  dependencies: {
    builds?: readonly FirefoxRuntimeBuild[];
    extract?: (archive: string, destination: string, platform: NodeJS.Platform) => Promise<void>;
    fetch?: (input: string) => Promise<Response>;
  } = {},
): Promise<{ path: string; sha256: string }> {
  const platform = options.platform ?? process.platform;
  const build = firefoxBuildForHost(platform, options.arch ?? process.arch, dependencies.builds);
  const cwd = resolve(options.cwd ?? process.cwd());
  const downloaded = options.archive
    ? undefined
    : await downloadFirefoxArchive(build, cwd, dependencies.fetch ?? fetch);
  const archive = options.archive ? resolve(options.archive) : downloaded!.archive;
  try {
    if (await sha256File(archive) !== build.archiveSha256) {
      throw new Error("AliasMode Firefox archive does not match the approved host build SHA-256");
    }
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
      if (options.writeEnv !== false) {
        const envPath = join(cwd, ".env");
        const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const newline = current.includes("\r\n") || platform === "win32" ? "\r\n" : "\n";
        writeFileSync(envPath, browserEnvText(current, path, sha256, newline, "ALIASMODE_FIREFOX"), "utf8");
      }
      return { path, sha256 };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  } finally {
    downloaded?.cleanup();
  }
}

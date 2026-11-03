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
const FIREFOX_RUNTIME_RELEASE = `aliasmode-runtime-${FIREFOX_RUNTIME_VERSION}-r11`;
const FIREFOX_RELEASE_BASE = `https://github.com/aliasmode/aliasmode-firefox/releases/download/${FIREFOX_RUNTIME_RELEASE}`;

export const FIREFOX_RUNTIME_BUILDS: readonly FirefoxRuntimeBuild[] = [
  {
    platform: "linux", arch: "x64", executablePath: "aliasmode",
    archiveSha256: "0a514af4e4463eb43626fca6fb4d685273c1d4b1f7c652f83940ad3b4cda3736",
    executableSha256: "7b7c69b705f24be36f89f1fe92d34db600bd90213fa5c67572496408f4e9c004",
  },
  {
    platform: "darwin", arch: "arm64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "69f4b0b0851a4891d1f1b77b41d95f0fbebeb856248f42b6713733c6bf615797",
    executableSha256: "4d2b96bbe1f9fc8e196314d11d39a8dc5a3a7349a686d0aad18ff6b190e2fb70",
  },
  {
    platform: "darwin", arch: "x64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "365ef3e5df8ded5f4ad199a0d91c6872f2485ecfbe8b7caecdfbdacfffbacf5b",
    executableSha256: "3416934e3fb75194df8cbc9c1158ff1aa6a1d13a5664e497eddc1422aa7a39bf",
  },
  {
    platform: "win32", arch: "x64", executablePath: "aliasmode.exe",
    archiveSha256: "5709d0e194a2b75bcb6c909079c67404a63cca713eeca9380c409de23fb3b8b4",
    executableSha256: "cf60060ac7664bdf954353a18f358d7f251b68272119a5b3a6d3f11abd8bbb4f",
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

/**
 * Browser runtimes that are downloaded on first use instead of being bundled:
 * the opt-in Chromium 155 beta, and CloakBrowser. Each is pinned by archive and
 * executable SHA-256, and lives in the app's data folder, which survives app updates.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { cp, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  CLOAKBROWSER_MACOS_VERSION, CLOAKBROWSER_VERSION, CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256,
  CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256, renameWhenUnlocked, sha256File,
} from "./browser-install.ts";
import { trackRuntimeDownload } from "./runtime-download.ts";

// AliasMode's own Windows and Linux builds of the patch series. The Windows package includes
// Chromium's version manifest, which upstream's Windows archive omits. Each build gets its
// own directory, so a browser still running from an earlier build keeps its files.
// A new build changes the version, the release tag, and each target's two SHA-256 values and archive size.
const OWN_VERSION = "155.0.8059.85";
const OWN_RELEASE = "aliasmode.4";
const OWN_RELEASE_URL = `https://github.com/aliasmode/aliasmode-chromium/releases/download/v${OWN_VERSION}-${OWN_RELEASE}`;
const WINDOWS_BUILD = {
  root: `aliasmode-chromium-${OWN_VERSION}-windows-x64`,
  url: `${OWN_RELEASE_URL}/aliasmode-chromium-${OWN_VERSION}-windows-x64.zip`,
  dir: `chromium-${OWN_VERSION}-${OWN_RELEASE}`,
  archiveSha256: "cfea275e4b7f3274b701e64c0483b46cbf6cd12ead9a6cfda6ff77b2680e7a23",
  size: 203519527,
  executable: "chrome.exe",
  executableSha256: "0ef4de1bef7c12534031318e07ac89fa7942916a3abc89057985aafefbca619f",
  // Pages read and draw at --force-device-scale-factor, and
  // --aliasmode-window-label names the window without touching page titles.
  hostScale: true,
  windowLabel: true,
  // Behind an HTTP proxy, where WebRTC has no UDP, --fingerprint-webrtc-ip still gives a page
  // an mDNS host candidate and a server-reflexive candidate at that address, and sends nothing.
  webRtcIp: true,
  // --aliasmode-keep-alive keeps the browser running after its last window closes.
  keepAlive: true,
};
// Upstream's Apostate v0.5.1 (macOS only) keeps its own Chromium version.
const APOSTATE_VERSION = "155.0.8059.31";
const APOSTATE_RELEASE = "https://github.com/heretic-tech/apostate/releases/download/v0.5.1";
const MACOS_BUILD = {
  root: `apostate-${APOSTATE_VERSION}-macos-arm64`,
  url: `${APOSTATE_RELEASE}/apostate-${APOSTATE_VERSION}-macos-arm64.zip`,
  dir: `chromium-${APOSTATE_VERSION}`,
  archiveSha256: "58176ba9b3e9cfd74029165bdf716c636e618af17a48bd905fe6d5f1552d901a",
  size: 158101227,
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: "2dfa8b148e6d06598981c4a1e1bc0d7c2c7860d74401ad0d934d21a10c7916d7",
  hostScale: false,
  windowLabel: false,
  webRtcIp: false,
  keepAlive: false,
};
const LINUX_BUILD = {
  root: `aliasmode-chromium-${OWN_VERSION}-linux-x64`,
  url: `${OWN_RELEASE_URL}/aliasmode-chromium-${OWN_VERSION}-linux-x64.tar.zst`,
  dir: `chromium-${OWN_VERSION}-${OWN_RELEASE}`,
  archiveSha256: "00981c9e79e80accabd5707b140cf710c68797b6f905e990393d2a1224121f98",
  size: 198069298,
  executable: "chrome",
  executableSha256: "ee0bfec11c3da08f9ab8da0ef42f8b420cc13e80f389f09bcdc94fa582d3172a",
  hostScale: false,
  windowLabel: true,
  webRtcIp: true,
  keepAlive: true,
};
// Apple Silicon macOS gets upstream's build; Windows and Linux get AliasMode's own builds.
function chromiumBuild(platform: NodeJS.Platform): typeof WINDOWS_BUILD {
  return platform === "darwin" ? MACOS_BUILD : platform === "linux" ? LINUX_BUILD : WINDOWS_BUILD;
}
const BUILD = chromiumBuild(process.platform);
export const ALIASMODE_CHROMIUM_ARCHIVE_URL = BUILD.url;
export const ALIASMODE_CHROMIUM_ARCHIVE_SHA256 = BUILD.archiveSha256;
export const ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 = BUILD.executableSha256;
/** The pinned Windows build can draw pages at the display's own scale; an earlier build must get scale 1. */
export const ALIASMODE_CHROMIUM_HOST_SCALE = WINDOWS_BUILD.hostScale;
/** The pinned Windows build takes --aliasmode-window-label. */
export const ALIASMODE_CHROMIUM_WINDOW_LABEL = WINDOWS_BUILD.windowLabel;
/** The pinned Windows build shows --fingerprint-webrtc-ip behind an HTTP proxy, where WebRTC has no UDP. */
export const ALIASMODE_CHROMIUM_WEBRTC_IP = WINDOWS_BUILD.webRtcIp;
/** The pinned Windows build takes --aliasmode-keep-alive. */
export const ALIASMODE_CHROMIUM_KEEP_ALIVE = WINDOWS_BUILD.keepAlive;

/** One downloadable, hash-pinned browser runtime under the runtimes root. */
interface PinnedRuntime {
  label: string;
  /** The profiles that wait for it, as the dashboard matches a download to its rows. */
  runtime: "aliasmode" | "cloakbrowser";
  dir: string;
  url: string;
  archiveSha256: string;
  /** Archive size in bytes; only download progress uses it. */
  size: number;
  /** Directory inside the archive that holds the runtime; empty when the archive root is the runtime. */
  archiveRoot: string;
  executable: string;
  executableSha256: string;
}

function chromium155(platform: NodeJS.Platform): PinnedRuntime {
  const build = chromiumBuild(platform);
  return {
    label: "Chromium 155",
    runtime: "aliasmode",
    dir: build.dir,
    url: build.url,
    archiveSha256: build.archiveSha256,
    size: build.size,
    archiveRoot: build.root,
    executable: build.executable,
    executableSha256: build.executableSha256,
  };
}

// CloakBrowser publishes no macOS build after 145, so that build opens CloakBrowser profiles on a Mac.
export const CLOAKBROWSER_MACOS_EXECUTABLE_SHA256 = "79ddf7e7a7be8087319390ed79266387f6499b8a2e45ccfbaa724d7e7fff6b79";
const CLOAKBROWSER_MACOS: PinnedRuntime = {
  label: "CloakBrowser",
  runtime: "cloakbrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_MACOS_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_MACOS_VERSION}/cloakbrowser-darwin-arm64.tar.gz`,
  archiveSha256: "505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c",
  size: 147384149,
  archiveRoot: "",
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
};
export const CLOAKBROWSER_MACOS_X64_EXECUTABLE_SHA256 = "673538d1855e4dbe7ae0f0d7623cd19f766d40e08b9933c510a737f6463f12de";
const CLOAKBROWSER_MACOS_X64: PinnedRuntime = {
  ...CLOAKBROWSER_MACOS,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_MACOS_VERSION}/cloakbrowser-darwin-x64.tar.gz`,
  archiveSha256: "a0a061b1945db55b3bbe95986a82b67803311c0fedabb3946e7ab0172273daac",
  size: 158989564,
  executableSha256: CLOAKBROWSER_MACOS_X64_EXECUTABLE_SHA256,
};

// The Linux app downloads CloakBrowser's own Linux build on first use.
export const CLOAKBROWSER_LINUX_EXECUTABLE_SHA256 = "715722e8605ae3ce81523c1218aba1ec89425786ab33ceaf99f8a6cb5e70e6e8";
const CLOAKBROWSER_LINUX: PinnedRuntime = {
  label: "CloakBrowser",
  runtime: "cloakbrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_VERSION}/cloakbrowser-linux-x64.tar.gz`,
  archiveSha256: "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e",
  size: 216890134,
  archiveRoot: "",
  executable: "chrome",
  executableSha256: CLOAKBROWSER_LINUX_EXECUTABLE_SHA256,
};

// The Windows app downloads the build it bundled before, so profiles keep their exact kernel.
const CLOAKBROWSER_WINDOWS: PinnedRuntime = {
  label: "CloakBrowser",
  runtime: "cloakbrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_VERSION}/cloakbrowser-windows-x64.zip`,
  archiveSha256: CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256,
  size: 562004238,
  archiveRoot: "",
  executable: "chrome.exe",
  executableSha256: CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256,
};

/** The CloakBrowser build that the app downloads on this computer; none where CloakBrowser does not run. */
function cloakBrowser(platform: NodeJS.Platform, arch: string): PinnedRuntime | undefined {
  if (platform === "darwin" && arch === "arm64") return CLOAKBROWSER_MACOS;
  if (platform === "darwin" && arch === "x64") return CLOAKBROWSER_MACOS_X64;
  if (platform === "linux" && arch === "x64") return CLOAKBROWSER_LINUX;
  if (platform === "win32" && arch === "x64") return CLOAKBROWSER_WINDOWS;
  return undefined;
}

/** SHA-256 of the CloakBrowser executable that the app downloads on this computer. */
export function cloakBrowserExecutableSha256(platform: NodeJS.Platform, arch: string): string | undefined {
  return cloakBrowser(platform, arch)?.executableSha256;
}

/** The computers that can run Chromium 155. */
export function supportsChromium155Host(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === "win32" && arch === "x64") || (platform === "darwin" && arch === "arm64")
    || (platform === "linux" && arch === "x64");
}

/** The AppArmor profile that the Linux install command adds for the downloaded Chrome runtimes. */
export const LINUX_CHROMIUM_APPARMOR_PROFILE = "/etc/apparmor.d/aliasmode-chromium";

/**
 * Ubuntu 23.10 and later let a program create the user namespace of Chrome's sandbox only when
 * an AppArmor profile allows it. These Chrome builds have no setuid sandbox helper to fall back on.
 */
export function linuxChromiumSandboxBlocked(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  exists: (path: string) => boolean = existsSync,
): boolean {
  try {
    if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() !== "1") return false;
  } catch {
    return false;
  }
  return !exists(LINUX_CHROMIUM_APPARMOR_PROFILE);
}

/** New Chromium profiles made on an Apple Silicon Mac use this runtime, unless a CloakBrowser binary is configured. */
export function hostChromiumRuntime(platform = process.platform, env = process.env, arch: string = process.arch): "aliasmode" | undefined {
  return platform === "darwin" && arch === "arm64" && !env.CLOAKBROWSER_BINARY_PATH ? "aliasmode" : undefined;
}

/** New Chromium profiles that name no runtime use Chromium 155 wherever this computer can run it. */
export function defaultChromiumRuntime(platform = process.platform, arch: string = process.arch, env = process.env): "aliasmode" | undefined {
  if (platform === "darwin") return hostChromiumRuntime(platform, env, arch);
  return supportsChromium155Host(platform, arch) ? "aliasmode" : undefined;
}

/**
 * The primary display's scale, which the desktop app passes in ALIASMODE_HOST_SCALE
 * (1.25 at 125%). 1 when it is missing or is not a display scale.
 */
export function hostDisplayScale(env: NodeJS.ProcessEnv = process.env): number {
  const scale = Number(env.ALIASMODE_HOST_SCALE);
  return Number.isFinite(scale) && scale >= 1 ? scale : 1;
}

function displaySize(value: string | undefined): { width: number; height: number } | null {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** The primary display's size in physical pixels, which the desktop app passes in ALIASMODE_HOST_SCREEN. */
export function hostDisplaySize(env: NodeJS.ProcessEnv = process.env): { width: number; height: number } | null {
  return displaySize(env.ALIASMODE_HOST_SCREEN);
}

/**
 * The primary display's available area (without the taskbar, or the menu bar and Dock) as Firefox
 * pages measure it: ALIASMODE_HOST_AVAIL, which the desktop app passes in physical pixels, divided
 * by the display scale.
 */
export function hostDisplayAvail(env: NodeJS.ProcessEnv = process.env): { width: number; height: number } | null {
  const avail = displaySize(env.ALIASMODE_HOST_AVAIL);
  const scale = hostDisplayScale(env);
  return avail && { width: Math.floor(avail.width / scale), height: Math.floor(avail.height / scale) };
}

/** Chromium 155 on Windows draws pages at the display's scale; every other launch at 1. */
export function chromiumDeviceScale(hostPlatform: NodeJS.Platform, chromiumRuntime: string | undefined, hostScale: number): number {
  return hostPlatform === "win32" && chromiumRuntime && ALIASMODE_CHROMIUM_HOST_SCALE ? hostScale : 1;
}

export interface AliasmodeChromiumDeps {
  /** One download attempt. It continues the partial file that an earlier attempt or app run left. */
  download?: (url: string, output: string) => Promise<void>;
  extract?: (archive: string, directory: string) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Prepare the downloaded runtime's Windows sandbox file access. */
  run?: (command: string[]) => Promise<void>;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

/**
 * curl, not fetch: on Windows curl.exe trusts the Windows certificate store, so a company
 * proxy that inspects TLS works. A download that gets under 1 KB/s for a minute stops,
 * and the next attempt continues it.
 */
async function curlDownload(url: string, output: string, platform: NodeJS.Platform): Promise<void> {
  const child = Bun.spawn([
    platform === "win32" ? "curl.exe" : "curl", "--fail", "--location", "--silent", "--show-error",
    "--continue-at", "-", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60",
    "--output", output, url,
  ], { stdout: "ignore", stderr: "ignore" });
  const code = await child.exited;
  // 33: the server cannot continue the saved part, so the next attempt starts over.
  if (code === 33) rmSync(output, { force: true });
  if (code !== 0) throw new Error(`curl exited with code ${code}`);
}

const DOWNLOAD_ATTEMPTS = 5;

function fileSize(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

/** Retry a broken download. Only attempts that add no bytes count toward the limit. */
async function downloadWithRetry(
  url: string,
  partial: string,
  download: (url: string, output: string) => Promise<void>,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let failures = 0; ;) {
    const before = fileSize(partial);
    try {
      await download(url, partial);
      return;
    } catch (error) {
      if (fileSize(partial) <= before && ++failures >= DOWNLOAD_ATTEMPTS) throw error;
      await sleep(Math.min(30_000, 1000 * 2 ** failures));
    }
  }
}

export function aliasmodeChromiumExecutable(root: string, platform = process.platform): string {
  const build = chromiumBuild(platform);
  return join(root, build.dir, build.executable);
}

/**
 * The folder of Chromium 155's own files on Windows and Linux. Chromium loads the components it
 * finds there before it downloads them into a profile. On macOS that folder is inside the signed app.
 */
export function chromiumComponentsDir(executable: string, platform = process.platform): string | null {
  if (platform === "darwin") return null;
  const dir = dirname(executable);
  return basename(dir) === chromiumBuild(platform).dir ? dir : null;
}

const COMPONENT_VERSION = /^\d+(\.\d+)*$/;

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function manifestVersion(dir: string): Promise<string | null> {
  try {
    const { version } = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    return typeof version === "string" && COMPONENT_VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Chromium 155 downloads about 85 MB of components (Widevine, hyphenation data, models) into every
 * profile, and thousands of profiles filled an operator's disk. After a profile stops, keep one copy
 * of each component in `componentsDir`, where every profile loads it at its next start, and delete
 * the profile's own copies that are not newer.
 */
export async function shareChromiumComponents(userDataDir: string, componentsDir: string): Promise<void> {
  for (const entry of await readdir(userDataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const own = join(userDataDir, entry.name);
    const versions = (await readdir(own, { withFileTypes: true }))
      .filter((v) => v.isDirectory() && COMPONENT_VERSION.test(v.name) && existsSync(join(own, v.name, "manifest.json")))
      .map((v) => v.name)
      .sort(compareVersions);
    const newest = versions.at(-1);
    if (!newest) continue;
    const shared = join(componentsDir, entry.name);
    if (!existsSync(shared)) {
      // Copy beside the target and rename, so a browser that starts now never sees half a component.
      const temp = join(componentsDir, `.${entry.name}.${randomUUID()}.tmp`);
      await cp(join(own, newest), temp, { recursive: true });
      await rename(temp, shared).catch(() => rm(temp, { recursive: true, force: true }));
    }
    const sharedVersion = await manifestVersion(shared);
    if (sharedVersion && compareVersions(newest, sharedVersion) <= 0) await rm(own, { recursive: true, force: true });
  }
}

/** The pinned 155 archive of one system. */
export function aliasmodeChromiumArchive(platform: NodeJS.Platform): { url: string; archiveSha256: string; executableSha256: string } {
  const { url, archiveSha256, executableSha256 } = chromiumBuild(platform);
  return { url, archiveSha256, executableSha256 };
}

// ditto and tar keep the symlinks and code signature of a macOS app bundle.
function extractCommand(url: string, file: string, directory: string, platform: NodeJS.Platform): string[] {
  if (url.endsWith(".tar.gz")) return ["tar", "-xzf", file, "-C", directory];
  if (url.endsWith(".tar.zst")) return ["tar", "--zstd", "-xf", file, "-C", directory];
  return platform === "darwin" ? ["ditto", "-x", "-k", file, directory] : ["tar.exe", "-xf", file, "-C", directory];
}

/** The download in progress keeps this name across attempts and app runs, so it can continue. */
function partialName(spec: PinnedRuntime): string {
  return `.${spec.dir}.${spec.archiveSha256.slice(0, 16)}.part`;
}

// A launch checks the runtime twice. Grant access once per directory instance in this
// process, but prepare it again after a reinstall replaces the directory at the same path.
const windowsAccessPrepared = new Map<string, string>();

async function prepareWindowsAccess(target: string, deps: AliasmodeChromiumDeps, platform: NodeJS.Platform): Promise<void> {
  if (platform !== "win32") return;
  const directory = realpathSync(target);
  const stat = statSync(directory);
  const identity = [stat.dev, stat.ino, stat.birthtimeMs].join(":");
  if (windowsAccessPrepared.get(directory) === identity) return;
  try {
    // The main process can read AppData while an AppContainer GPU process cannot.
    // Grant only read/execute on the verified runtime, including its DLLs and resources.
    await (deps.run ?? run)(["icacls.exe", directory, "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "/T", "/Q"]);
  } catch (error) {
    throw new Error(`Could not prepare Windows sandbox read/execute access for ${directory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  windowsAccessPrepared.set(directory, identity);
}

async function install(spec: PinnedRuntime, root: string, deps: AliasmodeChromiumDeps, platform: NodeJS.Platform): Promise<string> {
  const hashFile = deps.hashFile ?? sha256File;
  const target = join(root, spec.dir);
  const executable = join(target, spec.executable);
  if (existsSync(executable) && await hashFile(executable) === spec.executableSha256) {
    await prepareWindowsAccess(target, deps, platform);
    return executable;
  }

  mkdirSync(root, { recursive: true });
  const tempPrefix = `.${spec.dir}-`;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(tempPrefix)) rmSync(join(root, entry), { recursive: true, force: true });
  }
  const partial = join(root, partialName(spec));
  await trackRuntimeDownload(spec.runtime, partial, spec.size, () => downloadWithRetry(
    spec.url,
    partial,
    deps.download ?? ((url, output) => curlDownload(url, output, platform)),
    deps.sleep ?? Bun.sleep,
  ));
  if (await hashFile(partial) !== spec.archiveSha256) {
    rmSync(partial, { force: true });
    throw new Error(`${spec.label} archive did not match its pinned SHA-256`);
  }
  const temp = join(root, `${tempPrefix}${process.pid}-${Date.now()}`);
  const archive = join(temp, "runtime.archive");
  const extracted = join(temp, "extracted");
  mkdirSync(extracted, { recursive: true });
  try {
    await renameWhenUnlocked(partial, archive);
    await (deps.extract ?? ((file, directory) => run(extractCommand(spec.url, file, directory, platform))))(archive, extracted);
    const runtime = spec.archiveRoot ? join(extracted, spec.archiveRoot) : extracted;
    if (await hashFile(join(runtime, spec.executable)) !== spec.executableSha256) {
      throw new Error(`${spec.label} archive contained an unexpected executable`);
    }
    rmSync(target, { recursive: true, force: true });
    await renameWhenUnlocked(runtime, target);
    await prepareWindowsAccess(target, deps, platform);
    return executable;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const installing = new Map<string, Promise<string>>();

/** Install a pinned runtime once at a time and return its executable. */
function ensure(spec: PinnedRuntime, root: string, deps: AliasmodeChromiumDeps, platform: NodeJS.Platform): Promise<string> {
  const key = `${root}\0${spec.dir}`;
  let pending = installing.get(key);
  if (!pending) {
    pending = install(spec, root, deps, platform).finally(() => installing.delete(key));
    installing.set(key, pending);
  }
  return pending;
}

/** Install the pinned Chromium 155 runtime and return its executable. */
export function ensureAliasmodeChromium(root: string, deps: AliasmodeChromiumDeps = {}, platform = process.platform): Promise<string> {
  return ensure(chromium155(platform), root, deps, platform);
}

/** Install the pinned CloakBrowser build of this computer and return its executable. */
export function ensureCloakBrowser(root: string, platform = process.platform, arch: string = process.arch, deps: AliasmodeChromiumDeps = {}): Promise<string> {
  const spec = cloakBrowser(platform, arch);
  if (!spec) return Promise.reject(new Error(`CloakBrowser does not run on ${platform} ${arch}`));
  return ensure(spec, root, deps, platform);
}

function within(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Remove downloaded Chromium and CloakBrowser runtimes that are no longer pinned, with their
 * partial downloads. A runtime that holds one of `inUse` (a live browser's executable) stays
 * until a later start. Other folders under the runtimes root are left alone.
 */
export function pruneBrowserRuntimes(root: string, inUse: readonly string[], platform = process.platform, arch: string = process.arch): void {
  let entries: string[];
  let real: string;
  try {
    entries = readdirSync(root);
    real = realpathSync(root);
  } catch {
    return;
  }
  const pins = [chromium155(platform), ...(cloakBrowser(platform, arch) ? [cloakBrowser(platform, arch)!] : [])];
  const keep = new Set(pins.flatMap((spec) => [spec.dir, partialName(spec)]));
  for (const entry of entries) {
    if (!/^\.?(chromium|cloakbrowser)-/.test(entry) || keep.has(entry)) continue;
    // An install running now owns its temporary folder; the next install removes stale ones.
    if (pins.some((spec) => entry.startsWith(`.${spec.dir}-`))) continue;
    const path = join(real, entry);
    if (inUse.some((executable) => within(path, executable))) continue;
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
}

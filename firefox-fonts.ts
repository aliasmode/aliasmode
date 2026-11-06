/**
 * Font packs for AliasMode Firefox. The engine package carries no fonts of other
 * operating systems; a profile whose identity is another OS needs that OS's fonts.
 * The app downloads one pinned pack per OS when a profile needs it, checks its
 * SHA-256, unpacks it in the app's data folder (which survives app updates) and
 * passes the folder to the engine in the aliasmode:fontsDir config key. All profiles
 * share one copy. The host's own OS needs no pack: the engine uses the real fonts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renameWhenUnlocked } from "./browser-install.ts";
import { sha256File, windowsSystemTool } from "./browser-install.ts";
import { trackRuntimeDownload } from "./runtime-download.ts";

export type FontPackOs = "windows" | "macos" | "linux";

export interface FirefoxFontPack {
  os: FontPackOs;
  asset: string;
  size: number;
  sha256: string;
  /** Font files in the pack, checked after unpacking. */
  files: number;
}

// The packs are published with the engine release that stopped carrying them. A
// later engine can keep these pins: a pack changes only when its fonts change.
const FONT_PACK_RELEASE = "aliasmode-runtime-156.0.1-beta.36-r4";
const FONT_PACK_BASE = `https://github.com/aliasmode/aliasmode-firefox/releases/download/${FONT_PACK_RELEASE}`;

export const FIREFOX_FONT_PACKS: Readonly<Record<FontPackOs, FirefoxFontPack>> = {
  windows: {
    os: "windows", asset: "aliasmode-fonts-windows-1.zip", size: 189218542, files: 144,
    sha256: "e5ed1bea592a0bf8e43f4564c83ce418cc823d2f605454b806c1744df8215410",
  },
  macos: {
    os: "macos", asset: "aliasmode-fonts-macos-1.zip", size: 352907600, files: 355,
    sha256: "7edaf42dbdf4d32f23965ca3ac4170f9c268ee73d0f715c5d4045d991fc80cfb",
  },
  linux: {
    os: "linux", asset: "aliasmode-fonts-linux-1.zip", size: 29123241, files: 143,
    sha256: "09caec637ecba08ad267955db9903b0635d7c799b0c5a9157e274b6b812e1a62",
  },
};

const PACKS_DIR = "firefox-fonts";
/** Holds the pack's SHA-256; written inside the unpacked folder before its atomic rename. */
const STAMP = "pack.sha256";

export function firefoxFontPackUrl(pack: FirefoxFontPack): string {
  return `${FONT_PACK_BASE}/${pack.asset}`;
}

/** The pack a profile of this OS needs on this computer; none for the computer's own OS. */
export function firefoxFontPackFor(personaOs: FontPackOs, platform: NodeJS.Platform = process.platform): FirefoxFontPack | undefined {
  const host = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
  return host && host !== personaOs ? FIREFOX_FONT_PACKS[personaOs] : undefined;
}

function packRoot(root: string, pack: FirefoxFontPack): string {
  return join(root, PACKS_DIR, `${pack.os}-${pack.sha256.slice(0, 16)}`);
}

/** The folder of font files the engine reads. */
export function firefoxFontPackFontsDir(root: string, pack: FirefoxFontPack): string {
  return join(packRoot(root, pack), "fonts");
}

export function firefoxFontPackInstalled(root: string, pack: FirefoxFontPack): boolean {
  try {
    return readFileSync(join(packRoot(root, pack), STAMP), "utf8") === pack.sha256;
  } catch {
    return false;
  }
}

/**
 * Preferences that let the browser's sandboxed content processes read the pack folder.
 * Without them those processes cannot load the fonts the main process lists.
 */
export function firefoxFontPackPrefs(fontsDir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform === "darwin") return { "security.sandbox.content.mac.testing_read_path1": fontsDir };
  // Windows: the folder itself (to list it) and, with the trailing separator, its files.
  if (platform === "win32") return { "security.sandbox.content.read_path_whitelist": `${fontsDir},${fontsDir}\\` };
  // Linux: a trailing slash allows the folder's whole tree; without it, only the folder itself.
  return { "security.sandbox.content.read_path_whitelist": `${fontsDir}/` };
}

/**
 * A fontconfig file for AliasMode Chromium on Linux that adds the pack's fonts to the system's,
 * given to the browser as FONTCONFIG_FILE. Chromium reads every font through fontconfig there, and
 * its engine shows only the fonts of the profile's OS, so a Windows profile needs Windows fonts
 * installed. The system's fonts stay installed for everything else. Written once, beside the pack.
 */
export function chromiumFontconfigFile(fontsDir: string, systemConf = "/etc/fonts/fonts.conf"): string {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const content = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">${escape(systemConf)}</include>
  <dir>${escape(fontsDir)}</dir>
</fontconfig>
`;
  const file = join(dirname(fontsDir), "chromium-fonts.conf");
  try {
    if (readFileSync(file, "utf8") === content) return file;
  } catch {}
  // Renamed into place, so a browser starting at the same time never reads half a file.
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
  return file;
}

export interface FirefoxFontPackDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  extract?: (archive: string, directory: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Download attempts in one install; a partial download resumes on the next. */
  attempts?: number;
  /** A download that receives nothing for this long is retried. */
  stallMs?: number;
}

/** Start byte of a 206 response, from its Content-Range header. */
function rangeStart(response: Response): number | undefined {
  const match = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : undefined;
}

async function receive(url: string, partial: string, have: number, deps: FirefoxFontPackDeps): Promise<void> {
  const controller = new AbortController();
  const stallMs = deps.stallMs ?? 60_000;
  let timer = setTimeout(() => controller.abort(), stallMs);
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs); };
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal: controller.signal,
    });
    const resume = have > 0 && response.status === 206 && rangeStart(response) === have;
    if (!resume && response.status !== 200) {
      // The saved part no longer lines up with what the server sends: start over.
      if (response.status === 206 || response.status === 416) rmSync(partial, { force: true });
      throw new Error(`font pack download answered HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("font pack download returned no data");
    const file = await open(partial, resume ? "a" : "w");
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        await file.write(value);
      }
    } finally {
      await file.close();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Download to `partial`, resuming what an earlier attempt or app run saved. */
async function download(url: string, partial: string, size: number, deps: FirefoxFontPackDeps): Promise<void> {
  const attempts = deps.attempts ?? 5;
  let lastError: unknown = new Error("font pack download did not run");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let have = existsSync(partial) ? statSync(partial).size : 0;
    if (have > size) {
      rmSync(partial, { force: true });
      have = 0;
    }
    if (have === size) return;
    try {
      await receive(url, partial, have, deps);
      const received = statSync(partial).size;
      if (received === size) return;
      if (received > size) rmSync(partial, { force: true });
      throw new Error("font pack download ended early");
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await (deps.sleep ?? Bun.sleep)(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function extractZip(archive: string, directory: string): Promise<void> {
  const command = process.platform === "darwin" ? ["ditto", "-x", "-k", archive, directory]
    : process.platform === "win32" ? [windowsSystemTool("tar.exe"), "-xf", archive, "-C", directory]
      : ["unzip", "-q", archive, "-d", directory];
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

async function install(root: string, pack: FirefoxFontPack, deps: FirefoxFontPackDeps): Promise<string> {
  const target = packRoot(root, pack);
  if (firefoxFontPackInstalled(root, pack)) return join(target, "fonts");
  const packs = join(root, PACKS_DIR);
  mkdirSync(packs, { recursive: true });
  // The same name across attempts and app runs, so a broken download resumes.
  const partial = join(packs, `.${basename(target)}.part`);
  await trackRuntimeDownload("firefox", partial, pack.size, () => download(firefoxFontPackUrl(pack), partial, pack.size, deps));
  if (await sha256File(partial) !== pack.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`${pack.asset} did not match its pinned SHA-256`);
  }
  const temp = join(packs, `.tmp-${basename(target)}-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(temp, "fonts"), { recursive: true });
    await (deps.extract ?? extractZip)(partial, join(temp, "fonts"));
    const files = readdirSync(join(temp, "fonts")).length;
    if (files !== pack.files) throw new Error(`${pack.asset} unpacked ${files} files instead of ${pack.files}`);
    writeFileSync(join(temp, STAMP), pack.sha256);
    // A folder left by an interrupted earlier install has no valid stamp.
    rmSync(target, { recursive: true, force: true });
    await renameWhenUnlocked(temp, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  rmSync(partial, { force: true });
  return join(target, "fonts");
}

const installing = new Map<string, Promise<string>>();

/** Install a pinned font pack once at a time and return the folder of its fonts. */
export function ensureFirefoxFontPack(root: string, pack: FirefoxFontPack, deps: FirefoxFontPackDeps = {}): Promise<string> {
  if (firefoxFontPackInstalled(root, pack)) return Promise.resolve(firefoxFontPackFontsDir(root, pack));
  const key = `${root}\0${pack.sha256}`;
  let pending = installing.get(key);
  if (!pending) {
    pending = install(root, pack, deps).finally(() => installing.delete(key));
    installing.set(key, pending);
  }
  return pending;
}

/**
 * Remove packs that are no longer pinned and folders of interrupted installs. A pack
 * a running browser still holds open stays until a later start.
 */
export function pruneFirefoxFontPacks(root: string, pins: readonly FirefoxFontPack[] = Object.values(FIREFOX_FONT_PACKS)): void {
  const packs = join(root, PACKS_DIR);
  let entries: string[];
  try { entries = readdirSync(packs); } catch { return; }
  const keep = new Set(pins.flatMap((pack) => {
    const name = basename(packRoot(root, pack));
    return [name, `.${name}.part`];
  }));
  // An install running now owns its temporary folder.
  const running = pins
    .filter((pack) => installing.has(`${root}\0${pack.sha256}`))
    .map((pack) => `.tmp-${basename(packRoot(root, pack))}-`);
  for (const entry of entries) {
    if (keep.has(entry) || running.some((prefix) => entry.startsWith(prefix))) continue;
    try { rmSync(join(packs, entry), { recursive: true, force: true }); } catch {}
  }
}

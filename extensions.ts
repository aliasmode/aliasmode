/**
 * Per-profile browser extensions. An uploaded .zip/.crx is extracted under the
 * extensions data root; at launch the assigned extensions are passed to
 * CloakBrowser via --load-extension (unpacked). The SQLite `extensions` table
 * (see store.ts) is the registry; the files live on disk here.
 */

import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extractZipTo, parseArchive, zipEntries } from "./unzip.ts";

export const DEFAULT_EXTENSIONS_ROOT = "extensions";

const EXTENSION_ID = /^[a-p]{32}$/;
const WEB_STORE_DOWNLOAD_URL = "https://clients2.google.com/service/update2/crx";
const WEB_STORE_PRODUCT_VERSION = "9999.0.0.0";

export type ExtensionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Extract an extension ID from a bare ID or an official Chrome Web Store detail URL. */
export function parseWebStoreExtensionId(source: string): string {
  const value = source.trim();
  if (EXTENSION_ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error();
    const parts = url.pathname.split("/").filter(Boolean);
    const current = url.hostname === "chromewebstore.google.com"
      && parts[0] === "detail"
      && (parts.length === 2 || parts.length === 3);
    const legacy = url.hostname === "chrome.google.com"
      && parts[0] === "webstore"
      && parts[1] === "detail"
      && (parts.length === 3 || parts.length === 4);
    const id = parts.at(-1) ?? "";
    if ((current || legacy) && EXTENSION_ID.test(id)) return id;
  } catch {}
  throw new Error("enter a Chrome Web Store extension URL or 32-character ID");
}

function webStoreDownloadUrl(id: string): string {
  const url = new URL(WEB_STORE_DOWNLOAD_URL);
  url.searchParams.set("response", "redirect");
  url.searchParams.set("prodversion", WEB_STORE_PRODUCT_VERSION);
  url.searchParams.set("acceptformat", "crx2,crx3");
  url.searchParams.set("x", `id=${id}&uc`);
  return url.toString();
}

/**
 * The directory to hand to --load-extension: the one containing manifest.json.
 * Zips are sometimes flat (manifest at root) and sometimes wrap a single folder
 * (manifest one level down) — handle both. Returns null if no manifest is found.
 */
export function findManifestDir(root: string): string | null {
  if (existsSync(join(root, "manifest.json"))) return root;
  let only: string | null = null;
  for (const entry of readdirSync(root)) {
    const sub = join(root, entry);
    try {
      if (statSync(sub).isDirectory() && existsSync(join(sub, "manifest.json"))) {
        if (only) return null; // ambiguous: more than one candidate
        only = sub;
      }
    } catch {}
  }
  return only;
}

/** Read the extension's display name from its manifest, falling back to `fallback`. */
export function readManifestName(dir: string, fallback: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
    if (name && !name.startsWith("__MSG_")) return name;
    const messageKey = /^__MSG_(.+)__$/.exec(name)?.[1];
    const locale = typeof manifest.default_locale === "string" ? manifest.default_locale.trim() : "";
    if (messageKey && /^[a-zA-Z0-9_-]+$/.test(locale)) {
      const messages = JSON.parse(readFileSync(join(dir, "_locales", locale, "messages.json"), "utf8"));
      const localized = typeof messages?.[messageKey]?.message === "string"
        ? messages[messageKey].message.trim()
        : "";
      if (localized) return localized;
    }
  } catch {}
  return fallback;
}

export interface InstalledExtension {
  /** Directory passed to --load-extension (contains manifest.json). */
  loadDir: string;
  name: string;
  extensionId?: string;
}

/**
 * Install an uploaded extension archive into `<root>/<id>/` and return where to
 * load it from plus its manifest name. Throws if the archive has no manifest.
 */
export async function installExtension(
  bytes: Uint8Array,
  id: string,
  fallbackName: string,
  root = DEFAULT_EXTENSIONS_ROOT,
): Promise<InstalledExtension> {
  const dest = resolve(root, id); // absolute, so --load-extension works from any cwd
  const archive = parseArchive(bytes);
  rmSync(dest, { recursive: true, force: true }); // clean any partial prior attempt
  try {
    await extractZipTo(archive.zip, dest);
    const loadDir = findManifestDir(dest);
    if (!loadDir) throw new Error("no manifest.json found in the uploaded extension");
    if (archive.manifestKey) {
      const manifestPath = join(loadDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.key = archive.manifestKey;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    }
    return {
      loadDir,
      name: readManifestName(loadDir, fallbackName),
      ...(archive.extensionId ? { extensionId: archive.extensionId } : {}),
    };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

/** Download and install a public Chrome Web Store extension as unpacked files. */
export async function installWebStoreExtension(
  source: string,
  root = DEFAULT_EXTENSIONS_ROOT,
  fetcher: ExtensionFetch = fetch,
): Promise<InstalledExtension & { id: string }> {
  const id = parseWebStoreExtensionId(source);
  const response = await fetcher(webStoreDownloadUrl(id), { redirect: "follow" });
  if (!response.ok) throw new Error(`Chrome Web Store download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const archive = parseArchive(bytes);
  if (!archive.extensionId) throw new Error("Chrome Web Store returned an unsigned extension archive");
  if (archive.extensionId !== id) throw new Error("downloaded extension identity does not match the requested Chrome Web Store ID");
  const installed = await installExtension(bytes, id, id, root);
  return { id, ...installed };
}

// Firefox add-on IDs are `name@domain` or `{uuid}`. Chrome IDs never contain `@` or braces,
// so an assignment's engine follows from the ID alone, also on devices without the add-on.
const FIREFOX_ADDON_ID = /^(?:[a-z0-9._+-]*@[a-z0-9._-]+|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i;
const AMO_API = "https://addons.mozilla.org/api/v5/addons/addon/";

export function isFirefoxAddonId(id: string): boolean {
  return FIREFOX_ADDON_ID.test(id);
}

/** Extract the add-on slug from an addons.mozilla.org detail URL. */
export function parseAmoSlug(source: string): string {
  try {
    const url = new URL(source.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const at = parts.indexOf("addon");
    const slug = at >= 0 ? parts[at + 1] ?? "" : "";
    if (url.protocol === "https:" && url.hostname === "addons.mozilla.org" && parts.includes("firefox") && /^[\w.@{}%-]+$/.test(slug)) {
      return decodeURIComponent(slug);
    }
  } catch {}
  throw new Error("enter an addons.mozilla.org add-on URL");
}

export function isAmoSource(source: string): boolean {
  try { return new URL(source.trim()).hostname === "addons.mozilla.org"; } catch { return false; }
}

/**
 * Store a signed Firefox add-on as `<root>/<id>/<id>.xpi`; the launcher copies it into each
 * assigned profile's extensions folder. `knownId` comes from addons.mozilla.org, whose signed
 * files may carry the ID only in their signature. Uploads must name their ID in manifest.json.
 */
export async function installFirefoxAddon(
  bytes: Uint8Array,
  fallbackName: string,
  root = DEFAULT_EXTENSIONS_ROOT,
  knownId?: string,
): Promise<InstalledExtension & { id: string }> {
  let manifest: any = null;
  let signed = false;
  for await (const entry of zipEntries(bytes)) {
    if (entry.name === "manifest.json") manifest = JSON.parse(new TextDecoder().decode(await entry.bytes()));
    if (/^META-INF\/mozilla\.rsa$/i.test(entry.name)) signed = true;
  }
  if (!manifest) throw new Error("no manifest.json found in the add-on");
  if (!signed) throw new Error("this add-on is not signed by Mozilla; install it from its addons.mozilla.org link");
  const gecko = manifest.browser_specific_settings?.gecko ?? manifest.applications?.gecko;
  const id = knownId ?? (typeof gecko?.id === "string" ? gecko.id : "");
  if (!id) throw new Error("this add-on file has no ID; install it from its addons.mozilla.org link");
  if (!isFirefoxAddonId(id)) throw new Error("this add-on has an invalid ID");
  const dir = resolve(root, id);
  const loadDir = join(dir, `${id}.xpi`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(loadDir, bytes);
  const name = typeof manifest.name === "string" && manifest.name.trim() && !manifest.name.startsWith("__MSG_")
    ? manifest.name.trim()
    : fallbackName;
  return { id, loadDir, name };
}

/** Download and store the current signed version of an addons.mozilla.org add-on. */
export async function installAmoAddon(
  source: string,
  root = DEFAULT_EXTENSIONS_ROOT,
  fetcher: ExtensionFetch = fetch,
): Promise<InstalledExtension & { id: string }> {
  const slug = parseAmoSlug(source);
  const response = await fetcher(`${AMO_API}${encodeURIComponent(slug)}/`);
  if (!response.ok) throw new Error(`addons.mozilla.org lookup failed (${response.status})`);
  const addon = await response.json() as any;
  const file = addon?.current_version?.file;
  if (addon?.type !== "extension" || typeof addon.guid !== "string" || typeof file?.url !== "string") {
    throw new Error("addons.mozilla.org has no installable extension at this link");
  }
  const download = await fetcher(file.url, { redirect: "follow" });
  if (!download.ok) throw new Error(`addons.mozilla.org download failed (${download.status})`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const expected = typeof file.hash === "string" && file.hash.startsWith("sha256:") ? file.hash.slice(7) : "";
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error("the downloaded add-on does not match addons.mozilla.org");
  }
  const names = addon.name && typeof addon.name === "object" ? addon.name : {};
  const name = names["en-US"] ?? names[addon.default_locale] ?? Object.values(names)[0] ?? slug;
  return installFirefoxAddon(bytes, String(name), root, addon.guid);
}

/** Remove an installed extension's files. `id` must be the install id (a path segment). */
export function removeExtensionFiles(id: string, root = DEFAULT_EXTENSIONS_ROOT): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return; // never escape root
  rmSync(resolve(root, id), { recursive: true, force: true });
}

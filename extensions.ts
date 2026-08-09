/**
 * Per-profile browser extensions. An uploaded .zip/.crx is extracted under the
 * extensions data root; at launch the assigned extensions are passed to
 * CloakBrowser via --load-extension (unpacked). The SQLite `extensions` table
 * (see store.ts) is the registry; the files live on disk here.
 */

import { join, resolve } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { extractZipTo } from "./unzip.ts";

export const DEFAULT_EXTENSIONS_ROOT = "extensions";

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
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const name = typeof m.name === "string" ? m.name.trim() : "";
    // __MSG_*__ names are i18n placeholders resolved from _locales — not worth
    // decoding here; fall back to the uploaded filename instead.
    if (name && !name.startsWith("__MSG_")) return name;
  } catch {}
  return fallback;
}

export interface InstalledExtension {
  /** Directory passed to --load-extension (contains manifest.json). */
  loadDir: string;
  name: string;
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
  rmSync(dest, { recursive: true, force: true }); // clean any partial prior attempt
  await extractZipTo(bytes, dest);
  const loadDir = findManifestDir(dest);
  if (!loadDir) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error("no manifest.json found in the uploaded extension");
  }
  return { loadDir, name: readManifestName(loadDir, fallbackName) };
}

/** Remove an installed extension's files. `id` must be the install id (a path segment). */
export function removeExtensionFiles(id: string, root = DEFAULT_EXTENSIONS_ROOT): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return; // never escape root
  rmSync(resolve(root, id), { recursive: true, force: true });
}

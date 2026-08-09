/**
 * Drop-in import: put AdsPower export `.txt` files in `inbox/`
 * and they get imported into the profile store — no flags, no file paths.
 *
 * Re-importing is presence-aware: fields absent from a refreshed export keep
 * their stored values, manager-owned identity state is never imported, and a
 * malformed batch is rejected before any row changes.
 */

import { readdirSync, existsSync, mkdirSync, watch, statSync } from "node:fs";
import { join } from "node:path";
import { parseExport, decodeText, type ParsedProfileImport } from "./parse.ts";
import { attachTimezones } from "./geoip.ts";
import type { Profile } from "./types.ts";
import type { ProfileStore } from "./store.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * True once every `.txt` in `dir` has held the same size across `gapMs`.
 * The watcher uses this to avoid importing a file that's still being copied —
 * presence-aware merging protects existing rows, while stability also avoids
 * creating a brand-new profile from an incomplete record. Exports legitimately
 * vary in which columns they include, so completeness cannot be inferred from
 * a fixed required-column list.
 */
async function inboxStable(dir: string, gapMs = 500): Promise<boolean> {
  const sizes = () =>
    readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".txt"))
      .map((f) => {
        try {
          return `${f}:${statSync(join(dir, f)).size}`;
        } catch {
          return `${f}:?`;
        }
      })
      .join("|");
  const before = sizes();
  await sleep(gapMs);
  return before === sizes();
}

export const DEFAULT_INBOX = "inbox";

export interface InboxResult {
  files: number;
  profiles: number;
  cookiesStripped: number;
  skipped: number;
  errors: Array<{ file: string; id: string; error: string; quarantined?: boolean }>;
}

export interface ImportOverrides {
  /** When set, import every uploaded profile into this group. */
  group?: string;
  /** When set, import every uploaded profile as this platform. */
  platform?: string;
}

function applyOverrides(entry: ParsedProfileImport, overrides: ImportOverrides): ParsedProfileImport {
  let profile = entry.profile;
  const present = new Set(entry.presentFields);
  if (overrides.group !== undefined) {
    profile = { ...profile, group: overrides.group.trim() };
    present.add("group");
  }
  if (overrides.platform !== undefined) {
    profile = { ...profile, platform: overrides.platform.trim() };
    present.add("platform");
  }
  return { ...entry, profile, presentFields: [...present] };
}

interface SourcedImport extends ParsedProfileImport {
  source: string;
}

function unsafeImportError(problems: string[]): Error {
  return new Error(`unsafe import rejected; no profiles were changed: ${problems.join("; ")}`);
}

/** Merge only fields actually present in an AdsPower re-export. */
function mergeExisting(existing: Profile, incoming: SourcedImport): Profile {
  const p = incoming.profile;
  const present = new Set(incoming.presentFields);
  const out: Profile = { ...existing };

  if (present.has("acc_id")) out.accId = p.accId;
  if (present.has("name")) out.name = p.name;
  if (present.has("group")) out.group = p.group;
  if (present.has("platform")) out.platform = p.platform ?? "";
  if (present.has("username")) out.username = p.username;
  if (present.has("password")) out.password = p.password;
  if (present.has("email")) out.email = p.email ?? "";
  if (present.has("emailpassword") || present.has("email_password")) out.emailPassword = p.emailPassword ?? "";
  if (present.has("fakey")) out.twofa = p.twofa;
  if (present.has("ua")) out.ua = p.ua;
  if (present.has("resolution")) {
    out.screenWidth = p.screenWidth;
    out.screenHeight = p.screenHeight;
  }
  if (present.has("cookie")) out.cookies = p.cookies;
  if (present.has("proxy")) {
    const proxyHasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(incoming.sourceFields.proxy?.trim() ?? "");
    out.proxy = p.proxy && !incoming.sourceFields.proxytype?.trim() && !proxyHasScheme && existing.proxy
      ? { ...p.proxy, type: existing.proxy.type }
      : p.proxy;
    delete out.proxyError;
    // A resolved timezone was attached to the supplied proxy. If resolution
    // failed, store persistence keeps it only when the canonical proxy is equal.
    out.timezone = p.timezone;
  }
  return out;
}

/**
 * Import AdsPower exports from in-memory buffers — the shared core used by both
 * the inbox folder and UI uploads. Decodes each (UTF-8/UTF-16), parses, resolves
 * proxy timezones via geoip (one batched call), and upserts.
 */
export async function importBuffers(
  store: ProfileStore,
  files: { name: string; bytes: Uint8Array }[],
  log: (msg: string) => void = console.log,
  overrides: ImportOverrides = {},
  /** Optional hub-side lock/CAS guard, called synchronously immediately before the atomic write. */
  beforeCommit?: (profiles: readonly Profile[]) => void,
): Promise<InboxResult> {
  let cookiesStripped = 0;
  let skipped = 0;
  const errors: InboxResult["errors"] = [];
  const collected: SourcedImport[] = [];
  for (const { name, bytes } of files) {
    const summary = parseExport(decodeText(bytes));
    if (summary.profiles.length === 0) {
      log(`import: ${name} parsed to 0 profiles — check it's a complete AdsPower "Export accounts" file`);
    }
    collected.push(...summary.imports.map((entry) => ({ ...applyOverrides(entry, overrides), source: name })));
    cookiesStripped += summary.cookiesStripped;
    skipped += summary.skipped;
    for (const error of summary.errors) {
      errors.push({ file: name, ...error });
    }
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of collected) {
    if (seen.has(entry.profile.id)) problems.push(`${entry.source}: duplicate profile id ${entry.profile.id}`);
    seen.add(entry.profile.id);
    for (const issue of entry.validationErrors) problems.push(`${entry.source}: profile ${entry.profile.id}: ${issue}`);
  }
  if (problems.length) throw unsafeImportError(problems);

  // Resolve only proxies explicitly supplied by the upload. A sparse re-import
  // must not refresh or mutate the stored proxy persona as a side effect.
  const toResolve = collected
    .filter((entry) => entry.presentFields.includes("proxy") && entry.profile.proxy)
    .map((entry) => entry.profile);
  const { resolved } = await attachTimezones(toResolve);

  // Merge after the asynchronous lookup so the database snapshot cannot go
  // stale while awaiting the network. No await occurs between here and commit.
  const prepared: Profile[] = [];
  for (const entry of collected) {
    const existing = store.getProfile(entry.profile.id);
    if (!existing) {
      prepared.push(entry.profile);
      continue;
    }
    const present = new Set(entry.presentFields);
    if (present.has("proxy") && !entry.profile.proxy && (existing.proxy || existing.proxyError)) {
      problems.push(`${entry.source}: profile ${entry.profile.id}: blank proxy would erase the stored proxy; use profile edit to remove it explicitly`);
    }
    if (present.has("ua") && !entry.profile.ua.trim() && existing.ua.trim()) {
      problems.push(`${entry.source}: profile ${entry.profile.id}: blank ua would erase the stored browser identity`);
    }
    if (
      present.has("resolution")
      && !entry.sourceFields.resolution?.trim()
      && (existing.screenWidth !== entry.profile.screenWidth || existing.screenHeight !== entry.profile.screenHeight)
    ) {
      problems.push(`${entry.source}: profile ${entry.profile.id}: blank resolution would erase the stored screen identity`);
    }
    if (present.has("cookie") && !entry.sourceFields.cookie?.trim() && existing.cookies.length) {
      problems.push(`${entry.source}: profile ${entry.profile.id}: blank cookie field would erase stored cookies; use [] to clear them explicitly`);
    }
    if (present.has("cookie") && entry.cookiesStripped > 0 && entry.profile.cookies.length === 0 && existing.cookies.length) {
      problems.push(`${entry.source}: profile ${entry.profile.id}: cookie field contained only stripped extension cookies; use [] to clear stored cookies explicitly`);
    }
    prepared.push(mergeExisting(existing, entry));
  }
  if (problems.length) throw unsafeImportError(problems);

  if (toResolve.length) log(`import: resolved timezone for ${resolved}/${toResolve.length} supplied proxy/proxies`);
  const liveIds = prepared.map((profile) => profile.id).filter((id) => !!store.getLaunch(id));
  if (liveIds.length > 0) {
    throw unsafeImportError([
      `profile(s) ${[...new Set(liveIds)].join(", ")} are currently open; close them before importing identity changes`,
    ]);
  }
  // Keep these checks adjacent to the single batch write: the hub guard closes
  // the claim-vs-import race after all parsing/timezone I/O has completed.
  beforeCommit?.(prepared);
  store.upsertProfiles(prepared);
  return { files: files.length, profiles: collected.length, cookiesStripped, skipped, errors };
}

/** Import every `*.txt` in `dir` into the store. Creates `dir` if missing. */
export async function importInbox(
  store: ProfileStore,
  dir = DEFAULT_INBOX,
  log: (msg: string) => void = console.log,
): Promise<InboxResult> {
  mkdirSync(dir, { recursive: true });
  const txts = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
  const files = await Promise.all(
    txts.map(async (f) => ({ name: f, bytes: new Uint8Array(await Bun.file(join(dir, f)).arrayBuffer()) })),
  );
  return importBuffers(store, files, log);
}

/**
 * Watch the inbox and re-import whenever a file appears or changes. Debounced
 * so a burst of editor/copy events collapses into one import. Returns a stop
 * function that waits for any active import. Best-effort: watch failures are
 * logged, not thrown.
 */
export function watchInbox(
  store: ProfileStore,
  dir = DEFAULT_INBOX,
  log: (msg: string) => void = console.log,
): () => Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let stopped = false;
  let inFlight = Promise.resolve();

  // Signature of the inbox's .txt files (name+size). Used to skip re-importing
  // — and re-running the geoip batch — when a watch event didn't actually change
  // any export (e.g. a null-filename directory event on Linux inotify).
  const inboxSig = () =>
    readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".txt"))
      .map((f) => {
        try {
          const st = statSync(join(dir, f));
          // Size alone misses a same-length content edit (different cookies/proxy
          // at the same byte count) — include mtime so the edit still re-imports.
          return `${f}:${st.size}:${st.mtimeMs}`;
        } catch {
          return `${f}:?`;
        }
      })
      .sort()
      .join("|");
  let lastSig = "";

  const runImport = async () => {
    if (stopped) return;
    // Don't import a file that's still being copied in. If it isn't settled yet,
    // reschedule instead of dropping — a completed export must never sit
    // unimported because the copy happened to finish between two size samples.
    if (!(await inboxStable(dir).catch(() => true))) {
      if (!stopped) {
        log(`inbox: a file is still being written — will retry shortly`);
        timer = setTimeout(tryImport, 1000);
      }
      return;
    }
    if (stopped) return;
    // No-op events shouldn't re-run the import (and burn ip-api's budget).
    const current = inboxSig();
    if (current === lastSig) return;
    const r = await importInbox(store, dir).catch((err) => {
      log(`inbox import failed: ${err}`);
      return null;
    });
    if (r) {
      lastSig = current;
      log(`inbox: imported ${r.profiles} profile(s) from ${r.files} file(s)`);
    }
  };

  const tryImport = () => {
    inFlight = inFlight.then(runImport, runImport);
    return inFlight;
  };

  try {
    watcher = watch(dir, (_event, filename) => {
      if (stopped) return;
      // When the OS gives a filename (always on Windows) filter to .txt up
      // front. A null filename (some Linux/dir events) falls through to
      // tryImport, whose signature check no-ops when nothing actually changed.
      if (filename && !filename.toLowerCase().endsWith(".txt")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tryImport, 500);
    });
    log(`watching ${dir} — drop AdsPower export .txt files here to import`);
  } catch (err) {
    log(`inbox watch unavailable (${err}); use \`import\` manually instead`);
  }
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    await inFlight;
  };
}

import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readHostProcessSnapshot, readSnapshotChildBounded, type HostProcessSnapshot } from "./launcher.ts";
import { isSafeProfileId } from "./profile-id.ts";
import { statePaths, type StatePaths } from "./paths.ts";

export interface LegacyMigrationResult {
  status: "not_found" | "migrated";
  profileCount: number;
}

export interface MigrationOptions {
  profileRoot?: string;
  userProfile?: string;
  scanProcesses?: () => Promise<HostProcessSnapshot | null>;
  rename?: (from: string, to: string) => void;
  validateDpapi?: (localStatePaths: string[]) => Promise<void>;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query<{ found: number }, [string]>(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
}

function tableCount(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`).get()!.count;
}

function userTables(db: Database): string[] {
  return db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
}

function databaseHasRows(path: string, label = "AliasMode destination database"): boolean {
  if (!existsSync(path) || statSync(path).size === 0) return false;
  const db = new Database(path, { readonly: true });
  try {
    return userTables(db).some((table) => tableCount(db, table) > 0);
  } catch {
    throw new Error(`${label} is unreadable: ${basename(path)}`);
  } finally {
    db.close();
  }
}

function hasContent(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size > 0;
  return readdirSync(path).some((name) => hasContent(join(path, name)));
}

function validateDestination(destination: StatePaths): void {
  if (!existsSync(destination.root)) return;
  if (existsSync(destination.config)) {
    let config: { mode?: unknown };
    try {
      config = JSON.parse(readFileSync(destination.config, "utf8"));
    } catch {
      throw new Error("AliasMode destination config is unreadable");
    }
    if (config.mode === "cloud") throw new Error("AliasMode Cloud destinations cannot import Cloakpit data");
  }
  if (databaseHasRows(destination.database) || hasContent(destination.profiles) || hasContent(destination.extensions)) {
    throw new Error("AliasMode destination already contains local profile data");
  }
  if (databaseHasRows(destination.pendingSync, "AliasMode pending synchronization database")) {
    throw new Error("AliasMode destination contains pending Cloud synchronization state");
  }
  const cloudRoot = join(destination.root, "cloud-cache");
  if (databaseHasRows(destination.cloudDatabase, "AliasMode Cloud cache database") || hasContent(destination.cloudProfiles)) {
    throw new Error("AliasMode destination contains Cloud cache state");
  }
  if (existsSync(cloudRoot)) {
    const allowed = new Set(["profiles", "profiles.sqlite", "profiles.sqlite-wal", "profiles.sqlite-shm"]);
    if (readdirSync(cloudRoot).some((name) => !allowed.has(name) && hasContent(join(cloudRoot, name)))) {
      throw new Error("AliasMode destination contains Cloud cache state");
    }
  }
  if (hasContent(destination.browser)) {
    throw new Error("AliasMode destination contains browser state");
  }
  const allowed = new Set([
    "profiles.sqlite", "profiles.sqlite-wal", "profiles.sqlite-shm", "profiles", "extensions",
    "pending-sync.sqlite", "pending-sync.sqlite-wal", "pending-sync.sqlite-shm", "pending-sync.key", "cloud-cache",
    "browser", "config.json", ".operator-id", "logs", "inbox", "reports",
  ]);
  const allowedName = (name: string) => allowed.has(name)
    || (name.startsWith("pending-sync.key.") && name.endsWith(".tmp"));
  if (readdirSync(destination.root).some((name) => !allowedName(name) && hasContent(join(destination.root, name)))) {
    throw new Error("AliasMode destination contains unsupported existing state");
  }
}

function rejectRemoteState(path: string): void {
  if (!existsSync(path)) return;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    if (userTables(db).some((table) => tableCount(db!, table) > 0)) {
      throw new Error("Cloakpit remote sessions in hub.sqlite are unsupported and cannot be imported");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("remote sessions")) throw error;
    throw new Error("Cloakpit hub.sqlite could not be verified; remote state cannot be imported safely");
  } finally {
    db?.close();
  }
}

function nonemptyProfileIds(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const ids: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory() && hasContent(path)) ids.push(name);
    else if (hasContent(path)) throw new Error(`Unknown browser data entry ${path} is not a profile directory`);
  }
  return ids;
}

function candidateRoots(source: string, options: MigrationOptions): string[] {
  const candidates = [
    ...(options.profileRoot ? [resolve(options.profileRoot)] : []),
    join(source, "profiles"),
    join(source, "cloakbrowser", "profiles"),
  ];
  const userProfile = options.userProfile ?? process.env.USERPROFILE;
  const browserRoot = userProfile ? join(userProfile, ".cloakbrowser") : "";
  if (browserRoot && existsSync(browserRoot)) {
    for (const name of readdirSync(browserRoot).sort()) {
      if (name.startsWith("chromium-")) candidates.push(join(browserRoot, name, "profiles"));
    }
  }
  return [...new Set(candidates.map((path) => resolve(path)))];
}

function chooseProfileDirectories(
  source: string,
  profileIds: Set<string>,
  options: MigrationOptions,
): { selected: Map<string, string>; roots: string[] } {
  const roots = candidateRoots(source, options).filter((root) => nonemptyProfileIds(root).length > 0);
  const byId = new Map<string, string[]>();
  for (const root of roots) {
    for (const id of nonemptyProfileIds(root)) {
      if (!profileIds.has(id)) {
        throw new Error(`Browser data directory ${join(root, id)} is not represented in profiles.sqlite`);
      }
      byId.set(id, [...(byId.get(id) ?? []), root]);
    }
  }
  const explicit = options.profileRoot ? resolve(options.profileRoot) : null;
  const selected = new Map<string, string>();
  for (const [id, matches] of byId) {
    if (matches.length === 1) selected.set(id, join(matches[0]!, id));
    else if (explicit && matches.includes(explicit)) selected.set(id, join(explicit, id));
    else throw new Error(`Profile ${id} has nonempty state in multiple browser profile roots; pass --cloakpit-profile-root`);
  }
  return { selected, roots };
}

function normalizeWindowsPath(value: string): string {
  return resolve(value).replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
}

function processUsesLegacyState(snapshot: HostProcessSnapshot, source: string, roots: string[]): boolean {
  const sourcePath = normalizeWindowsPath(source);
  const profileRoots = roots.map(normalizeWindowsPath);
  return snapshot.records.some((record) => {
    if (record.pid === process.pid) return false;
    const executable = (record.executablePath ?? "").replaceAll("/", "\\").toLowerCase();
    const processName = (record.processName ?? executable.split("\\").at(-1) ?? "").toLowerCase();
    const command = [record.commandLine ?? "", ...(record.argv ?? [])]
      .join(" ").replaceAll("/", "\\").toLowerCase();
    const uses = (flag: string, root: string) => command.includes(`${flag}=${root}`)
      || command.includes(`${flag}=\"${root}`) || command.includes(`${flag} ${root}`)
      || command.includes(`${flag} \"${root}`);
    const relativeBunManager = /^bun(?:\.exe)?$/.test(processName)
      && /(?:^|[\s"])(?:\.\\)?cli\.ts"?\s+(?:start|serve)(?:\s|$)/.test(command);
    return executable.startsWith(`${sourcePath}\\`)
      || /^(?:cloakpit|cloakbrowser|cloak-browser)(?:\.exe)?$/.test(processName)
      || relativeBunManager
      || command.includes(`${sourcePath}\\cli.ts`)
      || [sourcePath, ...profileRoots].some((root) => uses("--state-root", root))
      || profileRoots.some((root) => uses("--user-data-dir", root));
  });
}

async function assertStopped(source: string, roots: string[], scan: () => Promise<HostProcessSnapshot | null>): Promise<void> {
  const snapshot = await scan();
  if (!snapshot || snapshot.incomplete) {
    throw new Error("Cloakpit process scan was inconclusive; close Cloakpit and retry");
  }
  if (processUsesLegacyState(snapshot, source, roots)) {
    throw new Error("Cloakpit or a browser using the legacy profile state is still running; close it and retry");
  }
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex")}`;
  return `${typeof value}:${String(value)}`;
}

function databaseContents(db: Database): string {
  const master = db.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  ).all();
  const rows = userTables(db).map((table) => {
    const escaped = table.replaceAll('"', '""');
    const values = db.query<Record<string, unknown>, []>(`SELECT * FROM "${escaped}"`).all()
      .map((row) => Object.entries(row).map(([key, value]) => `${key}=${canonical(value)}`).join("\0"))
      .sort();
    return [table, values];
  });
  return JSON.stringify([master, rows]);
}

function integrityCheck(db: Database): void {
  const result = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  if (result?.integrity_check !== "ok") throw new Error("Migration validation failed: SQLite integrity check failed");
}

function rewriteExtensionPaths(db: Database, source: string, destination: StatePaths): void {
  if (!tableExists(db, "extensions")) return;
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(extensions)").all().map((row) => row.name);
  if (!columns.includes("id") || !columns.includes("load_dir")) return;
  const sourceExtensions = resolve(source, "extensions");
  const update = db.query("UPDATE extensions SET load_dir = ? WHERE id = ?");
  for (const row of db.query<{ id: string; loadDir: string }, []>("SELECT id, load_dir AS loadDir FROM extensions").all()) {
    if (typeof row.loadDir !== "string") continue;
    const suffix = relative(sourceExtensions, resolve(row.loadDir));
    if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) {
      update.run(suffix ? join(destination.extensions, suffix) : destination.extensions, row.id);
    }
  }
}

function assertNoLinks(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Linked browser data is unsupported: ${path}`);
  if (statSync(path).isDirectory()) for (const name of readdirSync(path)) assertNoLinks(join(path, name));
}

function copySqliteSet(source: string, destination: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(`${source}${suffix}`)) cpSync(`${source}${suffix}`, `${destination}${suffix}`, { errorOnExist: true });
}

function dpapiKeys(localStates: string[]): string[] {
  return localStates.map((path) => {
    let encoded: unknown;
    try { encoded = JSON.parse(readFileSync(path, "utf8"))?.os_crypt?.encrypted_key; } catch {}
    const bytes = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    if (bytes.length <= 5 || bytes.subarray(0, 5).toString() !== "DPAPI") throw new Error(`Missing or malformed DPAPI key in ${path}`);
    return bytes.subarray(5).toString("base64");
  });
}

async function validateWindowsDpapi(localStates: string[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows DPAPI validation is unavailable");
  const keys = dpapiKeys(localStates);
  if (!keys.length) return;
  const script = "$k=ConvertFrom-Json ([Console]::In.ReadToEnd());foreach($v in $k){$b=[Convert]::FromBase64String($v);[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)|Out-Null}";
  const child = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: new Blob([JSON.stringify(keys)]), stdout: "pipe", stderr: "ignore",
  });
  const result = await readSnapshotChildBounded(child as never, 60_000);
  if (!result || result.exitCode !== 0) {
    throw new Error("Browser secrets cannot be decrypted by this Windows account; import requires the same machine and account");
  }
}

function copyPreservedDestination(destination: StatePaths, staging: StatePaths): void {
  for (const name of ["logs", "inbox", "reports"]) {
    const source = join(destination.root, name);
    if (existsSync(source)) cpSync(source, join(staging.root, name), { recursive: true, errorOnExist: true });
  }
  for (const path of [destination.config, destination.operatorId, destination.pendingSyncKey]) {
    if (existsSync(path)) cpSync(path, join(staging.root, basename(path)), { errorOnExist: true });
  }
}

/** Import a stopped same-account Cloakpit installation without modifying it. */
export async function migrateLegacyState(
  sourceRoot: string,
  destination: StatePaths,
  options: MigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const source = resolve(sourceRoot);
  const sourceDatabase = join(source, "profiles.sqlite");
  if (!existsSync(sourceDatabase)) return { status: "not_found", profileCount: 0 };
  const rename = options.rename ?? renameSync;
  const backup = `${destination.root}.pre-cloakpit-import`;
  const scan = options.scanProcesses ?? readHostProcessSnapshot;
  const initialRoots = candidateRoots(source, options);

  await assertStopped(source, initialRoots, scan);
  mkdirSync(dirname(destination.root), { recursive: true });
  if (existsSync(backup)) {
    if (existsSync(destination.root)) {
      throw new Error(`AliasMode destination and recovery backup both exist; resolve ${backup} before importing`);
    }
    rename(backup, destination.root);
  }
  if (existsSync(destination.migration)) {
    throw new Error("AliasMode destination already contains imported local profile data");
  }
  validateDestination(destination);

  const stagingRoot = mkdtempSync(join(dirname(destination.root), `.${basename(destination.root)}.migrating-`));
  const staging = statePaths(stagingRoot);
  const privateSource = join(stagingRoot, ".legacy-profiles.sqlite");
  const privateHub = join(stagingRoot, ".legacy-hub.sqlite");
  try {
    copySqliteSet(sourceDatabase, privateSource);
    const sourceHub = join(source, "hub.sqlite");
    if (existsSync(sourceHub)) {
      copySqliteSet(sourceHub, privateHub);
      rejectRemoteState(privateHub);
    }

    const sourceDb = new Database(privateSource);
    let sourceContents = "";
    let profileIds = new Set<string>();
    let seededIds: string[] = [];
    try {
      integrityCheck(sourceDb);
      if (tableExists(sourceDb, "launches") && tableCount(sourceDb, "launches") > 0) {
        throw new Error("Cloakpit has launch records; close Cloakpit and every managed browser before importing");
      }
      if (!tableExists(sourceDb, "profiles")) throw new Error("Cloakpit profiles.sqlite has no profiles table");
      const ids = sourceDb.query<{ id: unknown }, []>("SELECT id FROM profiles").all().map((row) => row.id);
      if (ids.some((id) => !isSafeProfileId(id))) {
        throw new Error("Cloakpit profiles.sqlite contains an unsafe profile ID");
      }
      profileIds = new Set(ids as string[]);
      if (profileIds.size !== ids.length) throw new Error("Cloakpit profiles.sqlite contains duplicate profile IDs");
      const columns = sourceDb.query<{ name: string }, []>("PRAGMA table_info(profiles)").all().map((row) => row.name);
      if (columns.includes("seeded")) {
        seededIds = sourceDb.query<{ id: string }, []>("SELECT id FROM profiles WHERE seeded <> 0").all().map((row) => row.id);
      }
      sourceContents = databaseContents(sourceDb);
      sourceDb.exec(`VACUUM INTO '${staging.database.replaceAll("'", "''")}'`);
    } finally {
      sourceDb.close();
    }

    const selected = chooseProfileDirectories(source, profileIds, options);
    const missingSeeded = seededIds.find((id) => !selected.selected.has(id));
    if (missingSeeded) {
      throw new Error(`Seeded profile ${missingSeeded} has no browser data; pass --cloakpit-profile-root with its historical profiles directory`);
    }
    for (const path of selected.selected.values()) assertNoLinks(path);
    const sourceExtensions = join(source, "extensions");
    if (existsSync(sourceExtensions)) assertNoLinks(sourceExtensions);
    if (existsSync(destination.root)) copyPreservedDestination(destination, staging);
    const stagedDb = new Database(staging.database);
    try {
      integrityCheck(stagedDb);
      if (databaseContents(stagedDb) !== sourceContents) {
        throw new Error("Migration validation failed: database fields changed during snapshot");
      }
      rewriteExtensionPaths(stagedDb, source, destination);
      integrityCheck(stagedDb);
      const stagedIds = new Set(stagedDb.query<{ id: string }, []>("SELECT id FROM profiles").all().map((row) => row.id));
      if (stagedIds.size !== profileIds.size || [...profileIds].some((id) => !stagedIds.has(id))) {
        throw new Error("Migration validation failed: profile IDs or count changed");
      }
    } finally {
      stagedDb.close();
    }

    for (const [id, path] of selected.selected) cpSync(path, join(staging.profiles, id), { recursive: true, errorOnExist: true });
    if (existsSync(sourceExtensions)) cpSync(sourceExtensions, staging.extensions, { recursive: true, errorOnExist: true });
    const sourceOperator = join(source, ".operator-id");
    if (existsSync(sourceOperator)) cpSync(sourceOperator, staging.operatorId, { force: true });
    const requiredLocalStates = [...selected.selected.keys()].map((id) => join(staging.profiles, id, "Local State"));
    dpapiKeys(requiredLocalStates);
    await (options.validateDpapi ?? validateWindowsDpapi)(requiredLocalStates);
    for (const path of [privateSource, privateHub]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
    }
    writeFileSync(staging.migration, `${JSON.stringify({ version: 1, completedAt: Date.now(), profileCount: profileIds.size }, null, 2)}\n`, { mode: 0o600 });

    validateDestination(destination);
    await assertStopped(source, selected.roots, scan);
    const hadDestination = existsSync(destination.root);
    if (hadDestination) rename(destination.root, backup);
    try {
      rename(stagingRoot, destination.root);
    } catch (commitError) {
      if (hadDestination) {
        try {
          rename(backup, destination.root);
        } catch (rollbackError) {
          throw new Error(`Import commit failed and rollback failed. Recovery backup retained at ${backup}. Commit: ${String(commitError)}. Rollback: ${String(rollbackError)}`);
        }
      }
      throw commitError;
    }
    if (hadDestination) rmSync(backup, { recursive: true, force: true });
    return { status: "migrated", profileCount: profileIds.size };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

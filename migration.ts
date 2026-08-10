import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ProfileStore } from "./store.ts";
import { statePaths, type StatePaths } from "./paths.ts";

export interface LegacyMigrationResult {
  status: "not_found" | "already_migrated" | "migrated";
  profileCount: number;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query<{ found: number }, [string]>(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
}

function copyDirectory(source: string, destination: string): void {
  if (!existsSync(source)) return;
  cpSync(source, destination, { recursive: true, errorOnExist: true });
}

function rewriteExtensionPaths(db: Database, sourceRoot: string, destinationRoot: string): void {
  if (!tableExists(db, "extensions")) return;
  const sourcePrefix = resolve(sourceRoot, "extensions");
  const destinationPrefix = resolve(destinationRoot, "extensions");
  const rows = db.query<{ id: string; loadDir: string }, []>(
    "SELECT id, load_dir AS loadDir FROM extensions",
  ).all();
  const prefix = sourcePrefix.endsWith(sep) ? sourcePrefix : `${sourcePrefix}${sep}`;
  const update = db.query("UPDATE extensions SET load_dir = ? WHERE id = ?");
  for (const row of rows) {
    if (row.loadDir === sourcePrefix) {
      update.run(destinationPrefix, row.id);
    } else if (row.loadDir.startsWith(prefix)) {
      update.run(join(destinationPrefix, row.loadDir.slice(prefix.length)), row.id);
    }
  }
}

function databaseProfileCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    if (!tableExists(db, "profiles")) return 0;
    return db.query<{ count: number }, []>("SELECT count(*) AS count FROM profiles").get()!.count;
  } finally {
    db.close();
  }
}

/**
 * Copy a stopped legacy installation into a fresh AliasMode state root.
 * The source is never modified. The destination appears only after the staged
 * SQLite snapshot and profile files have passed validation.
 */
export function migrateLegacyState(sourceRoot: string, destination: StatePaths): LegacyMigrationResult {
  const source = resolve(sourceRoot);
  const sourceDatabase = join(source, "profiles.sqlite");
  if (!existsSync(sourceDatabase)) return { status: "not_found", profileCount: 0 };
  if (existsSync(destination.migration)) {
    return { status: "already_migrated", profileCount: databaseProfileCount(destination.database) };
  }

  if (existsSync(destination.root)) {
    if (readdirSync(destination.root).length > 0) {
      throw new Error("AliasMode state already exists; migration requires a fresh destination");
    }
    rmdirSync(destination.root);
  }

  mkdirSync(dirname(destination.root), { recursive: true });
  const stagingRoot = mkdtempSync(join(dirname(destination.root), `.${basename(destination.root)}.migrating-`));
  const staging = statePaths(stagingRoot);

  try {
    const sourceDb = new Database(sourceDatabase, { readonly: true });
    let sourceCount = 0;
    try {
      if (tableExists(sourceDb, "launches")) {
        const active = sourceDb.query<{ count: number }, []>("SELECT count(*) AS count FROM launches").get()!.count;
        if (active > 0) {
          throw new Error("Close Cloakpit and every managed browser before migrating");
        }
      }
      sourceCount = tableExists(sourceDb, "profiles")
        ? sourceDb.query<{ count: number }, []>("SELECT count(*) AS count FROM profiles").get()!.count
        : 0;
      const escaped = staging.database.replaceAll("'", "''");
      sourceDb.exec(`VACUUM INTO '${escaped}'`);
    } finally {
      sourceDb.close();
    }

    copyDirectory(join(source, "profiles"), staging.profiles);
    copyDirectory(join(source, "extensions"), staging.extensions);
    if (existsSync(join(source, ".operator-id"))) {
      cpSync(join(source, ".operator-id"), staging.operatorId, { errorOnExist: true });
    }

    const stagedDb = new Database(staging.database);
    try {
      rewriteExtensionPaths(stagedDb, source, destination.root);
    } finally {
      stagedDb.close();
    }

    const migratedStore = new ProfileStore(staging.database);
    const migratedCount = migratedStore.count();
    migratedStore.close();
    if (migratedCount !== sourceCount) {
      throw new Error(`Migration validation failed: expected ${sourceCount} profiles, found ${migratedCount}`);
    }

    writeFileSync(
      staging.migration,
      `${JSON.stringify({ version: 1, completedAt: Date.now(), profileCount: migratedCount }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(stagingRoot, destination.root);
    return { status: "migrated", profileCount: migratedCount };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

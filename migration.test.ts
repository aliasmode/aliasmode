import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState, type MigrationOptions } from "./migration.ts";
import { statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";

function roots() {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-migration-"));
  const source = join(parent, "cloakpit");
  const destination = statePaths(join(parent, "AliasMode"));
  mkdirSync(source);
  return { parent, source, destination };
}

function sourceDb(source: string, ids = ["legacy1"]): Database {
  const db = new Database(join(source, "profiles.sqlite"));
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, acc_id TEXT, name TEXT, "group" TEXT, platform TEXT,
      username TEXT, password TEXT, email TEXT, email_password TEXT, twofa TEXT,
      proxy_json TEXT, extensions_json TEXT, ua TEXT, timezone TEXT,
      screen_width INTEGER, screen_height INTEGER, fingerprint_seed INTEGER,
      cookies_json TEXT, seeded INTEGER, future_value BLOB
    );
    CREATE TABLE launches (profile_id TEXT PRIMARY KEY, pid INTEGER);
    CREATE TABLE groups (name TEXT PRIMARY KEY, future_group_value TEXT);
    CREATE TABLE extensions (id TEXT PRIMARY KEY, name TEXT, load_dir TEXT, future_extension_value TEXT);
  `);
  const insert = db.query(`INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const id of ids) {
    insert.run(id, "account", "Legacy", "Imported", "x.com", "user", "pass", "mail@example.com",
      "mail-pass", "seed", '{"type":"socks5","host":"proxy","port":1080}', '["ext1"]', "exact-ua",
      "Europe/Riga", 1440, 900, 424242, '[{"name":"auth_token","value":"cookie"}]', 1,
      Buffer.from([0, 255, 17]));
  }
  db.query("INSERT INTO groups VALUES (?,?)").run("Imported", "unknown-group-value");
  const extensionDir = join(source, "extensions", "ext1");
  db.query("INSERT INTO extensions VALUES (?,?,?,?)").run("ext1", "Extension", extensionDir, "unknown-extension-value");
  return db;
}

function addBrowserState(root: string, id: string) {
  mkdirSync(join(root, id, "Default", "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(join(root, id, "Default", "IndexedDB", "site.indexeddb.leveldb"), { recursive: true });
  const encryptedKey = Buffer.concat([Buffer.from("DPAPI"), Buffer.from([0, 1, 2, 255])]).toString("base64");
  writeFileSync(join(root, id, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }));
  writeFileSync(join(root, id, "Default", "Cookies"), Buffer.from([9, 8, 7, 0]));
  writeFileSync(join(root, id, "Default", "Local Storage", "leveldb", "000003.log"), Buffer.from([4, 3, 2, 1]));
  writeFileSync(join(root, id, "Default", "IndexedDB", "site.indexeddb.leveldb", "000004.ldb"), Buffer.from([6, 5, 4]));
}

function treeHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string, relative: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const rel = join(relative, name);
      const stat = statSync(child);
      hash.update(`${stat.isDirectory() ? "d" : "f"}:${rel}\0`);
      if (stat.isDirectory()) visit(child, rel);
      else hash.update(readFileSync(child));
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

async function leaveHotJournal(path: string, statement: string): Promise<void> {
  const script = `import { Database } from "bun:sqlite"; const db=new Database(${JSON.stringify(path)}); db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;"+${JSON.stringify(statement)}); process.stdout.write("ready"); await new Promise(()=>{});`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  await reader.read();
  child.kill(9);
  await child.exited;
  expect(existsSync(`${path}-journal`)).toBe(true);
}

const stopped: Pick<MigrationOptions, "scanProcesses" | "validateDpapi"> = {
  scanProcesses: async () => ({ records: [], incomplete: false }),
  validateDpapi: async () => {},
};

test("migration preserves all database values and session-bearing Chromium bytes", async () => {
  const { source, destination } = roots();
  const db = sourceDb(source);
  db.close();
  addBrowserState(join(source, "profiles"), "legacy1");
  mkdirSync(join(source, "extensions", "ext1"), { recursive: true });
  writeFileSync(join(source, "extensions", "ext1", "manifest.json"), Buffer.from([123, 125, 10]));
  writeFileSync(join(source, ".operator-id"), "legacy-device\n");
  const before = treeHash(source);

  expect(await migrateLegacyState(source, destination, stopped)).toEqual({ status: "migrated", profileCount: 1 });
  expect(treeHash(source)).toBe(before);
  for (const relative of [
    "Local State", "Default/Cookies", "Default/Local Storage/leveldb/000003.log",
    "Default/IndexedDB/site.indexeddb.leveldb/000004.ldb",
  ]) {
    expect(readFileSync(join(destination.profiles, "legacy1", relative))).toEqual(readFileSync(join(source, "profiles", "legacy1", relative)));
  }
  const migrated = new Database(destination.database, { readonly: true });
  const profile = migrated.query<Record<string, unknown>, []>("SELECT * FROM profiles").get()!;
  expect(profile).toMatchObject({ acc_id: "account", password: "pass", email_password: "mail-pass", twofa: "seed", ua: "exact-ua", timezone: "Europe/Riga", fingerprint_seed: 424242 });
  expect(Buffer.from(profile.future_value as Uint8Array)).toEqual(Buffer.from([0, 255, 17]));
  expect(migrated.query("SELECT * FROM groups").get()).toEqual({ name: "Imported", future_group_value: "unknown-group-value" });
  expect(migrated.query("SELECT * FROM extensions").get()).toEqual({ id: "ext1", name: "Extension", load_dir: join(destination.extensions, "ext1"), future_extension_value: "unknown-extension-value" });
  migrated.close();
  expect(readFileSync(destination.operatorId, "utf8")).toBe("legacy-device\n");
  await expect(migrateLegacyState(source, destination, stopped)).rejects.toThrow("already contains imported local profile data");
});

test("the migration sidecar command is not mistaken for a running source process", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "legacy1");
  const scanProcesses = async () => ({
    records: [{ pid: process.pid, executablePath: "C:\\AliasMode\\aliasmode-sidecar.exe", commandLine: `__import-cloakpit --source \"${source}\"` }],
    incomplete: false,
  });
  await expect(migrateLegacyState(source, destination, { scanProcesses, validateDpapi: async () => {} })).resolves.toMatchObject({ status: "migrated" });
});

test("alternate roots copy disjoint IDs, reject ambiguity, and permit explicit selection", async () => {
  const { parent, source, destination } = roots();
  sourceDb(source, ["one", "two"]).close();
  const first = join(source, "profiles");
  const alternate = join(source, "cloakbrowser", "profiles");
  addBrowserState(first, "one");
  addBrowserState(alternate, "two");
  await migrateLegacyState(source, destination, stopped);
  expect(existsSync(join(destination.profiles, "one", "Local State"))).toBe(true);
  expect(existsSync(join(destination.profiles, "two", "Local State"))).toBe(true);

  const second = roots();
  sourceDb(second.source).close();
  addBrowserState(join(second.source, "profiles"), "legacy1");
  const historical = join(parent, "user", ".cloakbrowser", "chromium-1", "profiles");
  addBrowserState(historical, "legacy1");
  writeFileSync(join(historical, "legacy1", "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), Buffer.from([7, 7, 7])]).toString("base64") } }));
  await expect(migrateLegacyState(second.source, second.destination, { ...stopped, userProfile: join(parent, "user") })).rejects.toThrow("multiple browser profile roots");
  await migrateLegacyState(second.source, second.destination, { ...stopped, userProfile: join(parent, "user"), profileRoot: historical });
  expect(readFileSync(join(second.destination.profiles, "legacy1", "Local State"))).toEqual(readFileSync(join(historical, "legacy1", "Local State")));
});

test("unknown browser data directories are rejected without changing source", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "not-in-db");
  const before = treeHash(source);
  await expect(migrateLegacyState(source, destination, stopped)).rejects.toThrow("not represented in profiles.sqlite");
  expect(treeHash(source)).toBe(before);
  expect(existsSync(destination.root)).toBe(false);
});

test("initialized-empty local destination is accepted and harmless files are preserved", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "legacy1");
  mkdirSync(destination.root);
  const empty = new ProfileStore(destination.database);
  empty.close();
  mkdirSync(destination.profiles, { recursive: true });
  mkdirSync(destination.inbox, { recursive: true });
  mkdirSync(destination.reports, { recursive: true });
  mkdirSync(join(destination.root, "logs"), { recursive: true });
  writeFileSync(join(destination.inbox, "keep.txt"), "keep");
  writeFileSync(join(destination.reports, "keep.txt"), "keep");
  writeFileSync(join(destination.root, "logs", "keep.log"), "keep");
  writeFileSync(destination.config, '{"version":1,"mode":"local","localAnalytics":true}\n');

  await migrateLegacyState(source, destination, stopped);
  expect(readFileSync(join(destination.inbox, "keep.txt"), "utf8")).toBe("keep");
  expect(readFileSync(join(destination.reports, "keep.txt"), "utf8")).toBe("keep");
  expect(readFileSync(join(destination.root, "logs", "keep.log"), "utf8")).toBe("keep");
  expect(readFileSync(destination.config, "utf8")).toContain('"mode":"local"');
});

test("nonempty, Cloud, pending-sync, launch, remote, live, and inconclusive states reject", async () => {
  const cases: Array<[string, (source: string, destination: ReturnType<typeof statePaths>) => void, Pick<MigrationOptions, "scanProcesses"> | undefined, string]> = [
    ["profiles", (_s, d) => { mkdirSync(join(d.profiles, "old"), { recursive: true }); writeFileSync(join(d.profiles, "old", "Cookies"), "x"); }, stopped, "destination"],
    ["cloud config", (_s, d) => { mkdirSync(d.root); writeFileSync(d.config, '{"version":1,"mode":"cloud","cloudUrl":"https://cloud.aliasmode.com","localAnalytics":false}'); }, stopped, "Cloud"],
    ["cloud cache", (_s, d) => { mkdirSync(join(d.root, "cloud-cache"), { recursive: true }); writeFileSync(d.cloudDatabase, "state"); }, stopped, "Cloud"],
    ["pending", (_s, d) => { mkdirSync(d.root); writeFileSync(d.pendingSync, "state"); }, stopped, "pending"],
    ["launch", (s) => { const db = new Database(join(s, "profiles.sqlite")); db.query("INSERT INTO launches VALUES (?,?)").run("legacy1", 1); db.close(); }, stopped, "launch"],
    ["remote", (s) => { const db = new Database(join(s, "hub.sqlite")); db.exec("CREATE TABLE sessions (profile_id TEXT); INSERT INTO sessions VALUES ('legacy1')"); db.close(); }, stopped, "remote"],
    ["live", () => {}, { scanProcesses: async () => ({ records: [{ pid: 10, executablePath: "C:/Cloakpit/cloakbrowser.exe", commandLine: '--user-data-dir="C:/Cloakpit/profiles/legacy1"' }], incomplete: false }) }, "running"],
    ["unreadable Cloakpit", () => {}, { scanProcesses: async () => ({ records: [{ pid: 11, processName: "Cloakpit.exe", executablePath: null, commandLine: "" }], incomplete: false }) }, "running"],
    ["incomplete", () => {}, { scanProcesses: async () => ({ records: [], incomplete: true }) }, "inconclusive"],
    ["failed scan", () => {}, { scanProcesses: async () => null }, "inconclusive"],
  ];
  for (const [name, arrange, options, message] of cases) {
    const { source, destination } = roots();
    sourceDb(source).close();
    addBrowserState(join(source, "profiles"), "legacy1");
    arrange(source, destination);
    await expect(migrateLegacyState(source, destination, options)).rejects.toThrow(message);
    expect(existsSync(destination.migration), name).toBe(false);
  }
});

test("hot rollback journals are recovered only in private profile and hub copies", async () => {
  const profiles = roots();
  sourceDb(profiles.source).close();
  addBrowserState(join(profiles.source, "profiles"), "legacy1");
  await leaveHotJournal(join(profiles.source, "profiles.sqlite"), "UPDATE profiles SET name='uncommitted' WHERE id='legacy1'");
  const profilesHash = treeHash(profiles.source);
  await migrateLegacyState(profiles.source, profiles.destination, stopped);
  expect(treeHash(profiles.source)).toBe(profilesHash);
  expect(existsSync(join(profiles.destination.root, ".legacy-profiles.sqlite-journal"))).toBe(false);
  const migrated = new Database(profiles.destination.database, { readonly: true });
  expect(migrated.query<{ name: string }, []>("SELECT name FROM profiles").get()?.name).toBe("Legacy");
  migrated.close();

  const hub = roots();
  sourceDb(hub.source).close();
  addBrowserState(join(hub.source, "profiles"), "legacy1");
  const hubPath = join(hub.source, "hub.sqlite");
  const hubDb = new Database(hubPath);
  hubDb.exec("CREATE TABLE sessions (profile_id TEXT PRIMARY KEY, bundle TEXT); INSERT INTO sessions VALUES ('legacy1','committed')");
  hubDb.close();
  await leaveHotJournal(hubPath, "DELETE FROM sessions WHERE profile_id='legacy1'");
  const hubHash = treeHash(hub.source);
  await expect(migrateLegacyState(hub.source, hub.destination, stopped)).rejects.toThrow("remote sessions");
  expect(treeHash(hub.source)).toBe(hubHash);
});

test("persistent rollback journals never enter the destination", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "legacy1");
  const db = new Database(join(source, "profiles.sqlite"));
  db.exec("PRAGMA journal_mode=PERSIST; UPDATE profiles SET name='Persisted' WHERE id='legacy1'");
  db.close();
  expect(existsSync(join(source, "profiles.sqlite-journal"))).toBe(true);
  const before = treeHash(source);
  await migrateLegacyState(source, destination, stopped);
  expect(treeHash(source)).toBe(before);
  expect(readdirSync(destination.root).some((name) => name.startsWith(".legacy-"))).toBe(false);
});

test("linked profile and extension trees reject before copy", async () => {
  const profileLink = roots();
  sourceDb(profileLink.source).close();
  addBrowserState(join(profileLink.source, "profiles"), "legacy1");
  const outside = join(profileLink.parent, "outside.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(profileLink.source, "profiles", "legacy1", "Default", "linked"));
  await expect(migrateLegacyState(profileLink.source, profileLink.destination, stopped)).rejects.toThrow("Linked browser data");
  expect(existsSync(profileLink.destination.root)).toBe(false);

  const extensionLink = roots();
  sourceDb(extensionLink.source).close();
  addBrowserState(join(extensionLink.source, "profiles"), "legacy1");
  mkdirSync(join(extensionLink.source, "extensions", "ext1"), { recursive: true });
  symlinkSync(outside, join(extensionLink.source, "extensions", "ext1", "manifest.json"));
  await expect(migrateLegacyState(extensionLink.source, extensionLink.destination, stopped)).rejects.toThrow("Linked browser data");
  expect(existsSync(extensionLink.destination.root)).toBe(false);
});

test("seeded and session-bearing profiles require valid Local State DPAPI keys", async () => {
  const seeded = roots();
  sourceDb(seeded.source).close();
  mkdirSync(join(seeded.source, "profiles", "legacy1", "Default"), { recursive: true });
  writeFileSync(join(seeded.source, "profiles", "legacy1", "Default", "Cookies"), "cookies");
  await expect(migrateLegacyState(seeded.source, seeded.destination, stopped)).rejects.toThrow("Missing or malformed DPAPI key");

  const session = roots();
  const db = sourceDb(session.source);
  db.query("UPDATE profiles SET seeded = 0").run();
  db.close();
  addBrowserState(join(session.source, "profiles"), "legacy1");
  writeFileSync(join(session.source, "profiles", "legacy1", "Local State"), "{}");
  await expect(migrateLegacyState(session.source, session.destination, stopped)).rejects.toThrow("Missing or malformed DPAPI key");
});

test("live Bun manager rejects before SQLite touches source WAL or SHM", async () => {
  const { source, destination } = roots();
  const db = sourceDb(source);
  db.exec("PRAGMA journal_mode = WAL");
  db.query("UPDATE profiles SET name = ? WHERE id = ?").run("WAL persona", "legacy1");
  expect(existsSync(join(source, "profiles.sqlite-wal"))).toBe(true);
  expect(existsSync(join(source, "profiles.sqlite-shm"))).toBe(true);
  const before = treeHash(source);
  await expect(migrateLegacyState(source, destination, {
    scanProcesses: async () => ({
      records: [{ pid: 9876, executablePath: "C:\\Program Files\\Bun\\bun.exe", commandLine: `bun \"${join(source, "cli.ts")}\" start --state-root \"${source}\"` }],
      incomplete: false,
    }),
  })).rejects.toThrow("still running");
  expect(treeHash(source)).toBe(before);
  db.close();
});

test("relative Bun manager invocation rejects before migration", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "legacy1");
  await expect(migrateLegacyState(source, destination, {
    scanProcesses: async () => ({
      records: [{ pid: 9877, processName: "bun.exe", executablePath: "C:\\Program Files\\Bun\\bun.exe", commandLine: "bun cli.ts start" }],
      incomplete: false,
    }),
  })).rejects.toThrow("still running");
  expect(existsSync(destination.root)).toBe(false);
});

test("unopened database-only profiles may omit browser data", async () => {
  const { source, destination } = roots();
  const db = sourceDb(source);
  db.query("UPDATE profiles SET seeded = 0").run();
  db.close();
  await expect(migrateLegacyState(source, destination, stopped)).resolves.toEqual({ status: "migrated", profileCount: 1 });
  expect(existsSync(join(destination.profiles, "legacy1"))).toBe(false);
});

test("seeded profiles require selected historical browser data", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  await expect(migrateLegacyState(source, destination, stopped)).rejects.toThrow("--cloakpit-profile-root");
  expect(existsSync(destination.root)).toBe(false);
});

test("DPAPI validation fails closed before commit", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "legacy1");
  let validated: string[] = [];
  await expect(migrateLegacyState(source, destination, {
    ...stopped,
    validateDpapi: async (paths) => {
      validated = paths;
      throw new Error("DPAPI belongs to another Windows account");
    },
  })).rejects.toThrow("another Windows account");
  expect(validated).toHaveLength(1);
  expect(validated[0]).toEndWith(join("profiles", "legacy1", "Local State"));
  expect(existsSync(destination.root)).toBe(false);
});

test("shared profile ID policy rejects unsafe legacy IDs", async () => {
  for (const id of ["../escape", "CON", "a".repeat(129), "bad.id", "bad!id"]) {
    const { source, destination } = roots();
    const db = sourceDb(source);
    db.query("UPDATE profiles SET id = ?").run(id);
    db.close();
    await expect(migrateLegacyState(source, destination, stopped)).rejects.toThrow("unsafe profile ID");
  }
});

test("interrupted backup is recovered and ambiguous backup is rejected", async () => {
  const recovered = roots();
  sourceDb(recovered.source).close();
  addBrowserState(join(recovered.source, "profiles"), "legacy1");
  const backup = `${recovered.destination.root}.pre-cloakpit-import`;
  mkdirSync(join(backup, "inbox"), { recursive: true });
  writeFileSync(join(backup, "inbox", "keep.txt"), "keep");
  await migrateLegacyState(recovered.source, recovered.destination, stopped);
  expect(readFileSync(join(recovered.destination.inbox, "keep.txt"), "utf8")).toBe("keep");
  expect(existsSync(backup)).toBe(false);

  const ambiguous = roots();
  sourceDb(ambiguous.source).close();
  mkdirSync(ambiguous.destination.root);
  mkdirSync(`${ambiguous.destination.root}.pre-cloakpit-import`);
  await expect(migrateLegacyState(ambiguous.source, ambiguous.destination, stopped)).rejects.toThrow("both exist");
});

test("double commit failure retains discoverable recovery backup", async () => {
  const { source, destination } = roots();
  sourceDb(source).close();
  addBrowserState(join(source, "profiles"), "legacy1");
  mkdirSync(destination.root);
  mkdirSync(destination.inbox);
  writeFileSync(join(destination.inbox, "keep.txt"), "keep");
  const backup = `${destination.root}.pre-cloakpit-import`;
  await expect(migrateLegacyState(source, destination, {
    ...stopped,
    rename: (from, to) => {
      if (from.includes(".migrating-") || from === backup) throw new Error("injected rename failure");
      renameSync(from, to);
    },
  })).rejects.toThrow(backup);
  expect(existsSync(destination.root)).toBe(false);
  expect(readFileSync(join(backup, "inbox", "keep.txt"), "utf8")).toBe("keep");
});

test("forged migration markers reject missing or truncated destination databases", async () => {
  for (const truncated of [false, true]) {
    const { source, destination } = roots();
    sourceDb(source).close();
    mkdirSync(destination.root);
    writeFileSync(destination.migration, '{"version":1}');
    if (truncated) writeFileSync(destination.database, "not sqlite");
    await expect(migrateLegacyState(source, destination, stopped)).rejects.toThrow("already contains imported local profile data");
  }
});

test("second process scan rejects and commit failure restores initialized destination", async () => {
  const first = roots();
  sourceDb(first.source).close();
  addBrowserState(join(first.source, "profiles"), "legacy1");
  let scans = 0;
  await expect(migrateLegacyState(first.source, first.destination, {
    scanProcesses: async () => ++scans === 1 ? { records: [], incomplete: false } : null,
    validateDpapi: async () => {},
  })).rejects.toThrow("inconclusive");
  expect(scans).toBe(2);
  expect(existsSync(first.destination.root)).toBe(false);

  const second = roots();
  sourceDb(second.source).close();
  addBrowserState(join(second.source, "profiles"), "legacy1");
  mkdirSync(second.destination.root);
  mkdirSync(second.destination.inbox);
  writeFileSync(join(second.destination.inbox, "keep.txt"), "keep");
  await expect(migrateLegacyState(second.source, second.destination, {
    ...stopped,
    rename: (from, to) => {
      if (from.includes(".migrating-") && to === second.destination.root) throw new Error("injected commit failure");
      renameSync(from, to);
    },
  })).rejects.toThrow("injected commit failure");
  expect(readFileSync(join(second.destination.inbox, "keep.txt"), "utf8")).toBe("keep");
  expect(existsSync(second.destination.migration)).toBe(false);
});

/**
 * SQLite-backed profile + runtime store for the CloakBrowser manager.
 *
 * Two concerns live here:
 *   - `profiles`: the imported identity for each AdsPower profile id. The
 *     identity columns (proxy, ua, screen, fingerprint_seed) are written once
 *     at import and read verbatim on launch.
 *   - `launches`: which profiles are currently running (pid, debug port, ws).
 *     Used for active() checks and for orphan cleanup on startup.
 */

import { Database } from "bun:sqlite";
import type {
  CookieRecord,
  FingerprintVerdict,
  LaunchInfo,
  ObservedFingerprint,
  Profile,
  ProxySpec,
} from "./types.ts";
import { normalizeProxySpec } from "./proxy.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import { assertValidProfile } from "./profile-validation.ts";

export class ProfileStore {
  private db: Database;

  constructor(path = "profiles.sqlite") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        acc_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        "group" TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        email_password TEXT NOT NULL DEFAULT '',
        twofa TEXT NOT NULL DEFAULT '',
        proxy_json TEXT,
        ua TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        screen_width INTEGER NOT NULL DEFAULT 1920,
        screen_height INTEGER NOT NULL DEFAULT 1080,
        fingerprint_seed INTEGER NOT NULL,
        platform_os TEXT NOT NULL DEFAULT '',
        fp_observed_json TEXT NOT NULL DEFAULT '',
        fp_expected_json TEXT NOT NULL DEFAULT '',
        fp_verdict_json TEXT NOT NULL DEFAULT '',
        cookies_json TEXT NOT NULL DEFAULT '[]',
        seeded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        last_open_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        profile_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        debug_port INTEGER NOT NULL,
        ws TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        relay_port INTEGER,
        session_base_version INTEGER,
        binary_path TEXT,
        user_data_dir TEXT,
        binary_sha256 TEXT,
        persona_digest TEXT,
        headless INTEGER,
        search_bootstrap_revision INTEGER,
        process_group_id INTEGER,
        root_start_time TEXT
      );
    `);
    // Migration for stores predating the proxy-auth relay (nullable: only authed-proxy launches set it).
    try {
      this.db.exec(`ALTER TABLE launches ADD COLUMN relay_port INTEGER`);
    } catch {
      /* column already exists */
    }
    // Migration for stores predating persisted optimistic-concurrency bases for survivor reattach.
    try {
      this.db.exec(`ALTER TABLE launches ADD COLUMN session_base_version INTEGER`);
    } catch {
      /* column already exists */
    }
    for (const column of [
      "binary_path TEXT",
      "user_data_dir TEXT",
      "binary_sha256 TEXT",
      "persona_digest TEXT",
      "headless INTEGER",
      "search_bootstrap_revision INTEGER",
      "process_group_id INTEGER",
      "root_start_time TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE launches ADD COLUMN ${column}`);
      } catch {
        /* column already exists */
      }
    }
    // Group registry: lets a folder exist (and stay listed) with zero profiles,
    // matching AdsPower's folders. group_id == name everywhere. Backfill from any
    // labels already on profiles so pre-existing groups persist even once emptied.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        name TEXT PRIMARY KEY,
        extension_defaults_json TEXT NOT NULL DEFAULT '[]'
      );
    `);
    try {
      this.db.exec(`ALTER TABLE groups ADD COLUMN extension_defaults_json TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      /* column already exists */
    }
    this.db.exec(`INSERT OR IGNORE INTO groups (name) SELECT DISTINCT "group" FROM profiles WHERE "group" <> ''`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_temporary_profiles (
        profile_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
    // Uploaded browser extensions (files live on disk; this is the registry).
    // load_dir is the directory handed to --load-extension (has manifest.json).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extensions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        load_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Migration for stores created before the timezone column existed.
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN timezone TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    // Migration for stores created before the platform column existed.
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN platform TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    // Separate account and mailbox credentials. Older stores are upgraded in
    // place; blank defaults preserve every existing profile.
    for (const col of ["email TEXT NOT NULL DEFAULT ''", "email_password TEXT NOT NULL DEFAULT ''"]) {
      try {
        this.db.exec(`ALTER TABLE profiles ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // Migration for stores created before per-profile extension assignment.
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN extensions_json TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      /* column already exists */
    }
    // Migration for stores created before per-profile custom tags.
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      /* column already exists */
    }
    // Invalid legacy proxies are quarantined instead of making every profile
    // read fail or being silently converted into a direct/no-proxy launch.
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN proxy_error TEXT`);
    } catch {
      /* column already exists */
    }
    // Migration for stores predating the operator-chosen "custom NO." serial.
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN custom_no TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    // Migrations for the full-fidelity identity export. platform_os makes the
    // desktop platform an explicit stored value instead of one inferred from
    // the UA (a blank UA previously meant no --fingerprint-platform flag at
    // all, so the browser silently inherited the HOST os). The fp_* columns
    // hold the measured fingerprint, the fingerprint an import claimed, and
    // the comparison between them.
    for (const col of [
      "platform_os TEXT NOT NULL DEFAULT ''",
      "fp_observed_json TEXT NOT NULL DEFAULT ''",
      "fp_expected_json TEXT NOT NULL DEFAULT ''",
      "fp_verdict_json TEXT NOT NULL DEFAULT ''",
    ]) {
      try {
        this.db.exec(`ALTER TABLE profiles ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // Migrations for stores predating the AdsPower-parity bookkeeping columns
    // (created_at: profile creation; last_open_at: most recent launch). Both
    // surface through the AdsPower /api/v1/user/list facade.
    for (const col of ["created_at INTEGER NOT NULL DEFAULT 0", "last_open_at INTEGER NOT NULL DEFAULT 0"]) {
      try {
        this.db.exec(`ALTER TABLE profiles ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Insert or replace a profile's identity. Preserves the existing seeded flag. */
  upsertProfile(p: Profile): void {
    // Defense in depth for direct hub/API/remote callers that bypass the import
    // parser. Invalid full-profile JSON must never reach persistent identity.
    assertValidProfile(p);
    if (p.proxy && p.proxyError) throw new Error("profile cannot contain both a valid proxy and a proxy quarantine error");
    const proxy = p.proxyError ? null : normalizeProxySpec(p.proxy);
    const proxyError = p.proxyError?.trim() ?? "";
    const existing = this.db
      .query<{ seeded: number }, [string]>("SELECT seeded FROM profiles WHERE id = ?")
      .get(p.id);
    const seeded = existing ? existing.seeded : p.seeded ? 1 : 0;
    this.db
      .query(
        `INSERT INTO profiles
           (id, acc_id, name, "group", platform, username, password, email, email_password, twofa, proxy_json, proxy_error, extensions_json, tags_json, custom_no, ua, timezone,
            screen_width, screen_height, fingerprint_seed, platform_os, fp_observed_json, fp_expected_json, fp_verdict_json, cookies_json, seeded, created_at)
         -- fp_verdict_json is literal '': a verdict is a COMPUTED fact, written
         -- only by saveObservedFingerprint from a real measurement. If a caller
         -- could supply one, an import could hand itself a "verified" badge and
         -- the badge would mean nothing.
         VALUES ($id,$acc,$name,$group,$platform,$user,$pass,$email,$emailPass,$twofa,$proxy,$proxyError,$ext,$tags,$customNo,$ua,$tz,$w,$h,$seed,$platformOs,$fpObserved,$fpExpected,'',$cookies,$seeded,$created)
         ON CONFLICT(id) DO UPDATE SET
           acc_id=$acc, name=$name, "group"=$group, platform=$platform, username=$user, password=$pass,
           email=$email, email_password=$emailPass, twofa=$twofa,
           -- An unrelated edit to a quarantined profile must preserve the raw
           -- legacy proxy for operator recovery. A valid replacement or an
           -- explicit clear removes the quarantine and writes the new value.
           proxy_json = CASE WHEN $proxyError <> '' THEN proxy_json ELSE $proxy END,
           proxy_error = CASE WHEN $proxyError <> '' THEN $proxyError ELSE NULL END,
           extensions_json=$ext, tags_json=$tags, custom_no=$customNo, ua=$ua,
           -- Timezone on re-import:
           --   * new lookup resolved one ($tz<>'')       -> use it
           --   * else proxy UNCHANGED                     -> keep stored value
           --     (a transient ip-api failure must not erase a still-valid tz)
           --   * else proxy changed/removed + no new tz   -> clear it
           --     (keeping it would emit --fingerprint-timezone for a proxy the
           --      profile no longer uses — a worse mismatch than the default).
           -- In ON CONFLICT DO UPDATE the bare column (proxy_json) is the OLD
           -- row value; $proxy is the incoming value. IS is null-safe.
           timezone = CASE
             WHEN $tz <> '' THEN $tz
             WHEN $proxyError <> '' THEN timezone
             WHEN proxy_json IS $proxy THEN timezone
             ELSE ''
           END,
           screen_width=$w, screen_height=$h,
           fingerprint_seed=$seed, platform_os=$platformOs,
           -- An ordinary profile edit carries no capture. Preserving the stored
           -- one keeps a rename from erasing a measurement that is still true.
           fp_observed_json = CASE WHEN $fpObserved <> '' THEN $fpObserved ELSE fp_observed_json END,
           fp_expected_json = CASE WHEN $fpExpected <> '' THEN $fpExpected ELSE fp_expected_json END,
           -- A CHANGED expectation invalidates the verdict: one computed
           -- against the previous expectation must never be read as if it
           -- applied to this one. An unrelated edit (a rename, a group move)
           -- re-sends the same expectation and keeps its verdict. As everywhere
           -- in this clause, the bare column is the OLD row value.
           fp_verdict_json  = CASE
             WHEN $fpExpected <> '' AND $fpExpected IS NOT fp_expected_json THEN ''
             ELSE fp_verdict_json
           END,
           cookies_json=$cookies`,
      )
      .run({
        $id: p.id,
        $acc: p.accId,
        $name: p.name,
        $group: p.group,
        $platform: p.platform ?? "",
        $user: p.username,
        $pass: p.password,
        $email: p.email ?? "",
        $emailPass: p.emailPassword ?? "",
        $twofa: p.twofa,
        $proxy: proxy ? JSON.stringify(proxy) : null,
        $proxyError: proxyError || null,
        $ext: JSON.stringify(p.extensions ?? []),
        $tags: JSON.stringify(p.tags ?? []),
        $customNo: p.customNo ?? "",
        $ua: p.ua,
        $tz: p.timezone ?? "",
        $w: p.screenWidth,
        $h: p.screenHeight,
        $seed: p.fingerprintSeed,
        $platformOs: p.platformOs ?? "",
        $fpObserved: p.fpObserved ? JSON.stringify(p.fpObserved) : "",
        $fpExpected: p.fpExpected ? JSON.stringify(p.fpExpected) : "",
        $cookies: JSON.stringify(p.cookies),
        $seeded: seeded,
        // Set on INSERT; preserved on re-import (the ON CONFLICT clause never
        // updates created_at). New profiles get a real timestamp; rows imported
        // before this column stay 0 (creation time was never recorded then).
        $created: Date.now(),
      });
    if (p.group) this.registerGroup(p.group);
  }

  /** Apply a prevalidated profile batch atomically (all rows or none). */
  upsertProfiles(profiles: Profile[]): void {
    const apply = this.db.transaction((items: Profile[]) => {
      for (const profile of items) this.upsertProfile(profile);
    });
    apply(profiles);
  }

  getProfile(id: string): Profile | null {
    const row = this.db
      .query<any, [string]>(`SELECT * FROM profiles WHERE id = ?`)
      .get(id);
    return row ? rowToProfile(row) : null;
  }

  listProfiles(): Profile[] {
    return this.db.query<any, []>(`SELECT * FROM profiles ORDER BY id`).all().map(rowToProfile);
  }

  count(): number {
    return this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM profiles`).get()!.n;
  }

  markSeeded(id: string): void {
    this.db.query(`UPDATE profiles SET seeded = 1 WHERE id = ?`).run(id);
  }

  /**
   * Record a capture and, when there was something to check it against, the
   * verdict. Deliberately narrow: this is the launch path's only write, and it
   * must not be able to touch identity, credentials or the expectation.
   */
  saveObservedFingerprint(
    profileId: string,
    observed: ObservedFingerprint,
    verdict: FingerprintVerdict | null,
  ): void {
    this.db
      .query(`UPDATE profiles SET fp_observed_json = ?, fp_verdict_json = ? WHERE id = ?`)
      .run(JSON.stringify(observed), verdict ? JSON.stringify(verdict) : "", profileId);
  }

  /** Delete a profile and its launch row. Returns true if a row was removed. */
  deleteProfile(id: string): boolean {
    this.db.query(`DELETE FROM launches WHERE profile_id = ?`).run(id);
    this.db.query(`DELETE FROM agent_temporary_profiles WHERE profile_id = ?`).run(id);
    const res = this.db.query(`DELETE FROM profiles WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  markAgentTemporary(profileId: string): void {
    assertSafeProfileId(profileId);
    this.db.query(
      `INSERT INTO agent_temporary_profiles (profile_id, created_at) VALUES (?, ?)
       ON CONFLICT(profile_id) DO NOTHING`,
    ).run(profileId, Date.now());
  }

  clearAgentTemporary(profileId: string): void {
    this.db.query(`DELETE FROM agent_temporary_profiles WHERE profile_id = ?`).run(profileId);
  }

  listAgentTemporary(): string[] {
    return this.db
      .query<{ profile_id: string }, []>(`SELECT profile_id FROM agent_temporary_profiles ORDER BY created_at, profile_id`)
      .all()
      .map((row) => row.profile_id);
  }

  /**
   * Reassign profiles to a group and materialize that group's extension defaults.
   * Unknown ids and profiles already in the destination are ignored.
   */
  setGroup(ids: string[], group: string): number {
    if (ids.length === 0) return 0;
    const destination = group.trim();
    const move = this.db.transaction((profileIds: string[]) => {
      if (destination) this.registerGroup(destination);
      let changed = 0;
      for (const id of profileIds) {
        const profile = this.getProfile(id);
        if (!profile || profile.group === destination) continue;
        const previousGroup = profile.group;
        profile.group = destination;
        this.applyGroupExtensionDefaults(profile, previousGroup, false);
        this.upsertProfile(profile);
        changed++;
      }
      return changed;
    });
    return move(ids);
  }

  /** Register a group so it persists (and stays listed) with zero profiles. */
  registerGroup(name: string): void {
    const n = name.trim();
    if (n) this.db.query(`INSERT OR IGNORE INTO groups (name) VALUES (?)`).run(n);
  }

  getGroupExtensionDefaults(name: string): string[] {
    const n = name.trim();
    if (!n) return [];
    const row = this.db
      .query<{ extensions: string }, [string]>(
        `SELECT extension_defaults_json AS extensions FROM groups WHERE name = ?`,
      )
      .get(n);
    return normalizeExtensionIds(safeParse<string[]>(row?.extensions, []));
  }

  listGroupExtensionDefaults(): Array<{ name: string; extensions: string[] }> {
    return this.listGroups().map((name) => ({
      name,
      extensions: this.getGroupExtensionDefaults(name),
    }));
  }

  /** Replace a group's default and every current member's materialized assignment. */
  setGroupExtensionDefaults(name: string, extensionIds: string[]): number {
    const group = name.trim();
    if (!group) throw new Error("group name required");
    const extensions = normalizeExtensionIds(extensionIds);
    const apply = this.db.transaction(() => {
      this.registerGroup(group);
      this.db.query(`UPDATE groups SET extension_defaults_json = ? WHERE name = ?`)
        .run(JSON.stringify(extensions), group);
      let changed = 0;
      for (const profile of this.listProfiles()) {
        if (profile.group !== group || sameStrings(profile.extensions ?? [], extensions)) continue;
        profile.extensions = [...extensions];
        this.upsertProfile(profile);
        changed++;
      }
      return changed;
    });
    return apply();
  }

  /** Apply a named destination's default unless assignments were explicitly supplied. */
  applyGroupExtensionDefaults(profile: Profile, previousGroup: string | null, extensionsExplicit: boolean): void {
    const destination = profile.group.trim();
    if (extensionsExplicit || !destination || previousGroup?.trim() === destination) return;
    profile.extensions = this.getGroupExtensionDefaults(destination);
  }

  /**
   * Rename a group: move every member profile from `from` to `to`, and migrate
   * its defaults. If `to` exists the groups merge and its defaults win.
   */
  renameGroup(from: string, to: string): number {
    const source = from.trim(), destination = to.trim();
    if (!source || !destination || source === destination) return 0;
    const rename = this.db.transaction(() => {
      const destinationExists = !!this.db
        .query<{ found: number }, [string]>(`SELECT 1 AS found FROM groups WHERE name = ?`)
        .get(destination);
      if (!destinationExists) {
        this.db.query(`INSERT INTO groups (name, extension_defaults_json) VALUES (?, ?)`)
          .run(destination, JSON.stringify(this.getGroupExtensionDefaults(source)));
      }
      const res = this.db.query(`UPDATE profiles SET "group" = ? WHERE "group" = ?`)
        .run(destination, source);
      this.db.query(`DELETE FROM groups WHERE name = ?`).run(source);
      return Number(res.changes);
    });
    return rename();
  }

  /**
   * Delete a group. Members aren't deleted — they're moved to "ungrouped" (empty
   * group), matching AdsPower. Materialized extension assignments are preserved.
   */
  deleteGroup(name: string): number {
    const n = name.trim();
    const remove = this.db.transaction(() => {
      const res = this.db.query(`UPDATE profiles SET "group" = '' WHERE "group" = ?`).run(n);
      this.db.query(`DELETE FROM groups WHERE name = ?`).run(n);
      return Number(res.changes);
    });
    return remove();
  }

  /** Distinct group names: the registry unioned with any labels live on profiles. */
  listGroups(): string[] {
    return this.db
      .query<{ name: string }, []>(
        `SELECT name FROM groups WHERE name <> ''
         UNION SELECT DISTINCT "group" FROM profiles WHERE "group" <> ''
         ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
  }

  /** Set a profile's display name (AdsPower user/update). No-op for unknown ids. */
  rename(id: string, name: string): void {
    this.db.query(`UPDATE profiles SET name = ? WHERE id = ?`).run(name, id);
  }

  // --- Extensions ----------------------------------------------------------

  /** Register (or replace) an uploaded extension. */
  addExtension(ext: { id: string; name: string; loadDir: string }): void {
    this.db
      .query(
        `INSERT INTO extensions (id, name, load_dir, created_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, load_dir=excluded.load_dir`,
      )
      .run(ext.id, ext.name, ext.loadDir, Date.now());
  }

  listExtensions(): Array<{ id: string; name: string; loadDir: string }> {
    return this.db
      .query<{ id: string; name: string; loadDir: string }, []>(
        `SELECT id, name, load_dir AS loadDir FROM extensions ORDER BY name COLLATE NOCASE`,
      )
      .all();
  }

  getExtension(id: string): { id: string; name: string; loadDir: string } | null {
    return (
      this.db
        .query<{ id: string; name: string; loadDir: string }, [string]>(
          `SELECT id, name, load_dir AS loadDir FROM extensions WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  deleteExtension(id: string): void {
    this.db.query(`DELETE FROM extensions WHERE id = ?`).run(id);
  }

  /** Remove an extension id from every profile and group default that contains it. */
  unassignExtension(id: string): void {
    const unassign = this.db.transaction(() => {
      for (const group of this.listGroupExtensionDefaults()) {
        if (!group.extensions.includes(id)) continue;
        this.db.query(`UPDATE groups SET extension_defaults_json = ? WHERE name = ?`)
          .run(JSON.stringify(group.extensions.filter((item) => item !== id)), group.name);
      }
      for (const profile of this.listProfiles()) {
        if (!profile.extensions?.includes(id)) continue;
        profile.extensions = profile.extensions.filter((item) => item !== id);
        this.upsertProfile(profile);
      }
    });
    unassign();
  }

  /**
   * Add or remove one extension id across many profiles (bulk assign). The
   * assignment list is treated as a set (no duplicates). Unknown profile ids are
   * skipped. Returns how many profiles changed.
   */
  assignExtension(ids: string[], extId: string, add: boolean): number {
    let changed = 0;
    for (const id of ids) {
      const p = this.getProfile(id);
      if (!p) continue;
      const set = new Set(p.extensions ?? []);
      const had = set.has(extId);
      if (add) set.add(extId);
      else set.delete(extId);
      if (set.size === (p.extensions?.length ?? 0) && had === add) continue; // no change
      p.extensions = [...set];
      this.upsertProfile(p);
      changed++;
    }
    return changed;
  }

  /**
   * Rows for the AdsPower-compatible /api/v1/user/list + group/list facade.
   * `serial` is the SQLite rowid (stable — upsert uses ON CONFLICT DO UPDATE,
   * not REPLACE), standing in for AdsPower's serial_number. Timestamps are ms.
   */
  listUserRecords(): Array<{
    id: string;
    name: string;
    group: string;
    createdAt: number;
    lastOpenAt: number;
    serial: number;
    fpVerdict: string;
    fpCapturedAt: string;
  }> {
    return this.db
      .query<any, []>(
        `SELECT id, name, "group" AS grp, created_at AS c, last_open_at AS l, rowid AS s,
                fp_verdict_json AS fpv, fp_observed_json AS fpo
           FROM profiles ORDER BY rowid`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name ?? "",
        group: r.grp ?? "",
        createdAt: r.c ?? 0,
        lastOpenAt: r.l ?? 0,
        serial: r.s,
        fpVerdict: safeParse<{ verdict?: string }>(r.fpv, {}).verdict ?? "",
        fpCapturedAt: safeParse<{ capturedAt?: string }>(r.fpo, {}).capturedAt ?? "",
      }));
  }

  /** This profile's serial (SQLite rowid) — AdsPower's serial_number stand-in. Null if unknown. */
  getSerial(profileId: string): number | null {
    const row = this.db
      .query<{ s: number }, [string]>(`SELECT rowid AS s FROM profiles WHERE id = ?`)
      .get(profileId);
    return row ? row.s : null;
  }

  /**
   * Per-profile bookkeeping the roster shows but that does not live on Profile:
   * the serial (rowid) plus creation/last-open timestamps. One query for a whole
   * roster render rather than a lookup per row.
   */
  listProfileMeta(): Map<string, { serial: number; createdAt: number; lastOpenAt: number }> {
    return new Map(
      this.db
        .query<{ id: string; s: number; c: number; l: number }, []>(
          `SELECT id, rowid AS s, created_at AS c, last_open_at AS l FROM profiles`,
        )
        .all()
        .map((row) => [row.id, { serial: row.s, createdAt: row.c ?? 0, lastOpenAt: row.l ?? 0 }] as const),
    );
  }

  recordLaunch(info: LaunchInfo): void {
    this.db
      .query(
        `INSERT INTO launches
           (profile_id, pid, debug_port, ws, started_at, relay_port, session_base_version,
            binary_path, user_data_dir, binary_sha256, persona_digest, headless,
            search_bootstrap_revision, process_group_id, root_start_time)
         VALUES ($id,$pid,$port,$ws,$at,$relay,$base,$binary,$data,$binary_sha,$persona,$headless,$search_bootstrap,$pgid,$root_start)
         ON CONFLICT(profile_id) DO UPDATE SET
           pid=$pid, debug_port=$port, ws=$ws, started_at=$at, relay_port=$relay,
           session_base_version=$base, binary_path=$binary, user_data_dir=$data,
           binary_sha256=$binary_sha, persona_digest=$persona, headless=$headless,
           search_bootstrap_revision=$search_bootstrap,
           process_group_id=$pgid, root_start_time=$root_start`,
      )
      .run({
        $id: info.profileId,
        $pid: info.pid,
        $port: info.debugPort,
        $ws: info.ws,
        $at: info.startedAt,
        $relay: info.relayPort ?? null,
        $base: info.sessionBaseVersion ?? null,
        $binary: info.binaryPath ?? null,
        $data: info.userDataDir ?? null,
        $binary_sha: info.binarySha256 ?? null,
        $persona: info.personaDigest ?? null,
        $headless: info.headless === undefined ? null : Number(info.headless),
        $search_bootstrap: info.searchBootstrapRevision ?? null,
        $pgid: info.processGroupId ?? null,
        $root_start: info.rootStartTime ?? null,
      });
    // Mirror the launch time onto the profile so the AdsPower user/list facade
    // can report last_open_time (the launches row is deleted on stop).
    this.db.query(`UPDATE profiles SET last_open_at = ? WHERE id = ?`).run(info.startedAt, info.profileId);
  }

  updateLaunchSessionBaseVersion(profileId: string, version: number): void {
    this.db.query(`UPDATE launches SET session_base_version = ? WHERE profile_id = ?`).run(version, profileId);
  }

  getLaunch(profileId: string): LaunchInfo | null {
    const row = this.db
      .query<any, [string]>(`SELECT * FROM launches WHERE profile_id = ?`)
      .get(profileId);
    return row ? rowToLaunch(row) : null;
  }

  listLaunches(): LaunchInfo[] {
    return this.db.query<any, []>(`SELECT * FROM launches`).all().map(rowToLaunch);
  }

  clearLaunch(profileId: string): void {
    this.db.query(`DELETE FROM launches WHERE profile_id = ?`).run(profileId);
  }
}

function normalizeExtensionIds(ids: string[]): string[] {
  return [...new Set(ids.map(String).map((id) => id.trim()).filter(Boolean))];
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Parse a JSON column defensively so one corrupt row can't break list/diagnose. */
function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Spread-friendly optional JSON column: absent (not `undefined`) when the
 * column is blank, so a profile that has never been probed does not carry
 * three explicit `undefined` keys into every comparison and serialization.
 */
function optionalJson<T>(key: string, raw: unknown): Record<string, T> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    return { [key]: JSON.parse(raw) as T };
  } catch {
    return {};
  }
}

function rowToProfile(row: any): Profile {
  const stored = readStoredProxy(row.proxy_json, row.proxy_error);
  return {
    id: row.id,
    accId: row.acc_id ?? "",
    name: row.name ?? "",
    group: row.group ?? "",
    platform: row.platform ?? "",
    username: row.username ?? "",
    password: row.password ?? "",
    email: row.email ?? "",
    emailPassword: row.email_password ?? "",
    twofa: row.twofa ?? "",
    proxy: stored.proxy,
    ...(stored.error ? { proxyError: stored.error } : {}),
    extensions: safeParse<string[]>(row.extensions_json, []),
    tags: safeParse<string[]>(row.tags_json, []),
    customNo: typeof row.custom_no === "string" ? row.custom_no : "",
    ua: row.ua ?? "",
    timezone: row.timezone ?? "",
    screenWidth: row.screen_width ?? 1920,
    screenHeight: row.screen_height ?? 1080,
    fingerprintSeed: row.fingerprint_seed,
    platformOs: row.platform_os ?? "",
    ...optionalJson<ObservedFingerprint>("fpObserved", row.fp_observed_json),
    ...optionalJson<ObservedFingerprint>("fpExpected", row.fp_expected_json),
    ...optionalJson<FingerprintVerdict>("fpVerdict", row.fp_verdict_json),
    cookies: safeParse<CookieRecord[]>(row.cookies_json, []),
    seeded: Boolean(row.seeded),
  };
}

function readStoredProxy(raw: unknown, quarantined: unknown): { proxy: ProxySpec | null; error?: string } {
  const priorError = typeof quarantined === "string" ? quarantined.trim() : "";
  if (priorError) return { proxy: null, error: priorError };
  if (raw == null || raw === "") return { proxy: null };
  if (typeof raw !== "string") return { proxy: null, error: "invalid stored proxy encoding" };
  let parsed: ProxySpec | null;
  try {
    parsed = JSON.parse(raw) as ProxySpec | null;
  } catch {
    return { proxy: null, error: "invalid stored proxy JSON" };
  }
  try {
    return { proxy: normalizeProxySpec(parsed) };
  } catch (error) {
    return { proxy: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function rowToLaunch(row: any): LaunchInfo {
  return {
    profileId: row.profile_id,
    pid: row.pid,
    debugPort: row.debug_port,
    ws: row.ws,
    startedAt: row.started_at,
    relayPort: row.relay_port ?? undefined,
    sessionBaseVersion: row.session_base_version ?? undefined,
    binaryPath: row.binary_path ?? undefined,
    userDataDir: row.user_data_dir ?? undefined,
    binarySha256: row.binary_sha256 ?? undefined,
    personaDigest: row.persona_digest ?? undefined,
    headless: row.headless == null ? undefined : Boolean(row.headless),
    searchBootstrapRevision: row.search_bootstrap_revision ?? undefined,
    processGroupId: row.process_group_id ?? undefined,
    rootStartTime: row.root_start_time ?? undefined,
  };
}

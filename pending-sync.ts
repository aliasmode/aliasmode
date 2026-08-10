import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CloudApiError } from "./cloud-client.ts";
import type {
  CloseOpenConflict,
  CloseOpenRequest,
  CloseOpenResponse,
  PendingSyncStatus,
  PortableProfileV1,
} from "./contracts/cloud-v1.ts";

export interface PendingCloseInput {
  accountId: string;
  profileId: string;
  registrationId: string;
  expectedVersion: number;
  payload: PortableProfileV1;
  readyToSubmit?: boolean;
}

export interface PendingClose extends PendingCloseInput {
  id: string;
  readyToSubmit: boolean;
  status: PendingSyncStatus;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface PendingCloseSummary {
  id: string;
  profileId: string;
  expectedVersion: number;
  readyToSubmit: boolean;
  status: PendingSyncStatus;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

interface EncryptedPendingClose {
  registrationId: string;
  payload: PortableProfileV1;
}

export type PendingOpenPhase = "opening" | "restoring" | "running";

export interface PendingOpenSession {
  accountId: string;
  profileId: string;
  registrationId: string;
  expectedVersion: number;
  phase: PendingOpenPhase;
  debugPort: number | null;
  startedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PendingOpenRow {
  account_id: string;
  profile_id: string;
  expected_version: number;
  phase: PendingOpenPhase;
  debug_port: number | null;
  started_at: number | null;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  created_at: number;
  updated_at: number;
}

interface PendingRow {
  id: string;
  account_id: string;
  profile_id: string;
  expected_version: number;
  ready_to_submit: number;
  status: PendingSyncStatus;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  created_at: number;
  updated_at: number;
  error: string | null;
}

function aad(id: string, accountId: string, profileId: string, expectedVersion: number): Buffer {
  return Buffer.from(
    `aliasmode-pending-sync:v1:${id}:${accountId}:${profileId}:${expectedVersion}`,
    "utf8",
  );
}

function openAad(accountId: string, profileId: string, expectedVersion: number): Buffer {
  return Buffer.from(
    `aliasmode-pending-open:v1:${accountId}:${profileId}:${expectedVersion}`,
    "utf8",
  );
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export class PendingSyncQueue {
  private readonly db: Database;
  private readonly key: Buffer;

  constructor(path: string, key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("pending sync encryption key must be 32 bytes");
    this.key = Buffer.from(key);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows Credential Manager protects the key; Windows does not honor POSIX modes.
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_closes (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        ready_to_submit INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('pending', 'retrying', 'conflict')),
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_closes_account_status
        ON pending_closes(account_id, status, created_at);
      CREATE TABLE IF NOT EXISTS pending_open_sessions (
        account_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('opening', 'restoring', 'running')),
        debug_port INTEGER,
        started_at INTEGER,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, profile_id)
      );
    `);
    try {
      this.db.exec("ALTER TABLE pending_closes ADD COLUMN ready_to_submit INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Existing queue already has the lifecycle-ready column.
    }
  }

  assertEncryptionKey(): void {
    const row = this.db.query<PendingRow, []>(
      "SELECT * FROM pending_closes ORDER BY created_at, id LIMIT 1",
    ).get();
    if (row) {
      this.get(row.id, row.account_id);
      return;
    }
    const open = this.db.query<{ profile_id: string; account_id: string }, []>(
      "SELECT profile_id, account_id FROM pending_open_sessions ORDER BY created_at, profile_id LIMIT 1",
    ).get();
    if (open) this.getOpen(open.profile_id, open.account_id);
  }

  close(): void {
    this.db.close();
    this.key.fill(0);
  }

  enqueue(input: PendingCloseInput): string {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative safe integer");
    }
    const id = randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad(id, input.accountId, input.profileId, input.expectedVersion));
    const plaintext = Buffer.from(JSON.stringify({
      registrationId: input.registrationId,
      payload: input.payload,
    } satisfies EncryptedPendingClose));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const authTag = cipher.getAuthTag();
    const now = Date.now();
    const readyToSubmit = input.readyToSubmit !== false;
    const write = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO pending_closes
          (id, account_id, profile_id, expected_version, ready_to_submit, status,
           nonce, ciphertext, auth_tag, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(
        id,
        input.accountId,
        input.profileId,
        input.expectedVersion,
        readyToSubmit ? 1 : 0,
        nonce,
        ciphertext,
        authTag,
        now,
        now,
      );
      if (!readyToSubmit) {
        this.db.query(`
          DELETE FROM pending_closes
          WHERE account_id = ? AND profile_id = ? AND ready_to_submit = 0 AND id != ?
        `).run(input.accountId, input.profileId, id);
      }
    });
    write();
    return id;
  }

  list(accountId: string): PendingCloseSummary[] {
    return this.db.query<PendingRow, [string]>(`
      SELECT * FROM pending_closes
      WHERE account_id = ?
      ORDER BY created_at, id
    `).all(accountId).map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      expectedVersion: row.expected_version,
      readyToSubmit: row.ready_to_submit === 1,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error,
    }));
  }

  get(id: string, accountId: string): PendingClose | null {
    const row = this.db.query<PendingRow, [string, string]>(
      "SELECT * FROM pending_closes WHERE id = ? AND account_id = ?",
    ).get(id, accountId);
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, asBuffer(row.nonce));
    decipher.setAAD(aad(row.id, row.account_id, row.profile_id, row.expected_version));
    decipher.setAuthTag(asBuffer(row.auth_tag));
    const plaintext = Buffer.concat([
      decipher.update(asBuffer(row.ciphertext)),
      decipher.final(),
    ]);
    try {
      const encrypted = JSON.parse(plaintext.toString("utf8")) as EncryptedPendingClose;
      return {
        id: row.id,
        accountId: row.account_id,
        profileId: row.profile_id,
        registrationId: encrypted.registrationId,
        expectedVersion: row.expected_version,
        payload: encrypted.payload,
        readyToSubmit: row.ready_to_submit === 1,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        error: row.error,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  markRetrying(id: string, accountId: string, error: string | null = null): boolean {
    return this.db.query(`
      UPDATE pending_closes
      SET status = 'retrying', error = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND status != 'conflict'
    `).run(error, Date.now(), id, accountId).changes === 1;
  }

  markReady(id: string, accountId: string): boolean {
    return this.db.query(`
      UPDATE pending_closes
      SET ready_to_submit = 1, updated_at = ?
      WHERE id = ? AND account_id = ? AND status != 'conflict'
    `).run(Date.now(), id, accountId).changes === 1;
  }

  markConflict(id: string, accountId: string, error: string): boolean {
    return this.updateStatus(id, accountId, "conflict", error);
  }

  remove(id: string, accountId: string): boolean {
    return this.db.query(
      "DELETE FROM pending_closes WHERE id = ? AND account_id = ?",
    ).run(id, accountId).changes === 1;
  }

  recordOpen(input: {
    accountId: string;
    profileId: string;
    registrationId: string;
    expectedVersion: number;
  }): void {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative safe integer");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(openAad(input.accountId, input.profileId, input.expectedVersion));
    const plaintext = Buffer.from(JSON.stringify({ registrationId: input.registrationId }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const authTag = cipher.getAuthTag();
    const now = Date.now();
    this.db.query(`
      INSERT INTO pending_open_sessions
        (account_id, profile_id, expected_version, phase, debug_port, started_at,
         nonce, ciphertext, auth_tag, created_at, updated_at)
      VALUES (?, ?, ?, 'opening', NULL, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, profile_id) DO UPDATE SET
        expected_version = excluded.expected_version,
        phase = 'opening',
        debug_port = NULL,
        started_at = NULL,
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(
      input.accountId,
      input.profileId,
      input.expectedVersion,
      nonce,
      ciphertext,
      authTag,
      now,
      now,
    );
  }

  getOpen(profileId: string, accountId: string): PendingOpenSession | null {
    const row = this.db.query<PendingOpenRow, [string, string]>(`
      SELECT * FROM pending_open_sessions WHERE profile_id = ? AND account_id = ?
    `).get(profileId, accountId);
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, asBuffer(row.nonce));
    decipher.setAAD(openAad(row.account_id, row.profile_id, row.expected_version));
    decipher.setAuthTag(asBuffer(row.auth_tag));
    const plaintext = Buffer.concat([
      decipher.update(asBuffer(row.ciphertext)),
      decipher.final(),
    ]);
    try {
      const encrypted = JSON.parse(plaintext.toString("utf8")) as { registrationId?: unknown };
      if (typeof encrypted.registrationId !== "string" || !encrypted.registrationId) {
        throw new Error("pending open registration is invalid");
      }
      return {
        accountId: row.account_id,
        profileId: row.profile_id,
        registrationId: encrypted.registrationId,
        expectedVersion: row.expected_version,
        phase: row.phase,
        debugPort: row.debug_port,
        startedAt: row.started_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  listOpens(accountId: string): PendingOpenSession[] {
    return this.db.query<{ profile_id: string }, [string]>(`
      SELECT profile_id FROM pending_open_sessions
      WHERE account_id = ? ORDER BY created_at, profile_id
    `).all(accountId).map((row) => this.getOpen(row.profile_id, accountId)!);
  }

  listAllOpens(): PendingOpenSession[] {
    return this.db.query<{ profile_id: string; account_id: string }, []>(`
      SELECT profile_id, account_id FROM pending_open_sessions
      ORDER BY created_at, account_id, profile_id
    `).all().map((row) => this.getOpen(row.profile_id, row.account_id)!);
  }

  updateOpen(
    profileId: string,
    accountId: string,
    phase: PendingOpenPhase,
    launch?: { debugPort: number; startedAt: number },
  ): boolean {
    return this.db.query(`
      UPDATE pending_open_sessions
      SET phase = ?, debug_port = ?, started_at = ?, updated_at = ?
      WHERE profile_id = ? AND account_id = ?
    `).run(
      phase,
      launch?.debugPort ?? null,
      launch?.startedAt ?? null,
      Date.now(),
      profileId,
      accountId,
    ).changes === 1;
  }

  removeOpen(profileId: string, accountId: string): boolean {
    return this.db.query(`
      DELETE FROM pending_open_sessions WHERE profile_id = ? AND account_id = ?
    `).run(profileId, accountId).changes === 1;
  }

  private updateStatus(
    id: string,
    accountId: string,
    status: PendingSyncStatus,
    error: string | null,
  ): boolean {
    return this.db.query(`
      UPDATE pending_closes
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ? AND account_id = ?
    `).run(status, error, Date.now(), id, accountId).changes === 1;
  }
}

export interface PendingSyncInitialization {
  queue: PendingSyncQueue;
  createdKey?: string;
}

function queueStateExists(path: string): boolean {
  return existsSync(path) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
}

function queueHasEncryptedState(path: string): boolean {
  if (!existsSync(path)) return false;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const closes = db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM pending_closes",
    ).get()?.count ?? 0;
    const opens = db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM pending_open_sessions",
    ).get()?.count ?? 0;
    return closes > 0 || opens > 0;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

function decodeQueueKey(encodedKey: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new Error("pending sync encryption key must be base64-encoded AES-256 key material");
  }
  return Buffer.from(encodedKey, "base64");
}

export class PendingSyncRuntime {
  private queueValue: PendingSyncQueue | undefined;

  constructor(private readonly path: string) {}

  queue(): PendingSyncQueue | undefined {
    return this.queueValue;
  }

  hasStoredState(): boolean {
    return queueStateExists(this.path);
  }

  initialize(encodedKey?: string): PendingSyncInitialization {
    if (!encodedKey && queueStateExists(this.path) && queueHasEncryptedState(this.path)) {
      throw new Error("an existing pending queue requires its stored encryption key");
    }

    const key = encodedKey ? decodeQueueKey(encodedKey) : randomBytes(32);
    const createdKey = encodedKey ? undefined : key.toString("base64");
    let candidate: PendingSyncQueue | undefined;
    try {
      candidate = new PendingSyncQueue(this.path, key);
      candidate.assertEncryptionKey();
      this.queueValue?.close();
      this.queueValue = candidate;
      return { queue: candidate, createdKey };
    } catch (error) {
      candidate?.close();
      throw error;
    } finally {
      key.fill(0);
    }
  }

  close(): void {
    this.queueValue?.close();
    this.queueValue = undefined;
  }
}

export interface PendingCloseSubmitter {
  closeOpen(
    registrationId: string,
    request: CloseOpenRequest,
  ): Promise<CloseOpenResponse | CloseOpenConflict>;
}

export interface PendingSyncRetryResult {
  accepted: number;
  conflicts: number;
  failed: number;
}

const TERMINAL_PENDING_CLOSE_ERRORS = new Set([
  "device_revoked",
  "membership_revoked",
  "workspace_conflict",
  "profile_not_found",
  "profile_trashed",
  "validation_failed",
]);

/** Retry queued closes in order for the currently authenticated account only. */
export async function retryPendingSync(
  queue: PendingSyncQueue,
  cloud: PendingCloseSubmitter,
  accountId: string,
): Promise<PendingSyncRetryResult> {
  const result: PendingSyncRetryResult = { accepted: 0, conflicts: 0, failed: 0 };
  for (const summary of queue.list(accountId)) {
    if (summary.status === "conflict" || !summary.readyToSubmit) continue;
    const pending = queue.get(summary.id, accountId);
    if (!pending) continue;
    queue.markRetrying(pending.id, accountId);
    try {
      const response = await cloud.closeOpen(pending.registrationId, {
        expectedVersion: pending.expectedVersion,
        payload: pending.payload,
      });
      if (response.ok) {
        queue.remove(pending.id, accountId);
        result.accepted++;
      } else {
        queue.markConflict(
          pending.id,
          accountId,
          `version conflict (current version ${response.error.currentVersion})`,
        );
        result.conflicts++;
      }
    } catch (error) {
      if (error instanceof CloudApiError && TERMINAL_PENDING_CLOSE_ERRORS.has(error.code)) {
        queue.markConflict(pending.id, accountId, error.code);
        result.conflicts++;
        continue;
      }
      queue.markRetrying(pending.id, accountId, "transport_error");
      result.failed++;
      break;
    }
  }
  return result;
}

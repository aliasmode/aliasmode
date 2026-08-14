import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudApiError } from "./cloud-client.ts";
import { PendingSyncQueue, PendingSyncRuntime, retryPendingSync } from "./pending-sync.ts";
import type { PortableProfileV1 } from "./contracts/cloud-v1.ts";

function payload(secret = "very-secret-cookie"): PortableProfileV1 {
  return {
    schemaVersion: 1,
    profile: {
      id: "profile1",
      accId: "",
      name: "Profile",
      group: "",
      platform: "x.com",
      username: "user",
      password: "password",
      email: "",
      emailPassword: "",
      twofa: "",
      proxy: null,
      extensionAssignments: [],
      tags: [],
      ua: "ua",
      timezone: "UTC",
      screenWidth: 1920,
      screenHeight: 1080,
      fingerprintSeed: 1,
    },
    session: {
      cookies: [{ name: "auth", value: secret, domain: ".x.com", path: "/" }],
    },
  };
}

function queue() {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-")), "pending.sqlite");
  return { path, queue: new PendingSyncQueue(path, new Uint8Array(32).fill(7)) };
}

test("pending sync queue encrypts close payloads at rest and decrypts for the same account", () => {
  const state = queue();
  const id = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration-secret",
    expectedVersion: 3,
    payload: payload(),
  });

  expect(state.queue.list("account1")).toMatchObject([{ id, profileId: "profile1", status: "pending" }]);
  expect(state.queue.get(id, "another-account")).toBeNull();
  expect(state.queue.get(id, "account1")).toMatchObject({
    registrationId: "registration-secret",
    expectedVersion: 3,
    payload: { session: { cookies: [{ value: "very-secret-cookie" }] } },
  });
  state.queue.close();

  const databaseBytes = readFileSync(state.path).toString("utf8");
  expect(databaseBytes).not.toContain("very-secret-cookie");
  expect(databaseBytes).not.toContain("registration-secret");
});

test("pending sync queue keeps conflicts terminal until explicitly removed", () => {
  const state = queue();
  const id = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  expect(state.queue.markRetrying(id, "account1", "offline")).toBe(true);
  expect(state.queue.markConflict(id, "account1", "current version is 3")).toBe(true);
  expect(state.queue.markRetrying(id, "account1", "must stay terminal")).toBe(false);
  expect(state.queue.list("account1")[0]).toMatchObject({
    status: "conflict",
    error: "current version is 3",
  });
  expect(state.queue.remove(id, "another-account")).toBe(false);
  expect(state.queue.remove(id, "account1")).toBe(true);
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
});

test("pending sync queue detects ciphertext tampering", () => {
  const state = queue();
  const id = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  const db = new Database(state.path);
  db.query("UPDATE pending_closes SET ciphertext = ? WHERE id = ?").run(new Uint8Array([1, 2, 3]), id);
  db.close();
  expect(() => state.queue.get(id, "account1")).toThrow();
  state.queue.close();
});

test("pending sync retry accepts first valid closes and preserves conflicts", async () => {
  const state = queue();
  const acceptedId = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "accepted-registration",
    expectedVersion: 2,
    payload: payload(),
  });
  await Bun.sleep(2);
  const conflictId = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile2",
    registrationId: "stale-registration",
    expectedVersion: 4,
    payload: { ...payload(), profile: { ...payload().profile, id: "profile2" } },
  });
  const seen: string[] = [];
  const result = await retryPendingSync(state.queue, {
    async closeOpen(registrationId) {
      seen.push(registrationId);
      return registrationId === "accepted-registration"
        ? { ok: true, status: "accepted", version: 3 }
        : {
            ok: false,
            error: { code: "version_conflict", message: "stale", currentVersion: 5 },
          };
    },
  }, "account1");

  expect(result).toEqual({ accepted: 1, conflicts: 1, failed: 0 });
  expect(seen).toEqual(["accepted-registration", "stale-registration"]);
  expect(state.queue.get(acceptedId, "account1")).toBeNull();
  expect(state.queue.get(conflictId, "account1")?.status).toBe("conflict");
  state.queue.close();
});

test("concurrent pending retries report only durable accepted transitions", async () => {
  const state = queue();
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const cloud = {
    async closeOpen() {
      calls++;
      await blocked;
      return { ok: true as const, status: "accepted" as const, version: 3 };
    },
  };

  const first = retryPendingSync(state.queue, cloud, "account1");
  const second = retryPendingSync(state.queue, cloud, "account1");
  while (calls < 2) await Bun.sleep(1);
  release();
  const results = await Promise.all([first, second]);
  expect(results.reduce((count, result) => count + result.accepted, 0)).toBe(1);
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
});

test("pending sync retry surfaces terminal API errors and continues with later closes", async () => {
  const state = queue();
  const terminalId = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "invalid-registration",
    expectedVersion: 2,
    payload: payload(),
  });
  await Bun.sleep(2);
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile2",
    registrationId: "valid-registration",
    expectedVersion: 3,
    payload: { ...payload(), profile: { ...payload().profile, id: "profile2" } },
  });
  const seen: string[] = [];
  const result = await retryPendingSync(state.queue, {
    async closeOpen(registrationId) {
      seen.push(registrationId);
      if (registrationId === "invalid-registration") {
        throw new CloudApiError("invalid payload", "validation_failed", 400);
      }
      return { ok: true, status: "accepted", version: 4 };
    },
  }, "account1");
  expect(result).toEqual({ accepted: 1, conflicts: 1, failed: 0 });
  expect(seen).toEqual(["invalid-registration", "valid-registration"]);
  expect(state.queue.get(terminalId, "account1")).toMatchObject({
    status: "conflict",
    error: "validation_failed",
  });
  state.queue.close();
});

test("pending sync retry stops after transport failure without losing payload", async () => {
  const state = queue();
  const id = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  expect(await retryPendingSync(state.queue, {
    async closeOpen() { throw new Error("offline"); },
  }, "account1")).toEqual({ accepted: 0, conflicts: 0, failed: 1 });
  expect(state.queue.get(id, "account1")).toMatchObject({
    status: "retrying",
    error: "transport_error",
    registrationId: "registration1",
  });
  state.queue.close();
});

test("pending sync runtime creates and restores a queue encryption key", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-runtime-")), "pending.sqlite");
  const first = new PendingSyncRuntime(path);
  const initialized = first.initialize();
  expect(initialized.createdKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  const id = initialized.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  first.close();

  const restored = new PendingSyncRuntime(path);
  const reopened = restored.initialize(initialized.createdKey);
  expect(reopened.createdKey).toBeUndefined();
  expect(reopened.queue.get(id, "account1")?.registrationId).toBe("registration1");
  restored.close();
});

test("pending sync runtime rejects malformed queue keys", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-runtime-")), "pending.sqlite");
  const runtime = new PendingSyncRuntime(path);
  expect(() => runtime.initialize("not-base64")).toThrow("base64-encoded AES-256");
  expect(runtime.queue()).toBeUndefined();
});

test("pending sync runtime safely regenerates a lost key only for an empty queue", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-runtime-")), "pending.sqlite");
  const first = new PendingSyncRuntime(path);
  const firstKey = first.initialize().createdKey!;
  first.close();

  const recovered = new PendingSyncRuntime(path);
  const replacementKey = recovered.initialize().createdKey!;
  expect(replacementKey).not.toBe(firstKey);
  expect(recovered.queue()?.list("account1")).toEqual([]);
  recovered.close();
});

test("pending sync runtime requires the stored key for an existing queue", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-runtime-")), "pending.sqlite");
  const first = new PendingSyncRuntime(path);
  first.initialize().queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  first.close();

  const restored = new PendingSyncRuntime(path);
  expect(() => restored.initialize()).toThrow("requires its stored encryption key");
  expect(restored.queue()).toBeUndefined();
});

test("pending sync runtime rejects a wrong key without replacing queued data", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-runtime-")), "pending.sqlite");
  const first = new PendingSyncRuntime(path);
  const initialized = first.initialize();
  const id = initialized.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload(),
  });
  first.close();

  const wrongKey = Buffer.alloc(32, 9).toString("base64");
  const rejected = new PendingSyncRuntime(path);
  expect(() => rejected.initialize(wrongKey)).toThrow();
  expect(rejected.queue()).toBeUndefined();

  const restored = new PendingSyncRuntime(path);
  const reopened = restored.initialize(initialized.createdKey);
  expect(reopened.queue.get(id, "account1")?.registrationId).toBe("registration1");
  restored.close();
});

test("pending sync keeps captures unready until browser teardown is confirmed", async () => {
  const state = queue();
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "old-registration",
    expectedVersion: 2,
    payload: payload("old-cookie"),
    readyToSubmit: false,
  });
  const replacementId = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 2,
    payload: payload("latest-cookie"),
    readyToSubmit: false,
  });
  expect(state.queue.list("account1")).toMatchObject([{
    id: replacementId,
    readyToSubmit: false,
  }]);
  let submitted = 0;
  expect(await retryPendingSync(state.queue, {
    async closeOpen() { submitted++; return { ok: true, status: "accepted", version: 3 }; },
  }, "account1")).toEqual({ accepted: 0, conflicts: 0, failed: 0 });
  expect(submitted).toBe(0);

  expect(state.queue.markReady(replacementId, "account1")).toBe(true);
  expect(await retryPendingSync(state.queue, {
    async closeOpen(registrationId, request) {
      submitted++;
      expect(registrationId).toBe("registration1");
      expect(request.payload.session.cookies[0]?.value).toBe("latest-cookie");
      return { ok: true, status: "accepted", version: 3 };
    },
  }, "account1")).toEqual({ accepted: 1, conflicts: 0, failed: 0 });
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
});

test("pending sync encrypts durable Cloud open registrations", () => {
  const state = queue();
  state.queue.recordOpen({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration-secret",
    expectedVersion: 4,
  });
  expect(state.queue.getOpen("profile1", "account1")).toMatchObject({
    registrationId: "registration-secret",
    expectedVersion: 4,
    phase: "opening",
    debugPort: null,
  });
  expect(state.queue.updateOpen("profile1", "account1", "running", {
    debugPort: 9222,
    startedAt: 1234,
  })).toBe(true);
  expect(state.queue.listOpens("account1")).toMatchObject([{
    profileId: "profile1",
    phase: "running",
    debugPort: 9222,
    startedAt: 1234,
  }]);
  expect(state.queue.getOpen("profile1", "another-account")).toBeNull();
  state.queue.close();
  expect(readFileSync(state.path).toString("utf8")).not.toContain("registration-secret");
});

test("pending open removal can be fenced to its registration", () => {
  const state = queue();
  state.queue.recordOpen({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 1,
  });

  expect(state.queue.removeOpenRegistration("profile1", "account1", "replacement")).toBe(false);
  expect(state.queue.getOpen("profile1", "account1")?.registrationId).toBe("registration1");
  expect(state.queue.removeOpenRegistration("profile1", "account1", "registration1")).toBe(true);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  state.queue.close();
});

test("pending open checkpoint finalization is atomic and registration-fenced", () => {
  const state = queue();
  state.queue.recordOpen({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 1,
  });
  const checkpointId = state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 1,
    payload: payload(),
    readyToSubmit: false,
  });

  expect(state.queue.finalizeOpenCheckpoint("profile1", "account1", "replacement")).toBe(false);
  expect(state.queue.getOpen("profile1", "account1")?.registrationId).toBe("registration1");
  expect(state.queue.get(checkpointId, "account1")?.readyToSubmit).toBe(false);

  expect(state.queue.finalizeOpenCheckpoint("profile1", "account1", "registration1")).toBe(true);
  expect(state.queue.getOpen("profile1", "account1")).toBeNull();
  expect(state.queue.get(checkpointId, "account1")?.readyToSubmit).toBe(true);
  state.queue.close();
});

test("pending opens encrypt cleanup intent and fence updates to the registration", () => {
  const state = queue();
  state.queue.recordOpen({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration-secret",
    expectedVersion: 1,
  });

  expect(state.queue.setOpenCleanup("profile1", "account1", "replacement", "discard")).toBe(false);
  expect(state.queue.setOpenCleanup(
    "profile1",
    "account1",
    "registration-secret",
    "discard",
  )).toBe(true);
  expect(state.queue.getOpen("profile1", "account1")?.cleanupMode).toBe("discard");
  state.queue.close();
  expect(readFileSync(state.path).toString("utf8")).not.toContain("discard");
});

test("pending checkpoint removal is registration-fenced", () => {
  const state = queue();
  state.queue.enqueue({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 1,
    payload: payload("checkpoint"),
    readyToSubmit: false,
  });

  expect(state.queue.removeUnreadyCaptures("profile1", "account1", "replacement")).toBe(0);
  expect(state.queue.list("account1")).toHaveLength(1);
  expect(state.queue.removeUnreadyCaptures("profile1", "account1", "registration1")).toBe(1);
  expect(state.queue.list("account1")).toEqual([]);
  state.queue.close();
});

test("pending sync queue requires an AES-256 key", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-pending-")), "pending.sqlite");
  expect(() => new PendingSyncQueue(path, new Uint8Array(16))).toThrow("32 bytes");
});

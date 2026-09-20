import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";
import { importBuffers, ProfileImportError } from "./inbox.ts";
import type { Launcher } from "./launcher.ts";

const stores: ProfileStore[] = [];
const roots: string[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  // Bun's transaction statements release file handles only after collection.
  Bun.gc(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-trash-"));
  roots.push(dir);
  const path = join(dir, "profiles.sqlite");
  const store = new ProfileStore(path); stores.push(store);
  const profile = { ...buildNewProfile({ name: "Retain me", group: "original" }, () => false), id: "p1", password: "fixture-password", cookies: [{ name: "session", value: "fixture-cookie", domain: ".example.com", path: "/" }] };
  store.upsertProfile(profile); store.saveSessionBundle("p1", "fixture-session");
  const data = join(dir, "p1"); mkdirSync(data); writeFileSync(join(data, "browser-data"), "retained");
  const blocked = new Set<string>();
  const launcher = {
    profileDeletionBlocked: (id: string) => blocked.has(id),
    removeUserDataDir: (id: string) => { rmSync(join(dir, id), { recursive: true, force: true }); return true; },
  } as unknown as Launcher;
  const request = (path: string, body?: unknown, options: UiRuntimeOptions = {}) => handleUiRequest(new Request(`http://localhost/ui/api/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), launcher, store, null, options).then((r) => r!);
  return { dir, path, data, store, profile, launcher, blocked, request };
}

test("existing databases migrate active profiles without changing their data", () => {
  const { store, path } = fixture();
  const before = store.getProfile("p1"), serial = store.getSerial("p1");
  const database = new Database(path);
  database.exec("ALTER TABLE profiles DROP COLUMN trashed_at");
  database.close();
  const migrated = new ProfileStore(path); stores.push(migrated);
  expect(migrated.getProfile("p1")).toEqual(before);
  expect(migrated.getSerial("p1")).toBe(serial);
  expect(migrated.listTrashed()).toEqual([]);
  expect(migrated.getSessionBundle("p1")).toBe("fixture-session");
  expect(migrated.trashProfile("p1")).toBe(true);
});

test("user-retained Trash entries leave temporary profile cleanup", () => {
  const { store } = fixture();
  store.markAgentTemporary("p1");
  expect(store.listAgentTemporary()).toEqual(["p1"]);
  store.trashProfile("p1");
  expect(store.listAgentTemporary()).toEqual([]);
  store.restoreProfile("p1");
  expect(store.getProfile("p1")).not.toBeNull();
});

test("Local trash hides active entries and restores the same serial, identity, and saved data", () => {
  const { store } = fixture();
  const original = store.getProfile("p1")!, serial = store.getSerial("p1");
  expect(store.trashProfile("p1")).toBe(true);
  expect(store.getProfile("p1")).toBeNull();
  expect(store.listProfiles()).toEqual([]);
  expect(store.listUserRecords()).toEqual([]);
  expect(store.listProfileMeta().size).toBe(0);
  expect(store.count()).toBe(0);
  expect(store.listTrashed()[0]!.trashedAt).toBeGreaterThan(0);
  expect(store.restoreProfile("p1")).toBe(true);
  expect(store.getProfile("p1")).toEqual(original);
  expect(store.getSerial("p1")).toBe(serial);
  expect(store.getSessionBundle("p1")).toBe("fixture-session");
});

test("re-import cannot overwrite a trashed profile and group edits leave its saved data unchanged", () => {
  const { store, profile } = fixture();
  store.trashProfile("p1");
  expect(() => store.upsertProfile({ ...profile, name: "overwrite" })).toThrow("Trash");
  store.renameGroup("original", "renamed");
  store.deleteGroup("original");
  expect(store.listTrashed()[0]!.group).toBe("original");
  store.restoreProfile("p1");
  expect(store.getProfile("p1")!.name).toBe("Retain me");
  expect(store.listGroups()).toContain("original");
});

test("imports report a recoverable Trash conflict before the atomic write", async () => {
  const { store } = fixture();
  store.trashProfile("p1");
  let error: unknown;
  try {
    await importBuffers(store, [{ name: "profiles.csv", bytes: new TextEncoder().encode("id,name\np1,replaced\np2,new\n") }], () => {});
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ProfileImportError);
  expect((error as ProfileImportError).status).toBe(409);
  expect((error as Error).message).toContain("Trash");
  expect(store.getProfile("p2")).toBeNull();
  store.restoreProfile("p1");
  expect(store.getProfile("p1")!.name).toBe("Retain me");
});

test("trash survives reopening the database without exposing retained secrets", () => {
  const { store, path } = fixture();
  store.trashProfile("p1");
  const reopened = new ProfileStore(path); stores.push(reopened);
  expect(reopened.listProfiles()).toEqual([]);
  const trash = reopened.listTrashed();
  expect(trash.map((p) => p.id)).toEqual(["p1"]);
  expect(JSON.stringify(trash)).not.toContain("fixture-password");
  expect(JSON.stringify(trash)).not.toContain("fixture-cookie");
  reopened.restoreProfile("p1");
  expect(reopened.getSessionBundle("p1")).toBe("fixture-session");
});

test("dashboard deletion preserves the browser directory; explicit purge removes it", async () => {
  const { store, data, request } = fixture();
  expect((await request("profiles/delete", { ids: ["p1"] })).status).toBe(200);
  expect(existsSync(data)).toBe(true);
  const listed = await (await request("trash")).json();
  expect(listed.profiles[0]).toMatchObject({ id: "p1", canRestore: true, canPurge: true });
  expect((await request("trash/restore", { ids: ["p1"] })).status).toBe(200);
  expect(store.getProfile("p1")).not.toBeNull();
  await request("profiles/delete", { ids: ["p1"] });
  const purged = await (await request("trash/purge", { ids: ["p1"] })).json();
  expect(purged.results).toEqual([{ id: "p1", status: "purged" }]);
  expect(existsSync(data)).toBe(false);
  expect(store.listTrashed()).toEqual([]);
});

test("purge requires a trashed, closed profile and retains its row when disk deletion fails", async () => {
  const { store, data, request, blocked, launcher } = fixture();
  const active = await (await request("trash/purge", { ids: ["p1"] })).json();
  expect(active.results[0]!.status).toBe("failed");
  expect(existsSync(data)).toBe(true);
  blocked.add("p1");
  expect((await request("profiles/delete", { ids: ["p1"] })).status).toBe(409);
  blocked.clear(); await request("profiles/delete", { ids: ["p1"] });
  launcher.removeUserDataDir = () => { throw new Error("disk failure"); };
  const failed = await (await request("trash/purge", { ids: ["p1"] })).json();
  expect(failed.results[0]!.status).toBe("failed");
  expect(store.listTrashed()).toHaveLength(1);
  expect(existsSync(data)).toBe(true);
});

test("purge rechecks that a profile is still in Trash after reading the request body", async () => {
  const { store, data, launcher } = fixture();
  store.trashProfile("p1");
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let listed!: () => void;
  const listing = new Promise<void>((resolve) => { listed = resolve; });
  const listTrashed = store.listTrashed.bind(store);
  store.listTrashed = () => { const rows = listTrashed(); listed(); return rows; };
  const pending = handleUiRequest(new Request("http://localhost/ui/api/trash/purge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }),
  }), launcher, store);
  await listing;
  store.restoreProfile("p1");
  body.enqueue(new TextEncoder().encode('{"ids":["p1"]}')); body.close();
  const result = await (await pending)!.json();
  expect(result.results).toEqual([{ id: "p1", status: "failed", code: "not_in_trash" }]);
  expect(store.getProfile("p1")).not.toBeNull();
  expect(existsSync(data)).toBe(true);
});

test("Cloud Trash uses authoritative summaries and owner-only purge", async () => {
  const { request } = fixture();
  let role = "member", permission = "view", version = 7;
  const calls: unknown[] = [];
  const options = {
    cloudBrowser: {},
    cloudConnection: {
      accountId: () => "account",
      client: {
        status: async () => ({ account: { id: "account" }, workspace: { id: "workspace", role } }),
        listProfiles: async () => ({ profiles: [{ id: "cloud1", name: "Cloud", group: "shared", trashedAt: 100, permission, version, activeOpens: [] }, { id: "active", trashedAt: null }] }),
        restoreProfile: async (...args: unknown[]) => { calls.push(args); },
        purgeProfile: async (...args: unknown[]) => { calls.push(args); },
      },
    },
  } as unknown as UiRuntimeOptions;
  const listed = await (await request("trash", undefined, options)).json();
  expect(listed.profiles).toHaveLength(1);
  expect(listed.profiles[0]).toMatchObject({ canRestore: false, canPurge: false, version: 7 });
  await request("trash/purge", { ids: ["cloud1"] }, options);
  expect(calls).toEqual([]);
  permission = "edit";
  await request("trash/restore", { ids: ["cloud1"] }, options);
  expect(calls).toEqual([["cloud1", { expectedVersion: 7 }]]);
  role = "owner"; version = 8;
  await request("trash/purge", { ids: ["cloud1"] }, options);
  expect(calls.at(-1)).toEqual(["cloud1", 8]);
});

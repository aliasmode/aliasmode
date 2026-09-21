import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";
import { importBuffers, ProfileImportError } from "./inbox.ts";
import { CloudApiError } from "./cloud-client.ts";
import type { Launcher } from "./launcher.ts";

const stores: ProfileStore[] = [];
const roots: string[] = [];
async function removeFixtureRoot(root: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      Bun.gc(true);
      await Bun.sleep(100);
    }
  }
  rmSync(root, { recursive: true, force: true });
}
afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  // Bun's transaction statements release file handles only after collection.
  Bun.gc(true);
  for (const root of roots.splice(0)) await removeFixtureRoot(root);
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

test("Cloud Trash listing does not wait for mutation transitions and discards account changes", async () => {
  const { request } = fixture();
  let account = "account", switchAccount = false;
  const options = {
    cloudAuth: { acquireTransition: async () => { throw new Error("GET must not queue behind a proxy run"); } },
    cloudBrowser: {}, cloudConnection: {
      accountId: () => account, client: {
        status: async () => ({ account: { id: account }, workspace: { role: "owner" } }),
        listProfiles: async () => {
          if (switchAccount) account = "different";
          return { profiles: [{ id: "cloud1", name: "Deleted", group: "Sales", trashedAt: 100, permission: "edit", version: 7 }] };
        },
      },
    },
  } as unknown as UiRuntimeOptions;
  expect((await request("trash", undefined, options)).status).toBe(200);
  switchAccount = true;
  const response = await request("trash", undefined, options);
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toContain("cloud1");
});

test("900 Local profiles move to Trash and restore in one request each", async () => {
  const { store, profile, request } = fixture();
  const ids = Array.from({ length: 900 }, (_, i) => `bulk${i}`);
  for (const id of ids) store.upsertProfile({ ...profile, id });
  expect(await (await request("profiles/delete", { ids })).json()).toMatchObject({ ok: true, deleted: 900 });
  expect(store.listTrashed()).toHaveLength(900);
  const restored = await (await request("trash/restore", { ids })).json();
  expect(restored.results).toEqual(ids.map((id) => ({ id, status: "restored" })));
  expect(store.listTrashed()).toHaveLength(0);
  expect(store.count()).toBe(901);
});

for (const action of ["delete", "restore", "purge"] as const) {
  test(`Cloud bulk ${action} processes 900 IDs concurrently from one summary read`, async () => {
    const { request } = fixture();
    const ids = Array.from({ length: 900 }, (_, i) => `bulk${i}`);
    let rosterReads = 0, fullReads = 0, active = 0, peak = 0;
    const calls: string[] = [];
    const mutate = async (id: string, input: { expectedVersion: number } | number) => {
      expect(typeof input === "number" ? input : input.expectedVersion).toBe(7);
      peak = Math.max(peak, ++active);
      await Bun.sleep(1);
      active--; calls.push(id);
    };
    const options = {
      cloudBrowser: {}, cloudConnection: {
        accountId: () => "account", client: {
          status: async () => ({ account: { id: "account" }, workspace: { role: "owner" } }),
          listProfiles: async () => { rosterReads++; return { profiles: ids.map((id) => ({ id, name: id, group: "Sales", version: 7, permission: "edit", activeOpens: [], trashedAt: action === "delete" ? null : 100 })) }; },
          getProfile: async () => { fullReads++; throw new Error("Full payload must not be downloaded"); },
          trashProfile: mutate, restoreProfile: mutate, purgeProfile: mutate,
        },
      },
    } as unknown as UiRuntimeOptions;
    const result = await (await request(action === "delete" ? "profiles/delete" : `trash/${action}`, { ids: [...ids, ids[0]] }, options)).json();
    expect(result.ok).toBe(true);
    if (action === "delete") expect(result).toEqual({ ok: true, deleted: 900, locked: [], failed: [] });
    else expect(result.results).toEqual(ids.map((id) => ({ id, status: action === "restore" ? "restored" : "purged" })));
    expect(new Set(calls)).toEqual(new Set(ids));
    expect(calls).toHaveLength(900);
    expect(rosterReads).toBe(1); expect(fullReads).toBe(0);
    expect(peak).toBe(4);
  });

  test(`Cloud bulk ${action} stops scheduling after an account transition`, async () => {
    const { request } = fixture();
    let current = true, released = false;
    const calls: string[] = [];
    const ids = Array.from({ length: 20 }, (_, i) => `bulk${i}`);
    const mutate = async (id: string) => {
      calls.push(id); await Bun.sleep(1); current = false;
    };
    const options = {
      cloudAuth: { acquireTransition: async () => ({ release: () => { released = true; } }), isTransitionCurrent: () => current },
      cloudBrowser: {}, cloudConnection: {
        accountId: () => "account", client: {
          status: async () => ({ account: { id: "account" }, workspace: { role: "owner" } }),
          listProfiles: async () => ({ profiles: ids.map((id) => ({ id, version: 7, permission: "edit", activeOpens: [], trashedAt: action === "delete" ? null : 100 })) }),
          trashProfile: mutate, restoreProfile: mutate, purgeProfile: mutate,
        },
      },
    } as unknown as UiRuntimeOptions;
    const response = await request(action === "delete" ? "profiles/delete" : `trash/${action}`, { ids }, options);
    expect(response.status).toBe(409);
    expect(calls).toEqual(ids.slice(0, 4));
    expect(released).toBe(true);
  });
}

test("Cloud bulk delete retains local/remote locks, permissions, and version-conflict outcomes", async () => {
  const { request, blocked } = fixture();
  blocked.add("local");
  const ids = ["closed", "local", "remote", "stale", "view", "trashed", "missing"];
  const calls: string[] = [];
  const options = {
    cloudBrowser: {}, cloudConnection: {
      accountId: () => "account", client: {
        listProfiles: async () => ({ profiles: ids.filter((id) => id !== "missing").map((id) => ({
          id, version: 7, permission: id === "view" ? "view" : "edit", activeOpens: id === "remote" ? [{}] : [], trashedAt: id === "trashed" ? 100 : null,
        })) }),
        trashProfile: async (id: string, input: { expectedVersion: number }) => {
          expect(input.expectedVersion).toBe(7); calls.push(id);
          if (id === "stale") throw new CloudApiError("Changed", "version_conflict", 409);
        },
      },
    },
  } as unknown as UiRuntimeOptions;
  const result = await (await request("profiles/delete", { ids }, options)).json();
  expect(result).toEqual({ ok: true, deleted: 1, locked: ["local", "remote"], failed: ["stale", "view", "trashed", "missing"] });
  expect(calls).toEqual(["closed", "stale"]);
});

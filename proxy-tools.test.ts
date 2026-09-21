import { afterEach, expect, test } from "bun:test";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";
import { CloudApiError } from "./cloud-client.ts";
import type { Launcher } from "./launcher.ts";
import type { ProxyPreview, ProxyProgressEvent } from "./proxy-tools-types.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const proxy = { type: "http" as const, host: "old.example", port: "8080", user: "test-user", pass: "test-private-proxy" };
function setup(ids = ["p1", "p2"]) {
  const store = new ProfileStore(":memory:"); stores.push(store);
  for (const id of ids) store.upsertProfile({ ...buildNewProfile({ name: id, group: "folder", proxy }, () => false), id });
  const blocked = new Set<string>();
  const launcher = { profileDeletionBlocked: (id: string) => blocked.has(id) } as unknown as Launcher;
  const options: UiRuntimeOptions = {};
  const request = (action: string, body: unknown, extra: UiRuntimeOptions = options, headers = { "Content-Type": "application/json" }) =>
    handleUiRequest(new Request(`http://localhost/ui/api/proxies/${action}`, { method: "POST", headers, body: JSON.stringify(body) }), launcher, store, null, extra).then((r) => r!);
  const preview = async () => (await request("preview", { scope: { all: true }, mode: "list", input: "new.example:9000\nnew.example:9001" })).json() as Promise<ProxyPreview>;
  return { store, launcher, blocked, options, request, preview };
}
async function events(response: Response): Promise<ProxyProgressEvent[]> {
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
}

test("preview changes nothing; apply changes only the reviewed proxies and retains sessions", async () => {
  const { store, request, preview } = setup();
  store.saveSessionBundle("p1", "saved-session");
  const before = store.getProfile("p1")!;
  const result = await preview();
  expect(store.getProfile("p1")).toEqual(before);
  expect(JSON.stringify(result)).not.toContain("test-private-proxy");
  expect(result.rows.every((r) => r.status === "ready")).toBe(true);
  const output = await events(await request("apply", { previewId: result.previewId }));
  expect(output.at(-1)).toEqual({ type: "done" });
  expect(output.filter((e) => e.type === "replacement").map((e) => e.row.status)).toEqual(["updated", "updated"]);
  const after = store.getProfile("p1")!;
  expect(after.proxy!.host).toBe("new.example");
  expect(after.fingerprintSeed).toBe(before.fingerprintSeed);
  expect(after.cookies).toEqual(before.cookies);
  expect(store.getSessionBundle("p1")).toBe("saved-session");
});

test("stale and running rows are skipped independently; failed-only retry requires a new preview", async () => {
  const { store, request, preview, blocked } = setup();
  const result = await preview();
  const changed = store.getProfile("p1")!;
  changed.proxy = { ...proxy, port: "9999" }; store.upsertProfile(changed);
  blocked.add("p2");
  const output = await events(await request("apply", { previewId: result.previewId }));
  expect(output.filter((e) => e.type === "replacement").map((e) => e.row.code)).toEqual(["version_conflict", "profile_open"]);
  blocked.clear();
  const retried = await (await request("retry-preview", { previewId: result.previewId, ids: ["p2"] })).json();
  expect(retried.previewId).not.toBe(result.previewId);
  expect(retried.rows.map((r: any) => r.profileId)).toEqual(["p2"]);
  expect((await request("apply", { previewId: result.previewId })).status).toBe(409);
  await events(await request("apply", { previewId: retried.previewId }));
  expect(store.getProfile("p1")!.proxy!.port).toBe("9999");
  expect(store.getProfile("p2")!.proxy!.port).toBe("9001");
});

test("bulk replacements preserve timezone without a lookup", async () => {
  const { store, request, preview, options } = setup(["p1"]);
  const before = store.getProfile("p1")!;
  before.timezone = "America/Los_Angeles";
  store.upsertProfile(before);
  let lookups = 0;
  options.timezoneFetch = async () => { lookups++; return new Response("{}"); };
  const result = await preview();
  const output = await events(await request("apply", { previewId: result.previewId }));
  expect(output.find((e) => e.type === "replacement")?.row.status).toBe("updated");
  expect(lookups).toBe(0);
  expect(store.getProfile("p1")!.proxy!.host).toBe("new.example");
  expect(store.getProfile("p1")!.timezone).toBe("America/Los_Angeles");
});

test("bulk checks stream redacted deduplicated results without opening a browser", async () => {
  const { request, options } = setup();
  let calls = 0;
  options.proxyCheck = async () => { calls++; return { status: "working", attempts: 3, successes: 3 }; };
  const result = await request("check", { scope: { groups: ["folder"] } });
  expect(result.headers.get("cache-control")).toBe("no-store");
  const output = await events(result);
  expect(calls).toBe(1);
  expect(output).toContainEqual({ type: "summary", selectedProfiles: 2, uniqueProxies: 1, duplicatesSkipped: 1 });
  expect(output.at(-1)).toEqual({ type: "done" });
  expect(JSON.stringify(output)).not.toContain("test-private-proxy");
});

test("bulk routes enforce JSON origin checks and never use a remote launch cache", async () => {
  const { request, launcher, store } = setup();
  expect((await request("preview", {}, {}, { "Content-Type": "application/json", Origin: "https://other.example" } as any)).status).toBe(403);
  expect((await request("preview", {}, {}, { "Content-Type": "text/plain" })).status).toBe(415);
  const response = await handleUiRequest(new Request("http://localhost/ui/api/proxies/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scope":{"all":true}}' }), launcher, store, {} as any);
  expect(response!.status).toBe(400);
});

function cloudOptions(overrides: Record<string, unknown> = {}): UiRuntimeOptions {
  return {
    cloudBrowser: {} as any,
    cloudConnection: {
      accountId: () => "account1",
      client: {
        status: async () => ({ account: { id: "account1" }, workspace: { id: "workspace1", role: "owner" } }),
        listProfileProxies: async () => ({ ok: true, profiles: [{ id: "p1", name: "p1", group: "folder", proxy, version: 5, permission: "edit", activeOpens: [] }] }),
        ...overrides,
      },
    } as any,
    proxyCheck: async () => ({ status: "working", attempts: 3, successes: 3 }),
  };
}

test("Cloud checks read one narrow inventory and never fetch full profiles", async () => {
  const { request } = setup();
  let inventories = 0;
  const options = cloudOptions({
    listProfileProxies: async () => { inventories++; return { ok: true, profiles: Array.from({ length: 8000 }, (_, i) => ({ id: `p${i}`, name: String(i), group: `folder${i % 9}`, proxy, version: 5, permission: "edit", activeOpens: [] })) }; },
    getProfile: () => { throw new Error("must not download sessions"); },
  });
  const output = await events(await request("check", { scope: { all: true } }, options));
  expect(inventories).toBe(1);
  expect(output).toContainEqual({ type: "summary", selectedProfiles: 8000, uniqueProxies: 1, duplicatesSkipped: 7999 });
  expect(output.at(-1)).toEqual({ type: "done" });
});

test("Cloud without the inventory endpoint does not fall back to local cached proxies", async () => {
  const { request } = setup();
  const output = await events(await request("check", { scope: { all: true } }, cloudOptions({
    listProfileProxies: async () => { throw new CloudApiError("not found", "profile_not_found", 404); },
  })));
  expect(output.some((e) => e.type === "error")).toBe(true);
  expect(output.some((e) => e.type === "check")).toBe(false);
  expect(output.some((e) => e.type === "done")).toBe(false);
});

test("Cloud apply preserves preview versions and row indexes across batches", async () => {
  const { request } = setup();
  const calls: any[] = [];
  const inventory = Array.from({ length: 35 }, (_, i) => ({ id: `cloud${String(i).padStart(2, "0")}`, name: String(i), group: "folder", proxy, version: i + 5, permission: "edit", activeOpens: [] }));
  const options = cloudOptions({
    listProfileProxies: async () => ({ ok: true, profiles: inventory }),
    replaceProfileProxies: async (input: any) => {
      calls.push(input);
      return { ok: true, dryRun: input.dryRun, missingUsernames: [], results: input.replacements.map((row: any, index: number) => ({
        index, profileId: row.profileId, currentVersion: row.expectedVersion, status: input.dryRun ? "ready" : "updated",
      })) };
    },
  });
  const preview = await (await request("preview", { scope: { all: true }, mode: "list", input: inventory.map(() => "new.example:9000").join("\n") }, options)).json();
  inventory[0]!.version++;
  const output = await events(await request("apply", { previewId: preview.previewId }, options));
  const rows = output.filter((e) => e.type === "replacement").map((e) => e.row);
  expect(rows).toHaveLength(35);
  expect(rows[0]).toMatchObject({ index: 0, status: "skipped", code: "version_conflict" });
  expect(rows.slice(1).every((r) => r.status === "updated")).toBe(true);
  expect(rows.map((r) => r.index)).toEqual(Array.from({ length: 35 }, (_, i) => i));
  expect(calls.map((c) => c.replacements.length)).toEqual([15, 15, 16, 16, 3, 3]);
  for (const call of calls) for (const row of call.replacements) {
    expect(row.expectedVersion).toBe(inventory.find((p) => p.id === row.profileId)!.version);
    expect(row.profileId).not.toBe("cloud00");
  }
});

test("repeating apply replays completed outcomes without writing twice", async () => {
  const { request, preview, options } = setup();
  let lookups = 0;
  options.timezoneFetch = async () => { lookups++; return new Response("{}"); };
  const result = await preview();
  await events(await request("apply", { previewId: result.previewId }));
  const before = lookups;
  const replay = await events(await request("apply", { previewId: result.previewId }));
  expect(replay.filter((e) => e.type === "replacement").map((e) => e.row.status)).toEqual(["updated", "updated"]);
  expect(lookups).toBe(before);
});

test("cancelled Cloud apply retains committed rows and resumes only pending assignments", async () => {
  const { request, store, launcher } = setup();
  const controller = new AbortController();
  const writes: string[] = [];
  const inventory = Array.from({ length: 20 }, (_, i) => ({ id: `cloud${String(i).padStart(2, "0")}`, name: String(i), group: "folder", proxy, version: 5, permission: "edit", activeOpens: [] }));
  const options = cloudOptions({
    listProfileProxies: async () => ({ ok: true, profiles: inventory }),
    replaceProfileProxies: async (input: any) => {
      if (!input.dryRun) { writes.push(...input.replacements.map((r: any) => r.profileId)); controller.abort(); }
      return { ok: true, dryRun: input.dryRun, missingUsernames: [], results: input.replacements.map((row: any, index: number) => ({
        index, profileId: row.profileId, currentVersion: 5, status: input.dryRun ? "ready" : "updated",
      })) };
    },
  });
  const preview = await (await request("preview", { scope: { all: true }, mode: "list", input: inventory.map(() => "new.example:9000").join("\n") }, options)).json();
  const cancelled = await handleUiRequest(new Request("http://localhost/ui/api/proxies/apply", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
    body: JSON.stringify({ previewId: preview.previewId }),
  }), launcher, store, null, options);
  await cancelled!.text();
  expect(writes).toHaveLength(16);
  const resumed = await events(await request("apply", { previewId: preview.previewId }, options));
  expect(resumed.filter((e) => e.type === "replacement").map((e) => e.row.status)).toEqual(Array(20).fill("updated"));
  expect(writes).toHaveLength(20);
  expect(new Set(writes).size).toBe(20);
});

test("failed retry previews show the current proxy and folder without changing assignments", async () => {
  const { request, preview, store } = setup();
  const result = await preview();
  store.upsertProfile({ ...store.getProfile("p1")!, name: "Renamed", group: "new folder", proxy: { ...proxy, host: "changed.example" } });
  await events(await request("apply", { previewId: result.previewId }));
  const retry = await (await request("retry-preview", { previewId: result.previewId, ids: ["p1"] })).json();
  expect(retry.rows).toHaveLength(1);
  expect(retry.rows[0]).toMatchObject({ name: "Renamed", group: "new folder", previousProxy: "http://changed.example:8080", proxy: "http://new.example:9000", status: "ready" });
  expect(store.getProfile("p1")!.proxy!.host).toBe("changed.example");
});

test("a different Cloud account cannot apply an earlier preview", async () => {
  const { request } = setup();
  const options = cloudOptions();
  const result = await (await request("preview", { scope: { all: true }, mode: "list", input: "new.example:9000" }, options)).json();
  (options.cloudConnection!.client as any).status = async () => ({ account: { id: "account2" }, workspace: { id: "workspace2" } });
  (options.cloudConnection as any).accountId = () => "account2";
  expect((await request("apply", { previewId: result.previewId }, options)).status).toBe(409);
});

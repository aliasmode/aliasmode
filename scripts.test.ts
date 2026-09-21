import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptLibrary, ScriptSupervisor, type ScriptExecution } from "./scripts.ts";
import { handleUiRequest } from "./ui.ts";
import { CloudClient } from "./cloud-client.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), "aliasmode-scripts-")); roots.push(dir); return dir; }
const input = { name: "Visit", description: "Example", language: "javascript" as const, source: "export default async () => {};" };

function harness(execute: ScriptExecution = async () => {}, options: { active?: string[]; cloud?: any; firefoxOwner?: any } = {}) {
  const directory = root();
  const events: string[] = [];
  const launch = (id: string) => options.firefoxOwner
    ? { ws: `firefox://127.0.0.1:9000/${options.firefoxOwner.generation}`, debugPort: 9000, engine: "firefox", firefoxOwner: options.firefoxOwner }
    : { ws: `ws://test/${id}`, debugPort: 9000 };
  const launches = new Map((options.active ?? []).map((id) => [id, launch(id)]));
  const profiles = ["a", "b", "c"].map((id) => ({ id, name: id, group: "", platform: "", username: `user-${id}`, password: `test-password-${id}`, twofa: "" }));
  const library = new ScriptLibrary(directory, !!options.cloud, options.cloud);
  const supervisor = new ScriptSupervisor({
    root: directory, library, execute,
    store: { getProfile: (id: string) => profiles.find((p) => p.id === id), getLaunch: (id: string) => launches.get(id), listAgentTemporary: () => [] } as any,
    launcher: {
      certifiedActive: async (id: string) => launches.has(id),
      start: async (id: string) => { events.push(`open:${id}`); const value = launch(id); launches.set(id, value); return { ws: value.ws, port: 9000 }; },
      stop: async (id: string) => { events.push(`close:${id}`); launches.delete(id); return true; },
    } as any,
    admission: { run: async (_: unknown, work: () => Promise<unknown>) => work() } as any,
    cloudConnection: options.cloud,
  });
  return { library, supervisor, events, directory, launches };
}

test("local script imports never execute, survive reload, and check revisions", async () => {
  const h = harness();
  const script = await h.library.save(input);
  expect(h.events).toEqual([]);
  expect(await new ScriptLibrary(h.directory, false).get(script.id)).toEqual(script);
  expect(await h.library.list()).toEqual([expect.objectContaining({ id: script.id, revision: 1 })]);
  expect(JSON.stringify(await h.library.list())).not.toContain(input.source);
  await h.library.save({ ...input, name: "Updated" }, script.id, 1);
  await expect(h.library.save(input, script.id, 1)).rejects.toThrow("changed");
  await expect(h.library.delete(script.id, 1)).rejects.toThrow("changed");
  await h.library.delete(script.id, 2);
  expect(await h.library.list()).toEqual([]);
});

test("runs only selected profiles sequentially and closes only job-opened browsers", async () => {
  const calls: any[] = [];
  const h = harness(async (request) => { calls.push(request.input); }, { active: ["a"] });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: { url: "https://example.test" }, useCredentials: false });
  await h.supervisor.settled();
  expect(calls.map((call) => call.profile.id)).toEqual(["a", "b"]);
  expect(calls.every((call) => call.credentials === null)).toBe(true);
  expect(h.events).toEqual(["open:b", "close:b"]);
  expect(h.launches.has("a")).toBe(true);
  expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["succeeded", "succeeded"]);
});

test("Firefox JavaScript scripts run inside the persistent owner context", async () => {
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({ version: 1, ok: true, result: { result: null, logs: ["native output"] } });
    },
  });
  const owner = {
    endpoint: `http://127.0.0.1:${server.port}/`, token: "private-token", pid: 12, browserPid: 13, generation: "generation",
  };
  const h = harness(async () => { throw new Error("external runner must not start"); }, { firefoxOwner: owner });
  try {
    const script = await h.library.save(input);
    const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: { url: "https://example.test" }, useCredentials: false });
    await h.supervisor.settled();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "run-script",
      payload: {
        scriptPath: expect.any(String),
        ownerGeneration: "generation",
        input: { profile: { id: "a" }, inputs: { url: "https://example.test" }, credentials: null },
      },
    });
    expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
    expect(h.supervisor.log(run.id, 0).text).toContain("native output");
  } finally {
    server.stop(true);
  }
});

test("a browser reopened outside the run is not closed by script cleanup", async () => {
  const h = harness(async () => { h.launches.set("a", { ws: "ws://test/replacement", debugPort: 9001 }); });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(h.events).toEqual(["open:a"]);
  expect(h.launches.get("a")?.ws).toBe("ws://test/replacement");
  expect(h.supervisor.status()?.profiles[0]?.warning).toContain("left open");
});

test("saved login fields require opt-in and never enter status or cached scripts", async () => {
  const calls: any[] = [];
  const h = harness(async ({ input: data }) => { calls.push(data); });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["b"], inputs: {}, useCredentials: true });
  await h.supervisor.settled();
  expect(calls[0].credentials).toMatchObject({ username: "user-b", password: "test-password-b" });
  expect(JSON.stringify(h.supervisor.status())).not.toContain("test-password");
  expect(JSON.stringify(await h.library.get(script.id))).not.toContain("test-password");
});

test("Stop kills active work before close, cancels remaining profiles, and rejects overlapping runs", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const h = harness(async ({ signal }) => {
    started();
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { h.events.push("terminated"); reject(new Error("stopped")); }, { once: true }));
  });
  const script = await h.library.save(input);
  const request = { scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false };
  h.supervisor.start(request);
  await ready;
  expect(() => h.supervisor.start(request)).toThrow("already running");
  await h.supervisor.stop();
  expect(h.events).toEqual(["open:a", "terminated", "close:a"]);
  expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["cancelled", "cancelled"]);
});

test("a profile failure does not retry or skip the remaining selected profiles", async () => {
  const called: string[] = [];
  const h = harness(async ({ input: data }) => { called.push(data.profile.id); if (data.profile.id === "a") throw new Error("Script exited with code 1"); });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(called).toEqual(["a", "b"]);
  expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["failed", "succeeded"]);
  expect(h.events).toEqual(["open:a", "close:a", "open:b", "close:b"]);
});

test("run source is fixed while the library entry is replaced", async () => {
  const seen: string[] = [];
  const h = harness(async ({ scriptPath }) => {
    seen.push(readFileSync(scriptPath, "utf8"));
    if (seen.length === 1) await h.library.save({ ...input, source: "replacement" }, script.id, 1);
  });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(seen).toEqual([input.source, input.source]);
});

test("Cloud permission is checked even for an already-open browser", async () => {
  const cloud = { accountId: () => "account-a", client: {
    getScript: async () => ({ script: { ...input, id: "script", revision: 1 } }),
    getProfile: async () => ({ profile: { permission: "view" }, payload: { profile: {} } }),
  } };
  let executed = false;
  const h = harness(async () => { executed = true; }, { cloud, active: ["a"] });
  h.supervisor.start({ scriptId: "script", profileIds: ["a"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(executed).toBe(false);
  expect(h.supervisor.status()?.profiles[0]?.status).toBe("failed");
  expect(h.events).toEqual([]);
});

test("local logs are incremental and unknown runs cannot be read", async () => {
  const h = harness(async ({ logFd }) => { writeFileSync(logFd, "profile output\n"); });
  const script = await h.library.save(input);
  const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  const log = h.supervisor.log(run.id, 0);
  expect(log.text).toContain("profile output");
  expect(h.supervisor.log(run.id, log.nextOffset).text).toBe("");
  expect(() => h.supervisor.log("another-run", 0)).toThrow();
});

test("all script API operations require the desktop nonce and trusted origin", async () => {
  const h = harness();
  const nonce = "a".repeat(64);
  const options = { scripts: { library: h.library, runner: h.supervisor, nonce } };
  for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/run"], ["POST", "/run"], ["POST", "/stop"], ["GET", "/log"], ["GET", "/id"], ["PATCH", "/id"], ["DELETE", "/id"], ["GET", "/library"], ["GET", "/library/id"], ["POST", "/library/id/import"], ["PUT", "/id/publication"], ["DELETE", "/id/publication"]]) {
    const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/scripts${path}`, { method }), {} as any, {} as any, null, options);
    expect(response?.status).toBe(401);
  }
  const foreign = await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts", {
    headers: { authorization: `Bearer ${nonce}`, origin: "https://foreign.test" },
  }), {} as any, {} as any, null, options);
  expect(foreign?.status).toBe(403);
  const imported = await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts", {
    method: "POST", headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" }, body: JSON.stringify(input),
  }), {} as any, {} as any, null, options);
  expect(imported?.status).toBe(200);
  expect(imported?.headers.get("cache-control")).toBe("no-store");
  expect(h.events).toEqual([]);
  expect((await h.library.list()).length).toBe(1);
});

test("private Cloud methods use existing auth and revision contract", async () => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const client = new CloudClient({
    baseUrl: "https://cloud.example.test", accessToken: () => "test-token", deviceCredential: () => "test-device",
    fetchFn: async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      expect(new Headers(init?.headers).get("x-aliasmode-device")).toBe("test-device");
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true, scripts: [], script: { ...input, id: "id", revision: 1 }, deleted: true });
    },
  });
  await client.listScripts();
  await client.createScript(input);
  await client.getScript("id/encoded");
  await client.updateScript("id", { ...input, expectedRevision: 1 });
  await client.deleteScript("id", 2);
  expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "GET", "PATCH", "DELETE"]);
  expect(calls[2]?.url).toEndWith("/v1/account/scripts/id%2Fencoded");
  expect(calls[3]?.body.expectedRevision).toBe(1);
  expect(calls[4]?.body).toEqual({ expectedRevision: 2 });
});

const publication = { ...input, id: "published-script", authorName: "Example author", authorEmail: null, sourceRevision: 2, publishedAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" };

test("public catalog requests are anonymous even with a signed-in client", async () => {
  const calls: string[] = [];
  const client = new CloudClient({
    baseUrl: "https://cloud.example.test",
    accessToken: () => { throw new Error("Public browsing must not read credentials"); },
    deviceCredential: () => { throw new Error("Public browsing must not read device credentials"); },
    fetchFn: async (url, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("x-aliasmode-device")).toBe(false);
      expect(init?.cache).toBe("no-store");
      calls.push(url);
      return Response.json({ ok: true, scripts: [], nextOffset: null, script: publication });
    },
  });
  await client.listPublishedScripts({ q: "two words & symbols", language: "python", offset: 50 });
  await client.getPublishedScript("id/encoded");
  const query = new URL(calls[0]!).searchParams;
  expect(query.get("q")).toBe("two words & symbols");
  expect(query.get("language")).toBe("python");
  expect(query.get("offset")).toBe("50");
  expect(calls[1]).toEndWith("/v1/library/scripts/id%2Fencoded");
});

test("Local catalog imports create independent copies without executing", async () => {
  let current = publication;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, script: current, scripts: [current], nextOffset: null }) });
  try {
    const library = new ScriptLibrary(root(), false, undefined, server.url.origin);
    expect((await library.browse()).scripts[0]?.id).toBe(publication.id);
    const first = await library.importPublished(publication.id);
    const second = await library.importPublished(publication.id);
    expect(first.id).not.toBe(publication.id);
    expect(second.id).not.toBe(first.id);
    expect(first.revision).toBe(1);
    expect(first).not.toHaveProperty("authorName");
    expect(first).not.toHaveProperty("sourceRevision");
    current = { ...publication, source: "changed public source" };
    expect((await library.get(first.id)).source).toBe(publication.source);
    expect(await library.info()).toMatchObject({ canPublish: false, scripts: expect.any(Array) });
    await expect(library.publish(first.id, { expectedRevision: 1, authorName: "Author", showEmail: false })).rejects.toThrow("Cloud");
    await expect(library.unpublish(first.id)).rejects.toThrow("Cloud");
  } finally { await server.stop(true); }
});

test("publication methods preserve authenticated revision and email consent", async () => {
  const calls: Array<{ method: string; body: any }> = [];
  const client = new CloudClient({
    baseUrl: "https://cloud.example.test", accessToken: () => "test-token",
    fetchFn: async (url, init) => {
      expect(url).toEndWith("/v1/account/scripts/id%2Fencoded/publication");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true, script: publication, unpublished: true });
    },
  });
  await client.publishScript("id/encoded", { expectedRevision: 2, authorName: "Author", showEmail: false });
  await client.unpublishScript("id/encoded");
  expect(calls).toEqual([
    { method: "PUT", body: { expectedRevision: 2, authorName: "Author", showEmail: false } },
    { method: "DELETE", body: undefined },
  ]);
});

test("public import cannot save into an account that changed during download", async () => {
  let account = "account-a";
  let created = false;
  const library = new ScriptLibrary(root(), true, { accountId: () => account, client: {
    getPublishedScript: async () => { account = "account-b"; return { script: publication }; },
    createScript: async () => { created = true; },
  } } as any);
  await expect(library.importPublished(publication.id)).rejects.toThrow("account changed");
  expect(created).toBe(false);
});

test("script library info exposes publication metadata and last author only in its account", async () => {
  let account: string | undefined = "account-a";
  const library = new ScriptLibrary(root(), true, { accountId: () => account, client: {
    listScripts: async () => ({ scripts: [{ ...input, id: "script", revision: 3, publishedRevision: 2 }], publicationDefaults: { authorName: "Author" } }),
  } } as any);
  expect(await library.info()).toMatchObject({ canPublish: true, publicationDefaults: { authorName: "Author" }, scripts: [expect.objectContaining({ publishedRevision: 2 })] });
  expect(JSON.stringify(await library.info())).not.toContain(input.source);
  account = undefined;
  await expect(library.info()).rejects.toThrow("Sign in");
});

test("desktop library routes browse, import privately, publish, and unpublish without running", async () => {
  let account: string | undefined = "importing-account";
  const calls: string[] = [];
  const copied = { ...input, id: "independent-copy", revision: 1, createdAt: publication.publishedAt, updatedAt: publication.updatedAt };
  const client = new CloudClient({
    baseUrl: "https://cloud.example.test", accessToken: () => account ? "test-token" : undefined,
    fetchFn: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path.startsWith("/v1/library/")) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json({ ok: true, script: publication, scripts: [publication], nextOffset: null });
      }
      if (method === "POST") expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json({ ok: true, script: path.endsWith("/publication") ? publication : copied, scripts: [], unpublished: true });
    },
  });
  const h = harness(undefined, { cloud: { accountId: () => account, client } });
  const nonce = "b".repeat(64);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/scripts${path}`, {
      method, headers: { authorization: `Bearer ${nonce}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }), {} as any, {} as any, null, { scripts: { library: h.library, runner: h.supervisor, nonce } });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    return response!.json();
  };
  expect((await request("/library?q=example&language=javascript&offset=0")).scripts[0].id).toBe(publication.id);
  expect((await request(`/library/${publication.id}`)).script.source).toBe(input.source);
  expect((await request(`/library/${publication.id}/import`, "POST")).script).toEqual(copied);
  expect((await request("/independent-copy/publication", "PUT", { expectedRevision: 1, authorName: "Author", showEmail: false })).script).toEqual(publication);
  expect((await request("/independent-copy/publication", "DELETE")).unpublished).toBe(true);
  expect((await request("")).canPublish).toBe(true);
  expect(calls).toContain("POST /v1/account/scripts");
  expect(h.events).toEqual([]);
  expect(h.supervisor.status()).toBeNull();
  account = undefined;
  expect((await request("/library")).scripts[0].id).toBe(publication.id);
});

test("Cloud run status and logs remain account-scoped after switching accounts", async () => {
  let account: string | undefined = "account-a";
  const cloud = { accountId: () => account, client: { getScript: async () => { throw new Error("offline"); } } };
  const h = harness(undefined, { cloud });
  const run = h.supervisor.start({ scriptId: "script", profileIds: ["a"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(h.supervisor.status()?.id).toBe(run.id);
  account = "account-b";
  expect(h.supervisor.status()).toBeNull();
  expect(() => h.supervisor.log(run.id, 0)).toThrow("Run not found");
  account = undefined;
  expect(h.supervisor.status()).toBeNull();
  await h.supervisor.stop();
});

test("account transitions pause new script runs until the transition finishes", async () => {
  const h = harness();
  const script = await h.library.save(input);
  const request = { scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false };
  const resume = h.supervisor.pause();
  expect(() => h.supervisor.start(request)).toThrow("paused");
  await h.supervisor.stop();
  resume();
  h.supervisor.start(request);
  await h.supervisor.settled();
  expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
});

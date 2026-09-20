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

function harness(execute: ScriptExecution = async () => {}, options: { active?: string[]; cloud?: any } = {}) {
  const directory = root();
  const events: string[] = [];
  const launches = new Map((options.active ?? []).map((id) => [id, { ws: `ws://test/${id}`, debugPort: 9000 }]));
  const profiles = ["a", "b", "c"].map((id) => ({ id, name: id, group: "", platform: "", username: `user-${id}`, password: `test-password-${id}`, twofa: "" }));
  const library = new ScriptLibrary(directory, !!options.cloud, options.cloud);
  const supervisor = new ScriptSupervisor({
    root: directory, library, execute,
    store: { getProfile: (id: string) => profiles.find((p) => p.id === id), getLaunch: (id: string) => launches.get(id), listAgentTemporary: () => [] } as any,
    launcher: {
      certifiedActive: async (id: string) => launches.has(id),
      start: async (id: string) => { events.push(`open:${id}`); launches.set(id, { ws: `ws://test/${id}`, debugPort: 9000 }); return { ws: `ws://test/${id}`, port: 9000 }; },
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
  for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/run"], ["POST", "/run"], ["POST", "/stop"], ["GET", "/log"], ["GET", "/id"], ["PATCH", "/id"], ["DELETE", "/id"]]) {
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

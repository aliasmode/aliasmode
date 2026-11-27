import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControlSession } from "./agent-control.ts";
import { LOG_READ_BYTES, ScriptLibrary, ScriptSupervisor, resolveScriptRunner, verifyScriptRuntime, type ScriptExecution } from "./scripts.ts";
import { handleUiRequest } from "./ui.ts";
import { serveAutomationApi } from "./web.ts";
import { Scheduler } from "./scheduler.ts";
import { CloudClient } from "./cloud-client.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { PYTHON_RUNTIME_FAILED, PythonRuntime } from "./python-runtime.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), "aliasmode-scripts-")); roots.push(dir); return dir; }
const input = { name: "Visit", description: "Example", language: "javascript" as const, source: "export default async () => {};" };

function harness(execute: ScriptExecution = async () => {}, options: { active?: string[]; profileIds?: string[]; admission?: LifecycleAdmissionController; close?: (id: string) => Promise<void>; cloud?: any; firefoxOwner?: any; realExecute?: boolean; python?: PythonRuntime; openWarning?: string } = {}) {
  const directory = root();
  const events: string[] = [];
  const startOptions: unknown[] = [];
  const launch = (id: string) => options.firefoxOwner
    ? { ws: `firefox://127.0.0.1:9000/${options.firefoxOwner.generation}`, debugPort: 9000, engine: "firefox", firefoxOwner: options.firefoxOwner }
    : { ws: `ws://test/${id}`, debugPort: 9000 };
  const launches = new Map((options.active ?? []).map((id) => [id, launch(id)]));
  const profiles = (options.profileIds ?? ["a", "b", "c"]).map((id) => ({ id, name: id, group: "", platform: "", username: `user-${id}`, password: `test-password-${id}`, twofa: "" }));
  const library = new ScriptLibrary(directory, !!options.cloud, options.cloud);
  const supervisor = new ScriptSupervisor({
    root: directory, library, python: options.python, ...(options.realExecute ? {} : { execute }),
    store: { getProfile: (id: string) => profiles.find((p) => p.id === id), getLaunch: (id: string) => launches.get(id), listAgentTemporary: () => [] } as any,
    launcher: {
      certifiedActive: async (id: string) => launches.has(id),
      start: async (id: string, _urls?: string[], opened?: unknown) => { events.push(`open:${id}`); startOptions.push(opened); const value = launch(id); launches.set(id, value); return { ws: value.ws, port: 9000, ...(options.openWarning ? { warning: options.openWarning } : {}) }; },
      stop: async (id: string) => { await options.close?.(id); events.push(`close:${id}`); launches.delete(id); return true; },
    } as any,
    admission: options.admission ?? { run: async (_: unknown, work: () => Promise<unknown>) => work() } as any,
    cloudConnection: options.cloud,
  });
  return { library, supervisor, events, directory, launches, startOptions };
}

const sourceRuntime = {
  kind: "source" as const,
  root: import.meta.dir,
  nodeExecutable: "node",
  workerPath: join(import.meta.dir, "playwright-worker.mjs"),
};

test("source scripts resolve the checked-in runners through system executables", async () => {
  if (!((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "linux" && process.arch === "x64"))) return;
  expect(resolveScriptRunner("javascript", sourceRuntime)).toEqual({
    executable: "node", runner: join(import.meta.dir, "agent", "script-runner.mjs"),
  });
  expect(resolveScriptRunner("python", sourceRuntime)).toEqual({
    executable: "python3", runner: join(import.meta.dir, "agent", "script-runner.py"),
  });
  await expect(verifyScriptRuntime("javascript", { runtime: sourceRuntime })).resolves.toEqual({
    executable: "node", runner: join(import.meta.dir, "agent", "script-runner.mjs"),
  });
});

test("source script prerequisite errors are clear", async () => {
  if (!((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "linux" && process.arch === "x64"))) return;
  const emptyPath = root();
  await expect(verifyScriptRuntime("javascript", { runtime: sourceRuntime, env: { PATH: emptyPath } }))
    .rejects.toThrow("Node.js 18 or newer and compatible Playwright");
  await expect(verifyScriptRuntime("python", { runtime: sourceRuntime, env: { PATH: emptyPath } }))
    .rejects.toThrow("Python 3 with compatible Playwright");
});

test("a missing runtime fails before a script opens a profile", async () => {
  const previous = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
  process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = root();
  try {
    const h = harness(undefined, { realExecute: true });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    expect(h.events).toEqual([]);
    expect(h.supervisor.status()?.profiles[0]?.error).toContain("script runtime is missing");
  } finally {
    if (previous === undefined) delete process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
    else process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = previous;
  }
});

const pythonInput = { ...input, name: "Visit in Python", language: "python" as const, source: "async def run(**_):\n    pass\n" };

/** A Python runtime whose one pinned download comes from `fetch`. */
function fakePython(fetch: (url: string, init: RequestInit) => Promise<Response>): PythonRuntime {
  const bytes = new TextEncoder().encode("python archive");
  return new PythonRuntime(join(root(), "runtimes"), {
    platform: "win32", fetch, attempts: 1, sleep: async () => {}, check: async () => {},
    pins: { archive: { url: "https://python.test/python.zip", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, wheels: [] },
    unpack: async (_archive, directory) => {
      const python = join(directory, "python");
      mkdirSync(join(python, "Lib", "site-packages", "playwright", "driver"), { recursive: true });
      writeFileSync(join(python, "python.exe"), "");
      writeFileSync(join(python, "Lib", "site-packages", "playwright", "driver", "node.exe"), "");
      return python;
    },
  });
}

test("a Python script waits for the Python runtime download before it opens a profile", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const python = fakePython(async () => { await gate; return new Response("python archive"); });
  const interpreters: Array<string | undefined> = [];
  const h = harness(async ({ python: interpreter }) => { interpreters.push(interpreter); }, { python });
  const script = await h.library.save(pythonInput);
  const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
  await Bun.sleep(20);
  expect(h.events).toEqual([]);
  expect(h.supervisor.status()).toMatchObject({ scriptName: "Visit in Python", status: "running", profiles: [{ status: "queued" }] });
  expect(python.status().state).toBe("downloading");
  release();
  await h.supervisor.settled();
  expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
  expect(interpreters).toEqual([python.executable]);
  const log = h.supervisor.log(run.id, 0).text;
  expect(log).toContain("Downloading the Python runtime for Python scripts");
  expect(log).toContain("Python runtime download: 100%");
  expect(log).toContain("Python runtime ready");

  // An installed runtime starts the next run at once, without a download note.
  const next = h.supervisor.start({ scriptId: script.id, profileIds: ["b"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(h.supervisor.log(next.id, 0).text).not.toContain("Python runtime");
  expect(interpreters).toEqual([python.executable, python.executable]);
});

test("a failed Python runtime download fails the run clearly before any profile opens", async () => {
  const python = fakePython(async () => { throw new Error("network is down"); });
  let executed = false;
  const h = harness(async () => { executed = true; }, { python });
  const script = await h.library.save(pythonInput);
  const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(executed).toBe(false);
  expect(h.events).toEqual([]);
  expect(h.supervisor.status()?.profiles).toEqual([
    { id: "a", name: "a", status: "failed", error: PYTHON_RUNTIME_FAILED },
    { id: "b", name: "b", status: "failed", error: PYTHON_RUNTIME_FAILED },
  ]);
  expect(h.supervisor.log(run.id, 0).text).toContain("Python runtime download failed: network is down");
  expect(python.status()).toMatchObject({ state: "failed", error: "network is down" });
});

test("Stop ends the wait for the Python runtime", async () => {
  const python = fakePython(() => new Promise<Response>(() => {}));
  const h = harness(async () => { throw new Error("must not run"); }, { python });
  const script = await h.library.save(pythonInput);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
  await Bun.sleep(20);
  const stopped = await h.supervisor.stop();
  expect(stopped?.status).toBe("finished");
  expect(stopped?.profiles[0]?.status).toBe("cancelled");
  expect(h.events).toEqual([]);
});

test("packaged Python scripts run only on the downloaded runtime", async () => {
  const packaged = { kind: "packaged" as const, root: root(), nodeExecutable: "node", workerPath: "worker.mjs" };
  expect(() => resolveScriptRunner("python", packaged)).toThrow("The Python runtime is not ready. Run the script again to download it.");
  expect(resolveScriptRunner("python", packaged, "/runtimes/python/python.exe").executable).toBe("/runtimes/python/python.exe");
  await expect(verifyScriptRuntime("python", { runtime: packaged, python: join(packaged.root, "missing.exe") }))
    .rejects.toThrow("The Python runtime is not ready");
});

test("JavaScript scripts run on the bundled Node and never download Python", async () => {
  const requests: string[] = [];
  const python = fakePython(async (url) => { requests.push(url); return new Response("python archive"); });
  const languages: string[] = [];
  const h = harness(async ({ language, python: interpreter }) => { languages.push(`${language}:${interpreter ?? ""}`); }, { python });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
  await h.supervisor.settled();
  expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
  expect(languages).toEqual(["javascript:"]);
  expect(requests).toEqual([]);
  expect(existsSync(python.directory)).toBe(false);
});

test("the scripts API prefetches Python only for Python scripts and reports the runtime", async () => {
  const requests: string[] = [];
  const python = fakePython(async (url) => { requests.push(url); return new Response("python archive"); });
  const h = harness(undefined, { python });
  const nonce = "c".repeat(64);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/scripts${path}`, {
      method, headers: { authorization: `Bearer ${nonce}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }), {} as any, {} as any, null, { scripts: { library: h.library, runner: h.supervisor, nonce, python } });
    expect(response?.status).toBe(200);
    return response!.json();
  };
  expect((await request("/python-runtime")).python).toMatchObject({ state: "missing" });
  await request("", "POST", input);
  await request("");
  await Bun.sleep(10);
  expect(requests).toEqual([]);

  // Adding a Python script starts the download; opening the list again does not start a second one.
  await request("", "POST", pythonInput);
  await request("");
  await Bun.sleep(10);
  expect(requests).toEqual(["https://python.test/python.zip"]);
  expect((await request("/python-runtime")).python).toMatchObject({ state: "ready" });

  const source = { scripts: { library: h.library, runner: h.supervisor, nonce } };
  const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts/python-runtime", {
    headers: { authorization: `Bearer ${nonce}` },
  }), {} as any, {} as any, null, source);
  expect(await response!.json()).toEqual({ ok: true, python: null });
});

test("the user can retry a failed Python runtime download from the scripts page", async () => {
  let down = true;
  const python = fakePython(async () => { if (down) throw new Error("network is down"); return new Response("python archive"); });
  const h = harness(undefined, { python });
  const nonce = "d".repeat(64);
  const call = async (method: string) => (await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts/python-runtime", {
    method, headers: { authorization: `Bearer ${nonce}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  }), {} as any, {} as any, null, { scripts: { library: h.library, runner: h.supervisor, nonce, python } }))!.json();
  await h.library.save(pythonInput);
  python.prefetch();
  await Bun.sleep(10);
  expect((await call("GET")).python).toMatchObject({ state: "failed", error: "network is down" });
  down = false;
  expect((await call("POST")).python.state).toBe("downloading");
  await Bun.sleep(10);
  expect((await call("GET")).python.state).toBe("ready");
});

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
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: { url: "https://example.test" }, useCredentials: false, concurrency: 1 });
  await h.supervisor.settled();
  expect(calls.map((call) => call.profile.id)).toEqual(["a", "b"]);
  expect(calls.every((call) => call.credentials === null)).toBe(true);
  expect(h.events).toEqual(["open:b", "close:b"]);
  expect(h.launches.has("a")).toBe(true);
  expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["succeeded", "succeeded"]);
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await Bun.sleep(1);
  expect(check()).toBe(true);
}

for (const concurrency of [undefined, 1, 30, 100]) {
  test(`parallel runs respect concurrency ${concurrency ?? "default 10"} and refill individual slots`, async () => {
    const profileIds = Array.from({ length: 30 }, (_, i) => `profile-${i}`);
    const waiting = new Map<string, () => void>();
    const called: string[] = [];
    let peak = 0;
    const h = harness(async ({ input: data, signal }) => {
      called.push(data.profile.id);
      await new Promise<void>((resolve) => {
        waiting.set(data.profile.id, resolve);
        peak = Math.max(peak, waiting.size);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      waiting.delete(data.profile.id);
    }, { profileIds, admission: new LifecycleAdmissionController() });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: [...profileIds, profileIds[0]!], inputs: {}, useCredentials: false, concurrency });
    const limit = Math.min(concurrency ?? 10, profileIds.length);
    try {
      await until(() => waiting.size === limit);
      expect(called).toHaveLength(limit);
      if (limit < profileIds.length) {
        waiting.get(profileIds[0]!)!();
        await until(() => called.length === limit + 1);
        expect(waiting.size).toBe(limit);
        expect(h.events).toContain(`close:${profileIds[0]}`);
      }
      while (h.supervisor.status()?.status !== "finished") {
        for (const finish of waiting.values()) finish();
        await Bun.sleep(1);
      }
      expect(peak).toBe(limit);
      expect(called).toHaveLength(30);
      expect(new Set(called).size).toBe(30);
      expect(h.supervisor.status()?.profiles.every((p) => p.status === "succeeded")).toBe(true);
      expect(h.launches.size).toBe(0);
    } finally { await h.supervisor.stop(); }
  });
}

test("parallel slots remain occupied until browser cleanup finishes, and failures refill slots", async () => {
  let finishClose!: () => void;
  const close = new Promise<void>((resolve) => { finishClose = resolve; });
  const waiting = new Map<string, () => void>();
  const h = harness(async ({ input: data, signal }) => {
    if (data.profile.id === "a") throw new Error("script failed");
    await new Promise<void>((resolve) => {
      waiting.set(data.profile.id, resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }, { close: async (id) => { if (id === "a") await close; } });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b", "c"], inputs: {}, useCredentials: false, concurrency: 2 });
  try {
    await until(() => waiting.has("b") && h.supervisor.status()?.profiles[0]?.status === "failed");
    expect(h.events).toEqual(["open:a", "open:b"]);
    expect(h.supervisor.status()?.profiles[2]?.status).toBe("queued");
    finishClose();
    await until(() => waiting.has("c"));
    for (const finish of waiting.values()) finish();
    await h.supervisor.settled();
    expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["failed", "succeeded", "succeeded"]);
  } finally { finishClose(); await h.supervisor.stop(); }
});

for (const action of ["stop", "shutdown"] as const) {
  test(`${action} waits for all parallel runners and cleanup, cancels queued profiles, and preserves existing browsers`, async () => {
    const started: string[] = [];
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness(async ({ input: data, signal, logFd }) => {
      started.push(data.profile.id);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await release;
      writeFileSync(logFd, `stopped:${data.profile.id}\n`);
      h.events.push(`terminated:${data.profile.id}`);
    }, { active: ["a"] });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b", "c"], inputs: {}, useCredentials: false, concurrency: 2 });
    try {
      await until(() => started.length === 2);
      let done = false;
      const stopping = h.supervisor[action]().then(() => { done = true; });
      await Bun.sleep(1);
      expect(done).toBe(false);
      expect(h.supervisor.status()?.status).not.toBe("finished");
      expect(h.events).toEqual(["open:b"]);
      finish();
      await stopping;
      expect(h.events).toContain("close:b");
      expect(h.events.indexOf("terminated:b")).toBeLessThan(h.events.indexOf("close:b"));
      expect(h.launches.has("a")).toBe(true);
      expect(h.events).not.toContain("open:c");
      expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    } finally { finish(); await h.supervisor.stop(); }
  });
}

test("Stop removes parallel browser opens waiting for lifecycle admission", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release!: () => void;
  const blocker = admission.run({ kind: "start" }, () => new Promise<void>((resolve) => { release = resolve; }));
  const h = harness(undefined, { admission });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b", "c"], inputs: {}, useCredentials: false });
  try {
    await until(() => admission.stats().queued === 3);
    const stopping = h.supervisor.stop();
    await until(() => admission.stats().queued === 0);
    await stopping;
    expect(h.events).toEqual([]);
    expect(h.supervisor.status()?.profiles.every((p) => p.status === "cancelled")).toBe(true);
  } finally { release(); await blocker; await h.supervisor.stop(); }
});

test("invalid parallel limits fail before creating a run", async () => {
  const h = harness();
  const script = await h.library.save(input);
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null]) {
    expect(() => h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false, concurrency: concurrency as number })).toThrow("positive whole number");
  }
  expect(h.supervisor.status()).toBeNull();
  expect(h.events).toEqual([]);
});

test("Firefox scripts use a private Playwright endpoint in the external runner", async () => {
  const requests: any[] = [];
  const executions: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({ version: 1, ok: true, result: { endpoint: "ws://127.0.0.1:9223/private" } });
    },
  });
  const owner = {
    endpoint: `http://127.0.0.1:${server.port}/`, token: "private-token", pid: 12, browserPid: 13, generation: "generation",
  };
  const h = harness(async (options) => { executions.push(options); }, { firefoxOwner: owner });
  try {
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: { url: "https://example.test" }, useCredentials: false });
    await h.supervisor.settled();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "playwright-endpoint",
      payload: { ownerGeneration: "generation" },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].input).toMatchObject({
      endpoint: "ws://127.0.0.1:9223/private", engine: "firefox",
      profile: { id: "a" }, inputs: { url: "https://example.test" }, credentials: null,
    });
    expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
    expect(h.supervisor.log(h.supervisor.status()!.id, 0).text).not.toContain("9223/private");
  } finally {
    server.stop(true);
  }
});

test("Firefox script cancellation aborts the external runner before browser cleanup", async () => {
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({ version: 1, ok: true, result: { endpoint: "ws://127.0.0.1:9223/private" } });
    },
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const h = harness(async ({ signal }) => {
    started();
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  }, { firefoxOwner: {
    endpoint: `http://127.0.0.1:${server.port}/`, token: "private-token", pid: 12, browserPid: 13, generation: "generation",
  } });
  try {
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await ready;
    await h.supervisor.stop();
    expect(requests).toHaveLength(1);
    expect(requests[0].operation).toBe("playwright-endpoint");
    expect(h.events).toEqual(["open:a", "close:a"]);
    expect(h.supervisor.status()?.profiles[0]?.status).toBe("cancelled");
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

test("an open warning is kept on the run, in its log, and in the schedule history", async () => {
  const warning = "This profile shows your computer's timezone because the proxy location lookup failed. Set a timezone in the profile settings.";
  const h = harness(async () => {}, { openWarning: warning });
  const script = await h.library.save(input);
  let now = Date.now();
  const scheduler = new Scheduler({ root: h.directory, runner: h.supervisor, scope: () => h.library.scope(), now: () => now });
  scheduler.save({ scriptId: script.id, profileIds: ["a"], inputs: {}, headless: true, everyHours: 1 });
  now += 3_600_000;
  await scheduler.tick();
  const run = h.supervisor.status()!;
  expect(run.profiles[0]).toMatchObject({ status: "succeeded", warning });
  expect(h.supervisor.log(run.id, 0).text).toContain(`--- a ---\nWarning: ${warning}\n`);
  expect(scheduler.list().history[0]!.profiles).toEqual([{ id: "a", name: "a", status: "succeeded", warning }]);
});

test("New identity is refused while a script run has the profile queued or running", async () => {
  const release = Promise.withResolvers<void>();
  const h = harness(async () => { await release.promise; });
  const script = await h.library.save(input);
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false, concurrency: 1 });
  await until(() => h.supervisor.status()?.profiles[0]?.status === "running");
  expect(["a", "b", "c"].map((id) => h.supervisor.usesProfile(id))).toEqual([true, true, false]);
  const refusal = "A script is using this profile; stop it first";
  const store = { getProfile: () => null, getLaunch: () => null } as any;
  const scripts = { library: h.library, runner: h.supervisor };

  const ui = await handleUiRequest(new Request("http://x/ui/api/profiles/b/new-identity", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {} as any, store, null, { scripts: scripts as any });
  expect(ui!.status).toBe(409);
  expect((await ui!.json()).error).toBe(refusal);
  const session = new AgentControlSession({ store, admission: { run: async (_: unknown, work: () => Promise<unknown>) => work() }, scripts } as any);
  expect(await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "profiles.newIdentity", params: { profileId: "a" } })))
    .toMatchObject({ ok: false, error: { code: "conflict", message: refusal } });
  const server = serveAutomationApi({ port: 0, launcher: {} as any, store, scriptBusy: (id) => h.supervisor.usesProfile(id), log: () => {} });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v2/browser-profile/new-identity`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile_id: "a" }),
    });
    expect(await response.json()).toMatchObject({ code: -1, msg: refusal });
  } finally { await server.stop(true); }

  release.resolve();
  await h.supervisor.settled();
  expect(h.supervisor.usesProfile("a")).toBe(false);
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
  const request = { scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false, concurrency: 1 };
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
  h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false, concurrency: 1 });
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
  for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/run"], ["POST", "/run"], ["POST", "/stop"], ["GET", "/log"], ["GET", "/id"], ["PATCH", "/id"], ["DELETE", "/id"], ["GET", "/library"], ["GET", "/library/id"], ["POST", "/library/id/import"], ["PUT", "/id/publication"], ["DELETE", "/id/publication"], ["GET", "/python-runtime"], ["POST", "/python-runtime"], ["GET", "/schedules"], ["POST", "/schedules"], ["PUT", "/schedules/id"], ["DELETE", "/schedules/id"], ["PUT", "/on-open/p1"], ["DELETE", "/on-open/p1"]]) {
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

test("agent control lists, runs, follows and stops library scripts", async () => {
  const credentials: unknown[] = [];
  const h = harness(async ({ input: data }) => { credentials.push(data.credentials); });
  const script = await h.library.save(input);
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }));
    return response.ok ? response.result as any : response.error!;
  };
  expect(await call("scripts.list")).toEqual({ scripts: [{ id: script.id, name: "Visit", language: "javascript", description: "Example" }] });
  const started = await call("scripts.run", { scriptId: script.id, profileIds: ["a"], headless: true });
  expect(started.run.status).toBe("running");
  await h.supervisor.settled();
  expect(h.startOptions).toEqual([{ headless: true }]);
  expect((await call("scripts.status")).run.profiles.map((p: any) => p.status)).toEqual(["succeeded"]);
  expect(await call("scripts.log", { runId: started.run.id })).toMatchObject({ nextOffset: expect.any(Number) });
  await call("scripts.run", { scriptId: script.id, profileIds: ["a"], headless: false });
  await h.supervisor.settled();
  expect(h.startOptions.at(-1)).toEqual({ headless: false });
  await call("scripts.run", { scriptId: script.id, profileIds: ["a"], useCredentials: true });
  await h.supervisor.settled();
  expect(credentials).toEqual([null, null, expect.objectContaining({ username: "user-a", password: "test-password-a" })]);
  expect((await call("scripts.stop")).run.status).toBe("finished");
});

test("agent control reports a busy runner and missing script support", async () => {
  const release = Promise.withResolvers<void>();
  const h = harness(async () => { await release.promise; });
  const script = await h.library.save(input);
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const run = () => session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "scripts.run", params: { scriptId: script.id, profileIds: ["a"] } }));
  expect((await run()).ok).toBe(true);
  expect(await run()).toMatchObject({ ok: false, error: { message: "A script is already running" } });
  release.resolve();
  await h.supervisor.settled();
  const bare = await new AgentControlSession({} as any).enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "scripts.list" }));
  expect(bare).toMatchObject({ ok: false, error: { code: "scripts_unavailable" } });
});

test("agent control reads, creates and updates library scripts", async () => {
  const h = harness();
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }));
    return response.ok ? response.result as any : response.error!;
  };
  const created = (await call("scripts.save", input)).script;
  expect(created).toMatchObject({ name: "Visit", revision: 1 });
  expect(created.source).toBeUndefined();
  // An update keeps the fields it leaves out.
  const updated = (await call("scripts.save", { scriptId: created.id, source: "export default async () => { /* v2 */ };" })).script;
  expect(updated).toMatchObject({ id: created.id, name: "Visit", description: "Example", revision: 2 });
  expect((await call("scripts.get", { scriptId: created.id })).script.source).toContain("v2");
  expect(await call("scripts.save", { scriptId: created.id, source: "x", expectedRevision: 1 })).toMatchObject({ message: expect.stringContaining("changed") });
  expect(await call("scripts.get", { scriptId: "missing" })).toMatchObject({ message: "Script not found" });
});

test("AI clients get script logs and errors with saved login values masked; the dashboard log is not", async () => {
  const h = harness(async ({ logFd }) => {
    writeFileSync(logFd, "signed in as user-a with test-password-a, then user-b\n");
    throw new Error("login failed for user-a");
  }, { profileIds: ["a", "b"] });
  const script = await h.library.save(input);
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) =>
    (await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }))).result as any;
  const started = await call("scripts.run", { scriptId: script.id, profileIds: ["a"], useCredentials: true });
  await h.supervisor.settled();
  const log = await call("scripts.log", { runId: started.run.id });
  expect(log.text).toContain("signed in as *** with ***, then user-b");
  expect(log.text).not.toContain("test-password");
  expect((await call("scripts.status")).run.profiles[0].error).toBe("login failed for ***");
  expect((await call("scripts.stop")).run.profiles[0].error).toBe("login failed for ***");
  expect(h.supervisor.log(started.run.id, 0).text).toContain("test-password-a");
  expect(h.supervisor.status()!.profiles[0]!.error).toBe("login failed for user-a");
});

test("schedule history keeps saved login values masked, and AI clients get older entries masked too", async () => {
  const h = harness(async () => { throw new Error("login failed for user-b with test-password-b"); });
  const script = await h.library.save(input);
  const due = (runner: any) => {
    const scheduler = new Scheduler({ root: h.directory, runner, scope: () => h.library.scope() });
    scheduler.save({ scriptId: script.id, profileIds: ["b"], inputs: {}, useCredentials: true, everyHours: 1 });
    const job = scheduler.list().jobs.at(-1)!;
    return new Scheduler({ root: h.directory, runner, scope: () => h.library.scope(), now: () => job.nextRun + 1 });
  };
  const scheduler = due(h.supervisor);
  await scheduler.tick();
  expect(scheduler.list().history[0]!.profiles[0]!.error).toBe("login failed for *** with ***");
  // A runner without saved values (an entry from an older version) is masked when read, from the stored profile.
  const older = due({ start: (request: any) => h.supervisor.start(request), settled: () => h.supervisor.settled(), status: () => h.supervisor.status(), shutdown: async () => {} });
  await older.tick();
  expect(older.list().history[0]!.profiles[0]!.error).toContain("test-password-b");
  const session = new AgentControlSession({ store: { getProfile: (id: string) => ({ id, username: `user-${id}`, password: `test-password-${id}` }) }, scripts: { library: h.library, runner: h.supervisor, scheduler: older } } as any);
  const listed = (await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "schedules.list" }))).result as any;
  expect(listed.history.map((entry: any) => entry.profiles[0].error)).toEqual(Array(2).fill("login failed for *** with ***"));
});

test("a log offset inside a saved login value reads from the value's start", async () => {
  const h = harness(async ({ logFd }) => { writeFileSync(logFd, "password: test-password-a\n"); });
  const script = await h.library.save(input);
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) =>
    (await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }))).result as any;
  const run = (await call("scripts.run", { scriptId: script.id, profileIds: ["a"], useCredentials: true })).run;
  await h.supervisor.settled();
  const full = h.supervisor.log(run.id, 0).text;
  const at = Buffer.byteLength(full.slice(0, full.indexOf("test-password-a")));
  for (const offset of [at + 1, at + 7, at + 14]) {
    expect(await call("scripts.log", { runId: run.id, offset })).toEqual({ text: "***\n", nextOffset: Buffer.byteLength(full) });
  }
});

test("a saved login value split by the read limit of a finished log is held back until it is whole", async () => {
  const head = "x".repeat(LOG_READ_BYTES - 5);
  const h = harness(async ({ logFd }) => { writeFileSync(logFd, `${head}test-password-a end\n`); });
  const script = await h.library.save(input);
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) =>
    (await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }))).result as any;
  const run = (await call("scripts.run", { scriptId: script.id, profileIds: ["a"], useCredentials: true })).run;
  await h.supervisor.settled();
  const first = await call("scripts.log", { runId: run.id });
  expect(first.text).not.toContain("test-");
  const second = await call("scripts.log", { runId: run.id, offset: first.nextOffset });
  expect(first.text + second.text).toEndWith(`${"x".repeat(10)}*** end\n`);
  expect(second.text).not.toContain("password");
});

test("a saved login value cut at the end of a live log is held back until it is whole", async () => {
  const release = Promise.withResolvers<void>();
  let fd = 0;
  const h = harness(async ({ logFd }) => {
    fd = logFd;
    writeFileSync(logFd, "password: test-pass");
    await release.promise;
  });
  const script = await h.library.save(input);
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) =>
    (await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }))).result as any;
  const run = (await call("scripts.run", { scriptId: script.id, profileIds: ["a"] })).run;
  while (!fd) await Bun.sleep(5);
  const first = await call("scripts.log", { runId: run.id });
  expect(first.text).toEndWith("password: ");
  writeFileSync(fd, "word-a done\n");
  release.resolve();
  await h.supervisor.settled();
  expect((await call("scripts.log", { runId: run.id, offset: first.nextOffset })).text).toBe("*** done\n");
});

test("an agent edit of a scheduled script saves in place", async () => {
  const h = harness();
  const scheduler = new Scheduler({ root: h.directory, runner: h.supervisor, scope: () => h.library.scope() });
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor, scheduler } } as any);
  const scheduled = await h.library.save(input);
  scheduler.save({ scriptId: scheduled.id, profileIds: ["a"], inputs: {}, useCredentials: true, everyHours: 6 });
  const result = (await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "scripts.save", params: { scriptId: scheduled.id, source: "export default async () => { /* agent */ };" } }))).result as any;
  expect(result).toEqual({ script: expect.objectContaining({ id: scheduled.id, name: "Visit", revision: 2 }) });
  expect((await h.library.get(scheduled.id)).source).toContain("agent");
});

test("agent control creates, updates, lists and deletes schedules and run-on-open scripts", async () => {
  const h = harness();
  const scheduler = new Scheduler({ root: h.directory, runner: h.supervisor, scope: () => h.library.scope() });
  const session = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor, scheduler } } as any);
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method, params }));
    return response.ok ? response.result as any : response.error!;
  };
  const script = await h.library.save(input);
  const created = (await call("schedules.save", { scriptId: script.id, profileIds: ["a"], everyHours: 6, useCredentials: true, headless: true })).job;
  expect(created).toMatchObject({ scriptId: script.id, profileIds: ["a"], inputs: {}, everyHours: 6, useCredentials: true, headless: true, enabled: true });
  // An update keeps omitted fields, and a new cadence replaces the old one.
  const updated = (await call("schedules.save", { scheduleId: created.id, dailyAt: "09:30", enabled: false })).job;
  expect(updated).toMatchObject({ id: created.id, scriptId: script.id, profileIds: ["a"], dailyAt: "09:30", useCredentials: true, headless: true, enabled: false });
  expect(updated.everyHours).toBeUndefined();
  expect(await call("schedules.save", { scheduleId: "missing", everyHours: 1 })).toMatchObject({ code: "schedule_not_found" });
  expect(await call("schedules.save", { scriptId: "missing", profileIds: ["a"], everyHours: 1 })).toMatchObject({ message: "Script not found" });
  expect(await call("schedules.save", { scriptId: script.id, profileIds: ["a"], everyHours: 1, dailyAt: "09:00" })).toMatchObject({ message: expect.stringContaining("either") });
  expect(await call("scripts.onOpen", { profileId: "b", scriptId: script.id })).toEqual({ profileId: "b", scriptId: script.id });
  expect(await call("scripts.onOpen", { profileId: "c", scriptId: "missing" })).toMatchObject({ message: "Script not found" });
  expect(await call("schedules.list")).toMatchObject({ jobs: [{ id: created.id }], onOpen: { b: script.id } });
  expect(await call("scripts.onOpen", { profileId: "b" })).toEqual({ profileId: "b", scriptId: null });
  expect(await call("schedules.delete", { scheduleId: created.id })).toEqual({ scheduleId: created.id, deleted: true });
  expect(await call("schedules.list")).toMatchObject({ jobs: [], onOpen: {} });
  const bare = new AgentControlSession({ scripts: { library: h.library, runner: h.supervisor } } as any);
  expect(await bare.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "schedules.list" }))).toMatchObject({ ok: false, error: { code: "schedules_unavailable" } });
});

test("schedule and run-on-open routes save, list, and delete under the nonce", async () => {
  const h = harness();
  const nonce = "e".repeat(64);
  const scheduler = new Scheduler({ root: h.directory, runner: h.supervisor, scope: () => h.library.scope() });
  const options = { scripts: { library: h.library, runner: h.supervisor, scheduler, nonce } };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = (await handleUiRequest(new Request(`http://127.0.0.1/ui/api/scripts${path}`, {
      method, headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }), {} as any, {} as any, null, options))!;
    return { status: response.status, body: await response.json() as any };
  };
  const job = { scriptId: "s1", profileIds: ["a"], inputs: {}, everyHours: 6 };
  const created = await call("POST", "/schedules", job);
  expect(created.status).toBe(200);
  const id = created.body.job.id;
  expect((await call("PUT", `/schedules/${id}`, { ...job, enabled: false })).body.job.enabled).toBe(false);
  expect((await call("POST", "/schedules", { ...job, everyHours: 0 })).status).toBe(400);
  expect((await call("PUT", "/schedules/missing", job)).status).toBe(404);
  expect((await call("PUT", "/on-open/p1", { scriptId: "s1" })).status).toBe(200);
  expect((await call("GET", "/schedules")).body).toMatchObject({ jobs: [{ id, enabled: false }], history: [], onOpen: { p1: "s1" } });
  expect((await call("DELETE", "/on-open/p1")).status).toBe(200);
  expect((await call("DELETE", `/schedules/${id}`)).status).toBe(200);
  expect((await call("GET", "/schedules")).body).toMatchObject({ jobs: [], onOpen: {} });
});

test("opening a profile from the dashboard queues its run-on-open script", async () => {
  const queued: string[] = [];
  const scheduler = { enqueueOpen: (id: string) => { queued.push(id); } } as unknown as Scheduler;
  const launcher = { start: async () => ({ ws: "ws://test/p1", port: 9000 }) } as any;
  const store = { getProfile: (id: string) => ({ id, name: id }) } as any;
  const options = { scripts: { scheduler } as any };
  const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/profiles/p1/open", { method: "POST" }), launcher, store, null, options);
  expect(response?.status).toBe(200);
  expect(queued).toEqual(["p1"]);
});

import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  playwrightWorkerCommand,
  playwrightWorkerEnvironment,
  runPlaywrightWorker,
  verifyPlaywrightRuntime,
} from "./playwright-runtime.ts";

const bunAsNodeTest = process.platform === "win32" ? test.skip : test;

test("uses packaged Node bootstrap and keeps requests off argv", () => {
  const runtime = "C:\\AliasMode\\playwright";
  const command = playwrightWorkerCommand(runtime);
  expect(command[0]).toBe(join(runtime, "node", "node.exe"));
  expect(command.slice(1, 3)).toEqual(["--input-type=module", "--eval"]);
  expect(command[3]).toContain("await import");
  expect(command[4]).toBe(join(runtime, "worker.mjs"));
});

test("worker inherits normal environment without Node hooks or app secrets", () => {
  expect(playwrightWorkerEnvironment({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    Node_Options: "--require injected.js",
    NODE_PATH: "C:\\untrusted",
    ALIASMODE_DESKTOP_NONCE: "private",
    cloakbrowser_license_key: "private",
    HUB_PASSWORD: "private",
  })).toEqual({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
  });
});

function textStream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body as ReadableStream<Uint8Array>;
}

function fakeWorker(output: string, exit = 0, onKill?: () => void, errorOutput = "") {
  return {
    stdin: { write() {}, end() {} },
    stdout: textStream(output),
    stderr: textStream(errorOutput),
    exited: Promise.resolve(exit),
    kill() { onKill?.(); },
  };
}

const success = (result: unknown) => JSON.stringify({ version: 1, ok: true, result });

test("worker request uses stdin and keeps endpoint and secrets off argv", async () => {
  const endpoint = "ws://user:secret@127.0.0.1/browser";
  let argv: string[] = [];
  let input = "";
  const runtime = "/fake/runtime";
  const payload = {
    endpoint,
    token: "private",
    captureSeed: { origins: ["https://private-origin.example"] },
  };
  await runPlaywrightWorker("session-capture", payload, {
    runtimeRoot: runtime,
    spawn(command) {
      argv = command;
      const worker = fakeWorker(success("bundle"));
      worker.stdin.write = ((value: string) => { input += value; }) as typeof worker.stdin.write;
      return worker;
    },
  });
  expect(argv[0]).toBe(join(runtime, "node", "node.exe"));
  expect(argv.slice(1, 3)).toEqual(["--input-type=module", "--eval"]);
  expect(argv[4]).toBe(join(runtime, "worker.mjs"));
  expect(argv.join(" ")).not.toContain("secret");
  expect(argv.join(" ")).not.toContain("private");
  expect(argv.join(" ")).not.toContain("private-origin");
  expect(JSON.parse(input).payload).toEqual(payload);
});

test("worker timeout kills only the worker and waits for its exit", async () => {
  let killed = false;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  let closeOutput!: () => void;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { closeOutput = () => controller.close(); } });
  const result = runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    timeoutMs: 5,
    spawn: () => ({
      stdin: { write() {}, end() {} },
      stdout, stderr: textStream(""), exited,
      kill() { killed = true; closeOutput(); },
    }),
  }).then(() => null, (error) => error);
  await Bun.sleep(10);
  expect(killed).toBe(true);
  resolveExit(137);
  expect(await result).toMatchObject({ code: "timeout" });
});

test("worker timeout returns when kill and exit confirmation fail", async () => {
  let killed = false;
  const hangingStream = () => new ReadableStream<Uint8Array>({ start() {} });
  const result = runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    timeoutMs: 5,
    spawn: () => ({
      stdin: { write() {}, end() {} },
      stdout: hangingStream(),
      stderr: hangingStream(),
      exited: new Promise<number>(() => {}),
      kill() { killed = true; throw new Error("failed"); },
    }),
  }).then(() => null, (error) => error);
  const outcome = await Promise.race([result, Bun.sleep(100).then(() => "hung")]);
  expect(killed).toBe(true);
  expect(outcome).not.toBe("hung");
  expect(outcome).toMatchObject({ code: "timeout" });
});

test("worker reports secret-safe response diagnostics without affecting the parent", async () => {
  const abrupt = await runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    spawn: () => fakeWorker("", 9, undefined, "private stderr"),
  }).then(() => null, (error) => error);
  expect(abrupt).toMatchObject({
    code: "runtime_unavailable",
    details: {
      workerOperation: "page",
      responseCategory: "empty_stdout",
      stdoutBytes: 0,
      exitCode: 9,
      stderrPresent: true,
    },
  });
  expect(abrupt.message).toBe("Playwright worker page failed: empty_stdout, 0 stdout bytes, exit 9, stderr present");
  expect(abrupt.message).not.toContain("private");

  const malformed = await runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    spawn: () => fakeWorker("{broken", 0),
  }).then(() => null, (error) => error);
  expect(malformed).toMatchObject({
    code: "invalid_response",
    details: {
      workerOperation: "page",
      responseCategory: "malformed_json",
      stdoutBytes: 7,
      exitCode: 0,
      stderrPresent: false,
    },
  });
  expect(1 + 1).toBe(2);
});

test("worker distinguishes a wrong protocol shape", async () => {
  const error = await runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    spawn: () => fakeWorker(JSON.stringify({ version: 2, ok: true, result: null }), 0),
  }).then(() => null, (failure) => failure);
  expect(error).toMatchObject({
    code: "invalid_response",
    details: {
      workerOperation: "page",
      responseCategory: "wrong_protocol_shape",
      stdoutBytes: 37,
      exitCode: 0,
      stderrPresent: false,
    },
  });
});

test("worker distinguishes success output with a nonzero exit", async () => {
  const error = await runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    spawn: () => fakeWorker(success("sentinel result"), 9, undefined, "sentinel stderr"),
  }).then(() => null, (failure) => failure);
  expect(error).toMatchObject({
    code: "operation_failed",
    details: {
      workerOperation: "page",
      responseCategory: "success_nonzero_exit",
      exitCode: 9,
      stderrPresent: true,
    },
  });
  expect(JSON.stringify(error)).not.toContain("sentinel");
});

bunAsNodeTest("bootstrap returns a structured error when the worker cannot load", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-bootstrap-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await chmod(join(root, "node", "node.exe"), 0o755);

    const error = await runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
      runtimeRoot: root,
      timeoutMs: 1_000,
    }).then(() => null, (failure) => failure);
    expect(error).toMatchObject({ code: "runtime_unavailable" });
    expect(error.details).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed Playwright storage source uses the supported direct export shape", async () => {
  const module = await import(pathToFileURL(join(import.meta.dir, "node_modules", "playwright-core", "lib", "generated", "storageScriptSource.js")).href);
  expect(typeof module.source).toBe("string");
  const commonJs = { exports: {} as Record<string, unknown> };
  Function("module", "exports", module.source)(commonJs, commonJs.exports);
  const StorageScript = commonJs.exports.StorageScript as (() => new (isFirefox: boolean) => unknown);
  expect(typeof StorageScript).toBe("function");
  expect(() => new (StorageScript())(false)).not.toThrow();
});

bunAsNodeTest("installed worker loads its packaged ESM dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-layout-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), "export const chromium = {};\n");
    await chmod(join(root, "node", "node.exe"), 0o755);

    const error = await runPlaywrightWorker("page", { endpoint: "ws://browser", connectTimeoutMs: 10 }, {
      runtimeRoot: root,
      timeoutMs: 1_000,
    }).then(() => null, (failure) => failure);
    expect(error).toMatchObject({ code: "timeout" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunAsNodeTest("worker retries until the persistent context appears without creating an incognito context", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-delayed-context-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      let connects = 0;
      const page = { evaluate: async () => "delayed-context" };
      const context = { pages: () => [page] };
      export const chromium = { async connectOverCDP() {
        connects++;
        return {
          contexts: () => connects === 1 ? [] : [context],
          async newContext() { throw new Error("must not create incognito context"); },
          async close() {},
        };
      } };
    `);
    await chmod(join(root, "node", "node.exe"), 0o755);

    expect(await runPlaywrightWorker<string>("page", { endpoint: "ws://browser", kind: "user-agent", connectTimeoutMs: 2_000 }, {
      runtimeRoot: root,
      timeoutMs: 5_000,
    })).toBe("delayed-context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunAsNodeTest("worker restore failures preserve operation and outcome details", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-error-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      const context = { pages: () => [], async clearCookies() { throw new Error("secret"); } };
      export const chromium = { async connectOverCDP() { return { contexts: () => [context], async close() {} }; } };
    `);
    await chmod(join(root, "node", "node.exe"), 0o755);

    const error = await runPlaywrightWorker("session-restore", {
      endpoint: "ws://browser", bundle: JSON.stringify({ cookies: [{ name: "a" }], origins: [] }), urls: [],
    }, { runtimeRoot: root, timeoutMs: 5_000 }).then(() => null, (failure) => failure);
    expect(error).toMatchObject({ code: "operation_failed", details: { operation: "cookie_clear", outcome: "failed" } });
    expect(error.message).not.toContain("secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunAsNodeTest("worker captures arbitrary web sessions, rejects malformed captures, and restores safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-web-session-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      const cookie = { name: "custom_auth", value: "value", domain: ".example.com", path: "/" };
      let captureMode = "valid";
      let bypassServiceWorker = false;
      let liveUrl = "https://example.com/dashboard";
      const livePage = {
        url() { return liveUrl; },
        async goto(url) { liveUrl = url; },
      };
      const routes = new Map();
      const context = {
        async storageState() {
          return {
            cookies: captureMode === "malformed-cookie" ? [{ name: "broken" }] : [cookie],
            origins: [],
          };
        },
        pages() { return [livePage]; },
        async newPage() {
          return {
            currentUrl: "about:blank",
            async goto(url) {
              const handler = routes.get(url);
              if (!handler) throw new Error("route missing");
              this.currentUrl = url;
              if (captureMode !== "service-worker" || bypassServiceWorker) await handler({ fulfill: async () => {} });
            },
            url() { return this.currentUrl; },
            async evaluate(_fn, input) {
              if (input) {
                if (input.entries?.length !== 1 || input.entries[0].name !== "session" || input.entries[0].value !== "active") throw new Error("wrong localStorage");
                if (input.databases?.length) throw new Error("unexpected IndexedDB");
                return true;
              }
              return { localStorage: [{ name: "session", value: captureMode === "malformed-storage" ? 42 : "active" }] };
            },
            async close() {},
          };
        },
        async newCDPSession() {
          return {
            async send(method, params) {
              if (method === "Network.setBypassServiceWorker" && params?.bypass === true) bypassServiceWorker = true;
            },
            async detach() {},
          };
        },
        async route(url, handler) {
          if (!url.startsWith("https://example.com/?__aliasmode_session_")) throw new Error("wrong session URL");
          routes.set(url, handler);
        },
        async unroute(url) { routes.delete(url); },
        async clearCookies() { if (liveUrl !== "about:blank") throw new Error("live target page was not blanked"); },
        async addCookies(cookies) { if (JSON.stringify(cookies) !== JSON.stringify([cookie])) throw new Error("wrong cookies"); },
      };
      export const chromium = { async connectOverCDP(endpoint) {
        bypassServiceWorker = false;
        if (endpoint.includes("malformed-cookie")) captureMode = "malformed-cookie";
        else if (endpoint.includes("malformed-storage")) captureMode = "malformed-storage";
        else if (endpoint.includes("internal-origin")) captureMode = "internal-origin";
        else if (endpoint.includes("service-worker")) captureMode = "service-worker";
        else captureMode = "valid";
        return { contexts: () => [context], async close() {} };
      } };
    `);
    await chmod(join(root, "node", "node.exe"), 0o755);

    const captured = JSON.parse(await runPlaywrightWorker<string>("session-capture", {
      endpoint: "ws://browser",
    }, { runtimeRoot: root, timeoutMs: 5_000 }));
    expect(captured).toEqual({
      cookies: [{ name: "custom_auth", value: "value", domain: ".example.com", path: "/" }],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "session", value: "active" }] }],
    });
    const malformedCookie = await runPlaywrightWorker("session-capture", {
      endpoint: "ws://malformed-cookie",
    }, { runtimeRoot: root, timeoutMs: 5_000 }).then(() => null, (failure) => failure);
    expect(malformedCookie).toMatchObject({ code: "operation_failed" });

    for (const endpoint of ["ws://malformed-storage", "ws://internal-origin"]) {
      const invalidOrigin = await runPlaywrightWorker("session-capture", {
        endpoint,
        ...(endpoint.endsWith("internal-origin")
          ? { captureSeed: { origins: ["chrome-extension://abc"] } }
          : {}),
      }, { runtimeRoot: root, timeoutMs: 5_000 }).then(() => null, (failure) => failure);
      expect(invalidOrigin).toMatchObject({ code: "operation_failed" });
    }

    expect(JSON.parse(await runPlaywrightWorker<string>("session-capture", {
      endpoint: "ws://service-worker",
    }, { runtimeRoot: root, timeoutMs: 5_000 }))).toEqual(captured);

    await expect(runPlaywrightWorker("session-restore", {
      endpoint: "ws://browser",
      bundle: JSON.stringify({
        cookies: captured.cookies,
        origins: [
          ...captured.origins,
          { origin: "chrome-extension://abc", localStorage: [{ name: "private", value: "drop" }] },
        ],
      }),
      urls: [],
    }, { runtimeRoot: root, timeoutMs: 5_000 })).resolves.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunAsNodeTest("worker fails closed on Telegram IndexedDB reads and applies empty tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-telegram-tombstone-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      let mode = "capture";
      const routes = new Map();
      const livePage = { url: () => "https://web.telegram.org/a/" };
      const context = {
        pages: () => mode === "capture" ? [livePage] : [],
        async newPage() {
          return {
            currentUrl: "about:blank",
            async goto(url) {
              const handler = routes.get(url);
              if (!handler) throw new Error("route missing");
              this.currentUrl = url;
              await handler({ fulfill: async () => {} });
            },
            url() { return this.currentUrl; },
            async evaluate(fn, input) {
              if (mode === "capture") {
                if (Array.isArray(input)) throw new Error("IndexedDB request failed");
                return { localStorage: [{ name: "dc2_auth_key", value: "live" }] };
              }
              const databases = new Set(["tt-passcode", "tweb-common", "tweb-account-2", "cache-db"]);
              const deleted = [];
              const values = new Map([["dc2_auth_key", "stale"]]);
              globalThis.indexedDB = {
                async databases() { return [...databases].map((name) => ({ name })); },
                deleteDatabase(name) {
                  const request = {};
                  queueMicrotask(() => { databases.delete(name); deleted.push(name); request.onsuccess?.(); });
                  return request;
                },
              };
              globalThis.localStorage = {};
              Object.defineProperties(globalThis.localStorage, {
                getItem: { value: (name) => values.get(name) ?? null },
                setItem: { value: (name, value) => values.set(name, value) },
                clear: { value: () => values.clear() },
              });
              await fn(input);
              if (JSON.stringify(deleted.sort()) !== JSON.stringify(["tt-passcode", "tweb-account-2", "tweb-common"])) throw new Error("wrong databases deleted");
              if (databases.size !== 1 || !databases.has("cache-db")) throw new Error("unrelated database deleted");
              if (values.size !== 0) throw new Error("localStorage not cleared");
              return true;
            },
            async close() {},
          };
        },
        async route(url, handler) { routes.set(url, handler); },
        async unroute(url) { routes.delete(url); },
        async storageState() { return { cookies: [], origins: [] }; },
        async clearCookies() {},
      };
      export const chromium = { async connectOverCDP(endpoint) {
        mode = endpoint.includes("restore") ? "restore" : "capture";
        return { contexts: () => [context], async close() {} };
      } };
    `);
    await chmod(join(root, "node", "node.exe"), 0o755);

    const captureError = await runPlaywrightWorker("session-capture", {
      endpoint: "ws://capture",
    }, { runtimeRoot: root, timeoutMs: 5_000 }).then(() => null, (failure) => failure);
    expect(captureError).toMatchObject({ code: "operation_failed" });

    await expect(runPlaywrightWorker("session-restore", {
      endpoint: "ws://restore",
      bundle: JSON.stringify({ cookies: [], origins: [{ origin: "https://web.telegram.org" }] }),
      urls: [],
    }, { runtimeRoot: root, timeoutMs: 5_000 })).resolves.toBeNull();

    await expect(runPlaywrightWorker("session-restore", {
      endpoint: "ws://restore",
      bundle: JSON.stringify({ cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage: [] }] }),
      urls: [],
    }, { runtimeRoot: root, timeoutMs: 5_000 })).resolves.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunAsNodeTest("worker captures current localStorage for a closed known origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-closed-origin-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      const storage = {
        "https://closed.example": [{ name: "token", value: "fresh-closed-value" }],
        "https://live.example": [{ name: "live", value: "current-value" }],
      };
      const livePage = { url: () => "https://live.example/dashboard" };
      const pages = [];
      const routes = new Map();
      const context = {
        pages: () => [livePage],
        async newPage() {
          const page = {
            currentUrl: "about:blank",
            closed: false,
            url() { return this.currentUrl; },
            async goto(url) {
              const handler = routes.get(url);
              if (!handler) throw new Error("network request was not intercepted");
              await handler({ fulfill: async () => {} });
              this.currentUrl = url;
            },
            async evaluate() { return { localStorage: storage[new URL(this.currentUrl).origin] ?? [] }; },
            async close() { this.closed = true; },
          };
          pages.push(page);
          return page;
        },
        async route(url, handler) { routes.set(url, handler); },
        async unroute(url) { routes.delete(url); },
        async storageState() {
          if (pages.some((page) => page.closed)) throw new Error("capture page closed before storage snapshot");
          return { cookies: [], origins: [] };
        },
      };
      export const chromium = { async connectOverCDP() { return { contexts: () => [context], async close() {} }; } };
    `);
    await chmod(join(root, "node", "node.exe"), 0o755);

    const captured = JSON.parse(await runPlaywrightWorker<string>("session-capture", {
      endpoint: "ws://browser",
      captureSeed: { origins: ["https://closed.example", "https://empty.example"] },
    }, { runtimeRoot: root, timeoutMs: 5_000 }));
    expect(captured).toEqual({
      cookies: [],
      origins: [
        { origin: "https://closed.example", localStorage: [{ name: "token", value: "fresh-closed-value" }] },
        { origin: "https://empty.example", localStorage: [] },
        { origin: "https://live.example", localStorage: [{ name: "live", value: "current-value" }] },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunAsNodeTest("worker rejects capture when an attached Telegram page cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-worker-telegram-capture-"));
  try {
    await mkdir(join(root, "node"), { recursive: true });
    await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
    await symlink(process.execPath, join(root, "node", "node.exe"));
    await writeFile(join(root, "worker.mjs"), await Bun.file(join(import.meta.dir, "playwright-worker.mjs")).text());
    await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.58.2", type: "module" }));
    await writeFile(join(root, "node_modules", "playwright-core", "index.mjs"), `
      const page = { url: () => "https://web.telegram.org/a/", async evaluate() { throw new Error("unavailable"); } };
      const context = { async storageState() { return { cookies: [], origins: [] }; }, pages: () => [page] };
      export const chromium = { async connectOverCDP() { return { contexts: () => [context], async close() {} }; } };
    `);
    await chmod(join(root, "node", "node.exe"), 0o755);

    const error = await runPlaywrightWorker("session-capture", {
      endpoint: "ws://browser",
    }, { runtimeRoot: root, timeoutMs: 5_000 }).then(() => null, (failure) => failure);
    expect(error).toMatchObject({ code: "operation_failed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads the installed Playwright ESM entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-playwright-runtime-"));
  try {
    const packageRoot = join(root, "node_modules", "playwright-core");
    const wsRoot = join(root, "node_modules", "ws");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(wsRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "playwright-core",
      version: "1.58.2",
    }));
    await writeFile(join(wsRoot, "package.json"), JSON.stringify({
      name: "ws",
      version: "8.21.0",
    }));
    await writeFile(join(packageRoot, "index.mjs"), "export const chromium = {};");
    await mkdir(join(root, "node"));
    await writeFile(join(root, "node", "node.exe"), "node");
    await writeFile(join(root, "worker.mjs"), "worker");

    await verifyPlaywrightRuntime(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an installed runtime without its ESM entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliasmode-playwright-runtime-"));
  try {
    const packageRoot = join(root, "node_modules", "playwright-core");
    const wsRoot = join(root, "node_modules", "ws");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(wsRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "playwright-core",
      version: "1.58.2",
    }));
    await writeFile(join(wsRoot, "package.json"), JSON.stringify({
      name: "ws",
      version: "8.21.0",
    }));

    await expect(verifyPlaywrightRuntime(root)).rejects.toThrow("incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  playwrightWorkerCommand,
  runPlaywrightWorker,
  verifyPlaywrightRuntime,
} from "./playwright-runtime.ts";

test("uses packaged Node and keeps requests off argv", () => {
  expect(playwrightWorkerCommand("C:\\AliasMode\\playwright")).toEqual([
    "C:\\AliasMode\\playwright/node/node.exe",
    "C:\\AliasMode\\playwright/worker.mjs",
  ]);
});

function textStream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body as ReadableStream<Uint8Array>;
}

function fakeWorker(output: string, exit = 0, onKill?: () => void) {
  return {
    stdin: { write() {}, end() {} },
    stdout: textStream(output),
    stderr: textStream(""),
    exited: Promise.resolve(exit),
    kill() { onKill?.(); },
  };
}

const success = (result: unknown) => JSON.stringify({ version: 1, ok: true, result });

test("worker request uses stdin and keeps endpoint and secrets off argv", async () => {
  const endpoint = "ws://user:secret@127.0.0.1/browser";
  let argv: string[] = [];
  let input = "";
  await runPlaywrightWorker("session-capture", { endpoint, token: "private" }, {
    runtimeRoot: "/fake/runtime",
    spawn(command) {
      argv = command;
      const worker = fakeWorker(success("bundle"));
      worker.stdin.write = ((value: string) => { input += value; }) as typeof worker.stdin.write;
      return worker;
    },
  });
  expect(argv).toEqual(["/fake/runtime/node/node.exe", "/fake/runtime/worker.mjs"]);
  expect(argv.join(" ")).not.toContain("secret");
  expect(argv.join(" ")).not.toContain("private");
  expect(JSON.parse(input).payload).toEqual({ endpoint, token: "private" });
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

test("worker rejects abrupt exit and malformed responses without affecting the parent", async () => {
  await expect(runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    spawn: () => fakeWorker("", 9),
  })).rejects.toMatchObject({ code: "invalid_response" });
  await expect(runPlaywrightWorker("page", { endpoint: "ws://browser" }, {
    spawn: () => fakeWorker("{broken", 0),
  })).rejects.toMatchObject({ code: "invalid_response" });
  expect(1 + 1).toBe(2);
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

test("installed worker loads its packaged ESM dependency", async () => {
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

test("worker retries until the persistent context appears without creating an incognito context", async () => {
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

test("worker restore failures preserve operation and outcome details", async () => {
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

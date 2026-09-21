import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const nodeRunner = join(ROOT, "script-runner.mjs");
const pythonRunner = join(ROOT, "script-runner.py");
const pythonExecutable = process.platform === "win32" ? "python" : "python3";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "aliasmode-script-runner-"));
}

function nodeRuntime(root: string): string {
  const runner = join(root, "agent", "script-runner.mjs");
  mkdirSync(join(root, "agent"), { recursive: true });
  cpSync(nodeRunner, runner);
  const playwright = join(root, "node_modules", "playwright-core");
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  writeFileSync(join(playwright, "index.mjs"), `
    export const chromium = {
      async connectOverCDP(endpoint) {
        process.stdout.write("connected " + endpoint + "\\n");
        return {
          contexts: () => [{
            pages: () => [{ kind: "first-page" }],
            newPage: async () => ({ kind: "new-page" }),
          }],
          close: async () => process.stdout.write("detached\\n"),
        };
      },
    };
  `);
  return runner;
}

function pythonRuntime(root: string): string {
  const fake = join(root, "fake-python", "playwright");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "__init__.py"), "");
  writeFileSync(join(fake, "async_api.py"), `
class Context:
    pages = [{"kind": "first-page"}]
    async def new_page(self):
        return {"kind": "new-page"}

class Browser:
    contexts = [Context()]
    async def close(self):
        print("detached", flush=True)

class Chromium:
    async def connect_over_cdp(self, endpoint, timeout=None):
        print(f"connected {endpoint}", flush=True)
        return Browser()

class Playwright:
    chromium = Chromium()
    async def start(self):
        return self
    async def stop(self):
        print("driver-stopped", flush=True)

def async_playwright():
    return Playwright()
`);
  return join(root, "fake-python");
}

async function output(child: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  return { stdout: stdout.replaceAll("\r\n", "\n"), stderr, code };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  let output = "";
  while (!output.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    output = (output + new TextDecoder().decode(value)).replaceAll("\r\n", "\n");
  }
  return output;
}

const input = {
  endpoint: "ws://127.0.0.1:9222/devtools/browser/test",
  profile: { id: "profile-1", name: "Profile", group: "Group", platform: "Windows" },
  inputs: { message: "hello" },
  credentials: { username: "user" },
};

test("Node script runner passes the CDP objects and user data without a completion message", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const script = join(root, "script.mjs");
    writeFileSync(script, `
      export default async ({ page, profile, inputs, credentials, log }) => {
        log(profile.id, inputs.message, credentials.username, page.kind);
      };
    `);
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    const result = await output(child);
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: "connected ws://127.0.0.1:9222/devtools/browser/test\nprofile-1 hello user first-page\ndetached\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner rejects private Firefox locators", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const child = Bun.spawn(["node", runner, "unused.mjs"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(`${JSON.stringify({ ...input, endpoint: "firefox://127.0.0.1:9000/generation" })}\n`);
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Firefox scripts run through the AliasMode manager");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner exits when its parent closes stdin", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const script = join(root, "script.mjs");
    writeFileSync(script, "export default async () => await new Promise(() => setInterval(() => {}, 1_000));");
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    child.stdin.end();
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Python script runner passes the CDP objects and stops its driver", async () => {
  const root = workspace();
  try {
    const script = join(root, "script.py");
    writeFileSync(script, `
async def run(*, page, profile, inputs, credentials, log, **_):
    log(profile["id"], inputs["message"], credentials["username"], page["kind"])
`);
    const child = Bun.spawn([pythonExecutable, pythonRunner, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pythonRuntime(root) },
    });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    const result = await output(child);
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: "connected ws://127.0.0.1:9222/devtools/browser/test\nprofile-1 hello user first-page\ndetached\ndriver-stopped\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Python script runner exits on parent EOF while user code blocks", async () => {
  const root = workspace();
  try {
    const script = join(root, "script.py");
    writeFileSync(script, "import time\nasync def run(*, log, **_):\n    log('blocking-ready')\n    time.sleep(60)\n");
    const child = Bun.spawn([pythonExecutable, pythonRunner, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pythonRuntime(root) },
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    child.stdin.write(`${JSON.stringify(input)}\n`);
    expect(await readUntil(reader, "blocking-ready\n")).toContain("blocking-ready\n");
    child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await stderr).toBe("");
    await reader.cancel();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

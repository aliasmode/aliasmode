import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { applySourceRuntime, installSourceNode, setupSourceRuntime, type SourceRuntime } from "./source-runtime.ts";

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "aliasmode-source-runtime-"));
  roots.push(path);
  return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function runtime(path: string): SourceRuntime {
  return {
    version: 1,
    node: join(path, "node", "bin", "node"),
    chromium: { path: join(path, "chrome"), sha256: "a".repeat(64) },
    firefox: { path: join(path, "firefox"), sha256: "b".repeat(64) },
  };
}
function save(path: string, value: unknown) {
  writeFileSync(join(path, "browser-runtime.json"), JSON.stringify(value));
}

test("source runtime loading is optional and loads both saved engine pairs without dotenv", () => {
  const path = root();
  const env = { PATH: "/system/bin" } as NodeJS.ProcessEnv;
  applySourceRuntime(path, env);
  expect(env).toEqual({ PATH: "/system/bin" });
  const saved = runtime(path);
  save(path, saved);
  applySourceRuntime(path, env);
  expect(env.CLOAKBROWSER_BINARY_PATH).toBe(saved.chromium.path);
  expect(env.CLOAKBROWSER_BINARY_SHA256).toBe(saved.chromium.sha256);
  expect(env.ALIASMODE_FIREFOX_BINARY_PATH).toBe(saved.firefox.path);
  expect(env.ALIASMODE_FIREFOX_BINARY_SHA256).toBe(saved.firefox.sha256);
  expect(env.PATH).toBe(`${dirname(saved.node)}${delimiter}/system/bin`);
  expect(existsSync(join(path, ".env"))).toBe(false);
});

test("explicit complete or partial engine overrides never borrow a saved identity", () => {
  const path = root();
  save(path, runtime(path));
  for (const prefix of ["CLOAKBROWSER", "ALIASMODE_FIREFOX"]) {
    for (const override of [
      { [`${prefix}_BINARY_PATH`]: "/explicit/browser" },
      { [`${prefix}_BINARY_SHA256`]: "" },
      { [`${prefix}_BINARY_PATH`]: "/explicit/browser", [`${prefix}_BINARY_SHA256`]: "c".repeat(64) },
    ]) {
      const env: NodeJS.ProcessEnv = { ...override };
      applySourceRuntime(path, env);
      expect(env[`${prefix}_BINARY_PATH`]).toBe(override[`${prefix}_BINARY_PATH`]);
      expect(env[`${prefix}_BINARY_SHA256`]).toBe(override[`${prefix}_BINARY_SHA256`]);
      const other = prefix === "CLOAKBROWSER" ? "ALIASMODE_FIREFOX" : "CLOAKBROWSER";
      expect(env[`${other}_BINARY_SHA256`]).toHaveLength(64);
    }
  }
});

test("source runtime configuration rejects incomplete pins without changing the environment", () => {
  const path = root();
  const saved = runtime(path);
  save(path, { ...saved, firefox: { path: saved.firefox.path } });
  const env: NodeJS.ProcessEnv = { PATH: "/unchanged" };
  expect(() => applySourceRuntime(path, env)).toThrow("bun cli.ts setup");
  expect(env).toEqual({ PATH: "/unchanged" });
});

test("managed Node uses an official pinned host download and rejects changed bytes", async () => {
  const path = root();
  const urls: string[] = [];
  await expect(installSourceNode(path, {
    platform: "darwin", arch: "arm64",
    fetch: async (url) => { urls.push(url); return new Response("not the approved Node archive"); },
  })).rejects.toThrow("SHA-256");
  expect(urls).toEqual(["https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz"]);
  expect(readdirSync(path)).toEqual([]);
  await expect(installSourceNode(path, { platform: "darwin", arch: "x64", fetch: async () => { throw new Error("must not download"); } }))
    .rejects.toThrow("unsupported");
});

function installers(fail = false) {
  let node = "";
  const browser = async (options: { cwd?: string; writeEnv?: boolean }, name: string) => {
    expect(options.writeEnv).toBe(false);
    const path = join(options.cwd!, name);
    writeFileSync(path, name);
    return { path, sha256: (name === "chrome" ? "a" : "b").repeat(64) };
  };
  return {
    installNode: async (path: string) => {
      node = join(path, "node", "bin", "node");
      mkdirSync(dirname(node), { recursive: true });
      writeFileSync(node, "fixture Node");
      return node;
    },
    installChromium: (options: { cwd?: string; writeEnv?: boolean } = {}) => browser(options, "chrome"),
    installFirefox: async (options: { cwd?: string; writeEnv?: boolean }) => {
      if (fail) throw new Error("Firefox download failed");
      return browser(options, "firefox");
    },
    verify: async () => { expect(process.env.PATH?.split(delimiter)[0]).toBe(dirname(node)); },
  };
}

test("setup commits verified runtimes together without changing mode or dotenv", async () => {
  const path = root();
  const mode = JSON.stringify({ version: 1, mode: "local", localAnalytics: false });
  writeFileSync(join(path, "config.json"), mode);
  const originalPath = process.env.PATH;
  await setupSourceRuntime(path, installers());
  const saved = JSON.parse(readFileSync(join(path, "browser-runtime.json"), "utf8")) as SourceRuntime;
  expect(saved.version).toBe(1);
  expect(existsSync(saved.node)).toBe(true);
  expect(existsSync(saved.chromium.path)).toBe(true);
  expect(existsSync(saved.firefox.path)).toBe(true);
  expect(saved.chromium.sha256).toBe("a".repeat(64));
  expect(saved.firefox.sha256).toBe("b".repeat(64));
  expect(readFileSync(join(path, "config.json"), "utf8")).toBe(mode);
  expect(existsSync(join(path, ".env"))).toBe(false);
  expect(process.env.PATH).toBe(originalPath);
});

test("failed setup keeps prior configuration and runtimes and removes only its staging", async () => {
  const path = root();
  const prior = runtime(path);
  writeFileSync(prior.chromium.path, "existing browser");
  save(path, prior);
  const originalPath = process.env.PATH;
  await expect(setupSourceRuntime(path, installers(true))).rejects.toThrow("Firefox download failed");
  expect(JSON.parse(readFileSync(join(path, "browser-runtime.json"), "utf8"))).toEqual(prior);
  expect(readFileSync(prior.chromium.path, "utf8")).toBe("existing browser");
  expect(readdirSync(join(path, "runtime"))).toEqual([]);
  expect(process.env.PATH).toBe(originalPath);
});

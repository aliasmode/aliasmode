import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWindowsBundle, WINDOWS_SIDECAR_TARGET } from "./prepare-windows-bundle.ts";
import { ALIASMODE_VERSION } from "../version.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function firefoxArchive(executable = "owned-firefox"): { bytes: Uint8Array; archiveSha256: string; executableSha256: string } {
  const name = new TextEncoder().encode("firefox/aliasmode.exe");
  const contents = new TextEncoder().encode(executable);
  const local = new Uint8Array(30 + name.length + contents.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(18, contents.length, true);
  localView.setUint32(22, contents.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(contents, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(20, contents.length, true);
  centralView.setUint32(24, contents.length, true);
  centralView.setUint16(28, name.length, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const bytes = new Uint8Array(local.length + central.length + end.length);
  bytes.set(local);
  bytes.set(central, local.length);
  bytes.set(end, local.length + central.length);
  return {
    bytes,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    executableSha256: sha256(executable),
  };
}

test("Windows sidecar supports x64 CPUs without AVX2", () => {
  expect(WINDOWS_SIDECAR_TARGET).toBe("bun-windows-x64-baseline");
});

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-windows-bundle-"));
  mkdirSync(join(cwd, "src-tauri"), { recursive: true });
  writeFileSync(join(cwd, "playwright-worker.mjs"), "worker");
  writeFileSync(join(cwd, "firefox-worker.mjs"), "firefox worker");
  mkdirSync(join(cwd, "agent"), { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-runner.mjs",
    "script-runner.py",
    "runtime-client.mjs",
  ]) {
    writeFileSync(join(cwd, "agent", file), file);
  }
  const dependencies: Record<string, { version: string; dependencies?: Record<string, string> }> = {
    "playwright-core": { version: "1.58.2" },
    "ws": { version: "8.21.0" },
    "@modelcontextprotocol/sdk": { version: "1.30.0", dependencies: { zod: "1.0.0" } },
    "@playwright/mcp": {
      version: "0.0.56",
      dependencies: { playwright: "1.58.0-alpha-2026-01-16", "playwright-core": "1.58.0-alpha-2026-01-16" },
    },
    "playwright": { version: "1.58.0-alpha-2026-01-16", dependencies: { "playwright-core": "1.58.0-alpha-2026-01-16" } },
    "zod": { version: "1.0.0" },
  };
  for (const [dependency, manifest] of Object.entries(dependencies)) {
    const root = join(cwd, "node_modules", ...dependency.split("/"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: dependency, ...manifest }));
  }
  return cwd;
}

async function installPython(root: string): Promise<void> {
  const python = join(root, "python");
  mkdirSync(join(python, "Lib", "site-packages", "playwright", "driver"), { recursive: true });
  writeFileSync(join(python, "python.exe"), "python");
  writeFileSync(join(python, "Lib", "site-packages", "playwright", "driver", "node.exe"), "driver");
}

test("Windows bundle preparation packages CloakBrowser and owned Firefox with verified hashes", async () => {
  const cwd = workspace();
  const browserBytes = "official-browser";
  const firefox = firefoxArchive();
  const staging = join(cwd, "src-tauri", "target", "desktop-staging");
  const browserCache = join(cwd, "src-tauri", "target", "cloakbrowser-cache");
  mkdirSync(staging, { recursive: true });
  mkdirSync(browserCache, { recursive: true });
  writeFileSync(join(staging, "stale"), "remove");
  writeFileSync(join(browserCache, "cached-download"), "keep");
  try {
    const metadata = await prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: firefox,
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installPython,
      installBrowser: async (installCwd, cacheDir) => {
        expect(installCwd).toBe(staging);
        expect(cacheDir).toBe(browserCache);
        expect(existsSync(join(staging, "stale"))).toBe(false);
        expect(readFileSync(join(cacheDir, "cached-download"), "utf8")).toBe("keep");
        const runtime = join(cacheDir, "cloakbrowser");
        mkdirSync(join(runtime, "locales"), { recursive: true });
        writeFileSync(join(runtime, "chrome.exe"), browserBytes);
        writeFileSync(join(runtime, "chromedriver.exe"), "driver");
        writeFileSync(join(runtime, "chrome.dll"), "dll");
        writeFileSync(join(runtime, "locales", "en-US.pak"), "locale");
        return { path: join(runtime, "chrome.exe"), sha256: sha256(browserBytes) };
      },
    });

    expect(metadata).toEqual({
      executable: "chrome.exe",
      sha256: sha256(browserBytes),
      wrapperVersion: "0.4.11",
      firefox: {
        executable: "firefox/aliasmode.exe",
        sha256: firefox.executableSha256,
        version: "152.0.4-beta.30",
        archiveSha256: firefox.archiveSha256,
      },
    });
    expect(readFileSync(join(cwd, "src-tauri", "resources", "cloakbrowser", "chrome.dll"), "utf8")).toBe("dll");
    expect(existsSync(join(cwd, "src-tauri", "resources", "cloakbrowser", "chromedriver.exe"))).toBe(false);
    expect(readFileSync(join(cwd, "src-tauri", "resources", "firefox", "firefox", "aliasmode.exe"), "utf8")).toBe("owned-firefox");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node", "node.exe"), "utf8")).toBe("node");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "python", "python.exe"), "utf8")).toBe("python");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "script-runner.mjs"), "utf8")).toBe("script-runner.mjs");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "script-runner.py"), "utf8")).toBe("script-runner.py");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "worker.mjs"), "utf8")).toBe("worker");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "playwright-worker.mjs"), "utf8")).toBe("worker");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "firefox-worker.mjs"), "utf8")).toBe("firefox worker");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "playwright-core", "package.json"), "utf8")).version).toBe("1.58.2");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "ws", "package.json"), "utf8")).version).toBe("8.21.0");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8")).version).toBe("1.30.0");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "@playwright", "mcp", "package.json"), "utf8")).version).toBe("0.0.56");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "playwright", "package.json"), "utf8")).version).toBe("1.58.0-alpha-2026-01-16");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "zod", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "mcp-host.mjs"), "utf8")).toBe("mcp-host.mjs");
    expect(readFileSync(join(cwd, "src-tauri", "binaries", "aliasmode-mcp-x86_64-pc-windows-msvc.exe"), "utf8")).toBe("agent");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
    expect(readFileSync(join(cwd, "src-tauri", "generated", "VERSION.txt"), "utf8")).toBe(`${ALIASMODE_VERSION}\n`);
    expect(readFileSync(join(browserCache, "cached-download"), "utf8")).toBe("keep");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a non-Windows browser payload", async () => {
  const cwd = workspace();
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: firefoxArchive(),
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installPython,
      installBrowser: async (_staging, cacheDir) => {
        const runtime = join(cacheDir, "cloakbrowser");
        mkdirSync(runtime, { recursive: true });
        writeFileSync(join(runtime, "chrome"), "browser");
        writeFileSync(join(runtime, "libEGL.so"), "linux");
        return { path: join(runtime, "chrome"), sha256: sha256("browser") };
      },
    })).rejects.toThrow("Windows chrome.exe");
    expect(existsSync(join(cwd, "src-tauri", "generated", "browser.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects installer paths outside its cache", async () => {
  const cwd = workspace();
  const outside = join(cwd, "outside", "chrome.exe");
  mkdirSync(join(cwd, "outside"), { recursive: true });
  writeFileSync(outside, "browser");
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: firefoxArchive(),
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installPython,
      installBrowser: async () => ({ path: outside, sha256: sha256("browser") }),
    })).rejects.toThrow("outside its cache directory");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a changed packaged executable", async () => {
  const cwd = workspace();
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: firefoxArchive(),
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installPython,
      installBrowser: async (_staging, cacheDir) => {
        const runtime = join(cacheDir, "cloakbrowser");
        mkdirSync(runtime, { recursive: true });
        const executable = join(runtime, "chrome.exe");
        writeFileSync(executable, "browser");
        return { path: executable, sha256: sha256("browser") };
      },
      hashFile: async (path) => path.includes("firefox") ? sha256("owned-firefox") : sha256("replaced"),
    })).rejects.toThrow("does not match the installed SHA-256");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a Firefox archive hash mismatch", async () => {
  const cwd = workspace();
  const archive = firefoxArchive();
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: { ...archive, archiveSha256: sha256("replaced") },
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
    })).rejects.toThrow("Firefox archive SHA-256 does not match the approved CI artifact");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a Firefox executable hash mismatch", async () => {
  const cwd = workspace();
  const archive = firefoxArchive();
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: { ...archive, executableSha256: sha256("replaced") },
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
    })).rejects.toThrow("Firefox executable does not match the approved SHA-256");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a changed Python archive before extraction", async () => {
  const cwd = workspace();
  try {
    await expect(prepareWindowsBundle({
      cwd, platform: "win32", arch: "x64",
      firefoxArchive: firefoxArchive(),
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      compileAgent: async (output) => { writeFileSync(output, "agent"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      downloadPython: async () => new TextEncoder().encode("changed archive"),
    })).rejects.toThrow("Python runtime SHA-256 mismatch");
    expect(existsSync(join(cwd, "src-tauri", "resources", "playwright", "python"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("desktop bundle preparation is Windows x64 only", async () => {
  await expect(prepareWindowsBundle({ platform: "linux", arch: "x64" })).rejects.toThrow("Windows x64");
  await expect(prepareWindowsBundle({ platform: "win32", arch: "arm64" })).rejects.toThrow("Windows x64");
});

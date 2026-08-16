import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWindowsBundle, WINDOWS_SIDECAR_TARGET } from "./prepare-windows-bundle.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("Windows sidecar supports x64 CPUs without AVX2", () => {
  expect(WINDOWS_SIDECAR_TARGET).toBe("bun-windows-x64-baseline");
});

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-windows-bundle-"));
  mkdirSync(join(cwd, "src-tauri"), { recursive: true });
  writeFileSync(join(cwd, "playwright-worker.mjs"), "worker");
  for (const dependency of ["playwright-core", "ws"]) {
    const root = join(cwd, "node_modules", dependency);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: dependency }));
  }
  return cwd;
}

test("Windows bundle preparation packages the official runtime and records its hash", async () => {
  const cwd = workspace();
  const browserBytes = "official-browser";
  try {
    const metadata = await prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installBrowser: async (staging) => {
        const runtime = join(staging, "cloakbrowser");
        mkdirSync(join(runtime, "locales"), { recursive: true });
        writeFileSync(join(runtime, "chrome.exe"), browserBytes);
        writeFileSync(join(runtime, "chrome.dll"), "dll");
        writeFileSync(join(runtime, "locales", "en-US.pak"), "locale");
        return { path: join(runtime, "chrome.exe"), sha256: sha256(browserBytes) };
      },
    });

    expect(metadata).toEqual({
      executable: "chrome.exe",
      sha256: sha256(browserBytes),
      wrapperVersion: "0.4.11",
    });
    expect(readFileSync(join(cwd, "src-tauri", "resources", "cloakbrowser", "chrome.dll"), "utf8")).toBe("dll");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node", "node.exe"), "utf8")).toBe("node");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "worker.mjs"), "utf8")).toBe("worker");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "playwright-core", "package.json"), "utf8"))).toEqual({ name: "playwright-core" });
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "ws", "package.json"), "utf8"))).toEqual({ name: "ws" });
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
    expect(readFileSync(join(cwd, "src-tauri", "generated", "VERSION.txt"), "utf8")).toBe("0.1.0-beta.32\n");
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
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installBrowser: async (staging) => {
        const runtime = join(staging, "cloakbrowser");
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

test("Windows bundle preparation rejects installer paths outside staging", async () => {
  const cwd = workspace();
  const outside = join(cwd, "outside", "chrome.exe");
  mkdirSync(join(cwd, "outside"), { recursive: true });
  writeFileSync(outside, "browser");
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installBrowser: async () => ({ path: outside, sha256: sha256("browser") }),
    })).rejects.toThrow("outside its staging directory");
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
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
      installBrowser: async (staging) => {
        const runtime = join(staging, "cloakbrowser");
        mkdirSync(runtime, { recursive: true });
        const executable = join(runtime, "chrome.exe");
        writeFileSync(executable, "browser");
        return { path: executable, sha256: sha256("browser") };
      },
      hashFile: async () => sha256("replaced"),
    })).rejects.toThrow("does not match the installed SHA-256");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("desktop bundle preparation is Windows x64 only", async () => {
  await expect(prepareWindowsBundle({ platform: "linux", arch: "x64" })).rejects.toThrow("Windows x64");
  await expect(prepareWindowsBundle({ platform: "win32", arch: "arm64" })).rejects.toThrow("Windows x64");
});

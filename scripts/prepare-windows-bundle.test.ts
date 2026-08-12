import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWindowsBundle } from "./prepare-windows-bundle.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-windows-bundle-"));
  mkdirSync(join(cwd, "src-tauri"), { recursive: true });
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
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
    expect(readFileSync(join(cwd, "src-tauri", "generated", "VERSION.txt"), "utf8")).toBe("0.1.0-beta.18\n");
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

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserEnvText,
  CLOAKBROWSER_VERSION,
  CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256,
  CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256,
  CLOAKBROWSER_WRAPPER_VERSION,
  installCloakBrowser,
} from "./browser-install.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("official CloakBrowser payload identity is pinned", () => {
  expect(CLOAKBROWSER_WRAPPER_VERSION).toBe("0.4.11");
  expect(CLOAKBROWSER_VERSION).toBe("146.0.7680.177.5");
  expect(CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256).toBe(
    "b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe",
  );
  expect(CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256).toBe(
    "03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80",
  );
});

test("browserEnvText preserves unrelated config and replaces old browser pins", () => {
  const hash = "a".repeat(64);
  const next = browserEnvText(
    "HUB_URL=https://hub.example\r\nCLOAKBROWSER_BINARY_PATH=C:\\old\\chrome.exe\r\nCLOAKBROWSER_BINARY_SHA256=bad\r\nHUB_PASSWORD=secret\r\n",
    "C:\\Users\\admin\\.cloakbrowser\\chromium-146\\chrome.exe",
    hash.toUpperCase(),
    "\r\n",
  );
  expect(next).toContain("HUB_URL=https://hub.example\r\n");
  expect(next).toContain("HUB_PASSWORD=secret\r\n");
  expect(next).not.toContain("C:\\old");
  expect(next).toContain("CLOAKBROWSER_BINARY_PATH=C:\\Users\\admin\\.cloakbrowser\\chromium-146\\chrome.exe\r\n");
  expect(next).toContain(`CLOAKBROWSER_BINARY_SHA256=${hash}\r\n`);
});

test("installCloakBrowser records the readable binary reported by the official installer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-"));
  dirs.push(dir);
  const binary = join(dir, "cache", "chrome.exe");
  writeFileSync(join(dir, ".env"), "HUB_PASSWORD=keep-me\n");

  const result = await installCloakBrowser({
    cwd: dir,
    runInstaller: async () => ({ code: 0, output: `Downloading...\n${binary}\n` }),
    exists: (path) => path === binary,
    hashFile: async () => CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256,
  });

  expect(result).toEqual({ path: binary, sha256: CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256 });
  const env = readFileSync(join(dir, ".env"), "utf8");
  expect(env).toContain("HUB_PASSWORD=keep-me");
  expect(env).toContain(`CLOAKBROWSER_BINARY_PATH=${binary}`);
  expect(env).toContain(`CLOAKBROWSER_BINARY_SHA256=${CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256}`);
});

test("installCloakBrowser writes nothing when the official installer fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-fail-"));
  dirs.push(dir);
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "HUB_PASSWORD=unchanged\n");
  await expect(installCloakBrowser({
    cwd: dir,
    runInstaller: async () => ({ code: 9, output: "download failed" }),
  })).rejects.toThrow("exited with code 9");
  expect(readFileSync(envPath, "utf8")).toBe("HUB_PASSWORD=unchanged\n");
});

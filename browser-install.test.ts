import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserEnvText, installCloakBrowser } from "./browser-install.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    hashFile: async () => "b".repeat(64),
  });

  expect(result).toEqual({ path: binary, sha256: "b".repeat(64) });
  const env = readFileSync(join(dir, ".env"), "utf8");
  expect(env).toContain("HUB_PASSWORD=keep-me");
  expect(env).toContain(`CLOAKBROWSER_BINARY_PATH=${binary}`);
  expect(env).toContain(`CLOAKBROWSER_BINARY_SHA256=${"b".repeat(64)}`);
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

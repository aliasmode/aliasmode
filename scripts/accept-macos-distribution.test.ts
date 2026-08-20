import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const path = join(import.meta.dir, "accept-macos-distribution.sh");
const script = existsSync(path) ? readFileSync(path, "utf8") : "";

test("macOS delivery acceptance preserves quarantine and uses Gatekeeper", () => {
  expect(script).toContain("xattr -w com.apple.quarantine");
  expect(script).not.toMatch(/xattr\s+-(?:c|d)\b/);
  expect(script).toContain("syspolicy_check distribution");
  expect(script).toContain("spctl --assess --type execute");
});

test("trusted macOS acceptance uses LaunchServices and confirms cleanup", () => {
  expect(script).toContain('open -n "$installed"');
  expect(script).toContain('xcrun stapler validate "$dmg"');
  expect(script).toContain('tell application id "com.aliasmode.desktop" to quit');
  expect(script).toContain('pgrep -P "$app_pid"');
});

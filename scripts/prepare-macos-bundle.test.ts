import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signResourcePrograms } from "./prepare-macos-bundle.ts";

let root = "";
const savedIdentity = process.env.APPLE_SIGNING_IDENTITY;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aliasmode-macos-sign-"));
});

afterEach(() => {
  if (savedIdentity === undefined) delete process.env.APPLE_SIGNING_IDENTITY;
  else process.env.APPLE_SIGNING_IDENTITY = savedIdentity;
  rmSync(root, { recursive: true, force: true });
});

function program(path: string, magic: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.concat([Buffer.from(magic, "hex"), Buffer.alloc(32)]));
  return path;
}

/** Runs the signing step with a stand-in for codesign and returns each command it asked for. */
async function signedPaths(identity?: string): Promise<{ paths: string[]; calls: string[][] }> {
  if (identity === undefined) delete process.env.APPLE_SIGNING_IDENTITY;
  else process.env.APPLE_SIGNING_IDENTITY = identity;
  const resources = join(root, "resources");
  const calls: string[][] = [];
  await signResourcePrograms(join(root, "src-tauri"), [join(resources, "firefox"), join(resources, "playwright")], async (command) => {
    calls.push(command);
  });
  return { calls, paths: calls.map((call) => call.at(-1)!.replace(`${resources}/`, "")) };
}

test("signs every Mach-O file and then every nested bundle, innermost first", async () => {
  const resources = join(root, "resources");
  const engine = join(resources, "firefox", "AliasMode.app", "Contents");
  program(join(engine, "MacOS", "aliasmode"), "cffaedfe");
  program(join(engine, "MacOS", "helper.app", "Contents", "MacOS", "helper"), "cffaedfe");
  program(join(engine, "Frameworks", "ChannelPrefs.framework", "ChannelPrefs"), "cffaedfe");
  // A universal library starts with the fat header, not the thin one.
  program(join(resources, "playwright", "python", "lib", "greenlet.so"), "cafebabe");
  program(join(resources, "playwright", "node", "node"), "cffaedfe");
  program(join(resources, "playwright", "python", "lib", "module.py"), "696d706f");
  writeFileSync(join(engine, "Info.plist"), "");

  const { paths, calls } = await signedPaths();

  expect([...paths].sort()).toEqual([
    "firefox/AliasMode.app",
    "firefox/AliasMode.app/Contents/Frameworks/ChannelPrefs.framework",
    "firefox/AliasMode.app/Contents/Frameworks/ChannelPrefs.framework/ChannelPrefs",
    "firefox/AliasMode.app/Contents/MacOS/aliasmode",
    "firefox/AliasMode.app/Contents/MacOS/helper.app",
    "firefox/AliasMode.app/Contents/MacOS/helper.app/Contents/MacOS/helper",
    "playwright/node/node",
    "playwright/python/lib/greenlet.so",
  ]);
  const position = (path: string) => paths.indexOf(path);
  expect(position("firefox/AliasMode.app/Contents/MacOS/helper.app/Contents/MacOS/helper")).toBeLessThan(position("firefox/AliasMode.app/Contents/MacOS/aliasmode"));
  expect(position("firefox/AliasMode.app/Contents/MacOS/aliasmode")).toBeLessThan(position("firefox/AliasMode.app/Contents/MacOS/helper.app"));
  expect(position("firefox/AliasMode.app/Contents/MacOS/helper.app")).toBeLessThan(position("firefox/AliasMode.app"));
  expect(paths.at(-1)).toBe("firefox/AliasMode.app");
  const entitlements = join(root, "src-tauri", "macos", "entitlements.plist");
  for (const call of calls) {
    expect(call.slice(0, -1)).toEqual(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements]);
  }
});

test("a signing identity from the environment adds a timestamp", async () => {
  program(join(root, "resources", "playwright", "node", "node"), "cffaedfe");
  mkdirSync(join(root, "resources", "firefox"), { recursive: true });

  const { calls } = await signedPaths("Developer ID Application: Example (ABCDE12345)");

  expect(calls).toEqual([[
    "codesign", "--force", "--sign", "Developer ID Application: Example (ABCDE12345)", "--options", "runtime",
    "--entitlements", join(root, "src-tauri", "macos", "entitlements.plist"), "--timestamp",
    join(root, "resources", "playwright", "node", "node"),
  ]]);
});

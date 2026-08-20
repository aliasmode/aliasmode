import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DARWIN_ARM64_SIDECAR_TARGET, prepareDarwinArm64Bundle } from "./prepare-darwin-arm64-bundle.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const symlinkTest = process.platform === "win32" ? test.skip : test;

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-darwin-bundle-"));
  mkdirSync(join(cwd, "src-tauri"), { recursive: true });
  writeFileSync(join(cwd, "playwright-worker.mjs"), "worker");
  for (const dependency of ["playwright-core", "ws"]) {
    const root = join(cwd, "node_modules", dependency);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: dependency }));
  }
  return cwd;
}

function installNode(root: string): void {
  mkdirSync(join(root, "node"), { recursive: true });
  writeFileSync(join(root, "node", "node"), "node");
}

function installBrowser(staging: string, bytes = "official-browser") {
  const app = join(staging, "cloakbrowser", "Chromium.app");
  const executable = join(app, "Contents", "MacOS", "Chromium");
  mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(executable, bytes);
  writeFileSync(join(app, "Contents", "Frameworks", "framework"), "framework");
  return { path: executable, sha256: sha256(bytes) };
}

test("Darwin sidecar targets Apple Silicon", () => {
  expect(DARWIN_ARM64_SIDECAR_TARGET).toBe("bun-darwin-arm64");
});

test("Darwin bundle preparation packages the complete app and native Node runtime", async () => {
  const cwd = workspace();
  try {
    const metadata = await prepareDarwinArm64Bundle({
      cwd,
      platform: "darwin",
      arch: "arm64",
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => installNode(root),
      installBrowser: async (staging) => installBrowser(staging),
    });

    expect(metadata).toEqual({
      executable: "Chromium.app/Contents/MacOS/Chromium",
      sha256: sha256("official-browser"),
      wrapperVersion: "0.4.11",
    });
    expect(readFileSync(join(cwd, "src-tauri", "resources", "cloakbrowser", "Chromium.app", "Contents", "Frameworks", "framework"), "utf8")).toBe("framework");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node", "node"), "utf8")).toBe("node");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

symlinkTest("Darwin bundle preparation preserves internal links and rejects escaped links", async () => {
  const cwd = workspace();
  const common = {
    cwd,
    platform: "darwin" as const,
    arch: "arm64",
    compileSidecar: async (output: string) => { writeFileSync(output, "sidecar"); },
    installNode: async (root: string) => installNode(root),
  };
  try {
    await prepareDarwinArm64Bundle({
      ...common,
      installBrowser: async (staging) => {
        const installed = installBrowser(staging);
        const frameworks = join(staging, "cloakbrowser", "Chromium.app", "Contents", "Frameworks");
        symlinkSync("../MacOS/Chromium", join(frameworks, "Current"));
        return installed;
      },
    });
    expect(readlinkSync(join(cwd, "src-tauri", "resources", "cloakbrowser", "Chromium.app", "Contents", "Frameworks", "Current"))).toBe("../MacOS/Chromium");

    const outside = join(cwd, "outside");
    writeFileSync(outside, "outside");
    await expect(prepareDarwinArm64Bundle({
      ...common,
      installBrowser: async (staging) => {
        const installed = installBrowser(staging);
        const frameworks = join(staging, "cloakbrowser", "Chromium.app", "Contents", "Frameworks");
        symlinkSync(outside, join(frameworks, "Escaped"));
        return installed;
      },
    })).rejects.toThrow("unsafe symlink");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Darwin bundle preparation rejects the wrong browser layout and escaped paths", async () => {
  const cwd = workspace();
  const outside = join(cwd, "outside", "Chromium.app", "Contents", "MacOS", "Chromium");
  mkdirSync(join(outside, ".."), { recursive: true });
  writeFileSync(outside, "browser");
  const common = {
    cwd,
    platform: "darwin" as const,
    arch: "arm64",
    compileSidecar: async (output: string) => { writeFileSync(output, "sidecar"); },
    installNode: async (root: string) => installNode(root),
  };
  try {
    await expect(prepareDarwinArm64Bundle({
      ...common,
      installBrowser: async (staging) => {
        const runtime = join(staging, "cloakbrowser");
        mkdirSync(runtime, { recursive: true });
        const executable = join(runtime, "chrome.exe");
        writeFileSync(executable, "browser");
        return { path: executable, sha256: sha256("browser") };
      },
    })).rejects.toThrow("Chromium.app");
    expect(existsSync(join(cwd, "src-tauri", "generated", "browser.json"))).toBe(false);

    await expect(prepareDarwinArm64Bundle({
      ...common,
      installBrowser: async () => ({ path: outside, sha256: sha256("browser") }),
    })).rejects.toThrow("outside its staging directory");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Darwin bundle preparation rejects changed bytes and unsupported hosts", async () => {
  const cwd = workspace();
  try {
    await expect(prepareDarwinArm64Bundle({
      cwd,
      platform: "darwin",
      arch: "arm64",
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => installNode(root),
      installBrowser: async (staging) => installBrowser(staging),
      hashFile: async () => sha256("replaced"),
    })).rejects.toThrow("does not match the installed SHA-256");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  await expect(prepareDarwinArm64Bundle({ platform: "linux", arch: "arm64" })).rejects.toThrow("macOS arm64");
  await expect(prepareDarwinArm64Bundle({ platform: "darwin", arch: "x64" })).rejects.toThrow("macOS arm64");
});

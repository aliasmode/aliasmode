import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWindowsBundle, SIDECAR_BUILD_FLAGS, WINDOWS_SIDECAR_TARGET } from "./prepare-windows-bundle.ts";
import { MCP_MODE } from "../sidecar-entry.ts";
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

test("one sidecar program also runs the MCP helper behind the aliasmode-mcp launcher", () => {
  const repo = join(import.meta.dir, "..");
  const tauri = JSON.parse(readFileSync(join(repo, "src-tauri", "tauri.conf.json"), "utf8"));
  expect(tauri.bundle.externalBin).toEqual(["binaries/aliasmode-sidecar"]);
  const cargo = readFileSync(join(repo, "src-tauri", "Cargo.toml"), "utf8");
  expect(cargo).toContain(`default-run = "aliasmode"`);
  expect(cargo).toContain(`name = "aliasmode-mcp"\npath = "src/bin/aliasmode-mcp.rs"`);
  const launcher = readFileSync(join(repo, "src-tauri", "src", "bin", "aliasmode-mcp.rs"), "utf8");
  expect(launcher).toContain(`const MCP_MODE: &str = "${MCP_MODE}";`);

  const helper = Bun.spawnSync([process.execPath, "sidecar-entry.ts", MCP_MODE, "version"], { cwd: repo });
  expect(helper.exitCode).toBe(0);
  expect(JSON.parse(helper.stdout.toString())).toEqual({ ok: true, result: { version: ALIASMODE_VERSION } });
  const failed = Bun.spawnSync([process.execPath, "sidecar-entry.ts", MCP_MODE, "unknown"], { cwd: repo });
  expect(failed.exitCode).toBe(1);
  expect(JSON.parse(failed.stdout.toString())).toMatchObject({ ok: false });
});

// An import cycle through a module with top-level await runs fine from source but hangs the bundled
// sidecar before it prints anything, as main 109dcb5 did (agent-control.ts <-> scripts.ts).
test("the bundled sidecar finishes loading its modules", async () => {
  const repo = join(import.meta.dir, "..");
  const out = mkdtempSync(join(tmpdir(), "aliasmode-sidecar-bundle-"));
  try {
    const build = Bun.spawnSync([process.execPath, "build", "--target=bun", ...SIDECAR_BUILD_FLAGS, "sidecar-entry.ts", "--outdir", out], { cwd: repo });
    expect(build.exitCode).toBe(0);
    // A command with no side effects that answers only once cli.ts and all it imports have loaded.
    const child = Bun.spawn([process.execPath, join(out, "sidecar-entry.js"), "__import-cloakpit"], { cwd: out, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 30_000);
    const stdout = await new Response(child.stdout).text();
    clearTimeout(timer);
    expect(await child.exited).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, message: expect.stringContaining("No Cloakpit source was selected") });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);

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

test("Windows bundle preparation packages owned Firefox with verified hashes and no CloakBrowser", async () => {
  const cwd = workspace();
  const firefox = firefoxArchive();
  const staging = join(cwd, "src-tauri", "target", "desktop-staging");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "stale"), "remove");
  try {
    const metadata = await prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: firefox,
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
    });

    // The app downloads CloakBrowser on first use, so the installer carries none.
    expect(metadata).toEqual({
      firefox: {
        executable: "firefox/aliasmode.exe",
        sha256: firefox.executableSha256,
        version: "159.0-beta.43",
        archiveSha256: firefox.archiveSha256,
      },
    });
    expect(existsSync(join(staging, "stale"))).toBe(false);
    expect(existsSync(join(cwd, "src-tauri", "resources", "cloakbrowser"))).toBe(false);
    expect(readFileSync(join(cwd, "src-tauri", "resources", "firefox", "firefox", "aliasmode.exe"), "utf8")).toBe("owned-firefox");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node", "node.exe"), "utf8")).toBe("node");
    // Python scripts download their runtime on first use; the bundle carries no Python.
    expect(existsSync(join(cwd, "src-tauri", "resources", "playwright", "python"))).toBe(false);
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
    expect(readFileSync(join(cwd, "src-tauri", "binaries", "aliasmode-sidecar-x86_64-pc-windows-msvc.exe"), "utf8")).toBe("sidecar");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
    expect(readFileSync(join(cwd, "src-tauri", "generated", "VERSION.txt"), "utf8")).toBe(`${ALIASMODE_VERSION}\n`);
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
    })).rejects.toThrow("Firefox executable does not match the approved SHA-256");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("desktop bundle preparation is Windows x64 only", async () => {
  await expect(prepareWindowsBundle({ platform: "linux", arch: "x64" })).rejects.toThrow("Windows x64");
  await expect(prepareWindowsBundle({ platform: "win32", arch: "arm64" })).rejects.toThrow("Windows x64");
});

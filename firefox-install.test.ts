import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { browserEnvText } from "./browser-install.ts";
import { firefoxBuildForHost, installFirefox, type FirefoxRuntimeBuild } from "./firefox-install.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

for (const args of [["--engine", "firefox"], ["--engine", "invalid"]]) {
  test(`browser setup rejects incomplete engine options: ${args.join(" ")}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aliasmode-firefox-setup-cli-"));
    roots.push(cwd);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "install-browser", ...args], {
      cwd, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });
}


function fixture(platform: "linux" | "darwin" = "linux") {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-firefox-install-"));
  roots.push(cwd);
  const archive = join(cwd, "owned-browser.zip");
  writeFileSync(archive, "approved archive");
  writeFileSync(join(cwd, ".env"), "CLOAKBROWSER_BINARY_PATH=existing-chromium\nALIASMODE_FIREFOX_BINARY_PATH=old-firefox\nALIASMODE_FIREFOX_BINARY_SHA256=old-hash\n");
  const build: FirefoxRuntimeBuild = {
    platform, arch: platform === "darwin" ? "arm64" : "x64",
    executablePath: platform === "darwin" ? "AliasMode.app/Contents/MacOS/aliasmode" : "aliasmode",
    archiveSha256: hash("approved archive"), executableSha256: hash("approved executable"),
  };
  const extract = async (_archive: string, destination: string) => {
    const executable = join(destination, build.executablePath);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "approved executable", { mode: 0o755 });
    writeFileSync(join(destination, "runtime-resource"), "preserved");
  };
  return { cwd, archive, build, extract };
}

test("Firefox setup selects only matching host builds", () => {
  const { build } = fixture();
  expect(firefoxBuildForHost("linux", "x64", [build])).toBe(build);
  expect(() => firefoxBuildForHost("linux", "arm64", [build])).toThrow("Linux");
  expect(() => firefoxBuildForHost("darwin", "x64", [build])).toThrow("macOS");
});

test("Firefox setup includes approved builds for every supported host", () => {
  for (const [platform, arch] of [["win32", "x64"], ["linux", "x64"], ["darwin", "arm64"]] as const) {
    const build = firefoxBuildForHost(platform, arch);
    expect(build).toMatchObject({ platform, arch });
    expect(build.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(build.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("Firefox configuration preserves Chromium pins and replaces only Firefox pins", () => {
  const value = browserEnvText("CLOAKBROWSER_BINARY_PATH=chromium\nALIASMODE_FIREFOX_BINARY_PATH=old\nALIASMODE_FIREFOX_BINARY_SHA256=old\n", "/new firefox/aliasmode", "a".repeat(64), "\n", "ALIASMODE_FIREFOX");
  expect(value).toContain("CLOAKBROWSER_BINARY_PATH=chromium\n");
  expect(value).toContain("ALIASMODE_FIREFOX_BINARY_PATH=/new firefox/aliasmode\n");
  expect(value).toContain(`ALIASMODE_FIREFOX_BINARY_SHA256=${"a".repeat(64)}\n`);
  expect(value).not.toContain("=old");
});

for (const platform of ["linux", "darwin"] as const) {
  test(`Firefox setup pins the complete verified ${platform} runtime`, async () => {
    const f = fixture(platform);
    const result = await installFirefox({ archive: f.archive, cwd: f.cwd, platform, arch: f.build.arch }, { builds: [f.build], extract: f.extract });
    expect(result.sha256).toBe(f.build.executableSha256);
    expect(result.path.endsWith(f.build.executablePath)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("approved executable");
    if (process.platform !== "win32") expect(() => accessSync(result.path, constants.X_OK)).not.toThrow();
    const directories = readdirSync(join(f.cwd, "browser"));
    expect(directories).toHaveLength(1);
    expect(readFileSync(join(f.cwd, "browser", directories[0]!, "runtime-resource"), "utf8")).toBe("preserved");
    const config = readFileSync(join(f.cwd, ".env"), "utf8");
    expect(config).toContain("CLOAKBROWSER_BINARY_PATH=existing-chromium\n");
    expect(config).toContain(`ALIASMODE_FIREFOX_BINARY_PATH=${result.path}`);
    expect(config).toContain(`ALIASMODE_FIREFOX_BINARY_SHA256=${result.sha256}`);
    const second = await installFirefox({ archive: f.archive, cwd: f.cwd, platform, arch: f.build.arch }, { builds: [f.build], extract: f.extract });
    expect(second.path).not.toBe(result.path);
    expect(readFileSync(result.path, "utf8")).toBe("approved executable");
  });
}

test("Firefox setup rejects an unapproved archive before extraction or config changes", async () => {
  const f = fixture();
  const original = readFileSync(join(f.cwd, ".env"), "utf8");
  writeFileSync(f.archive, "wrong platform or modified archive");
  let extracted = false;
  await expect(installFirefox({ archive: f.archive, cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], extract: async () => { extracted = true; },
  })).rejects.toThrow("SHA-256");
  expect(extracted).toBe(false);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
  expect(readFileSync(join(f.cwd, ".env"), "utf8")).toBe(original);
});

test("Firefox setup removes only its failed extraction and preserves prior configuration", async () => {
  const f = fixture();
  const original = readFileSync(join(f.cwd, ".env"), "utf8");
  const previous = join(f.cwd, "browser", "existing-runtime");
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, "in-use"), "keep");
  await expect(installFirefox({ archive: f.archive, cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], extract: async (archive, destination) => {
      await f.extract(archive, destination);
      writeFileSync(join(destination, f.build.executablePath), "modified executable");
    },
  })).rejects.toThrow("SHA-256");
  expect(readdirSync(join(f.cwd, "browser"))).toEqual(["existing-runtime"]);
  expect(readFileSync(join(previous, "in-use"), "utf8")).toBe("keep");
  expect(readFileSync(join(f.cwd, ".env"), "utf8")).toBe(original);
});

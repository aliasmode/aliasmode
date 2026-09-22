import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { browserEnvText } from "./browser-install.ts";
import { firefoxBuildForHost, firefoxReleaseArchiveUrl, installFirefox, type FirefoxRuntimeBuild } from "./firefox-install.ts";

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


function fixture(platform: "linux" | "darwin" = "linux", writeEnv = true) {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-firefox-install-"));
  roots.push(cwd);
  const archive = join(cwd, "owned-browser.zip");
  writeFileSync(archive, "approved archive");
  if (writeEnv) {
    writeFileSync(join(cwd, ".env"), "CLOAKBROWSER_BINARY_PATH=existing-chromium\nALIASMODE_FIREFOX_BINARY_PATH=old-firefox\nALIASMODE_FIREFOX_BINARY_SHA256=old-hash\n");
  }
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

test("Firefox setup uses the exact approved public release archive for each host", () => {
  const expected = {
    "linux-x64": "aliasmode-152.0.4-beta.30-lin.x86_64.zip",
    "darwin-arm64": "aliasmode-152.0.4-beta.30-mac.arm64.zip",
    "win32-x64": "aliasmode-152.0.4-beta.30-win.x86_64.zip",
  };
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const) {
    const archive = expected[`${platform}-${arch}` as keyof typeof expected];
    expect(firefoxReleaseArchiveUrl(firefoxBuildForHost(platform, arch))).toBe(
      `https://github.com/aliasmode/aliasmode-firefox/releases/download/aliasmode-runtime-152.0.4-beta.30-r1/${archive}`,
    );
  }
});

test("Firefox setup downloads, verifies, and pins the host release without environment output", async () => {
  const f = fixture("darwin", false);
  let requested = "";
  const result = await installFirefox({ cwd: f.cwd, platform: "darwin", arch: "arm64", writeEnv: false }, {
    builds: [f.build],
    extract: f.extract,
    fetch: async (input) => {
      requested = String(input);
      return new Response("approved archive");
    },
  });

  expect(requested).toBe("https://github.com/aliasmode/aliasmode-firefox/releases/download/aliasmode-runtime-152.0.4-beta.30-r1/aliasmode-152.0.4-beta.30-mac.arm64.zip");
  expect(result.sha256).toBe(f.build.executableSha256);
  expect(existsSync(join(f.cwd, ".env"))).toBe(false);
  expect(readdirSync(f.cwd).some((entry) => entry.startsWith(".aliasmode-firefox-download-"))).toBe(false);
});

test("Firefox setup completes a redirected streaming download before extraction", async () => {
  const f = fixture("linux", false);
  const archive = "approved archive".repeat(65_536);
  f.build.archiveSha256 = hash(archive);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request): Response {
      if (new URL(request.url).pathname === "/release") return Response.redirect(`${server.url}archive`);
      return new Response(new ReadableStream({
        async start(controller) {
          for (let offset = 0; offset < archive.length; offset += 65_536) {
            controller.enqueue(new TextEncoder().encode(archive.slice(offset, offset + 65_536)));
            await Bun.sleep(1);
          }
          controller.close();
        },
      }));
    },
  });
  try {
    const result = await installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
      builds: [f.build], fetch: () => fetch(`${server.url}release`),
      extract: async (path, destination) => {
        expect(readFileSync(path, "utf8")).toBe(archive);
        await f.extract(path, destination);
      },
    });
    expect(result.sha256).toBe(f.build.executableSha256);
    expect(readdirSync(f.cwd).some((entry) => entry.startsWith(".aliasmode-firefox-download-"))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("Firefox setup removes its failed public release download", async () => {
  const f = fixture("linux", false);
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
    builds: [f.build],
    extract: f.extract,
    fetch: async () => new Response("missing", { status: 404 }),
  })).rejects.toThrow("download failed");

  expect(readdirSync(f.cwd).some((entry) => entry.startsWith(".aliasmode-firefox-download-"))).toBe(false);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
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

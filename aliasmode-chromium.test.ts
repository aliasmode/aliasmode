import { test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  aliasmodeChromiumArchive,
  aliasmodeChromiumExecutable,
  chromiumComponentsDir,
  CLOAKBROWSER_LINUX_EXECUTABLE_SHA256,
  CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
  CLOAKBROWSER_MACOS_X64_EXECUTABLE_SHA256,
  cloakBrowserExecutableSha256,
  defaultChromiumRuntime,
  ensureAliasmodeChromium,
  ensureCloakBrowser,
  hostChromiumRuntime,
  hostDisplayAvail,
  hostDisplayScale,
  LINUX_CHROMIUM_APPARMOR_PROFILE,
  linuxChromiumSandboxBlocked,
  pruneBrowserRuntimes,
  shareChromiumComponents,
  supportsChromium155Host,
  type AliasmodeChromiumDeps,
} from "./aliasmode-chromium.ts";
import { runtimeDownloads } from "./runtime-download.ts";

const WINDOWS_155 = aliasmodeChromiumArchive("win32");
import { buildNewProfile } from "./create.ts";
import { parseExport, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";

/** Fake archive whose files carry their pinned hashes by content. */
function fakeRelease(options: { archiveHash?: string; executableHash?: string } = {}) {
  const downloads: string[] = [];
  const commands: string[][] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, options.archiveHash ?? WINDOWS_155.archiveSha256);
    },
    extract: async (_archive, directory) => {
      const root = join(directory, "aliasmode-chromium-155.0.8059.85-windows-x64");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "chrome.exe"), options.executableHash ?? WINDOWS_155.executableSha256);
      writeFileSync(join(root, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
    run: async (command) => { commands.push(command); },
  };
  return { deps, downloads, commands };
}

test("installs AliasMode's own 155 build once, beside any earlier runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  mkdirSync(join(root, ".chromium-155.0.8059.85-aliasmode.4-stale"));
  // Earlier runtimes stay put for browsers still running from them.
  const earlier = ["chromium-155.0.8059.31", "chromium-155.0.8059.31-aliasmode.1", "chromium-155.0.8059.31-aliasmode.2", "chromium-155.0.8059.85-aliasmode.1", "chromium-155.0.8059.85-aliasmode.2", "chromium-155.0.8059.85-aliasmode.3"];
  for (const dir of earlier) mkdirSync(join(root, dir));
  const release = fakeRelease();

  const executable = await ensureAliasmodeChromium(root, release.deps, "win32");
  expect(executable).toBe(aliasmodeChromiumExecutable(root, "win32"));
  expect(release.downloads).toEqual([WINDOWS_155.url]);
  expect(WINDOWS_155.url).toBe(
    "https://github.com/aliasmode/aliasmode-chromium/releases/download/v155.0.8059.85-aliasmode.4/aliasmode-chromium-155.0.8059.85-windows-x64.zip",
  );
  expect([WINDOWS_155.archiveSha256, WINDOWS_155.executableSha256]).toEqual([
    "cfea275e4b7f3274b701e64c0483b46cbf6cd12ead9a6cfda6ff77b2680e7a23",
    "0ef4de1bef7c12534031318e07ac89fa7942916a3abc89057985aafefbca619f",
  ]);
  expect(executable).toBe(join(root, "chromium-155.0.8059.85-aliasmode.4", "chrome.exe"));
  expect(readdirSync(root).sort()).toEqual([...earlier, "chromium-155.0.8059.85-aliasmode.4"]);

  expect(await ensureAliasmodeChromium(root, release.deps, "win32")).toBe(executable);
  expect(release.downloads).toHaveLength(1);
  expect(release.commands).toEqual([
    ["icacls.exe", realpathSync(dirname(executable)), "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "/T", "/Q"],
  ]);
});

test("repairs a previously installed Windows runtime without downloading or changing its files", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const executable = aliasmodeChromiumExecutable(root, "win32");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, WINDOWS_155.executableSha256);
  writeFileSync(join(dirname(executable), "chrome.dll"), "existing dll");
  const release = fakeRelease();

  expect(await ensureAliasmodeChromium(root, release.deps, "win32")).toBe(executable);
  expect(release.downloads).toEqual([]);
  expect(release.commands).toEqual([
    ["icacls.exe", realpathSync(dirname(executable)), "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "/T", "/Q"],
  ]);
  expect(readFileSync(join(dirname(executable), "chrome.dll"), "utf8")).toBe("existing dll");
  await ensureAliasmodeChromium(root, release.deps, "win32");
  expect(release.commands).toHaveLength(1);
});

test("a Windows permission failure rejects the runtime and is retried without downloading it again", async () => {
  for (const alreadyInstalled of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
    const executable = aliasmodeChromiumExecutable(root, "win32");
    if (alreadyInstalled) {
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, WINDOWS_155.executableSha256);
    }
    const release = fakeRelease();
    let attempts = 0;
    release.deps.run = async () => {
      if (++attempts === 1) throw new Error("icacls.exe exited with code 5");
    };
    await expect(ensureAliasmodeChromium(root, release.deps, "win32")).rejects.toThrow("Windows sandbox read/execute access");
    expect(readFileSync(executable, "utf8")).toBe(WINDOWS_155.executableSha256);
    expect(await ensureAliasmodeChromium(root, release.deps, "win32")).toBe(executable);
    expect(attempts).toBe(2);
    expect(release.downloads).toHaveLength(alreadyInstalled ? 0 : 1);
  }
});

test("concurrent Windows runtime requests wait for one permission preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const release = fakeRelease();
  let started!: () => void;
  let finish!: () => void;
  const preparing = new Promise<void>((resolve) => { started = resolve; });
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  const run = release.deps.run!;
  release.deps.run = async (command) => {
    await run(command);
    started();
    await ready;
  };
  let returned = false;
  const first = ensureAliasmodeChromium(root, release.deps, "win32").then((path) => { returned = true; return path; });
  const second = ensureAliasmodeChromium(root, release.deps, "win32");
  await preparing;
  expect(returned).toBe(false);
  expect(release.commands).toHaveLength(1);
  finish();
  const executable = aliasmodeChromiumExecutable(root, "win32");
  expect(await Promise.all([first, second])).toEqual([executable, executable]);
  expect(release.downloads).toHaveLength(1);
  expect(release.commands).toHaveLength(1);
});

test("replacing a Windows runtime directory prepares its permissions again", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const release = fakeRelease();
  const executable = await ensureAliasmodeChromium(root, release.deps, "win32");
  const directory = dirname(executable);
  renameSync(directory, `${directory}-previous`);
  mkdirSync(directory);
  writeFileSync(executable, WINDOWS_155.executableSha256);

  expect(await ensureAliasmodeChromium(root, release.deps, "win32")).toBe(executable);
  expect(release.commands).toHaveLength(2);
  expect(release.downloads).toHaveLength(1);
});

test("a download in progress reports the bytes of its part against the pinned archive size", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const release = fakeRelease();
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const download = release.deps.download!;
  const installed = ensureAliasmodeChromium(root, {
    ...release.deps,
    download: async (url, output) => {
      writeFileSync(output, "12345");
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      await download(url, output);
    },
  }, "win32");
  await running;
  expect(runtimeDownloads()).toEqual([{ runtime: "aliasmode", receivedBytes: 5, totalBytes: 203519527 }]);
  finish();
  await installed;
  expect(runtimeDownloads()).toEqual([]);
});

test("Linux x64 installs AliasMode's own 155 build from its zstd tar archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const linux = aliasmodeChromiumArchive("linux");
  const downloads: string[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, linux.archiveSha256);
    },
    extract: async (_archive, directory) => {
      const runtime = join(directory, "aliasmode-chromium-155.0.8059.85-linux-x64");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "chrome"), linux.executableSha256);
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
    run: async () => { throw new Error("Linux must not run Windows permission commands"); },
  };
  expect(supportsChromium155Host("linux", "x64")).toBe(true);
  expect(supportsChromium155Host("linux", "arm64")).toBe(false);
  const executable = await ensureAliasmodeChromium(root, deps, "linux");
  expect(executable).toBe(join(root, "chromium-155.0.8059.85-aliasmode.4", "chrome"));
  expect(executable).toBe(aliasmodeChromiumExecutable(root, "linux"));
  expect(downloads).toEqual([
    "https://github.com/aliasmode/aliasmode-chromium/releases/download/v155.0.8059.85-aliasmode.4/aliasmode-chromium-155.0.8059.85-linux-x64.tar.zst",
  ]);
  expect([linux.archiveSha256, linux.executableSha256]).toEqual([
    "00981c9e79e80accabd5707b140cf710c68797b6f905e990393d2a1224121f98",
    "ee0bfec11c3da08f9ab8da0ef42f8b420cc13e80f389f09bcdc94fa582d3172a",
  ]);
  expect(readdirSync(root)).toEqual(["chromium-155.0.8059.85-aliasmode.4"]);
});

test("Windows and Linux pin AliasMode's own 155.0.8059.85 build while macOS keeps upstream's 155.0.8059.31", () => {
  expect(aliasmodeChromiumExecutable("/runtimes", "win32")).toBe(join("/runtimes", "chromium-155.0.8059.85-aliasmode.4", "chrome.exe"));
  expect(aliasmodeChromiumExecutable("/runtimes", "darwin"))
    .toBe(join("/runtimes", "chromium-155.0.8059.31", "Chromium.app/Contents/MacOS/Chromium"));
  expect(aliasmodeChromiumExecutable("/runtimes", "linux")).toBe(join("/runtimes", "chromium-155.0.8059.85-aliasmode.4", "chrome"));
  expect(aliasmodeChromiumArchive("darwin").url)
    .toBe("https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-macos-arm64.zip");
});

test("rejects an archive or executable that does not match its pin", async () => {
  for (const options of [{ archiveHash: "0".repeat(64) }, { executableHash: "1".repeat(64) }]) {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
    const release = fakeRelease(options);
    await expect(ensureAliasmodeChromium(root, release.deps, "win32")).rejects.toThrow("Chromium 155");
    expect(release.commands).toEqual([]);
    expect(existsSync(aliasmodeChromiumExecutable(root, "win32"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  }
});

test("new profiles keep their Chromium runtime fixed locally and in Cloud payloads", () => {
  const store = new ProfileStore(":memory:");
  const beta = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const standard = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  expect(standard.chromiumRuntime).toBeUndefined();
  expect(() => buildNewProfile({ engine: "firefox", chromiumRuntime: "aliasmode" }, () => false)).toThrow();
  expect(() => buildNewProfile({ chromiumRuntime: "chrome-200" }, () => false)).toThrow("unsupported Chromium runtime");

  store.upsertProfile(beta);
  store.upsertProfile(standard);
  const { chromiumRuntime: _runtime, ...edited } = store.getProfile(beta.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(beta.id)).toMatchObject({ name: "renamed", chromiumRuntime: "aliasmode" });
  const { hardware: _stored, ...standardEdit } = store.getProfile(standard.id)!;
  expect(() => store.upsertProfile({ ...standardEdit, chromiumRuntime: "aliasmode" }))
    .toThrow("Chromium runtime cannot change in place");
  expect(store.getProfile(standard.id)!.chromiumRuntime).toBeUndefined();

  // Cloud carries the runtime in schema V3, which older clients reject
  // instead of opening it on CloakBrowser. Default profiles stay V1.
  const payload = encodePortableProfile(beta);
  expect(payload.schemaVersion).toBe(3);
  expect(payload.profile).toMatchObject({ chromiumRuntime: "aliasmode" });
  expect(decodePortableProfile(payload).profile.chromiumRuntime).toBe("aliasmode");
  // A profile without stored hardware (made before it existed) stays V1.
  const { hardware: _hardware, ...legacy } = standard;
  const standardPayload = encodePortableProfile(legacy);
  expect(standardPayload.schemaVersion).toBe(1);
  expect("chromiumRuntime" in standardPayload.profile).toBe(false);
  expect(decodePortableProfile(standardPayload).profile.chromiumRuntime).toBeUndefined();
  expect(() => decodePortableProfile({ ...standardPayload, profile: { ...standardPayload.profile, chromiumRuntime: "aliasmode" } } as any))
    .toThrow("unsupported portable profile payload");
  expect(() => decodePortableProfile({ ...standardPayload, schemaVersion: 3 } as any)).toThrow("unsupported portable profile payload");
  store.close();
});

test("exports name the Chrome version of every Chromium profile so a re-import keeps it", () => {
  const beta = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const standard = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  const firefox = buildNewProfile({ engine: "firefox" }, () => false);
  const text = serializeAdsTxt([beta, standard, firefox]);
  expect(text.match(/^chromium_runtime=aliasmode$/gm)).toHaveLength(1);
  expect(text.match(/^chromium_runtime=cloakbrowser$/gm)).toHaveLength(1);
  expect(text.match(/^chromium_runtime=/gm)).toHaveLength(2);
  const imported = parseExport(text).profiles;
  expect(imported.find((profile) => profile.id === beta.id)?.chromiumRuntime).toBe("aliasmode");
  expect(imported.find((profile) => profile.id === standard.id)?.chromiumRuntime).toBeUndefined();
  expect(serializeXlsxRows([standard]).headers).toContain("chromium_runtime");
  expect(serializeXlsxRows([firefox]).headers).not.toContain("chromium_runtime");
});

test("Apple Silicon macOS uses the 155 runtime for Chromium profiles unless a CloakBrowser binary is configured", () => {
  expect(hostChromiumRuntime("darwin", {}, "arm64")).toBe("aliasmode");
  expect(hostChromiumRuntime("darwin", { CLOAKBROWSER_BINARY_PATH: "/opt/cloakbrowser" }, "arm64")).toBeUndefined();
  // Upstream has no Intel Mac build of Chromium 155.
  expect(hostChromiumRuntime("darwin", {}, "x64")).toBeUndefined();
  expect(hostChromiumRuntime("win32", {})).toBeUndefined();
  expect(hostChromiumRuntime("linux", {})).toBeUndefined();
});

test("new Chromium profiles use Chromium 155 wherever the computer can run it", () => {
  expect(defaultChromiumRuntime("win32", "x64", {})).toBe("aliasmode");
  expect(defaultChromiumRuntime("linux", "x64", {})).toBe("aliasmode");
  expect(defaultChromiumRuntime("darwin", "arm64", {})).toBe("aliasmode");
  expect(defaultChromiumRuntime("darwin", "arm64", { CLOAKBROWSER_BINARY_PATH: "/opt/cloakbrowser" })).toBeUndefined();
  expect(defaultChromiumRuntime("darwin", "x64", {})).toBeUndefined();
  expect(defaultChromiumRuntime("win32", "arm64", {})).toBeUndefined();
  expect(defaultChromiumRuntime("linux", "arm64", {})).toBeUndefined();
});

test("the host display scale comes from the desktop app, and 1 stands in for a missing or invalid value", () => {
  expect(hostDisplayScale({ ALIASMODE_HOST_SCALE: "1.25" })).toBe(1.25);
  expect(hostDisplayScale({ ALIASMODE_HOST_SCALE: "2" })).toBe(2);
  for (const value of [undefined, "", "abc", "0", "0.5", "-1.5", "Infinity"]) {
    expect(hostDisplayScale({ ALIASMODE_HOST_SCALE: value })).toBe(1);
  }
});

test("the host display's available area comes from the desktop app in the CSS pixels Firefox pages measure", () => {
  expect(hostDisplayAvail({ ALIASMODE_HOST_AVAIL: "1366x728", ALIASMODE_HOST_SCALE: "1" })).toEqual({ width: 1366, height: 728 });
  expect(hostDisplayAvail({ ALIASMODE_HOST_AVAIL: "1920x1020", ALIASMODE_HOST_SCALE: "1.25" })).toEqual({ width: 1536, height: 816 });
  expect(hostDisplayAvail({ ALIASMODE_HOST_AVAIL: "2880x1602", ALIASMODE_HOST_SCALE: "2" })).toEqual({ width: 1440, height: 801 });
  // A fraction rounds down, so a window of that size still fits.
  expect(hostDisplayAvail({ ALIASMODE_HOST_AVAIL: "1920x1032", ALIASMODE_HOST_SCALE: "1.25" })).toEqual({ width: 1536, height: 825 });
  for (const value of [undefined, "", "1920", "1920x", "big"]) expect(hostDisplayAvail({ ALIASMODE_HOST_AVAIL: value })).toBeNull();
});

test("installs the pinned CloakBrowser build for each Mac processor from its tar archive root", async () => {
  for (const [arch, archiveSha256, executableSha256] of [
    ["arm64", "505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c", CLOAKBROWSER_MACOS_EXECUTABLE_SHA256],
    ["x64", "a0a061b1945db55b3bbe95986a82b67803311c0fedabb3946e7ab0172273daac", CLOAKBROWSER_MACOS_X64_EXECUTABLE_SHA256],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
    const downloads: string[] = [];
    const deps: AliasmodeChromiumDeps = {
      download: async (url, output) => {
        downloads.push(url);
        writeFileSync(output, archiveSha256);
      },
      extract: async (_archive, directory) => {
        const bundle = join(directory, "Chromium.app", "Contents", "MacOS");
        mkdirSync(bundle, { recursive: true });
        writeFileSync(join(bundle, "Chromium"), executableSha256);
      },
      hashFile: async (path) => readFileSync(path, "utf8"),
      run: async () => { throw new Error("macOS must not run Windows permission commands"); },
    };
    const executable = await ensureCloakBrowser(root, "darwin", arch, deps);
    expect(executable).toBe(join(root, "cloakbrowser-145.0.7632.109.2", "Chromium.app", "Contents", "MacOS", "Chromium"));
    expect(downloads).toEqual([
      `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v145.0.7632.109.2/cloakbrowser-darwin-${arch}.tar.gz`,
    ]);
    expect(await ensureCloakBrowser(root, "darwin", arch, deps)).toBe(executable);
    expect(downloads).toHaveLength(1);
    expect(readdirSync(root)).toEqual(["cloakbrowser-145.0.7632.109.2"]);
  }
});

test("installs the pinned CloakBrowser build for Linux from its tar archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const downloads: string[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e");
    },
    extract: async (_archive, directory) => writeFileSync(join(directory, "chrome"), CLOAKBROWSER_LINUX_EXECUTABLE_SHA256),
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  const executable = await ensureCloakBrowser(root, "linux", "x64", deps);
  expect(executable).toBe(join(root, "cloakbrowser-146.0.7680.177.5", "chrome"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz",
  ]);
  expect(await ensureCloakBrowser(root, "linux", "x64", deps)).toBe(executable);
  expect(downloads).toHaveLength(1);
});

const WINDOWS_CLOAKBROWSER_ARCHIVE = "b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe";
const WINDOWS_CLOAKBROWSER_EXECUTABLE = "03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80";

test("installs the CloakBrowser build that the Windows app bundled before, from its zip archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const downloads: string[] = [];
  const commands: string[][] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, WINDOWS_CLOAKBROWSER_ARCHIVE);
    },
    extract: async (_archive, directory) => {
      writeFileSync(join(directory, "chrome.exe"), WINDOWS_CLOAKBROWSER_EXECUTABLE);
      writeFileSync(join(directory, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
    run: async (command) => { commands.push(command); },
  };
  // The same executable keeps the launch identity of every existing Windows profile.
  expect(cloakBrowserExecutableSha256("win32", "x64")).toBe(WINDOWS_CLOAKBROWSER_EXECUTABLE);
  expect(cloakBrowserExecutableSha256("win32", "arm64")).toBeUndefined();
  const executable = await ensureCloakBrowser(root, "win32", "x64", deps);
  expect(executable).toBe(join(root, "cloakbrowser-146.0.7680.177.5", "chrome.exe"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
  ]);
  expect(readdirSync(join(root, "cloakbrowser-146.0.7680.177.5")).sort()).toEqual(["chrome.dll", "chrome.exe"]);
  expect(readdirSync(root)).toEqual(["cloakbrowser-146.0.7680.177.5"]);
  expect(commands).toEqual([
    ["icacls.exe", realpathSync(dirname(executable)), "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "/T", "/Q"],
  ]);
  await ensureCloakBrowser(root, "win32", "x64", deps);
  expect(commands).toHaveLength(1);
  await expect(ensureCloakBrowser(root, "win32", "arm64", deps)).rejects.toThrow("CloakBrowser does not run");
});

/** A Windows CloakBrowser release whose download breaks `breaks` times, each after `step` bytes. */
function brokenDownload(breaks: number, step: number) {
  const outputs: string[] = [];
  const offsets: number[] = [];
  const sleeps: number[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (_url, output) => {
      outputs.push(output);
      const have = existsSync(output) ? statSync(output).size : 0;
      offsets.push(have);
      const rest = WINDOWS_CLOAKBROWSER_ARCHIVE.slice(have);
      if (offsets.length > breaks) {
        appendFileSync(output, rest);
        return;
      }
      appendFileSync(output, rest.slice(0, step));
      throw new Error("connection reset");
    },
    extract: async (_archive, directory) => writeFileSync(join(directory, "chrome.exe"), WINDOWS_CLOAKBROWSER_EXECUTABLE),
    hashFile: async (path) => readFileSync(path, "utf8"),
    sleep: async (ms) => { sleeps.push(ms); },
    run: async () => {},
  };
  return { deps, outputs, offsets, sleeps };
}

test("a broken download continues from the saved part, and attempts that add bytes do not use up the retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const release = brokenDownload(7, 4);
  await ensureCloakBrowser(root, "win32", "x64", release.deps);
  expect(release.offsets).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  // One partial file, outside the temporary install folders.
  expect(new Set(release.outputs)).toEqual(new Set([join(root, ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part")]));
  expect(release.sleeps).toHaveLength(7);
  expect(readdirSync(root)).toEqual(["cloakbrowser-146.0.7680.177.5"]);
});

test("a download that adds nothing stops after five attempts and keeps its part for the next try", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const failing = brokenDownload(Infinity, 0);
  await expect(ensureCloakBrowser(root, "win32", "x64", failing.deps)).rejects.toThrow("connection reset");
  expect(failing.offsets).toEqual([0, 0, 0, 0, 0]);
  expect(failing.sleeps).toEqual([2000, 4000, 8000, 16000]);
  expect(existsSync(join(root, "cloakbrowser-146.0.7680.177.5"))).toBe(false);

  // A part saved by an earlier app run survives the cleanup of temporary folders and continues.
  const partial = join(root, ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part");
  writeFileSync(partial, WINDOWS_CLOAKBROWSER_ARCHIVE.slice(0, 10));
  mkdirSync(join(root, ".cloakbrowser-146.0.7680.177.5-123-456"));
  const resumed = brokenDownload(0, 0);
  await ensureCloakBrowser(root, "win32", "x64", resumed.deps);
  expect(resumed.offsets).toEqual([10]);
  expect(readdirSync(root)).toEqual(["cloakbrowser-146.0.7680.177.5"]);
});

test("a completed download that does not match its pin is deleted, so the next try starts over", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const partial = join(root, ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part");
  writeFileSync(partial, "corrupted bytes from an earlier run");
  const release = brokenDownload(0, 0);
  await expect(ensureCloakBrowser(root, "win32", "x64", release.deps)).rejects.toThrow("CloakBrowser archive did not match its pinned SHA-256");
  expect(readdirSync(root)).toEqual([]);
  await ensureCloakBrowser(root, "win32", "x64", release.deps);
  expect(release.offsets).toEqual([35, 0]);
});

test("removes runtimes and parts that are no longer pinned, but not one a live browser runs from", () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-runtimes-"));
  const pinned155 = basename(dirname(aliasmodeChromiumExecutable(root, "win32")));
  const kept = [
    "cloakbrowser-146.0.7680.177.5",
    ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part",
    ".cloakbrowser-146.0.7680.177.5-99-1",
    pinned155,
    // A live browser still runs from this one.
    "chromium-155.0.8059.31",
    // Other runtimes under the same root are not this module's.
    "firefox-fonts",
    "python-3.13.7",
  ];
  const removed = [
    "cloakbrowser-145.0.7632.109.2",
    "chromium-155.0.8059.31-aliasmode.1",
    ".chromium-155.0.8059.31-aliasmode.1.7892833b6126b133.part",
    ".chromium-155.0.8059.31-aliasmode.1-12-34",
  ];
  for (const entry of [...kept, ...removed]) mkdirSync(join(root, entry));
  const live = join(root, "chromium-155.0.8059.31", "chrome.exe");
  pruneBrowserRuntimes(root, [live, "D:\\elsewhere\\chrome.exe"], "win32", "x64");
  expect(readdirSync(root).sort()).toEqual(kept.sort());
  pruneBrowserRuntimes(join(root, "missing"), [], "win32", "x64");
});

test("Linux blocks the Chrome sandbox only when AppArmor restricts user namespaces and our profile is missing", () => {
  const sysctl = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  const read = (value: string) => (path: string) => {
    if (path !== sysctl) throw new Error(`unexpected read ${path}`);
    return value;
  };
  const missing = () => { throw new Error("no such file"); };
  expect(linuxChromiumSandboxBlocked(read("1\n"), () => false)).toBe(true);
  expect(linuxChromiumSandboxBlocked(read("1\n"), (path) => path === LINUX_CHROMIUM_APPARMOR_PROFILE)).toBe(false);
  expect(linuxChromiumSandboxBlocked(read("0\n"), () => false)).toBe(false);
  expect(linuxChromiumSandboxBlocked(missing, () => false)).toBe(false);
});

test("Chromium 155 profiles share one copy of each downloaded component beside the browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-components-"));
  const runtime = dirname(aliasmodeChromiumExecutable(root));
  mkdirSync(join(runtime, "locales"), { recursive: true });
  writeFileSync(join(runtime, "locales", "en-US.pak"), "pak");
  const component = (profile: string, name: string, version: string) => {
    const dir = join(root, profile, name, version);
    mkdirSync(join(dir, "_platform_specific"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version }));
    writeFileSync(join(dir, "_platform_specific", "cdm.dll"), `cdm ${version}`);
  };
  component("a", "WidevineCdm", "4.10.3112.0");
  writeFileSync(join(root, "a", "WidevineCdm", "latest-component-updated-widevine-cdm"), "{}");
  component("a", "hyphen-data", "120.0.6050.0");
  mkdirSync(join(root, "a", "Default", "Network"), { recursive: true });
  writeFileSync(join(root, "a", "Default", "Network", "Cookies"), "login");
  mkdirSync(join(root, "a", "aliasmode-autofill"), { recursive: true });
  writeFileSync(join(root, "a", "aliasmode-autofill", "manifest.json"), JSON.stringify({ version: "1" }));

  await shareChromiumComponents(join(root, "a"), runtime);
  expect(JSON.parse(readFileSync(join(runtime, "WidevineCdm", "manifest.json"), "utf8")).version).toBe("4.10.3112.0");
  expect(readFileSync(join(runtime, "WidevineCdm", "_platform_specific", "cdm.dll"), "utf8")).toBe("cdm 4.10.3112.0");
  expect(existsSync(join(runtime, "hyphen-data", "manifest.json"))).toBe(true);
  expect(existsSync(join(root, "a", "WidevineCdm"))).toBe(false);
  expect(existsSync(join(root, "a", "hyphen-data"))).toBe(false);
  // Logins, extensions and the browser's own folders stay.
  expect(readFileSync(join(root, "a", "Default", "Network", "Cookies"), "utf8")).toBe("login");
  expect(existsSync(join(root, "a", "aliasmode-autofill", "manifest.json"))).toBe(true);
  expect(readdirSync(join(runtime, "locales"))).toEqual(["en-US.pak"]);
  expect(readdirSync(runtime).filter((name) => name.endsWith(".tmp"))).toEqual([]);

  // An older or equal copy goes; a newer one stays until a new browser version brings it.
  component("b", "WidevineCdm", "4.10.3000.0");
  component("c", "WidevineCdm", "4.10.3200.0");
  await shareChromiumComponents(join(root, "b"), runtime);
  await shareChromiumComponents(join(root, "c"), runtime);
  expect(existsSync(join(root, "b", "WidevineCdm"))).toBe(false);
  expect(existsSync(join(root, "c", "WidevineCdm", "4.10.3200.0", "manifest.json"))).toBe(true);
  expect(readFileSync(join(runtime, "WidevineCdm", "_platform_specific", "cdm.dll"), "utf8")).toBe("cdm 4.10.3112.0");
});

test("Chromium components are shared only beside the Windows and Linux 155 builds", () => {
  expect(chromiumComponentsDir(join("/data", "runtimes", "chromium-155.0.8059.85-aliasmode.4", "chrome.exe"), "win32"))
    .toBe(join("/data", "runtimes", "chromium-155.0.8059.85-aliasmode.4"));
  expect(chromiumComponentsDir(join("/data", "runtimes", "chromium-155.0.8059.85-aliasmode.4", "chrome"), "linux"))
    .toBe(join("/data", "runtimes", "chromium-155.0.8059.85-aliasmode.4"));
  expect(chromiumComponentsDir(join("/data", ".cloakbrowser", "chromium-146.0.7680.177.5", "chrome.exe"), "win32")).toBeNull();
  expect(chromiumComponentsDir(aliasmodeChromiumExecutable("/data/runtimes", "darwin"), "darwin")).toBeNull();
});

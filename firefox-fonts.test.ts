import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromiumFontconfigFile,
  ensureFirefoxFontPack,
  FIREFOX_FONT_PACKS,
  firefoxFontPackFontsDir,
  firefoxFontPackFor,
  firefoxFontPackInstalled,
  firefoxFontPackPrefs,
  firefoxFontPackUrl,
  pruneFirefoxFontPacks,
  type FirefoxFontPack,
  type FirefoxFontPackDeps,
} from "./firefox-fonts.ts";
import { runtimeDownloads } from "./runtime-download.ts";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-font-pack-"));
  cleanup.push(root);
  return root;
}

/** A synthetic pack: its "zip" is these bytes, and it unpacks to `files` font files. */
function syntheticPack(bytes: Uint8Array, files = 2, os: FirefoxFontPack["os"] = "macos"): FirefoxFontPack {
  return { os, asset: `test-fonts-${os}.zip`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), files };
}

const PACK_BYTES = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251));

function body(chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && sent === failAfter) {
        controller.error(new Error("connection reset"));
        return;
      }
      const chunk = chunks[sent++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

/** Server that honours Range requests; `breakFirst` cuts the first response after half the bytes. */
function server(bytes: Uint8Array, options: { breakFirst?: boolean; status?: number } = {}) {
  const requests: Array<{ url: string; range: string | null }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const range = new Headers(init.headers).get("range");
    requests.push({ url, range });
    if (options.status) return new Response("unavailable", { status: options.status });
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
    const rest = bytes.subarray(start);
    const half = Math.floor(rest.length / 2);
    const chunks = [rest.subarray(0, half), rest.subarray(half)];
    const failAfter = options.breakFirst && requests.length === 1 ? 1 : undefined;
    return new Response(body(chunks, failAfter), range
      ? { status: 206, headers: { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } }
      : { status: 200 });
  };
  return { fetch, requests };
}

function deps(fetch: FirefoxFontPackDeps["fetch"], extra: Partial<FirefoxFontPackDeps> = {}) {
  const extracted: string[] = [];
  const value: FirefoxFontPackDeps = {
    fetch,
    sleep: async () => {},
    extract: async (archive, directory) => {
      extracted.push(readFileSync(archive).toString("hex"));
      writeFileSync(join(directory, "A.ttf"), "a");
      writeFileSync(join(directory, "B.ttc"), "b");
    },
    ...extra,
  };
  return { deps: value, extracted };
}

test("a profile of the computer's own OS needs no pack; another OS needs that OS's pack", () => {
  expect(firefoxFontPackFor("windows", "win32")).toBeUndefined();
  expect(firefoxFontPackFor("macos", "darwin")).toBeUndefined();
  expect(firefoxFontPackFor("linux", "linux")).toBeUndefined();
  expect(firefoxFontPackFor("macos", "win32")).toBe(FIREFOX_FONT_PACKS.macos);
  expect(firefoxFontPackFor("linux", "win32")).toBe(FIREFOX_FONT_PACKS.linux);
  expect(firefoxFontPackFor("windows", "darwin")).toBe(FIREFOX_FONT_PACKS.windows);
  expect(firefoxFontPackUrl(FIREFOX_FONT_PACKS.macos)).toBe(
    "https://github.com/aliasmode/aliasmode-firefox/releases/download/aliasmode-runtime-156.0.1-beta.36-r4/aliasmode-fonts-macos-1.zip",
  );
  for (const pack of Object.values(FIREFOX_FONT_PACKS)) expect(pack.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("the sandboxed content processes may read the pack folder", () => {
  expect(firefoxFontPackPrefs("C:\\Data\\fonts", "win32")).toEqual({
    "security.sandbox.content.read_path_whitelist": "C:\\Data\\fonts,C:\\Data\\fonts\\",
  });
  expect(firefoxFontPackPrefs("/Users/a/fonts", "darwin")).toEqual({ "security.sandbox.content.mac.testing_read_path1": "/Users/a/fonts" });
  expect(firefoxFontPackPrefs("/home/a/fonts", "linux")).toEqual({ "security.sandbox.content.read_path_whitelist": "/home/a/fonts/" });
});

test("installs a verified pack atomically and reuses it without downloading again", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const remote = server(PACK_BYTES);
  const fake = deps(remote.fetch);

  const fonts = await ensureFirefoxFontPack(root, pack, fake.deps);
  expect(fonts).toBe(firefoxFontPackFontsDir(root, pack));
  expect(readdirSync(fonts).sort()).toEqual(["A.ttf", "B.ttc"]);
  expect(firefoxFontPackInstalled(root, pack)).toBe(true);
  expect(remote.requests).toEqual([{ url: firefoxFontPackUrl(pack), range: null }]);
  expect(fake.extracted).toEqual([Buffer.from(PACK_BYTES).toString("hex")]);
  // Nothing is left beside the installed pack: no download part, no temporary folder.
  expect(readdirSync(join(root, "firefox-fonts"))).toEqual([`macos-${pack.sha256.slice(0, 16)}`]);

  expect(await ensureFirefoxFontPack(root, pack, fake.deps)).toBe(fonts);
  expect(remote.requests).toHaveLength(1);
});

test("a download in progress reports the bytes saved so far against the pack size", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  let halfway!: () => void;
  let resume!: () => void;
  const saved = new Promise<void>((resolve) => { halfway = resolve; });
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 1) {
        // The first half is written before the stream is asked for more.
        halfway();
        await new Promise<void>((resolve) => { resume = resolve; });
      }
      if (sent < 2) controller.enqueue(PACK_BYTES.subarray(sent * 2048, ++sent * 2048));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const fake = deps(async () => new Response(stream, { status: 200 }));
  const installed = ensureFirefoxFontPack(root, pack, fake.deps);
  await saved;
  expect(runtimeDownloads()).toEqual([{ runtime: "firefox", receivedBytes: 2048, totalBytes: 4096 }]);
  resume();
  await installed;
  expect(runtimeDownloads()).toEqual([]);
});

test("concurrent opens share one download", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const remote = server(PACK_BYTES);
  const fake = deps(remote.fetch);
  const [first, second] = await Promise.all([ensureFirefoxFontPack(root, pack, fake.deps), ensureFirefoxFontPack(root, pack, fake.deps)]);
  expect(first).toBe(second);
  expect(remote.requests).toHaveLength(1);
});

test("a broken download resumes from the saved bytes with a Range request", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const remote = server(PACK_BYTES, { breakFirst: true });
  const fake = deps(remote.fetch);

  await ensureFirefoxFontPack(root, pack, fake.deps);
  expect(remote.requests.map((request) => request.range)).toEqual([null, `bytes=${PACK_BYTES.length / 2}-`]);
  expect(fake.extracted).toEqual([Buffer.from(PACK_BYTES).toString("hex")]);
  expect(firefoxFontPackInstalled(root, pack)).toBe(true);
});

test("a download that failed in an earlier app run resumes on the next one", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const broken = server(PACK_BYTES, { breakFirst: true });
  await expect(ensureFirefoxFontPack(root, pack, deps(broken.fetch, { attempts: 1 }).deps)).rejects.toThrow("connection reset");
  expect(firefoxFontPackInstalled(root, pack)).toBe(false);

  const remote = server(PACK_BYTES);
  await ensureFirefoxFontPack(root, pack, deps(remote.fetch).deps);
  expect(remote.requests.map((request) => request.range)).toEqual([`bytes=${PACK_BYTES.length / 2}-`]);
  expect(firefoxFontPackInstalled(root, pack)).toBe(true);
});

test("a server that ignores the Range request restarts the download from the first byte", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  mkdirSync(join(root, "firefox-fonts"), { recursive: true });
  writeFileSync(join(root, "firefox-fonts", `.macos-${pack.sha256.slice(0, 16)}.part`), PACK_BYTES.subarray(0, 100));
  const requests: Array<string | null> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    requests.push(new Headers(init.headers).get("range"));
    return new Response(PACK_BYTES, { status: 200 });
  };
  await ensureFirefoxFontPack(root, pack, deps(fetch).deps);
  expect(requests).toEqual(["bytes=100-"]);
  expect(firefoxFontPackInstalled(root, pack)).toBe(true);
});

test("a network failure fails the install after its retries and leaves no pack", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  let calls = 0;
  const delays: number[] = [];
  const fetch = async () => { calls++; throw new TypeError("network is unreachable"); };
  await expect(ensureFirefoxFontPack(root, pack, deps(fetch, { sleep: async (ms) => { delays.push(ms); } }).deps))
    .rejects.toThrow("network is unreachable");
  expect(calls).toBe(5);
  expect(delays).toEqual([1000, 2000, 4000, 8000]);
  expect(firefoxFontPackInstalled(root, pack)).toBe(false);
  expect(existsSync(firefoxFontPackFontsDir(root, pack))).toBe(false);

  const unavailable = server(PACK_BYTES, { status: 503 });
  await expect(ensureFirefoxFontPack(root, pack, deps(unavailable.fetch).deps)).rejects.toThrow("HTTP 503");
});

test("a download that stalls is retried", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  let calls = 0;
  const fetch = async (_url: string, init: RequestInit) => {
    calls++;
    if (calls === 1) {
      // Headers arrive, then no data until the stall timer aborts the request.
      return new Response(new ReadableStream({
        start(controller) { init.signal?.addEventListener("abort", () => controller.error(new Error("stalled"))); },
      }), { status: 200 });
    }
    return new Response(PACK_BYTES, { status: 200 });
  };
  await ensureFirefoxFontPack(root, pack, deps(fetch, { stallMs: 20 }).deps);
  expect(calls).toBe(2);
  expect(firefoxFontPackInstalled(root, pack)).toBe(true);
});

test("a pack that does not match its pinned SHA-256 is deleted and never unpacked", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const tampered = PACK_BYTES.slice();
  tampered[10] = tampered[10]! ^ 0xff;
  const fake = deps(server(tampered).fetch);
  await expect(ensureFirefoxFontPack(root, pack, fake.deps)).rejects.toThrow("did not match its pinned SHA-256");
  expect(fake.extracted).toEqual([]);
  expect(firefoxFontPackInstalled(root, pack)).toBe(false);
  expect(readdirSync(join(root, "firefox-fonts"))).toEqual([]);
});

test("a failed unpack leaves no pack folder and keeps the verified download for the next try", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES, 3);
  const remote = server(PACK_BYTES);
  // The fake unpacks two files, but the pin expects three.
  await expect(ensureFirefoxFontPack(root, pack, deps(remote.fetch).deps)).rejects.toThrow("unpacked 2 files instead of 3");
  expect(readdirSync(join(root, "firefox-fonts"))).toEqual([`.macos-${pack.sha256.slice(0, 16)}.part`]);

  const extractFails = deps(remote.fetch, { extract: async () => { throw new Error("tar.exe exited with code 1"); } });
  await expect(ensureFirefoxFontPack(root, pack, extractFails.deps)).rejects.toThrow("tar.exe exited");
  expect(remote.requests).toHaveLength(1);
  expect(firefoxFontPackInstalled(root, pack)).toBe(false);
  expect(readdirSync(join(root, "firefox-fonts"))).toEqual([`.macos-${pack.sha256.slice(0, 16)}.part`]);
});

test("a pack folder without a valid stamp is replaced", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const fonts = firefoxFontPackFontsDir(root, pack);
  mkdirSync(fonts, { recursive: true });
  writeFileSync(join(fonts, "half-written.ttf"), "x");
  await ensureFirefoxFontPack(root, pack, deps(server(PACK_BYTES).fetch).deps);
  expect(readdirSync(fonts).sort()).toEqual(["A.ttf", "B.ttc"]);
});

test("pruning removes packs that are no longer pinned and interrupted installs, and keeps pinned packs", async () => {
  const root = tempRoot();
  const pack = syntheticPack(PACK_BYTES);
  const other = syntheticPack(new Uint8Array([1, 2, 3]), 2, "windows");
  await ensureFirefoxFontPack(root, pack, deps(server(PACK_BYTES).fetch).deps);
  const packs = join(root, "firefox-fonts");
  mkdirSync(join(packs, "macos-0123456789abcdef", "fonts"), { recursive: true });
  mkdirSync(join(packs, `.tmp-macos-${pack.sha256.slice(0, 16)}-1-2`));
  writeFileSync(join(packs, ".macos-0123456789abcdef.part"), "old");
  writeFileSync(join(packs, `.windows-${other.sha256.slice(0, 16)}.part`), "resume me");

  pruneFirefoxFontPacks(root, [pack, other]);
  expect(readdirSync(packs).sort()).toEqual([`.windows-${other.sha256.slice(0, 16)}.part`, `macos-${pack.sha256.slice(0, 16)}`]);
  expect(statSync(firefoxFontPackFontsDir(root, pack)).isDirectory()).toBe(true);
  // No folder yet is not an error.
  pruneFirefoxFontPacks(tempRoot());
});

test("Chromium's fontconfig file adds the pack to the system fonts and is written once", () => {
  const root = mkdtempSync(join(tmpdir(), "chromium-fontconfig-"));
  cleanup.push(root);
  // Windows paths cannot hold < and >; fontconfig only runs on Linux, so there the name tests & alone.
  const name = process.platform === "win32" ? "a&b pack" : "a&b <pack>";
  const fontsDir = join(root, name, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  const file = chromiumFontconfigFile(fontsDir);
  expect(file).toBe(join(root, name, "chromium-fonts.conf"));
  const content = readFileSync(file, "utf8");
  expect(content).toContain('<include ignore_missing="yes">/etc/fonts/fonts.conf</include>');
  expect(content).toContain(`<dir>${join(root, name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), "fonts")}</dir>`);
  const written = statSync(file).mtimeMs;
  expect(chromiumFontconfigFile(fontsDir)).toBe(file);
  expect(statSync(file).mtimeMs).toBe(written);
  // Another system configuration replaces the file; no temporary file is left.
  expect(readFileSync(chromiumFontconfigFile(fontsDir, "/opt/fonts.conf"), "utf8")).toContain(">/opt/fonts.conf</include>");
  expect(readdirSync(join(root, name)).sort()).toEqual(["chromium-fonts.conf", "fonts"]);
});

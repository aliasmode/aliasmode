/**
 * Release gates for AliasMode's engines, run on a real computer of the OS under test against stock browsers.
 *   P  host check (also the first step of C): OS input reaches a stock Chrome window that is visible and focused.
 *   A  stock diff: the site's /check/ page and the detection lab (271 probes) in our engines vs stock Chrome and
 *      Firefox on this computer (scripts/engine-audit/audit.ts). Every lab difference beyond stock-vs-stock noise
 *      must be listed in expected.json with a reason.
 *   B  cross-profile linking: 3 profiles with different seeds, opened twice each the app's way; every signal in
 *      linking.json must differ between the profiles and stay the same across restarts. --buckets N instead opens N
 *      profiles once and reports how many distinct values each signal takes (real-variation measurement, info).
 *   C  logged-out anti-bot pages (sites.json): stock first, then ours, on the same proxy IP, a fresh profile per
 *      visit, at least 5 minutes between visits to one site from one IP, plain launch and OS-level input only.
 * Usage (from the app checkout, after `bun install --frozen-lockfile`; on Linux run scripts/gates/linux-setup.sh once):
 *   bun scripts/gates/gates.mjs <engine-build> <os> [--proxy bench:<k>|env:<VAR>|home] [--spare-proxy ...]
 *     [--only p,a,b,c] [--sites id,id] [--switch name=off ...] [--site <aliasmode-site checkout>] [--buckets N]
 *     [--sha256 <hex>] [--out <dir>] [--runtimes <dir>]
 *   <engine-build>: released (the app's pins) | stock (controls only) | chromium:<src> and/or firefox:<src>,
 *     comma separated; <src> = an unpacked build folder or executable, a .zip/.tar.zst archive, an https URL, or a
 *     release tag (v158.0.8127.90-aliasmode.1, aliasmode-runtime-159.0-beta.43-r1; checked against SHA256SUMS).
 *   <os>: linux | windows | macos | macos-intel, and it must be this computer's OS (personas follow the host OS).
 *   --switch name=off turns one internal switch off for bisecting (the app code reads ALIASMODE_SWITCHES_OFF=name,...).
 * Output: <out>/summary.json and summary.md (default $GATES_RESULTS or ~/gates-results, /gates-<date>-<engine>-<os>/;
 * never commit them: the repo is public). Proxy addresses never reach the output: an exit IP appears only as a short
 * hash. Every blocker names the switch to bisect with (switches.json). Exit code 0 only when every gate that ran passed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { defaultChromiumRuntime, ensureAliasmodeChromium, linuxChromiumSandboxBlocked } from "../../aliasmode-chromium.ts";
import { sha256File, windowsSystemTool } from "../../browser-install.ts";
import { firefoxBuildForHost } from "../../firefox-install.ts";
import { buildProfile, HOST_OS, installFirefoxRelease, PINNED_FIREFOX_RELEASE } from "../engine-audit/audit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const AUDIT = join(ROOT, "scripts", "engine-audit", "audit.ts");
const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const HOST = WIN ? "windows" : MAC ? (process.arch === "arm64" ? "macos" : "macos-intel") : "linux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
// The internal switch a blocker names for bisecting (switches.json).
const HINTS = readJson(join(HERE, "switches.json")).hints;
const switchHint = (id) => HINTS.find((h) => new RegExp(h.match).test(id))?.switch ?? "none";
const short = (v) => { const s = JSON.stringify(v) ?? "undefined"; return s.length > 160 ? `${s.slice(0, 157)}...` : s; };

// ---------- arguments ----------
const argv = process.argv.slice(2);
const positional = [], opts = { switch: [] };
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
  const name = argv[i].slice(2);
  if (name === "switch") opts.switch.push(argv[++i]); else opts[name] = argv[++i];
}
const [engineBuild, os] = positional;
if (!engineBuild || !os) { console.error("usage: gates.mjs <engine-build> <linux|windows|macos|macos-intel> [options] (see the header)"); process.exit(2); }
if (os !== HOST) { console.error(`<os> is ${os} but this computer is ${HOST}; the gates must run on the OS under test`); process.exit(2); }
const only = new Set((opts.only ?? "a,b,c").split(","));
const switchesOff = opts.switch.map((s) => s.replace(/=off$/, ""));
if (switchesOff.length) process.env.ALIASMODE_SWITCHES_OFF = [process.env.ALIASMODE_SWITCHES_OFF, ...switchesOff].filter(Boolean).join(",");
const date = new Date().toISOString().slice(0, 10);
const engineLabel = engineBuild.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
// Results stay outside git: the repo is public and they name our engines' exact tells.
const OUT = resolve(opts.out ?? join(process.env.GATES_RESULTS ?? join(homedir(), "gates-results"), `gates-${date}-${engineLabel}-${os}`));
const RUNTIMES = resolve(opts.runtimes ?? join(tmpdir(), "aliasmode-engine-audit"));
const WORK = join(OUT, "work");
mkdirSync(WORK, { recursive: true });
// At once, so a crashed run inside a checkout never leaves work files (proxy exit IP, page texts) unignored.
writeFileSync(join(OUT, ".gitignore"), "*\n");

// Linux: the rootless X server, libraries and stock browsers from linux-setup.sh.
if (!WIN && !MAC) {
  const envFile = join(process.env.GATES_TOOLS ?? join(process.env.HOME, "tools", "gates"), "env.sh");
  if (!existsSync(envFile)) { console.error(`${envFile} is missing: run bash scripts/gates/linux-setup.sh`); process.exit(2); }
  const dump = spawnSync("bash", ["-c", `. "${envFile}" && env -0`], { encoding: "utf8" }).stdout;
  for (const line of dump.split("\0")) { const i = line.indexOf("="); if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1); }
}

// ---------- OS-level input ----------
const DRIVER = WIN ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "input", "win-input.ps1")]
  : MAC ? ["osascript", "-l", "JavaScript", join(HERE, "input", "mac-input.js")] : ["bash", join(HERE, "input", "linux.sh")];
function input(...args) {
  const r = spawnSync(DRIVER[0], [...DRIVER.slice(1), ...args.map(String)], { encoding: "utf8", timeout: 120_000, env: process.env });
  if (r.status !== 0) log(`input ${args[0]} failed (${r.status ?? r.error?.message}): ${(r.stderr ?? "").trim().slice(-400)}`);
  return (r.stdout ?? "").trim();
}
let stopDisplay = () => {};
if (!WIN && !MAC) {
  // A display that is already in use belongs to another run: input there could reach its browser.
  const inUse = (n) => existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`);
  const display = [...Array(30).keys()].map((i) => 160 + ((process.pid + i) % 30)).find((n) => !inUse(n));
  if (display === undefined) { console.error("no free X display in :160-:189"); process.exit(2); }
  process.env.DISPLAY = `:${display}`;
  process.env.GATES_RUN = join(WORK, "x");
  if (!/up$/.test(input("display-start", display))) { console.error(`could not start X display :${display}`); process.exit(2); }
  process.on("exit", () => input("display-stop", display));
  stopDisplay = () => input("display-stop", display);
}

// ---------- engines ----------
const EXECUTABLE = {
  chromium: WIN ? "chrome.exe" : MAC ? "Chromium.app/Contents/MacOS/Chromium" : "chrome",
  firefox: firefoxBuildForHost().executablePath,
};
function findExecutable(dir, rel, depth = 3) {
  if (existsSync(join(dir, rel))) return join(dir, rel);
  if (depth === 0) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith(".app")) continue;
    const found = findExecutable(join(dir, entry.name), rel, depth - 1);
    if (found) return found;
  }
}
async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${url} (${response.status})`);
  await pipeline(response.body, createWriteStream(file));
}
function extract(file, dir) {
  mkdirSync(dir, { recursive: true });
  const command = file.endsWith(".tar.zst") ? ["tar", "--zstd", "-xf", file, "-C", dir]
    : /\.tar\.(xz|gz)$/.test(file) ? ["tar", "-xf", file, "-C", dir]
    : WIN ? [windowsSystemTool("tar.exe"), "-xf", file, "-C", dir] : MAC ? ["ditto", "-x", "-k", file, dir] : ["unzip", "-q", file, "-d", dir];
  if (spawnSync(command[0], command.slice(1), { stdio: "inherit" }).status !== 0) throw new Error(`could not unpack ${file}`);
}
/** A release tag's archive for this computer and its SHA-256 from the release's SHA256SUMS. */
async function releaseAsset(engine, tag) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  let repo, asset;
  if (engine === "chromium") {
    const version = tag.replace(/^v/, "").replace(/-aliasmode\.\d+$/, "");
    repo = "aliasmode-chromium";
    asset = `aliasmode-chromium-${version}-${WIN ? "windows" : MAC ? "macos" : "linux"}-${arch}.${!WIN && !MAC ? "tar.zst" : "zip"}`;
  } else {
    const version = tag.replace(/^aliasmode-runtime-/, "").replace(/-r\d+$/, "");
    repo = "aliasmode-firefox";
    asset = `aliasmode-${version}-${WIN ? "win.x86_64" : MAC ? `mac.${arch === "arm64" ? "arm64" : "x86_64"}` : "lin.x86_64"}.zip`;
  }
  const base = `https://github.com/aliasmode/${repo}/releases/download/${tag}`;
  // aliasmode-chromium publishes SHA256SUMS.txt, aliasmode-firefox SHA256SUMS.
  let sums = "";
  for (const name of ["SHA256SUMS.txt", "SHA256SUMS"]) { const r = await fetch(`${base}/${name}`); if (r.ok) { sums = await r.text(); break; } }
  const sha = sums.split("\n").find((l) => l.trim().endsWith(asset))?.split(/\s+/)[0];
  if (!sha) throw new Error(`${asset} is not in ${tag}'s SHA256SUMS`);
  return { url: `${base}/${asset}`, sha };
}
async function resolveBuild(engine, src) {
  let archive, sha = opts.sha256;
  if (/^(v\d+\.\d+\.\d+\.\d+-aliasmode\.\d+|aliasmode-runtime-.+-r\d+)$/.test(src)) ({ url: src, sha } = await releaseAsset(engine, src));
  if (/^https:\/\//.test(src)) {
    archive = join(RUNTIMES, "gates-builds", basename(new URL(src).pathname));
    mkdirSync(dirname(archive), { recursive: true });
    if (!existsSync(archive)) { log(`downloading ${src}`); await download(src, archive); }
  } else if (statSync(src).isDirectory()) {
    const exe = findExecutable(resolve(src), EXECUTABLE[engine]);
    if (!exe) throw new Error(`no ${EXECUTABLE[engine]} under ${src}`);
    return exe;
  } else if (!/\.(zip|tar\.zst|tar\.xz|tar\.gz)$/.test(src)) return resolve(src);
  else archive = resolve(src);
  const actual = await sha256File(archive);
  if (sha && actual !== sha) throw new Error(`${archive}: SHA-256 ${actual} is not ${sha}`);
  const dir = join(RUNTIMES, "gates-builds", `${engine}-${actual.slice(0, 16)}`);
  if (!existsSync(dir)) { extract(archive, `${dir}.tmp`); spawnSync(WIN ? "cmd" : "mv", WIN ? ["/c", "move", `${dir}.tmp`, dir] : [`${dir}.tmp`, dir]); }
  const exe = findExecutable(dir, EXECUTABLE[engine]);
  if (!exe) throw new Error(`no ${EXECUTABLE[engine]} in ${src}`);
  return exe;
}
async function engines() {
  const out = {};
  if (engineBuild === "released") {
    // Hosts without an AliasMode Chromium build (Intel Macs before 159) test Firefox only.
    out.chromium = defaultChromiumRuntime() === "aliasmode" ? await ensureAliasmodeChromium(RUNTIMES) : undefined;
    out.firefox = await installFirefoxRelease(RUNTIMES, PINNED_FIREFOX_RELEASE);
    // The runtime folder's name (chromium-<version>-<release>, firefox-<version>-<rN>), also inside a Mac .app.
    const folder = (exe, prefix) => exe.split(/[\\/]/).find((part) => part.startsWith(prefix)) ?? basename(dirname(exe));
    out.versions = { chromium: out.chromium ? folder(out.chromium, "chromium-") : "none for this host", firefox: folder(out.firefox.path, "firefox-") };
    return out;
  }
  out.versions = {};
  for (const item of engineBuild === "stock" ? [] : engineBuild.split(",")) {
    const [engine, ...rest] = item.split(":");
    const src = rest.join(":");
    if (!["chromium", "firefox"].includes(engine) || !src) throw new Error(`bad engine build "${item}"`);
    const exe = await resolveBuild(engine, src);
    if (engine === "chromium") out.chromium = exe; else out.firefox = { path: exe, sha256: await sha256File(exe) };
    out.versions[engine] = `${src} (${(await sha256File(exe)).slice(0, 12)})`;
  }
  return out;
}

// ---------- stock browsers ----------
const STOCK = {
  chrome: process.env.CHROME_BIN ?? (WIN ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : MAC ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome"),
  firefox: process.env.FIREFOX_BIN ?? (WIN ? "C:\\Program Files\\Mozilla Firefox\\firefox.exe" : MAC ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox"),
};
function stockVersion(name) {
  try {
    if (name === "firefox") {
      const ini = [join(dirname(STOCK.firefox), "application.ini"), join(dirname(STOCK.firefox), "..", "Resources", "application.ini")].find(existsSync);
      return readFileSync(ini, "utf8").match(/^Version=(.+)$/m)[1].trim();
    }
    if (WIN) return readdirSync(dirname(STOCK.chrome)).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    const out = spawnSync(STOCK.chrome, ["--version"], { encoding: "utf8", env: process.env }).stdout.trim();
    return `${out.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? "unknown"}${/beta/i.test(out) ? " beta" : ""}`;
  } catch { return "unknown"; }
}
const noSandbox = !WIN && !MAC && linuxChromiumSandboxBlocked();

// ---------- proxy: a loopback forwarder that adds the login, so no browser command line carries it ----------
function proxyUrl(spec) {
  if (!spec) return undefined;
  if (spec.startsWith("env:")) return process.env[spec.slice(4)] || undefined;
  if (spec === "home") {
    const file = join(process.env.HOME, ".config", "aliasmode-test", "home-proxy.env");
    return readFileSync(file, "utf8").match(/^ALIASMODE_TEST_PROXY=(.+)$/m)?.[1].trim();
  }
  if (spec.startsWith("bench:")) {
    const helper = process.env.GATES_BENCH_FIELD ?? join(process.env.HOME, "adbench", "scripts", "proxy-field.sh");
    return spawnSync(helper, [spec.slice(6), "url"], { encoding: "utf8" }).stdout || undefined;
  }
  throw new Error(`bad --proxy ${spec}`);
}
async function startForwarder(raw) {
  const up = new URL(raw);
  if (up.protocol !== "http:") throw new Error("only http:// proxies are supported");
  const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString("base64")}\r\n` : "";
  const server = createTcpServer((client) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 65536) client.destroy(); return; }
      client.off("data", onData);
      client.pause();
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const keep = lines.slice(1).filter((l) => l && !/^(proxy-authorization|proxy-connection|connection):/i.test(l));
      const plain = !/^CONNECT /i.test(lines[0]);
      const upstream = connect(Number(up.port || 80), up.hostname, () => {
        upstream.write(`${lines[0]}\r\n${keep.map((l) => `${l}\r\n`).join("")}${auth}${plain ? "Connection: close\r\n" : ""}\r\n`);
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const info = await (await fetch("https://ipinfo.io/json", { proxy: `http://127.0.0.1:${port}`, signal: AbortSignal.timeout(30_000) })).json();
  return {
    port, close: () => server.close(), ip: info.ip, timezone: info.timezone ?? "UTC",
    id: createHash("sha256").update(String(info.ip)).digest("hex").slice(0, 10),
  };
}

// ---------- launching ----------
function killTree(pid) {
  if (!pid) return;
  if (WIN) { spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }); return; }
  for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); } catch {}
}
/** Opens one profile the app's way (audit.ts open); returns a stop function that closes it the app's way. */
function openOurs(E, engine, mode, profile, dir, url, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const spec = {
    label: profile.id, mode, profile, runtimes: RUNTIMES, chromium: E.chromium ?? "", ...(engine === "firefox" ? { firefox: E.firefox } : {}),
    baseArgs: [`--aliasmode-launcher-pid=${process.pid}`, ...(noSandbox ? ["--no-sandbox"] : [])], pidFile: join(dir, "pids.json"), ...extra,
  };
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
  rmSync(`${spec.pidFile}.stop`, { force: true });
  const child = spawn(process.execPath, [AUDIT, "open", join(dir, "spec.json"), dir, url], { stdio: ["ignore", "ignore", "pipe"], detached: !WIN, env: process.env });
  let err = ""; child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  const exited = new Promise((r) => child.on("exit", r));
  return {
    exited,
    error: () => err,
    stop: async () => {
      writeFileSync(`${spec.pidFile}.stop`, "");
      await Promise.race([exited, sleep(20_000)]);
      killTree(child.pid);
      if (existsSync(spec.pidFile)) for (const pid of readJson(spec.pidFile)) { try { process.kill(pid, 0); killTree(pid); } catch {} }
    },
  };
}
function openStock(name, dir, url, proxy) {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ...(!WIN && proxy ? { TZ: proxy.timezone } : {}) };
  let args;
  if (name === "chrome") {
    args = [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--lang=en-US", "--window-position=0,0", "--window-size=1600,900",
      ...(proxy ? [`--proxy-server=http://127.0.0.1:${proxy.port}`] : []), ...(noSandbox ? ["--no-sandbox"] : []), url];
  } else {
    // Proxy and first-run prefs only; no policies.json (that switches on enterprise mode).
    const prefs = { "browser.shell.checkDefaultBrowser": false, "browser.aboutwelcome.enabled": false, "datareporting.policy.firstRunURL": "",
      "browser.startup.homepage_override.mstone": "ignore", "trailhead.firstrun.didSeeAboutWelcome": true, "app.update.auto": false,
      // The terms-of-use screen a new user accepts once; without this it replaces the first page.
      "termsofuse.acceptedVersion": 4, "termsofuse.acceptedDate": String(Date.now()), "termsofuse.bypassNotification": true,
      "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
      ...(proxy ? { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": proxy.port, "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": proxy.port, "network.proxy.share_proxy_settings": true } : {}) };
    writeFileSync(join(dir, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
    args = ["-profile", dir, "-no-remote", "-width", "1600", "-height", "900", url];
  }
  const child = spawn(STOCK[name], args, { stdio: "ignore", env, detached: !WIN });
  return {
    error: () => "",
    stop: async () => {
      killTree(child.pid);
      // Stock Firefox on Windows leaves processes that taskkill /T misses: kill everything that uses this profile.
      if (WIN) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${dir}*' } | % { Stop-Process -Id $_.ProcessId -Force }`], { stdio: "ignore" });
      await sleep(1500);
    },
  };
}

// ---------- Gate A: stock diff ----------
function differing(a, b) {
  const show = (r) => r === undefined ? "(missing)" : r.error ? `error: ${r.error}` : JSON.stringify(r.value);
  return [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])].filter((id) => show(a.results[id]) !== show(b.results[id]));
}
const at = (value, path) => path.split(".").reduce((v, k) => v?.[k], value);
async function gateA(E) {
  const site = opts.site && resolve(opts.site);
  if (!site || !existsSync(join(site, "tests", "detection-lab", "run.mjs"))) return { status: "skipped", reason: "--site must name an aliasmode-site checkout (tests/detection-lab)" };
  const persona = HOST_OS;
  const labels = [...(E.chromium ? [`aliasmode-chromium-${persona}`, `aliasmode-chromium-${persona}-plain`] : []), ...(E.firefox ? [`aliasmode-firefox-${persona}`] : [])];
  const dir = join(OUT, "A");
  const args = [AUDIT, "--site", site, "--out", dir, "--runtimes", RUNTIMES, "--only", labels.join(",") || "none",
    ...(E.chromium ? ["--chromium-build", E.chromium] : []), ...(E.firefox ? ["--firefox-build", E.firefox.path] : []),
    ...(existsSync(join(site, "dist", "check", "index.html")) ? [] : ["--skip-check"])];
  log(`A: ${labels.join(", ") || "stock only"}`);
  // ONLY would filter the lab's probe files (run.mjs ?only=).
  spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, ONLY: "", CHROME_BIN: STOCK.chrome, FIREFOX_BIN: STOCK.firefox } });
  const expected = readJson(join(HERE, "expected.json")).probes;
  const blockers = [], allowed = [], rows = [];
  for (const label of labels) {
    const engine = label.includes("firefox") ? "firefox" : "chromium";
    const stockLabel = engine === "firefox" ? "stock-firefox" : "stock-chrome";
    const check = (l) => existsSync(join(dir, "check", `fpcheck-${l}.json`)) ? readJson(join(dir, "check", `fpcheck-${l}.json`)) : undefined;
    const ours = check(label), stock = check(stockLabel);
    if (ours) {
      const stockIds = new Set((stock?.findings ?? []).filter((f) => f.status !== "pass" && f.status !== "info").map((f) => f.id));
      for (const f of ours.findings) {
        if (f.status === "fail" || (f.status === "warn" && !stockIds.has(f.id))) blockers.push({ run: label, kind: "check", id: f.id, detail: `${f.status}: ${f.detail ?? ""}`.slice(0, 200), switchHint: switchHint(f.id) });
      }
    }
    const lab = (l) => existsSync(join(dir, "lab", `${l}.json`)) ? readJson(join(dir, "lab", `${l}.json`)) : undefined;
    const o = lab(label), s = lab(stockLabel), s2 = lab(`${stockLabel}-2`);
    if (!o || !s || !Object.keys(o.results).length || !Object.keys(s.results).length) {
      blockers.push({ run: label, kind: "lab", id: "(no result)", detail: "the lab produced no result or ran no probes", switchHint: "none" }); continue;
    }
    const noise = new Set(s2 ? differing(s, s2) : []);
    let unexplained = 0;
    for (const id of differing(s, o).filter((id) => !noise.has(id))) {
      const e = expected[id], sv = s.results[id]?.value, ov = o.results[id]?.value;
      let why;
      if (!e || (e.engines && !e.engines.includes(engine))) why = "differs from stock";
      else if (e.compare) { const p = e.compare.find((path) => JSON.stringify(at(sv, path)) !== JSON.stringify(at(ov, path))); if (p) why = `robust signal ${p} differs from stock`; }
      else if (e.match && !new RegExp(e.match).test(JSON.stringify(ov))) why = `value does not match ${e.match}`;
      if (why) { unexplained++; blockers.push({ run: label, kind: "lab", id, detail: why, stock: short(s.results[id]?.error ?? sv), ours: short(o.results[id]?.error ?? ov), switchHint: switchHint(id) }); }
      else allowed.push({ run: label, id, reason: e.reason });
    }
    rows.push({ run: label, ua: o.ua, probes: Object.keys(o.results).length, noise: noise.size, unexplained, check: ours ? ours.identity ?? ours.summary : "skipped" });
  }
  return { status: labels.length ? (blockers.length ? "fail" : "pass") : "skipped", rows, blockers, allowed: allowed.length, stockUa: [readUa(dir, "stock-chrome"), readUa(dir, "stock-firefox")] };
}
function readUa(dir, label) { try { return readJson(join(dir, "lab", `${label}.json`)).ua; } catch { return undefined; } }

// ---------- probe server for Gates B and C ----------
async function probeServer() {
  const waiters = new Map(), headers = {};
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const run = url.searchParams.get("run") ?? "x";
    if (req.method === "POST" && url.pathname === "/result") {
      let body = ""; req.setEncoding("utf8");
      req.on("data", (c) => { body += c; });
      req.on("end", () => { res.end("ok"); waiters.get(run)?.(JSON.parse(body)); waiters.delete(run); });
      return;
    }
    if (url.pathname === "/blank") { res.setHeader("content-type", "text/html"); res.end("<title>New Tab</title>"); return; }
    if (url.pathname === "/hdr") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.rawHeaders.filter((_, i) => i % 2 === 0))); return; }
    if (url.pathname === "/focus") {
      res.setHeader("content-type", "text/html");
      res.end(`<title>gates focus</title><p>gates-focus-page</p><script>setTimeout(()=>fetch('/result?run=${run}',{method:'POST',body:JSON.stringify({visibility:document.visibilityState,focus:document.hasFocus()})}),2500)</script>`);
      return;
    }
    const file = join(HERE, "xprofile", basename(url.pathname));
    if (!/\.(html|js)$/.test(file) || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: (path, run) => `http://127.0.0.1:${server.address().port}/${path}?run=${run}`,
    wait: (run, ms) => Promise.race([new Promise((r) => waiters.set(run, r)), sleep(ms).then(() => undefined)]),
    close: () => server.close(),
  };
}

// ---------- Gate B: cross-profile linking ----------
async function gateB(E) {
  const linking = readJson(join(HERE, "linking.json"));
  const n = Number(opts.buckets ?? 3), passes = opts.buckets ? [1] : [1, 2];
  const server = await probeServer();
  const result = { status: "pass", engines: {}, blockers: [] };
  for (const engine of ["chromium", "firefox"].filter((e) => (e === "chromium" ? E.chromium : E.firefox))) {
    const runs = {};
    for (const pass of passes) {
      for (let i = 0; i < n; i++) {
        const id = `gates-${engine}-${i}`, run = `${engine}-${i}-${pass}`;
        const profile = buildProfile(engine, HOST_OS, id, 7919 * (i + 1), "America/Chicago");
        const dir = join(WORK, "B", id);
        if (pass === 1) rmSync(dir, { recursive: true, force: true });
        const pending = server.wait(run, 180_000);
        const browser = openOurs(E, engine, "app", profile, dir, server.url("probe.html", run));
        // A launch that fails ends the open command; stop waiting for the page then.
        runs[run] = await Promise.race([pending, browser.exited.then(() => sleep(3000)).then(() => undefined)]);
        await browser.stop();
        log(`B: ${run} ${runs[run] ? "ok" : `no result ${browser.error().slice(-300)}`}`);
      }
    }
    // One stock run: a signal stock reads but ours never does is an API we broke, not a host without it.
    const stockName = engine === "chromium" ? "chrome" : "firefox", stockRun = `stock-${engine}`;
    if (!opts.buckets) {
      const pending = server.wait(stockRun, 180_000);
      const browser = openStock(stockName, join(WORK, "B", stockRun), server.url("probe.html", stockRun));
      runs[stockRun] = await pending;
      await browser.stop();
      log(`B: ${stockRun} ${runs[stockRun] ? "ok" : "no result"}`);
    }
    mkdirSync(join(OUT, "B"), { recursive: true });
    writeFileSync(join(OUT, "B", `${engine}-runs.json`), JSON.stringify(runs));
    const value = (run, key) => runs[run] ? JSON.stringify(at(runs[run], key) ?? runs[run][key] ?? null) : "<no run>";
    const keys = [...new Set(Object.values(runs).filter(Boolean).flatMap((r) => Object.keys(r)))].filter((k) => k !== "run").sort();
    const table = {};
    for (const key of keys) {
      const first = [...Array(n).keys()].map((i) => value(`${engine}-${i}-1`, key));
      const distinct = new Set(first).size;
      const stable = passes.length < 2 ? null : [...Array(n).keys()].every((i) => value(`${engine}-${i}-1`, key) === value(`${engine}-${i}-2`, key));
      table[key] = { distinct, stable };
    }
    for (const key of linking.mustDiffer) {
      const first = [...Array(n).keys()].map((i) => value(`${engine}-${i}-1`, key));
      const distinct = new Set(first).size;
      const stable = passes.length < 2 ? null : [...Array(n).keys()].every((i) => value(`${engine}-${i}-1`, key) === value(`${engine}-${i}-2`, key));
      table[key] = { distinct, stable };
      if (opts.buckets) continue;
      const hint = switchHint(key);
      if (first.every((v) => v === "null")) {
        // Null everywhere passes only when this host cannot read it (stock reads null too) and no probe step failed.
        const errors = [...new Set(Object.values(runs).filter(Boolean).flatMap((r) => Object.keys(r).filter((k) => k.endsWith(".error") && key.startsWith(k.slice(0, -5) + ".")).map((k) => `${k}: ${r[k]}`)))];
        const stockValue = value(stockRun, key);
        if (errors.length) result.blockers.push({ engine, key, detail: `not measured: ${errors.join("; ").slice(0, 200)}`, switchHint: hint });
        else if (stockValue !== "null" && stockValue !== "<no run>") result.blockers.push({ engine, key, detail: `stock reads a value, ours reads null`, stock: stockValue.slice(0, 60), switchHint: hint });
        else table[key].na = true; // not readable on this host (e.g. no WebGL): cannot link
      } else if (first.includes("<no run>")) result.blockers.push({ engine, key, detail: "a profile produced no result", switchHint: "none" });
      else if (distinct < n) result.blockers.push({ engine, key, detail: `${distinct} distinct values across ${n} profiles (linkable)`, values: first.map((v) => v.slice(0, 60)), switchHint: hint });
      if (stable === false) result.blockers.push({ engine, key, detail: "changes across restarts", values: [...Array(n).keys()].flatMap((i) => [1, 2].map((p) => value(`${engine}-${i}-${p}`, key).slice(0, 60))), switchHint: hint });
    }
    result.engines[engine] = table;
  }
  server.close();
  if (opts.buckets) result.status = "info";
  else if (result.blockers.length) result.status = "fail";
  if (!E.chromium && !E.firefox) result.status = "skipped";
  return result;
}

// ---------- Gate C: anti-bot pages ----------
const pacingFile = join(RUNTIMES, "gates-pacing.json");
async function pace(site, proxy) {
  const state = existsSync(pacingFile) ? readJson(pacingFile) : {};
  const key = `${site.id}@${proxy.id}`, gap = (site.pace_s ?? 300) * 1000;
  const wait = (state[key] ?? 0) + gap - Date.now();
  if (wait > 0) { log(`C: ${site.id}: waiting ${Math.ceil(wait / 1000)} s (pacing per site per IP)`); await sleep(wait); }
  state[key] = Date.now();
  writeFileSync(pacingFile, JSON.stringify(state));
}
function fill(text, vars) { return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""); }
async function readPage(site, file, ready, maxWait, started) {
  let text = "";
  for (;;) {
    input("copytext", file, ...(site.copy_at ?? []));
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (new RegExp(ready, "ms").test(text)) return { text, ready: true };
    if (Date.now() - started > maxWait * 1000) return { text, ready: false };
    await sleep(5000);
  }
}
function judge(site, text, ready) {
  const metrics = {};
  for (const [name, re] of Object.entries(site.metrics ?? {})) { const m = text.match(new RegExp(re, "m")); metrics[name] = m ? (m[1] ?? m[0]).trim() : null; }
  let status;
  if (site.block && new RegExp(site.block, "ms").test(text)) status = "block";
  else if (site.pass) status = new RegExp(site.pass, "ms").test(text) ? "pass" : "fail";
  else status = ready ? "pass" : "fail";
  return { status, metrics };
}
/** Ours against stock for one site, by the site's rule. */
function compare(site, stock, ours) {
  if (ours.status !== "pass") return `ours: ${ours.status}`;
  const rule = site.rule ?? {};
  for (const [name, r] of Object.entries(rule)) {
    const s = stock.metrics[name], o = ours.metrics[name];
    if (r.min !== undefined && !(Number(o) >= Number(s) - r.min)) return `${name} ${o} < stock ${s} - ${r.min}`;
    if (r.max !== undefined && !(Number(o ?? 0) <= Number(s ?? 0) + r.max)) return `${name} ${o} > stock ${s} + ${r.max}`;
    if (r.same && o !== s && !(r.good && o === r.good)) return `${name} "${o}" vs stock "${s}"`;
  }
}
async function visit(E, target, site, proxy, server) {
  // Fresh unregistered identifiers for every visit, so no two browsers type the same one.
  const vars = { email: `gates.${randomBytes(4).toString("hex")}@example.com`, email_gmail: `gates.${randomBytes(6).toString("hex")}@gmail.com`, username: `gates${randomBytes(5).toString("hex")}` };
  await pace(site, proxy);
  const name = `${target}-${site.id}`, dir = join(WORK, "C", `${name}-${Date.now()}`);
  const shots = join(OUT, "C", target);
  mkdirSync(shots, { recursive: true });
  let browser;
  // The app opens only http(s) start pages, so every browser starts on the same empty local page.
  const start = server.url("blank", "c");
  if (target.startsWith("stock-")) browser = openStock(target.slice(6), dir, start, proxy);
  else {
    const engine = target.slice(5);
    const profile = buildProfile(engine, HOST_OS, `gates-c-${engine}`, 104729, proxy.timezone);
    profile.proxy = { type: "http", host: "127.0.0.1", port: String(proxy.port), user: "", pass: "" };
    browser = openOurs(E, engine, engine === "chromium" ? "plain" : "app", profile, dir, start, engine === "chromium" ? { webRtcIp: proxy.ip } : {});
  }
  const t0 = Date.now();
  let win = "none", gone = false;
  browser.exited?.then(() => { gone = true; });
  while (!gone && Date.now() - t0 < 90_000 && (win = input("activate")) === "none") await sleep(2000);
  if (win === "none") {
    log(`C: ${target}-${site.id}: no browser window ${browser.error().slice(-300)}`);
    await browser.stop();
    return { status: "no window", metrics: {}, ready: false, seconds: Math.round((Date.now() - t0) / 1000), window: false };
  }
  await sleep(3000);
  input("activate");
  input("open", site.url);
  const file = join(shots, `${site.id}.txt`);
  let page;
  if (site.steps) {
    // Form sites: the steps start from the page's own focus (no click first), then the result is read.
    for (const step of site.steps) {
      if (step.wait) await sleep(step.wait * 1000);
      for (let i = 0; i < (step.repeat ?? 1); i++) {
        if (step.type) input("type", fill(step.type, vars));
        if (step.key) { input("key", step.key); await sleep(300); }
      }
    }
    page = await readPage(site, file, site.after, site.after_wait ?? 30, Date.now());
  } else {
    await sleep((site.wait ?? 8) * 1000);
    page = await readPage(site, file, site.ready ?? ".", site.max_wait ?? 45, Date.now());
  }
  input("shot", join(shots, `${site.id}.png`));
  await browser.stop();
  rmSync(dir, { recursive: true, force: true });
  const verdict = { ...judge(site, page.text, page.ready), ready: page.ready, seconds: Math.round((Date.now() - t0) / 1000), window: win !== "none" };
  log(`C: ${name}: ${verdict.status} ${JSON.stringify(verdict.metrics)}`);
  return verdict;
}
/** Host check: OS input reaches a stock Chrome window, the page sees itself visible and focused, and copying works. */
async function preflight(server, proxy) {
  const pending = server.wait("focus", 90_000);
  const b = openStock("chrome", join(WORK, "focus"), "about:blank", proxy);
  for (let i = 0; i < 30 && input("activate") === "none"; i++) await sleep(1500);
  await sleep(2000); input("activate"); input("open", server.url("focus", "focus"));
  const seen = (await pending) ?? { visibility: "no result" };
  const file = join(WORK, "focus.txt");
  input("copytext", file);
  const copied = existsSync(file) && readFileSync(file, "utf8").includes("gates-focus-page");
  mkdirSync(join(OUT, "P"), { recursive: true });
  input("shot", join(OUT, "P", "focus.png"));
  await b.stop();
  const ok = seen.visibility === "visible" && seen.focus === true && copied;
  return { status: ok ? "pass" : "fail", ...seen, copied, ...(ok ? {} : { reason: `host invalid: page saw visibility ${seen.visibility}, focus ${seen.focus}; copy ${copied ? "worked" : "failed"}` }) };
}
async function gateC(E) {
  const raw = proxyUrl(opts.proxy);
  if (!raw) return { status: "skipped", reason: "no proxy (--proxy)" };
  const proxy = await startForwarder(raw);
  const spareRaw = proxyUrl(opts["spare-proxy"]);
  const sites = readJson(join(HERE, "sites.json")).sites.filter((s) => !opts.sites || opts.sites.split(",").includes(s.id));
  const server = await probeServer();
  const host = await preflight(server, proxy);
  if (host.status !== "pass") { proxy.close(); server.close(); return { status: "fail", reason: host.reason, ip: proxy.id }; }
  const targets = [...(E.chromium ? ["stock-chrome", "ours-chromium"] : []), ...(E.firefox ? ["stock-firefox", "ours-firefox"] : [])];
  if (!targets.length) targets.push("stock-chrome", "stock-firefox");
  const results = {}, blockers = [];
  // Stock and ours alternate per engine pass, so each site sees stock first and ours within the hour on the same IP.
  for (const target of targets) for (const site of sites) (results[site.id] ??= {})[target] = await visit(E, target, site, proxy, server);
  const rows = [];
  for (const site of sites) {
    for (const [stockT, oursT] of [["stock-chrome", "ours-chromium"], ["stock-firefox", "ours-firefox"]]) {
      const r = results[site.id], stock = r[stockT], ours = r[oursT];
      if (!stock) continue;
      let verdict, retry, spareStock;
      if (stock.status !== "pass") {
        if (spareRaw && ours) {
          const spare = await startForwarder(spareRaw);
          const s2 = await visit(E, stockT, site, spare, server);
          spareStock = s2.status;
          if (s2.status === "pass") { retry = await visit(E, oursT, site, spare, server); verdict = compare(site, s2, retry) ? `BLOCKER (spare IP): ${compare(site, s2, retry)}` : "pass (spare IP)"; }
          spare.close();
        }
        verdict ??= "dropped (host/IP)";
      } else if (!ours) verdict = "stock pass";
      else {
        let why = compare(site, stock, ours);
        if (why) { retry = await visit(E, oursT, site, proxy, server); why = compare(site, stock, retry); }
        verdict = why ? `BLOCKER: ${why}` : "pass";
      }
      if (verdict.startsWith("BLOCKER")) blockers.push({ site: site.id, engine: oursT.slice(5), detail: verdict, switchHint: site.switch_hint ?? "none" });
      // A retry decides the verdict, so the row shows both visits.
      rows.push({ site: site.id, vendor: site.vendor, pair: oursT.slice(5), stock: stock.status, stockMetrics: stock.metrics, ours: ours?.status, oursMetrics: ours?.metrics,
        ...(spareStock ? { spareStock } : {}), ...(retry ? { retry: retry.status, retryMetrics: retry.metrics } : {}), verdict });
    }
  }
  proxy.close(); server.close();
  return { status: blockers.length ? "fail" : "pass", ip: proxy.id, timezone: proxy.timezone, rows, blockers };
}

// ---------- main ----------
const E = await engines();
const summary = {
  date: new Date().toISOString(), engineBuild, os, host: `${process.platform} ${process.arch}`, switches: opts.switch,
  engines: E.versions, stock: { chrome: stockVersion("chrome"), firefox: stockVersion("firefox") }, gates: {},
};
// The stock control should be the engine's major; a different one shows as version differences in Gate A.
const major = (v) => String(v ?? "").match(/\b(\d{2,3})\.\d+\.\d+/)?.[1];
summary.majors = { chromium: { engine: major(E.versions.chromium), control: major(summary.stock.chrome) }, firefox: { engine: major(E.versions.firefox), control: major(summary.stock.firefox) } };
const mismatch = Object.entries(summary.majors).filter(([, m]) => m.engine && m.control && m.engine !== m.control).map(([e, m]) => `${e} ${m.engine} vs control ${m.control}`);
log(`engines ${JSON.stringify(E.versions)}, stock ${JSON.stringify(summary.stock)}${mismatch.length ? `; major differs: ${mismatch.join(", ")}` : ""}`);
if (only.has("p")) { const server = await probeServer(); summary.gates.P = await preflight(server); server.close(); }
if (only.has("a")) summary.gates.A = await gateA(E);
if (only.has("b")) summary.gates.B = await gateB(E);
if (only.has("c")) summary.gates.C = await gateC(E);
const ran = Object.values(summary.gates).filter((g) => g.status !== "skipped" && g.status !== "info");
// An info-only run (--buckets) passes when it ran.
summary.pass = ran.every((g) => g.status === "pass") && Object.values(summary.gates).some((g) => g.status !== "skipped");
// Page texts can echo addresses (block pages, checkers): the summaries keep none.
// (Version numbers stay: they have an octet over 255, end in .0.0.0, or follow a "/".)
const redact = (text) => text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip, at, all) =>
  ip.split(".").some((o) => Number(o) > 255) || ip.endsWith(".0.0.0") || all[at - 1] === "/" || /^(127|10|0)\.|^192\.168\./.test(ip) ? ip : "[ip]");
writeFileSync(join(OUT, "summary.json"), redact(JSON.stringify(summary, null, 1)));
const md = [`# Gates ${summary.date}`, "", `Engine build: ${engineBuild} on ${os} (${summary.host}). Engines: ${JSON.stringify(E.versions)}. Stock: Chrome ${summary.stock.chrome}, Firefox ${summary.stock.firefox}.${mismatch.length ? ` Major differs from the control: ${mismatch.join(", ")}.` : ""}${opts.switch.length ? ` Switches: ${opts.switch.join(", ")}.` : ""}`, ""];
for (const [name, g] of Object.entries(summary.gates)) {
  md.push(`## Gate ${name}: ${g.status}${g.reason ? ` (${g.reason})` : ""}`, "");
  if (name === "A" && g.rows) { md.push("| Run | Probes | Stock noise | Unexplained diffs | Checker | UA |", "|---|---|---|---|---|---|", ...g.rows.map((r) => `| ${r.run} | ${r.probes} | ${r.noise} | ${r.unexplained} | ${r.check} | ${r.ua} |`), "", `Allowed by expected.json: ${g.allowed}.`, ""); }
  if (name === "B" && g.engines) for (const [engine, table] of Object.entries(g.engines)) {
    md.push(`${engine}:`, "", "| Signal | Distinct | Stable |", "|---|---|---|", ...Object.entries(table).map(([k, v]) => `| ${k} | ${v.distinct} | ${v.na ? "n/a" : v.stable ?? "-"} |`), "");
  }
  if (name === "C" && g.rows) { md.push(`Proxy IP id ${g.ip} (${g.timezone}).`, "", "| Site | Vendor | Engine | Stock | Ours (retry) | Verdict | Stock metrics | Our metrics (retry) |", "|---|---|---|---|---|---|---|---|",
    ...g.rows.map((r) => `| ${r.site} | ${r.vendor ?? ""} | ${r.pair} | ${r.stock}${r.spareStock ? ` (spare IP: ${r.spareStock})` : ""} | ${r.ours ?? "-"}${r.retry ? ` (${r.spareStock ? "spare IP" : "retry"}: ${r.retry})` : ""} | ${r.verdict} | ${short(r.stockMetrics)} | ${short(r.oursMetrics ?? {})}${r.retry ? ` (retry: ${short(r.retryMetrics)})` : ""} |`), ""); }
  for (const b of g.blockers ?? []) md.push(`- BLOCKER ${Object.entries(b).filter(([k, v]) => k !== "switchHint" && typeof v === "string").map(([, v]) => v).join(" | ")}${b.switchHint && b.switchHint !== "none" ? ` (bisect: --switch ${b.switchHint}=off)` : " (bisect: no switch covers this; compare engine builds)"}`);
  md.push("");
}
writeFileSync(join(OUT, "summary.md"), redact(md.join("\n")));
stopDisplay(); // before WORK (it holds the X server's pid files) is removed
rmSync(WORK, { recursive: true, force: true });
log(`${summary.pass ? "PASS" : "FAIL"}: ${OUT}/summary.md`);
process.exit(summary.pass ? 0 : 1);

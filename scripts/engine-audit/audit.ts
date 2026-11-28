/**
 * Engine audit: opens the site's fingerprint checker (/check/) and detection lab in AliasMode's
 * own engines exactly as the app opens them, plus stock Chrome and stock Firefox as controls.
 *
 * Profiles come from the app's own code (buildNewProfile, withDefaultBrowser), with a fixed seed,
 * screen 1920x1080, time zone America/Chicago, locale en-US and no proxy: one Windows persona and one
 * persona of this computer's OS (the same one on Windows). Each engine run goes through the app's
 * Launcher.start(), so it gets the app's launch args, Firefox config and prefs, font pack, autofill
 * helper, start-up fingerprint capture and CDP/Juggler attach. "-plain" runs spawn the same Chromium
 * argv with nothing attached, to separate engine findings from attach findings. "-attached" runs keep
 * a Playwright connectOverCDP client attached while the page runs, as an app script or MCP client does.
 *
 * Usage (from the app checkout, after `bun install --frozen-lockfile`):
 *   bun scripts/engine-audit/audit.ts --site <aliasmode-site checkout with a built dist/> [--out <dir>]
 *     [--firefox-release <rN>] [--runtimes <cache dir>] [--only <label,label>] [--skip-check] [--skip-lab]
 *     [--chromium-build <executable>] [--firefox-build <executable>]
 * Engines: the app's pinned builds unless --chromium-build/--firefox-build name an unpacked build's executable
 * (scripts/gates/gates.mjs unpacks release tags, archives and URLs). --firefox-release defaults to the app's pin.
 * Stock browsers: $CHROME_BIN and $FIREFOX_BIN (Windows defaults: the Program Files installs).
 * Output: <out>/summary.md, check/fpcheck-<label>.json, lab/<label>.json and lab/<label>.diff.txt
 * (diff vs the stock browser of the same engine), targets/<label>/ (profile, argv or Firefox config).
 * Engines download to --runtimes (default <tmp>/aliasmode-engine-audit) the way the app installs them.
 * Internal: `audit.ts open <spec.json> <profile dir> <url>` is the browser command the site runners start.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { defaultChromiumRuntime, ensureAliasmodeChromium, linuxChromiumSandboxBlocked } from "../../aliasmode-chromium.ts";
import { AutofillBridge } from "../../autofill-bridge.ts";
import { sha256File, windowsSystemTool } from "../../browser-install.ts";
import { buildNewProfile, withDefaultBrowser } from "../../create.ts";
import { completeProfileFingerprint, firefoxLaunchConfig, firefoxStartupPrefs, FIREFOX_RUNTIME_VERSION } from "../../firefox-config.ts";
import { firefoxFontPackFontsDir, firefoxFontPackFor, firefoxFontPackPrefs } from "../../firefox-fonts.ts";
import { firefoxBuildForHost, firefoxReleaseArchiveUrl } from "../../firefox-install.ts";
import { firefoxLaunchOptions } from "../../firefox-worker.mjs";
import { Launcher } from "../../launcher.ts";
import { ensureDuckDuckGoDefault } from "../../search-provider.ts";
import { ProfileStore } from "../../store.ts";
import type { Profile } from "../../types.ts";

const SEED = 123456789;
const TIMEZONE = "America/Chicago";
const LOCALE = "en-US";
// Outside the app's own range (9333-9999), so a real AliasMode on the same computer keeps its ports.
const PORTS = { start: 19400, end: 19499 };
const WIN = process.platform === "win32";
export const HOST_OS = WIN ? "windows" : process.platform === "darwin" ? "macos" : "linux";

export interface Spec {
  label: string; mode: "app" | "plain" | "attached"; profile: Profile; runtimes: string; chromium: string;
  firefox?: { path: string; sha256: string }; baseArgs: string[]; pidFile: string;
  /** The proxy's exit address for a plain launch, as the app passes it to --fingerprint-webrtc-ip. */
  webRtcIp?: string;
}

function launcher(store: ProfileStore, spec: Spec, dataRoot: string, autofill?: AutofillBridge): Launcher {
  return new Launcher({
    store, ...(autofill ? { autofill } : {}), dataRoot, chromiumRuntimeRoot: spec.runtimes, portRange: PORTS,
    ensureAliasmodeChromium: async () => spec.chromium,
    ...(spec.firefox ? { firefoxBinaryPath: spec.firefox.path, expectedFirefoxBinarySha256: spec.firefox.sha256 } : {}),
    baseArgs: spec.baseArgs, chromiumSandboxBlocked: () => false, ensureSearchProvider: ensureDuckDuckGoDefault,
    gracefulStopMs: 1000, teardownTimeoutMs: 1500, log: (line: string) => { if (/rejected|fail/i.test(line)) process.stderr.write(`launcher: ${line}\n`); },
  });
}

/** The browser command the site runners start: opens the profile as the app does and stays until SIGTERM. */
export async function open(specFile: string, dir: string, url: string): Promise<void> {
  const spec: Spec = JSON.parse(readFileSync(specFile, "utf8"));
  const store = new ProfileStore(join(dir, "profiles.sqlite"));
  store.upsertProfile(spec.profile);
  const id = spec.profile.id;
  let stop: () => Promise<void>;
  if (spec.mode === "plain") {
    const l = launcher(store, spec, join(dir, "profiles"));
    const args = l.buildArgs(spec.profile, PORTS.end, l.userDataDir(id), [], undefined, false, false, spec.webRtcIp);
    const child = spawn(spec.chromium, [...args, url], { stdio: "ignore", detached: !WIN });
    writeFileSync(spec.pidFile, JSON.stringify([child.pid]));
    stop = async () => { killTree(child.pid!); };
  } else {
    const autofill = new AutofillBridge(store);
    autofill.listen();
    const l = launcher(store, spec, join(dir, "profiles"), autofill);
    let attached: { close(): Promise<void> } | undefined;
    if (spec.mode === "attached") {
      const { ws } = await l.start(id, []);
      const { chromium } = await import("playwright-core");
      attached = await chromium.connectOverCDP(ws);
      await l.navigate(ws, [url]);
    } else await l.start(id, [url]);
    const launch = store.getLaunch(id);
    writeFileSync(spec.pidFile, JSON.stringify([launch?.pid, launch?.firefoxOwner?.pid].filter(Boolean)));
    stop = async () => { await attached?.close().catch(() => {}); await l.stop(id).catch(() => {}); autofill.close(); };
  }
  const quit = () => { void stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  // Windows has no SIGTERM for a child process, so a "<pidFile>.stop" file also stops the browser the app's way.
  setInterval(() => { if (existsSync(`${spec.pidFile}.stop`)) quit(); }, 500);
}

function killTree(pid: number): void {
  if (WIN) { spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }); return; }
  for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); } catch {}
}

/** Kills what a run left behind: only the PIDs our own `open` command recorded. */
function reap(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  for (const pid of JSON.parse(readFileSync(pidFile, "utf8")) as number[]) {
    try { process.kill(pid, 0); killTree(pid); } catch {}
  }
  rmSync(pidFile, { force: true });
}

/** Math.random from a seed, so the browser-forge parts of a profile come out the same on every run. */
function seeded<T>(seed: number, fn: () => T): T {
  const real = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return fn(); } finally { Math.random = real; }
}

export function buildProfile(engine: "chromium" | "firefox", os: string, id: string, seed = SEED, timezone = TIMEZONE): Profile {
  return seeded(seed, () => {
    const created = buildNewProfile({ engine, ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}), screen: "1920x1080", platformOs: os, name: id }, () => false);
    const profile: Profile = { ...created, id, fingerprintSeed: seed, timezone, locale: LOCALE };
    // The Firefox identity is generated again from the fixed seed instead of the random id's.
    return engine === "firefox" ? withDefaultBrowser({ ...profile, firefox: undefined }) : completeProfileFingerprint(profile);
  });
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${url} (${response.status})`);
  await pipeline(response.body as any, createWriteStream(file));
}

/** The app's pinned AliasMode Firefox release suffix (rN). */
export const PINNED_FIREFOX_RELEASE = firefoxReleaseArchiveUrl(firefoxBuildForHost()).split("/").at(-2)!.split("-").at(-1)!;

/** AliasMode Firefox from a release tag, checked against the release's SHA256SUMS. */
export async function installFirefoxRelease(root: string, tag: string): Promise<{ path: string; sha256: string }> {
  const build = firefoxBuildForHost();
  const dir = join(root, `firefox-${FIREFOX_RUNTIME_VERSION}-${tag}`);
  const exe = join(dir, build.executablePath);
  if (!existsSync(exe)) {
    const kind = WIN ? "win.x86_64" : process.platform === "darwin" ? `mac.${process.arch === "arm64" ? "arm64" : "x86_64"}` : "lin.x86_64";
    const asset = `aliasmode-${FIREFOX_RUNTIME_VERSION}-${kind}.zip`;
    const base = `https://github.com/aliasmode/aliasmode-firefox/releases/download/aliasmode-runtime-${FIREFOX_RUNTIME_VERSION}-${tag}`;
    const sums = await (await fetch(`${base}/SHA256SUMS`)).text();
    const expected = sums.split("\n").find((line) => line.trim().endsWith(asset))?.split(/\s+/)[0];
    if (!expected) throw new Error(`${asset} is not in ${tag}'s SHA256SUMS`);
    mkdirSync(root, { recursive: true });
    const zip = `${dir}.zip`;
    console.log(`Downloading AliasMode Firefox ${tag}...`);
    await download(`${base}/${asset}`, zip);
    if (await sha256File(zip) !== expected) throw new Error(`${asset} does not match SHA256SUMS`);
    const temp = `${dir}.tmp`;
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp);
    const command = WIN ? [windowsSystemTool("tar.exe"), "-xf", zip, "-C", temp]
      : process.platform === "darwin" ? ["ditto", "-x", "-k", zip, temp] : ["unzip", "-q", zip, "-d", temp];
    if (spawnSync(command[0]!, command.slice(1), { stdio: "inherit" }).status !== 0) throw new Error("Firefox extraction failed");
    renameSync(temp, dir);
    rmSync(zip, { force: true });
  }
  return { path: exe, sha256: await sha256File(exe) };
}

/** Probe ids whose values differ between two lab runs, compared as diff.mjs compares them. */
function differing(a: any, b: any): string[] {
  const show = (r: any) => r === undefined ? "(missing)" : r.error ? `error: ${r.error}` : JSON.stringify(r.value);
  return [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])].filter((id) => show(a.results[id]) !== show(b.results[id]));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function node(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("node", args, { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function main(): Promise<void> {
  const site = resolve(arg("site") ?? "");
  const dist = join(site, "dist");
  if (!process.argv.includes("--skip-check") && !existsSync(join(dist, "check", "index.html"))) throw new Error("--site must be an aliasmode-site checkout with a built dist/ (npm run build)");
  const out = resolve(arg("out") ?? join(tmpdir(), `engine-audit-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`));
  const runtimes = resolve(arg("runtimes") ?? join(tmpdir(), "aliasmode-engine-audit"));
  const only = arg("only")?.split(",");
  for (const sub of ["check", "lab", "targets"]) mkdirSync(join(out, sub), { recursive: true });

  // Empty when the app gives this host no AliasMode Chromium (Intel Macs before 159): Firefox only.
  const chromium = arg("chromium-build") ? resolve(arg("chromium-build")!) : defaultChromiumRuntime() === "aliasmode" ? await ensureAliasmodeChromium(runtimes) : "";
  const firefoxTag = arg("firefox-build") ? "local" : arg("firefox-release") ?? PINNED_FIREFOX_RELEASE;
  const firefox = arg("firefox-build")
    ? { path: resolve(arg("firefox-build")!), sha256: await sha256File(resolve(arg("firefox-build")!)) }
    : await installFirefoxRelease(runtimes, firefoxTag);
  const noSandbox = process.platform === "linux" && linuxChromiumSandboxBlocked();
  const baseArgs = [`--aliasmode-launcher-pid=${process.pid}`, ...(noSandbox ? ["--no-sandbox"] : [])];
  const stockChrome = process.env.CHROME_BIN ?? (WIN ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
  const stockFirefox = process.env.FIREFOX_BIN ?? (WIN ? "C:\\Program Files\\Mozilla Firefox\\firefox.exe" : "firefox");
  // Stock browsers get the profiles' time zone where the OS allows it per process.
  const tz = WIN ? [] : ["env", `TZ=${TIMEZONE}`];

  const targets: Array<{ label: string; command: string[]; stock: string; version: string }> = [
    { label: "stock-chrome", command: [...tz, stockChrome, "--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", ...(noSandbox ? ["--no-sandbox"] : [])], stock: "", version: stockChrome },
    { label: "stock-firefox", command: [...tz, stockFirefox, "-profile", "{profile}", "-no-remote"], stock: "", version: stockFirefox },
  ];
  // A second stock run of each browser: the lab probes that differ between the two are noise (timing, randomness).
  targets.push({ ...targets[0]!, label: "stock-chrome-2" }, { ...targets[1]!, label: "stock-firefox-2" });
  const chromiumVersion = basename(dirname(chromium));
  for (const os of [...new Set(["windows", HOST_OS])]) {
    for (const engine of chromium ? ["chromium", "firefox"] as const : ["firefox"] as const) {
      const profile = buildProfile(engine, os, `engaudit-${engine}-${os}`);
      for (const mode of engine === "chromium" ? ["app", "plain", "attached"] as const : ["app"] as const) {
        const label = `aliasmode-${engine}-${os}${mode === "app" ? "" : `-${mode}`}`;
        const dir = join(out, "targets", label);
        mkdirSync(dir, { recursive: true });
        const spec: Spec = { label, mode, profile, runtimes, chromium, baseArgs, pidFile: join(dir, "pids.json"), ...(engine === "firefox" ? { firefox } : {}) };
        writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 1));
        // The exact launch inputs, with this run's profile folder and port as placeholders.
        const store = new ProfileStore(":memory:");
        const l = launcher(store, spec, "PROFILES", mode === "plain" ? undefined : new AutofillBridge(store));
        if (engine === "chromium") {
          writeFileSync(join(dir, "argv.json"), JSON.stringify([chromium, ...l.buildArgs(profile, 0, "USER_DATA_DIR", [], undefined, false)], null, 1));
        } else {
          const pack = firefoxFontPackFor(os as "windows" | "macos" | "linux");
          const fontsDir = pack ? firefoxFontPackFontsDir(runtimes, pack) : undefined;
          writeFileSync(join(dir, "firefox-launch.json"), JSON.stringify({
            executable: firefox.path, release: firefoxTag,
            config: firefoxLaunchConfig(profile, undefined, fontsDir),
            prefs: { ...firefoxStartupPrefs(profile, process.platform, process.arch), ...(fontsDir ? firefoxFontPackPrefs(fontsDir) : {}) },
            playwright: firefoxLaunchOptions({ executablePath: firefox.path, config: {} }),
          }, null, 1));
        }
        store.close();
        targets.push({
          label, command: [process.execPath, import.meta.path, "open", join(dir, "spec.json"), "{profile}"],
          stock: engine === "chromium" ? "stock-chrome" : "stock-firefox",
          version: engine === "chromium" ? chromiumVersion : `firefox ${FIREFOX_RUNTIME_VERSION}-${firefoxTag}`,
        });
      }
    }
  }

  const rows: string[] = [];
  const checkRunner = join(site, "tests", "check-calibration", "run.mjs");
  const labDir = join(site, "tests", "detection-lab");
  for (const t of targets.filter((t) => !only || only.includes(t.label) || !t.stock)) {
    const pidFile = join(out, "targets", t.label, "pids.json");
    let check = "skipped";
    if (!process.argv.includes("--skip-check")) {
      console.log(`check: ${t.label}`);
      console.log(node([checkRunner, dist, `${t.label}=${t.command.join("|")}`], { RUNNER_TEMP: join(out, "check"), CHECK_TZ: TIMEZONE }).trim());
      reap(pidFile);
      const file = join(out, "check", `fpcheck-${t.label}.json`);
      if (existsSync(file)) {
        const report = JSON.parse(readFileSync(file, "utf8"));
        const list = (status: string) => report.findings.filter((f: any) => f.status === status).map((f: any) => f.id).join(", ") || "-";
        check = `${report.identity ?? report.summary} | fail: ${list("fail")} | warn: ${list("warn")} | info: ${list("info")}`;
      } else check = "no result | | |";
    }
    let lab = "skipped";
    if (!process.argv.includes("--skip-lab")) {
      console.log(`lab: ${t.label}`);
      const name = `engine-audit-${process.pid}-${t.label}`;
      console.log(node([join(labDir, "run.mjs"), name, t.command.join("|")]).trim());
      reap(pidFile);
      const produced = join(labDir, "results", `${name}.json`);
      const file = join(out, "lab", `${t.label}.json`);
      if (existsSync(produced)) { copyFileSync(produced, file); rmSync(produced); }
      if (!existsSync(file)) lab = "no result";
      else {
        const result = JSON.parse(readFileSync(file, "utf8"));
        const errors = Object.values(result.results).filter((r: any) => r.error).length;
        lab = `${Object.keys(result.results).length} probes, ${errors} errors`;
        const stockFile = join(out, "lab", `${t.stock}.json`);
        if (t.stock && existsSync(stockFile)) {
          writeFileSync(join(out, "lab", `${t.label}.diff.txt`), node([join(labDir, "diff.mjs"), stockFile, file]));
          const stock = JSON.parse(readFileSync(stockFile, "utf8"));
          const again = join(out, "lab", `${t.stock}-2.json`);
          const noise = new Set(existsSync(again) ? differing(stock, JSON.parse(readFileSync(again, "utf8"))) : []);
          const ids = differing(stock, result);
          lab += `, ${ids.length} differ vs ${t.stock} (${ids.filter((id) => !noise.has(id)).length} beyond stock-vs-stock noise)`;
        }
        lab += ` | ${result.ua}`;
      }
    }
    rows.push(`| ${t.label} | ${t.version} | ${check} | ${lab} |`);
  }
  const summary = [
    `# Engine audit ${new Date().toISOString()}`, "",
    `Host: ${process.platform} ${process.arch}, ${availableParallelism()} threads. Profiles: seed ${SEED}, ${TIMEZONE}, ${LOCALE}, 1920x1080, no proxy.`,
    `Engines: Chromium ${chromium}; Firefox ${firefoxTag} ${firefox.path}.${noSandbox ? " Chromium runs with --no-sandbox (this host blocks its sandbox)." : ""}`, "",
    "| Run | Engine | Check: headline, fail, warn, info | Lab (diff vs stock), UA |", "|---|---|---|---|", ...rows, "",
  ].join("\n");
  writeFileSync(join(out, "summary.md"), summary);
  console.log(`\n${summary}\nSaved ${out}`);
}

/** The app's host GPU read, awaited (branches with the GPU-family rule), so every new profile gets the same GPU decision. */
export async function readHostGpu(): Promise<string> {
  const file = join(import.meta.dir, "..", "..", "host-gpu.ts");
  if (!existsSync(file)) return "no GPU rule in this checkout";
  return (await (await import(file)).waitForHostGpu()) ?? "none";
}

if (process.argv[2] === "open") await open(process.argv[3]!, process.argv[4]!, process.argv[5]!);
else if (import.meta.main) { await readHostGpu(); await main(); }

/**
 * Diagnostics: launch imported profiles and collect hard evidence that the
 * CloakBrowser setup is sound, so the report can be eyeballed (or forwarded)
 * to confirm everything before any real campaign traffic.
 *
 * Per profile it gathers, over CDP:
 *   - egress IP + geo (is the proxy actually in use? not bypassed?)
 *   - user agent + UA Client Hints (and whether they agree)
 *   - canvas / WebGL / audio fingerprints (unique per profile? stable on relaunch?)
 *   - WebRTC candidate IPs (real-IP leak?)
 *   - timezone / locale / screen
 *   - x.com login state (did the injected cookies land?)
 *
 * The collection shell (CDP + network) is deliberately thin and untested here;
 * the verdict logic lives in `analyze()`, which is pure and unit-tested. The
 * report intentionally omits cookie values and passwords — but it DOES contain
 * proxy hosts and egress IPs, so treat it as sensitive.
 */

import type { Profile } from "./types.ts";
import { fetchDirectEgress, parseEgressResponse, resolveEgressEndpoints, type EgressInfo } from "./egress.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";

// Preserve diagnose.ts's existing public type surface while sharing the parser.
export type { EgressInfo } from "./egress.ts";

export interface FingerprintSample {
  userAgent?: string;
  uaDataPlatform?: string;
  uaDataBrands?: string[];
  uaFullVersion?: string;
  platform?: string;
  language?: string;
  languages?: string[];
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screen?: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number; dpr: number };
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  audioHash?: string;
  errors?: Record<string, string>;
}

export interface LoginInfo {
  loggedIn: boolean;
  loggedOut: boolean;
  url?: string;
  title?: string;
}

export interface ProfileReport {
  profileId: string;
  ok: boolean;
  error?: string;
  proxyConfigured: { host: string; port: string } | null;
  /** The profile's stored screen, compared against what the browser reports. */
  screenConfigured: { width: number; height: number } | null;
  egress: EgressInfo | null;
  fingerprint: FingerprintSample | null;
  /** Second sample after a relaunch, when --relaunch is used. */
  fingerprintRelaunch?: FingerprintSample | null;
  webrtcIps?: string[];
  login: LoginInfo | null;
}

export interface DiagnoseReport {
  generatedAt: number;
  baselineRealIp?: string;
  profiles: ProfileReport[];
  analysis: Analysis;
}

export interface Analysis {
  total: number;
  okCount: number;
  proxy: { ok: string[]; bypassed: string[]; matchesConfiguredHost: string[]; noEgress: string[]; inconclusive: string[] };
  webrtcLeaks: string[];
  fingerprintCollisions: { canvas: Collision[]; audio: Collision[]; webgl: Collision[] };
  uaInconsistencies: { profileId: string; reason: string }[];
  unstableFingerprints: string[];
  login: { loggedIn: string[]; loggedOut: string[]; unknown: string[] };
  screenMismatches: { profileId: string; configured: string; seen: string }[];
  verdicts: string[];
}

export interface Collision {
  value: string;
  profiles: string[];
}

// ---------------------------------------------------------------------------
// Pure analysis — the tested core.
// ---------------------------------------------------------------------------

function dupes(pairs: { profileId: string; value?: string }[]): Collision[] {
  const byValue = new Map<string, string[]>();
  for (const { profileId, value } of pairs) {
    if (!value) continue;
    const list = byValue.get(value) ?? [];
    list.push(profileId);
    byValue.set(value, list);
  }
  return [...byValue.entries()].filter(([, ps]) => ps.length > 1).map(([value, profiles]) => ({ value, profiles }));
}

/** Infer the expected platform token CloakBrowser's UA-CH should report. */
function expectedPlatform(ua: string | undefined): string | null {
  const s = (ua ?? "").toLowerCase();
  if (s.includes("mac os") || s.includes("macintosh")) return "macOS";
  if (s.includes("linux") && !s.includes("android")) return "Linux";
  if (s.includes("windows")) return "Windows";
  return null;
}

export function analyze(profiles: ProfileReport[], baselineRealIp?: string): Analysis {
  const a: Analysis = {
    total: profiles.length,
    okCount: profiles.filter((p) => p.ok).length,
    proxy: { ok: [], bypassed: [], matchesConfiguredHost: [], noEgress: [], inconclusive: [] },
    webrtcLeaks: [],
    fingerprintCollisions: { canvas: [], audio: [], webgl: [] },
    uaInconsistencies: [],
    unstableFingerprints: [],
    login: { loggedIn: [], loggedOut: [], unknown: [] },
    screenMismatches: [],
    verdicts: [],
  };

  for (const p of profiles) {
    // Proxy: the critical check is bypass (browser egress == this machine's IP).
    const egressIp = p.egress?.ip;
    if (!egressIp) {
      a.proxy.noEgress.push(p.profileId);
    } else if (!baselineRealIp) {
      // Without the real-IP baseline we cannot prove the proxy isn't bypassed —
      // report as inconclusive rather than falsely green-lighting it.
      a.proxy.inconclusive.push(p.profileId);
    } else if (egressIp === baselineRealIp) {
      a.proxy.bypassed.push(p.profileId);
    } else {
      a.proxy.ok.push(p.profileId);
      if (p.proxyConfigured && egressIp === p.proxyConfigured.host) a.proxy.matchesConfiguredHost.push(p.profileId);
    }

    // WebRTC: any candidate equal to the real IP is a leak.
    if (baselineRealIp && p.webrtcIps?.includes(baselineRealIp)) a.webrtcLeaks.push(p.profileId);

    // UA vs UA-CH consistency.
    const fp = p.fingerprint;
    if (fp?.userAgent && fp.uaDataPlatform) {
      const want = expectedPlatform(fp.userAgent);
      if (want && fp.uaDataPlatform !== want) {
        a.uaInconsistencies.push({ profileId: p.profileId, reason: `UA implies ${want} but UA-CH platform is ${fp.uaDataPlatform}` });
      }
    }

    // Screen: the browser-reported resolution must match the spoofed value.
    const screen = p.fingerprint?.screen;
    if (screen && p.screenConfigured) {
      if (screen.width !== p.screenConfigured.width || screen.height !== p.screenConfigured.height) {
        a.screenMismatches.push({
          profileId: p.profileId,
          configured: `${p.screenConfigured.width}x${p.screenConfigured.height}`,
          seen: `${screen.width}x${screen.height}`,
        });
      }
    }

    // Login tally.
    if (p.login?.loggedIn) a.login.loggedIn.push(p.profileId);
    else if (p.login?.loggedOut) a.login.loggedOut.push(p.profileId);
    else a.login.unknown.push(p.profileId);

    // Fingerprint stability across relaunch (same profile must look identical).
    if (p.fingerprintRelaunch && fp) {
      if (fp.canvasHash && p.fingerprintRelaunch.canvasHash && fp.canvasHash !== p.fingerprintRelaunch.canvasHash) {
        a.unstableFingerprints.push(p.profileId);
      }
    }
  }

  // Cross-profile uniqueness (noise-based surfaces should differ per seed).
  a.fingerprintCollisions.canvas = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.canvasHash })));
  a.fingerprintCollisions.audio = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.audioHash })));
  a.fingerprintCollisions.webgl = dupes(
    profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.webglRenderer })),
  );

  // Verdicts: plain-language pass/fail lines for the summary.
  const v = a.verdicts;
  v.push(`${a.okCount}/${a.total} profiles launched and probed cleanly`);
  if (a.proxy.bypassed.length) v.push(`❌ PROXY BYPASSED on ${a.proxy.bypassed.length} profile(s): ${a.proxy.bypassed.join(", ")} — egress equals this machine's IP`);
  else if (a.proxy.inconclusive.length) v.push(`⚠️  proxy bypass could NOT be checked for ${a.proxy.inconclusive.length} profile(s) — this machine's real-IP baseline was unavailable; rerun with the baseline before trusting the proxy`);
  else if (a.proxy.noEgress.length) v.push(`⚠️  no egress IP captured for ${a.proxy.noEgress.length} profile(s) — cannot confirm proxy`);
  else v.push(`✅ proxy in use on all ${a.proxy.ok.length} profile(s) (no bypass to host IP)`);
  if (a.webrtcLeaks.length) v.push(`❌ WebRTC leaks real IP on: ${a.webrtcLeaks.join(", ")}`);
  else v.push(`✅ no WebRTC real-IP leak detected`);
  if (a.fingerprintCollisions.canvas.length) v.push(`❌ canvas fingerprint COLLISION across profiles: ${a.fingerprintCollisions.canvas.map((c) => c.profiles.join("+")).join("; ")}`);
  else v.push(`✅ canvas fingerprints unique across profiles`);
  if (a.unstableFingerprints.length) v.push(`❌ fingerprint changed across relaunch on: ${a.unstableFingerprints.join(", ")}`);
  if (a.uaInconsistencies.length) v.push(`⚠️  UA/UA-CH mismatch on ${a.uaInconsistencies.length} profile(s)`);
  const screensCompared = profiles.filter((p) => p.fingerprint?.screen && p.screenConfigured).length;
  if (a.screenMismatches.length) v.push(`⚠️  screen resolution mismatch on ${a.screenMismatches.length} profile(s): ${a.screenMismatches.map((s) => `${s.profileId} ${s.seen}≠${s.configured}`).join(", ")}`);
  else if (screensCompared) v.push(`✅ screen resolution matches the spoofed value on all ${screensCompared} profile(s)`);
  v.push(`login: ${a.login.loggedIn.length} signed in, ${a.login.loggedOut.length} signed out, ${a.login.unknown.length} unknown`);

  return a;
}

// ---------------------------------------------------------------------------
// In-browser probes (serialized to the page; must be self-contained).
// ---------------------------------------------------------------------------

async function fingerprintProbe(): Promise<FingerprintSample> {
  const out: FingerprintSample = { errors: {} };
  const err = (k: string, e: unknown) => {
    out.errors![k] = e instanceof Error ? e.message : String(e);
  };
  try {
    out.userAgent = navigator.userAgent;
    out.platform = (navigator as any).platform;
    out.language = navigator.language;
    out.languages = navigator.languages as string[];
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = (navigator as any).deviceMemory;
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.screen = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      dpr: devicePixelRatio,
    };
  } catch (e) {
    err("nav", e);
  }
  try {
    const uaData = (navigator as any).userAgentData;
    if (uaData) {
      const hi = await uaData.getHighEntropyValues(["platform", "platformVersion", "uaFullVersion", "fullVersionList"]);
      out.uaDataPlatform = hi.platform;
      out.uaFullVersion = hi.uaFullVersion;
      out.uaDataBrands = (uaData.brands ?? []).map((b: any) => `${b.brand} ${b.version}`);
    }
  } catch (e) {
    err("uaData", e);
  }
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        out.webglVendor = String(gl.getParameter((dbg as any).UNMASKED_VENDOR_WEBGL));
        out.webglRenderer = String(gl.getParameter((dbg as any).UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch (e) {
    err("webgl", e);
  }
  const sha = async (s: string) => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  try {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext("2d")!;
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(10, 10, 100, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("Cloak fingerprint \u{1F3A8}", 2, 15);
    out.canvasHash = await sha(c.toDataURL());
  } catch (e) {
    err("canvas", e);
  }
  try {
    const Ctx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const ac = new Ctx(1, 5000, 44100);
    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 10000;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(ac.destination);
    osc.start(0);
    const buf: AudioBuffer = await new Promise((res) => {
      ac.oncomplete = (e: any) => res(e.renderedBuffer);
      ac.startRendering();
    });
    const data = buf.getChannelData(0).slice(0, 1000);
    let sum = 0;
    for (const x of data) sum += Math.abs(x);
    out.audioHash = await sha(String(sum));
  } catch (e) {
    err("audio", e);
  }
  return out;
}

function loginProbe(): LoginInfo {
  const url = location.href;
  const loggedIn = !!document.querySelector(
    '[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"]',
  );
  const loggedOut =
    !!document.querySelector('input[name="text"], a[href="/login"], [data-testid="loginButton"]') ||
    /\/login|\/i\/flow\/login|logout/.test(url);
  return { url, loggedIn, loggedOut, title: document.title };
}

async function webrtcProbe(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const ips = new Set<string>();
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.createDataChannel("x");
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          resolve([...ips]);
          return;
        }
        const cand = e.candidate;
        // Modern browsers expose the parsed address; prefer it.
        const addr = ((cand as any).address || "").trim();
        if (addr && !addr.endsWith(".local")) {
          ips.add(addr);
          return;
        }
        // Skip mDNS-anonymized candidates (<uuid>.local) — they carry no real IP
        // and their hex would otherwise be misparsed as an address.
        const s = cand.candidate;
        if (/\.local\b/i.test(s)) return;
        const m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7})/i);
        if (m) ips.add(m[0]);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o));
      setTimeout(() => resolve([...ips]), 3000);
    } catch {
      resolve([]);
    }
  });
}

// ---------------------------------------------------------------------------
// CDP collection shell (untested; mirrors launcher's default-impl pattern).
// ---------------------------------------------------------------------------

/** Egress via the diagnostic page itself (interactive tooling only; the launch path never does this). */
async function diagnosePageEgress(page: any, timeoutMs: number): Promise<EgressInfo | null> {
  for (const endpoint of resolveEgressEndpoints()) {
    try {
      const response = await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!response?.ok()) continue;
      const info = parseEgressResponse(await page.locator("body").innerText({ timeout: Math.min(timeoutMs, 5_000) }));
      if (info) return info;
    } catch {
      // next endpoint
    }
  }
  return null;
}

export interface DiagnoseProfileOptions {
  timeoutMs?: number;
  collectLogin?: boolean;
}

/** Connect over CDP and collect one profile's full sample. */
export async function diagnoseOverCDP(
  ws: string,
  profile: Profile,
  opts: DiagnoseProfileOptions = {},
): Promise<Pick<ProfileReport, "fingerprint" | "egress" | "webrtcIps" | "login">> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const result = await runPlaywrightWorker<{
    fingerprint: FingerprintSample;
    webrtcIps: string[];
    egress: string | null;
    login: LoginInfo | null;
  }>("diagnostics", {
    endpoint: ws,
    timeoutMs,
    collectLogin: opts.collectLogin !== false,
    fingerprintScript: fingerprintProbe.toString(),
    webrtcScript: webrtcProbe.toString(),
    loginScript: loginProbe.toString(),
    egressUrls: resolveEgressEndpoints(),
    connectTimeoutMs: timeoutMs,
  }, { timeoutMs: timeoutMs * 3 + 20_000 });
  return {
    fingerprint: result.fingerprint,
    egress: result.egress ? parseEgressResponse(result.egress) : null,
    webrtcIps: result.webrtcIps,
    login: result.login,
  };
}

// ---------------------------------------------------------------------------
// Orchestration over the manager's AdsPower-shaped HTTP API.
// ---------------------------------------------------------------------------

export interface RunDiagnosticsOptions {
  baseUrl: string;
  profiles: Profile[];
  relaunch?: boolean;
  collectLogin?: boolean;
  log?: (msg: string) => void;
  /** Called with the running report after each profile, for incremental persistence. */
  onProgress?: (report: DiagnoseReport) => void;
  /** Hard cap per profile so a hung CDP connection can't stall the whole run. */
  perProfileTimeoutMs?: number;
}

/** Reject if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function apiStart(baseUrl: string, id: string): Promise<{ ws: string; port: number } | null> {
  const r = await (await fetch(`${baseUrl}/api/v1/browser/start?user_id=${encodeURIComponent(id)}`)).json();
  if (r.code !== 0) return null;
  return { ws: r.data.ws.puppeteer, port: Number(r.data.debug_port) };
}
async function apiStop(baseUrl: string, id: string): Promise<void> {
  await fetch(`${baseUrl}/api/v1/browser/stop?user_id=${encodeURIComponent(id)}`).catch(() => {});
}

/** This machine's own outbound IP (no proxy) — the bypass baseline. */
async function baselineRealIp(): Promise<string | undefined> {
  return (await fetchDirectEgress())?.ip;
}

/** Drive every profile through the manager, collect samples, and analyze. */
export async function runDiagnostics(opts: RunDiagnosticsOptions): Promise<DiagnoseReport> {
  const log = opts.log ?? ((m) => console.log(`[diagnose] ${m}`));
  const realIp = await baselineRealIp();
  log(`this machine's real IP (proxy-bypass baseline): ${realIp ?? "unknown"}`);

  const timeout = opts.perProfileTimeoutMs ?? 90_000;
  const reports: ProfileReport[] = [];
  const snapshot = (): DiagnoseReport => ({ generatedAt: Date.now(), baselineRealIp: realIp, profiles: reports, analysis: analyze(reports, realIp) });

  for (const profile of opts.profiles) {
    const proxyConfigured = profile.proxy ? { host: profile.proxy.host, port: profile.proxy.port } : null;
    const screenConfigured = { width: profile.screenWidth, height: profile.screenHeight };
    try {
      const first = await apiStart(opts.baseUrl, profile.id);
      if (!first) {
        reports.push({ profileId: profile.id, ok: false, error: "browser/start failed", proxyConfigured, screenConfigured, egress: null, fingerprint: null, login: null });
        continue;
      }
      const sample = await withTimeout(
        diagnoseOverCDP(first.ws, profile, { collectLogin: opts.collectLogin }),
        timeout,
        `diagnose ${profile.id}`,
      );

      let fingerprintRelaunch: FingerprintSample | null | undefined;
      if (opts.relaunch) {
        await apiStop(opts.baseUrl, profile.id);
        const second = await apiStart(opts.baseUrl, profile.id);
        if (second) {
          const s2 = await withTimeout(diagnoseOverCDP(second.ws, profile, { collectLogin: false }), timeout, `relaunch ${profile.id}`);
          fingerprintRelaunch = s2.fingerprint;
        }
      }

      const report: ProfileReport = { profileId: profile.id, ok: true, proxyConfigured, screenConfigured, ...sample, fingerprintRelaunch };
      reports.push(report);
      const eg = report.egress?.ip ?? "?";
      const proxyTag = !realIp ? "baseline?" : eg === realIp ? "❌BYPASS" : "ok";
      const li = report.login?.loggedIn ? "logged-in" : report.login?.loggedOut ? "logged-out" : "login?";
      log(`${profile.id}: egress=${eg} ${proxyTag} canvas=${report.fingerprint?.canvasHash?.slice(0, 8) ?? "?"} ${li}`);
    } catch (e) {
      reports.push({ profileId: profile.id, ok: false, error: e instanceof Error ? e.message : String(e), proxyConfigured, screenConfigured, egress: null, fingerprint: null, login: null });
      log(`${profile.id}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await apiStop(opts.baseUrl, profile.id);
      opts.onProgress?.(snapshot());
    }
  }

  return snapshot();
}

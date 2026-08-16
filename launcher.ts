/**
 * CloakBrowser process launcher.
 *
 * One browser process per profile, each with its own persistent user-data
 * dir and remote-debugging port — the same one-process-per-profile model
 * AdsPower uses, which keeps automation debug-port-based teardown working.
 *
 * Launch is read-only with respect to identity: proxy, fingerprint seed, UA,
 * and screen come straight from the store. Cookies are injected exactly once
 * (first launch); after that the persistent dir carries browser state.
 */

import { basename, join, resolve, sep } from "node:path";
import {
  createReadStream,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import type { CookieRecord, LaunchInfo, Profile } from "./types.ts";
import type { ProfileStore } from "./store.ts";
import { allocatePort } from "./ports.ts";
import { deriveFingerprintFlags, isMobileUserAgent, platformFromUA, proxyServerFlag } from "./fingerprint.ts";
export { isMobileUserAgent } from "./fingerprint.ts";
import { startProxyRelay, type ProxyRelay } from "./proxy-relay.ts";
import type { SearchProviderSetupResult } from "./search-provider.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import { SessionRestoreError } from "./session.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";

// Chromium ignores inline user:pass@ on --proxy-server. Rather than an MV3 extension answering
// onAuthRequired (whose service worker can't answer reliably during a page-load burst), the browser
// uses a loopback HTTP relay for authenticated HTTP and every SOCKS5 proxy. The relay injects HTTP
// auth or performs SOCKS5 itself, so behavior does not depend on the packaged kernel's native SOCKS
// patch level and proxy credentials never appear in the browser command line.
function needsProxyRelay(profile: Profile): boolean {
  return !!profile.proxy && (
    profile.proxy.type === "socks5"
    || (profile.proxy.type === "http" && !!profile.proxy.user)
  );
}

export type BrowserLaunchFailure =
  | "preflight"
  | "relay_setup"
  | "process_spawn"
  | "cdp_readiness";

/** Closed, public-safe browser launch failure. Never attach a raw cause. */
export class BrowserLaunchError extends Error {
  override readonly name = "BrowserLaunchError";

  constructor(readonly failure: BrowserLaunchFailure) {
    super(`browser_launch/${failure} (failed)`);
  }
}

export interface SpawnedProcess {
  pid: number;
  kill(): void;
  /** Linux-only dedicated process-group ownership captured at spawn. */
  processGroupId?: number;
  rootStartTime?: string;
  /**
   * Resolves with a human-readable reason once the spawner can PROVE the browser
   * never started (e.g. the Windows session helper exited nonzero because nobody is
   * logged in), or null when the spawn looks healthy / cannot be judged.
   *
   * Load-bearing for diagnosis: without it every spawn-side outage — no interactive
   * session, an unregistrable scheduled task, a missing helper — surfaces only as an
   * indistinguishable "CDP endpoint not ready within 60000ms" a full minute later,
   * which is how a fleet-wide launch failure can look identical to a slow browser.
   * Never rejects.
   */
  spawnFailed?: Promise<string | null>;
}

export type SpawnFn = (binary: string, args: string[]) => SpawnedProcess;
export type FetchFn = (url: string) => Promise<{ ok: boolean; json(): Promise<any> }>;
export type LaunchNavigator = (ws: string, urls: string[]) => Promise<void>;
export interface BrowserProcessIdentity {
  profileId: string;
  debugPort: number;
  userDataDir: string;
  binaryPath: string;
}
/** Exact process scan: null means the OS scan itself was inconclusive. */
export type OwnedBrowserProcessFinder = (identity: BrowserProcessIdentity) => Promise<number[] | null>;
/**
 * Label the launched window so an operator can tell which account a browser
 * belongs to among many open profiles — the visible cue AdsPower's panel used
 * to give. Prefixes the window/tab title with `<name> · #<serial>`. Best-effort:
 * a failure here must never fail (or slow) the launch. Injectable for tests.
 */
export type WindowLabeler = (ws: string, label: string) => Promise<void>;
/** Best-effort persistent omnibox-provider setup after CDP becomes ready. */
export type SearchProviderEnsurer = (ws: string) => Promise<SearchProviderSetupResult>;
/**
 * Ensure the browser has a logged-in session: inject the exported cookies
 * only when none is present, and report whether it injected. Leaving an
 * existing session untouched preserves cookies the platform rotated during
 * prior sessions.
 */
export type CookieEnsurer = (ws: string, cookies: CookieRecord[]) => Promise<{ injected: boolean }>;

/**
 * True if the exported cookies carry a usable X login token — a non-empty
 * `auth_token` that hasn't expired. A session-scoped token (no expiry) counts.
 * When false, injecting can't establish a session, so the manager defers to the
 * app's credential auto-login instead of replaying a dead cookie.
 */
export function hasUsableAuthToken(cookies: CookieRecord[]): boolean {
  return cookies.some((c) => c.name === "auth_token" && !!c.value && cookieIsCurrent(c));
}

/** True when an export carries a current Telegram web cookie. */
export function hasUsableTelegramCookie(cookies: CookieRecord[]): boolean {
  return cookies.some((c) => !!c.name && !!c.value && cookieDomainMatches(c, "telegram.org") && cookieIsCurrent(c));
}

type CookieBootstrapTarget = {
  name: "X" | "Telegram";
  url: string;
  hasUsableCookie: (cookies: CookieRecord[]) => boolean;
};

const COOKIE_BOOTSTRAP_TARGETS: CookieBootstrapTarget[] = [
  { name: "X", url: "https://x.com", hasUsableCookie: hasUsableAuthToken },
  { name: "Telegram", url: "https://web.telegram.org", hasUsableCookie: hasUsableTelegramCookie },
];

function cookieBootstrapTarget(cookies: CookieRecord[]): CookieBootstrapTarget | null {
  return COOKIE_BOOTSTRAP_TARGETS.find((target) => target.hasUsableCookie(cookies)) ?? null;
}

function cookieIsCurrent(c: CookieRecord): boolean {
  const nowSec = Date.now() / 1000;
  const expires = Number(c.expires);
  return c.expires === undefined || expires < 0 || expires > nowSec;
}

function cookieDomainMatches(c: CookieRecord, parentDomain: string): boolean {
  const domain = c.domain.replace(/^\./, "").toLowerCase();
  const parent = parentDomain.toLowerCase();
  return domain === parent || domain.endsWith(`.${parent}`);
}

export function splitLaunchUrls(launchArgs: string[]): { chromeArgs: string[]; startupUrls: string[] } {
  const chromeArgs: string[] = [];
  const startupUrls: string[] = [];
  for (const arg of launchArgs) {
    if (isHttpUrl(arg)) startupUrls.push(arg);
    else chromeArgs.push(arg);
  }
  return { chromeArgs, startupUrls };
}

const AUTOMATION_RUNTIME_LAUNCH_ARGS = new Set([
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--no-first-run",
  "--disable-features=BackForwardCache",
  "--disk-cache-size=1",
  "--media-cache-size=1",
  "--v8-cache-options=none",
  "--disable-gpu-shader-disk-cache",
  "--js-flags=--max-old-space-size=512",
  "--memory-pressure-off",
  // The automation CDP client connects to the debug port over a WebSocket;
  // Chromium >=111 rejects that connection unless the origin is permitted, so the
  // caller passes --remote-allow-origins=* (also a zendriver built-in default). It
  // only governs the DevTools endpoint's Origin check — not identity/proxy/storage.
  "--remote-allow-origins=*",
  // Suppresses the WebAuthn/passkey prompt that otherwise interrupts the automated
  // X login. JS-visible but a deliberate, long-standing Automation trade-off.
  "--disable-webauthn",
]);

/**
 * Only non-identity arguments required by the AdsPower-compatible caller may
 * cross the API. Chromium has too many aliases for a safe denylist: arbitrary
 * switches can replace proxy, profile dir, fingerprint, extensions, locale,
 * WebRTC policy, headless mode, or security settings.
 */
export function validateForwardedLaunchArgs(args: string[]): string[] {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const arg of args) {
    if (AUTOMATION_RUNTIME_LAUNCH_ARGS.has(arg) || /^--automation-launcher-pid=[1-9]\d*$/.test(arg)) accepted.push(arg);
    else rejected.push(arg);
  }
  if (rejected.length) {
    throw new Error(
      `unsafe launch_args rejected: ${rejected.join(", ")}. ` +
      "Only http(s) startup URLs, approved Automation runtime flags, and --automation-launcher-pid=<pid> are accepted.",
    );
  }
  return accepted;
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

const TELEGRAM_PLATFORM_ALIASES = new Set(["telegram.org", "telegram", "web.telegram.org"]);

/** Shared platform classification for routing and Telegram's no-concurrent-use safety guard. */
export function isTelegramPlatform(platform: string | undefined): boolean {
  return TELEGRAM_PLATFORM_ALIASES.has((platform || "").trim().toLowerCase());
}

/**
 * Home page to open as the browser's first tab for an account's platform, so a
 * launched profile lands straight on its app. Returns null for unknown/blank
 * platforms — those keep the browser's default new-tab page.
 */
export function platformHomeUrl(platform: string | undefined, telegramClient: "a" | "k" = "k"): string | null {
  const p = (platform || "").trim().toLowerCase();
  if (p === "x.com" || p === "x" || p === "twitter" || p === "twitter.com") return "https://x.com/home";
  if (p === "instagram" || p === "instagram.com" || p === "www.instagram.com") return "https://www.instagram.com/";
  if (p === "facebook" || p === "facebook.com" || p === "www.facebook.com") return "https://www.facebook.com/";
  if (p === "tiktok" || p === "tiktok.com" || p === "www.tiktok.com") return "https://www.tiktok.com/";
  if (p === "reddit" || p === "reddit.com" || p === "www.reddit.com") return "https://www.reddit.com/";
  if (isTelegramPlatform(p)) return `https://web.telegram.org/${telegramClient}/`;
  if (p === "linkedin.com" || p === "linkedin") return "https://www.linkedin.com/feed/";
  return null;
}

export interface LauncherOptions {
  store: ProfileStore;
  /** Path to the CloakBrowser binary. Defaults to $CLOAKBROWSER_BINARY_PATH. */
  binaryPath?: string;
  /**
   * Deployment-pinned SHA-256 of the approved CloakBrowser kernel. Defaults to
   * $CLOAKBROWSER_BINARY_SHA256 and is required before a production spawn.
   */
  expectedBinarySha256?: string;
  /** Root for persistent per-profile user-data dirs. */
  dataRoot?: string;
  headless?: boolean;
  portRange?: { start: number; end: number };
  /** Injectable port-bind probe for tests. Defaults to the real bind probe. */
  portProbe?: (port: number) => boolean;
  /** Ephemeral chrome flags forwarded onto every launch (e.g. ownership marker). */
  baseArgs?: string[];
  /**
   * Launched window size as fractions of the profile's screen resolution
   * (each 0.2–1.0). Defaults: width 0.65, height 0.9 → a ~two-thirds-width window
   * so several profiles sit side by side. Only affects the OS window, never the
   * spoofed screen size (that comes from --fingerprint-screen-*).
   */
  windowWidthScale?: number;
  windowHeightScale?: number;
  spawn?: SpawnFn;
  fetch?: FetchFn;
  ensureCookies?: CookieEnsurer;
  /** Repair Chromium's missing/No Search default. Omitted in low-level tests. */
  ensureSearchProvider?: SearchProviderEnsurer;
  /** Navigate initial platform URLs after session seeding, never as argv URLs. */
  navigate?: LaunchNavigator;
  /**
   * Explicit test-only escape hatch for fake binaries, hosts and network
   * probes. Supplying a custom spawn function never disables gates by itself.
   */
  unsafeDisableIdentityGates?: boolean;
  /** Enforce a native host architecture/platform for the stored persona. */
  enforceHostCompatibility?: boolean;
  /** Injectable host tuple for compatibility-policy tests. */
  hostPlatform?: NodeJS.Platform;
  hostArch?: string;
  /** Label the window with the profile name + serial so operators can identify it. */
  labelWindow?: WindowLabeler;
  /** Cross-platform kill-by-pid for the no-handle (post-restart) path. Injectable for tests. */
  killPid?: (pid: number) => Promise<void>;
  /** Linux-only dedicated process-group signal. Injectable for tests. */
  killProcessGroup?: (processGroupId: number) => Promise<void>;
  /** Fresh host process snapshot used for Linux tree ownership. Injectable for tests. */
  readProcessSnapshot?: () => Promise<HostProcessSnapshot | null>;
  /** Poll interval after graceful/forced teardown. */
  teardownPollMs?: number;
  /** Maximum wait for exact CDP and process-tree disappearance. */
  teardownTimeoutMs?: number;
  /** Signal-0 process liveness check used to avoid forgetting a live-but-slow browser. Injectable for tests. */
  isPidAlive?: (pid: number) => boolean;
  /**
   * How long a current-process Windows session launch may remain on PID 0 while
   * the helper recovers Chromium's real PID. After this grace, an unreachable
   * PID-less launch is stale rather than permanently alive. Injectable for
   * deterministic tests.
   */
  pidRecoveryGraceMs?: number;
  /**
   * Find processes whose executable + exact debug-port + exact user-data-dir
   * argv identify this launch. null means the OS scan was unavailable/failed;
   * an empty array is an authoritative "none". Injectable for tests.
   */
  findOwnedBrowserPids?: OwnedBrowserProcessFinder;
  /**
   * Find every process holding a profile's persistent user-data dir, on ANY debug
   * port. null means the OS scan was unavailable; an empty array is an authoritative
   * "none". Injectable for tests. See reapForeignProfileDirHolders for why the
   * port-pinned findOwnedBrowserPids scan cannot answer this question.
   */
  findProfileDirHolderPids?: (userDataDir: string) => Promise<number[] | null>;
  /**
   * Graceful pre-stop: ask the browser to close over CDP so Chromium flushes its
   * cookie/session store to disk, then wait until the browser has actually exited.
   * Returns true once the CDP listener is confirmed gone. stop() separately
   * exact-scans the OS process identity before considering teardown complete.
   * Injectable for tests.
   */
  browserClose?: (ws: string, timeoutMs: number) => Promise<boolean>;
  /** Budget for the graceful close above before falling through to the force-kill. */
  gracefulStopMs?: number;
  /**
   * When true, reset the volatile per-profile stores (Local Storage / IndexedDB / …) after detecting
   * an UNCLEAN exit, so a store a crash left corrupt can't wedge the next launch with Chromium's
   * "Something went wrong opening your profile" dialog. Safe ONLY when the login is re-injected from
   * elsewhere (remote/hub mode) — off by default so standalone mode never discards local session state.
   */
  resetStorageOnUncleanExit?: boolean;
  /** Poll budget for the CDP /json/version endpoint after spawn. */
  cdpReadyTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface LaunchStartOptions {
  autoNavigate?: boolean;
  resetStorage?: boolean;
  /** Hub session version the browser is being opened from; persisted for safe survivor reattach. */
  sessionBaseVersion?: number;
}

export interface LaunchStartResult {
  ws: string;
  port: number;
}

const DEFAULT_DATA_ROOT = "profiles";
const DEFAULT_CDP_READY_TIMEOUT_MS = 180_000;
const DEFAULT_PID_RECOVERY_GRACE_MS = 30_000;
const SESSION_PID_RECOVERY_TIMEOUT_MS = 30_000;
const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 60_000;
const WINDOWS_TASKLIST_TIMEOUT_MS = 10_000;
const DARWIN_PROCESS_SCAN_TIMEOUT_MS = 10_000;
const FAILED_PROCESS_SCAN_BACKOFF_MS = 60_000;
const EXTERNAL_OWNERSHIP_PROOF_TTL_MS = 5 * 60_000;

type ProcessLiveness = "alive" | "dead" | "recovering" | "unknown";

interface LaunchLiveness {
  cdpAlive: boolean;
  cdpWs: string | null;
  pid: number;
  ownedPids: number[];
  process: ProcessLiveness;
}

interface VerifiedExternalLaunch {
  pid: number;
  debugPort: number;
  ws: string;
  verifiedAt: number;
}

export interface HostProcessRecord {
  pid: number;
  executablePath: string | null;
  /** Linux /proc ownership fields; absent on other platforms. */
  parentPid?: number;
  processGroupId?: number;
  startTime?: string;
  /** False only when executablePath was heuristically split from flattened argv. */
  executablePathExact?: boolean;
  commandLine?: string;
  argv?: string[];
}

export interface HostProcessSnapshot {
  records: HostProcessRecord[];
  incomplete: boolean;
}

type LinuxTerminationProof =
  | { kind: "group"; rootPid: number; rootStartTime: string }
  | { kind: "tree"; rootPid: number; rootStartTime: string; members: Array<{ pid: number; startTime: string; depth: number }> };

/** Parse image names from tasklist /FO CSV /NH output. Localized status text
 * has no quoted CSV first field and is ignored. */
export function parseTasklistImageNames(raw: string): Set<string> {
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim().match(/^"([^"]+)"/)?.[1];
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

/** Share only a currently-running snapshot read; settled results are never cached. */
export function createInFlightSnapshotReader<T>(read: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const current = Promise.resolve().then(read);
    inFlight = current;
    const clear = () => { if (inFlight === current) inFlight = null; };
    current.then(clear, clear);
    return current;
  };
}

/** Share live reads and briefly reuse only failed results so a sick process
 * service cannot be hammered by every dashboard poll. Successful snapshots
 * are never cached because a browser may start immediately afterward. */
export function createFailureBackoffReader<T>(
  read: () => Promise<T>,
  failed: (value: T) => boolean,
  backoffMs: number,
  nowMs: () => number = Date.now,
): () => Promise<T> {
  let lastFailure: { value: T; retryAt: number } | null = null;
  const sharedRead = createInFlightSnapshotReader(async () => {
    const value = await read();
    lastFailure = failed(value)
      ? { value, retryAt: nowMs() + Math.max(1, backoffMs) }
      : null;
    return value;
  });
  return () => {
    if (lastFailure && nowMs() < lastFailure.retryAt) {
      return Promise.resolve(lastFailure.value);
    }
    return sharedRead();
  };
}

/** Read a spawned snapshot helper with a hard timeout that kills the helper. */
export function readSnapshotChildBounded(
  child: { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
  timeoutMs: number,
): Promise<{ raw: string; exitCode: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { raw: string; exitCode: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, Math.max(1, timeoutMs));
    void Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]).then(
      ([raw, exitCode]) => finish({ raw, exitCode }),
      () => finish(null),
    );
  });
}

/**
 * Rebuildable caches safe to remove automatically after a browser has fully
 * stopped. Deliberately excludes CacheStorage: Chromium treats it as site
 * storage rather than ordinary disk cache, so it remains an explicit/manual
 * cleanup choice.
 */
const POST_STOP_CACHE_DIRS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/Service Worker/ScriptCache",
  "Default/DawnCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
];

/**
 * Cache subdirectories safe to delete on the explicit delete-cache endpoint.
 * Deliberately excludes everything that holds session/login state (Cookies,
 * Local Storage, Network, Preferences) — deleting those would log the account
 * out and defeat the persistent-session design the whole migration relies on.
 */
const CACHE_DIRS = [
  ...POST_STOP_CACHE_DIRS,
  "Default/Service Worker/CacheStorage",
];

/**
 * Volatile per-profile stores that commonly get left half-written by an UNCLEAN kill (all leveldb-
 * backed), after which Chromium pops "Something went wrong opening your profile. Some features may be
 * unavailable." on the next launch. In remote/hub mode the session is re-injected over CDP on open, so
 * these are disposable — clearStaleProfileState resets them after an unclean exit so Chromium
 * regenerates them clean and writeSession repopulates the login. Local Storage is included because it
 * holds Telegram's login, which writeSession re-injects from the hub bundle right after launch. Never
 * includes Local State (the cookie-encryption key), Preferences, or fingerprint state.
 */
const RESETTABLE_SESSION_STORES = [
  "Default/Local Storage",
  "Default/Session Storage",
  "Default/IndexedDB",
  "Default/Service Worker",
  "Default/Sessions",
  "Default/Current Session",
  "Default/Current Tabs",
  "Default/Last Session",
  "Default/Last Tabs",
];

export class Launcher {
  private store: ProfileStore;
  private binaryPath: string;
  private expectedBinarySha256: string;
  private unsafeDisableIdentityGates: boolean;
  private verifiedBinaryCache?: { key: string; path: string; sha256: string };
  private binaryVerificationInFlight?: {
    key: string;
    promise: Promise<{ key: string; path: string; sha256: string }>;
  };
  private dataRoot: string;
  private headless: boolean;
  private portRange: { start: number; end: number };
  private portProbeFn?: (port: number) => boolean;
  private baseArgs: string[];
  private windowWidthScale: number;
  private windowHeightScale: number;
  private spawnFn: SpawnFn;
  private fetchFn: FetchFn;
  private ensureCookiesFn: CookieEnsurer;
  private ensureSearchProviderFn?: SearchProviderEnsurer;
  private navigateFn: LaunchNavigator;
  private enforceHostCompatibility: boolean;
  private hostPlatform: NodeJS.Platform;
  private hostArch: string;
  private labelWindowFn: WindowLabeler;
  private skipDefaultWindowLabel: boolean;
  private killPidFn: (pid: number) => Promise<void>;
  private killProcessGroupFn: (processGroupId: number) => Promise<void>;
  private readProcessSnapshotFn?: () => Promise<HostProcessSnapshot | null>;
  private teardownPollMs: number;
  private teardownTimeoutMs: number;
  private isPidAliveFn: (pid: number) => boolean;
  private pidRecoveryGraceMs: number;
  private findOwnedBrowserPidsFn: OwnedBrowserProcessFinder;
  private skipDefaultOwnedBrowserScan: boolean;
  private findProfileDirHolderPidsFn: (userDataDir: string) => Promise<number[] | null>;
  private skipDefaultProfileDirHolderScan: boolean;
  private browserCloseFn: (ws: string, timeoutMs: number) => Promise<boolean>;
  private gracefulStopMs: number;
  private cdpReadyTimeoutMs: number;
  private resetStorageOnUncleanExit: boolean;
  private log: (msg: string) => void;

  /** Live process handles keyed by profileId, for authoritative in-process kills. */
  private procs = new Map<string, SpawnedProcess>();
  /**
   * Exact-verified survivors from an earlier manager process. This turns their
   * steady-state active() probe back into cheap CDP + signal-0 checks; without
   * it Telegram's 3s checkpoint would launch a PowerShell CIM scan every tick.
   */
  private verifiedExternal = new Map<string, VerifiedExternalLaunch>();
  private relays = new Map<string, ProxyRelay>(); // auth-injecting proxy relay per running authed-proxy profile
  /** Proxied browser websocket generations verified by this manager process. */
  /** Full profile + launch generations certified by this manager process. */
  private certifiedLaunches = new Map<string, string>();
  private certificationsInFlight = new Map<string, Promise<boolean>>();
  /** Ports currently handed out, so the allocator never reuses a live one. */
  private liveReserved = new Set<number>();
  /**
   * In-flight start() per profile. Two concurrent browser/start calls for the
   * same profile must not both spawn — a second process on the same persistent
   * user-data dir corrupts profile state. The launch row isn't written until
   * after CDP/cookie seeding, so this promise is the only thing that catches an
   * overlap during that window.
   */
  private startsInFlight = new Map<string, Promise<LaunchStartResult>>();
  /**
   * In-flight stop() per profile. start() waits for this promise before it
   * inspects or creates a launch, and overlapping stops share it. Together with
   * startsInFlight this serializes every destructive lifecycle transition for
   * one persistent user-data dir: an older stop can never finish by clearing a
   * replacement launch that started while its process scan was still pending.
   */
  private stopsInFlight = new Map<string, Promise<boolean>>();
  /** Stop barrier, if any, that the current queued start belongs after. */
  private startAfterStop = new Map<string, Promise<boolean>>();

  constructor(opts: LauncherOptions) {
    this.store = opts.store;
    this.binaryPath = opts.binaryPath ?? defaultBinaryPath();
    this.unsafeDisableIdentityGates = opts.unsafeDisableIdentityGates ?? false;
    this.expectedBinarySha256 = (
      opts.expectedBinarySha256
      ?? process.env.CLOAKBROWSER_BINARY_SHA256
      ?? ""
    ).trim().toLowerCase();
    this.dataRoot = opts.dataRoot ?? DEFAULT_DATA_ROOT;
    this.headless = opts.headless ?? false;
    this.portRange = opts.portRange ?? { start: 9333, end: 9999 };
    this.portProbeFn = opts.portProbe;
    this.baseArgs = opts.baseArgs ?? [];
    // Clamp to a sane range so a stray config can't produce a 0-size or oversized window.
    this.windowWidthScale = Math.min(1.0, Math.max(0.2, opts.windowWidthScale ?? 0.65));
    this.windowHeightScale = Math.min(1.0, Math.max(0.2, opts.windowHeightScale ?? 0.9));
    // Wrapped in an arrow so the helper's diagnostics reach THIS launcher's log
    // (this.log is assigned below; the call happens long after construction).
    this.spawnFn = opts.spawn
      ?? (SESSION_LAUNCH ? (binary, args) => sessionLaunchSpawn(binary, args, (m) => this.log(m)) : defaultSpawn);
    // Bound the real CDP probe: this fetch backs active() and waitForCdp(), both hitting the
    // local 127.0.0.1 debug port. A wedged/half-open port would otherwise let a bare fetch() hang
    // on the OS connect timeout (tens of seconds), stalling stop() — which the Python side waits on
    // (up to 120s) — and eating a concurrent-reconnect slot. 800ms is generous for a local endpoint;
    // both callers treat a rejection as "not ready" (active→false, waitForCdp→keep polling).
    this.fetchFn = opts.fetch ?? ((url) => fetch(url, { signal: AbortSignal.timeout(800) }) as any);
    this.ensureCookiesFn = opts.ensureCookies ?? defaultEnsureCookies;
    this.ensureSearchProviderFn = opts.ensureSearchProvider;
    this.navigateFn = opts.navigate ?? defaultNavigate;
    // Test spawners do not implicitly weaken production policy. Every disabled
    // identity gate must be requested through the conspicuous unsafe option.
    this.enforceHostCompatibility = opts.enforceHostCompatibility ?? !this.unsafeDisableIdentityGates;
    this.hostPlatform = opts.hostPlatform ?? process.platform;
    this.hostArch = opts.hostArch ?? process.arch;
    this.labelWindowFn = opts.labelWindow ?? defaultLabelWindow;
    this.skipDefaultWindowLabel = this.unsafeDisableIdentityGates && opts.labelWindow === undefined;
    this.killPidFn = opts.killPid ?? killByPid;
    this.killProcessGroupFn = opts.killProcessGroup ?? killProcessGroup;
    this.readProcessSnapshotFn = opts.readProcessSnapshot
      ?? (opts.findOwnedBrowserPids ? undefined : readHostProcessSnapshot);
    this.teardownPollMs = Math.max(1, opts.teardownPollMs ?? 100);
    this.teardownTimeoutMs = Math.max(0, opts.teardownTimeoutMs ?? 4000);
    this.isPidAliveFn = opts.isPidAlive ?? isPidAlive;
    this.pidRecoveryGraceMs = Math.max(0, opts.pidRecoveryGraceMs ?? DEFAULT_PID_RECOVERY_GRACE_MS);
    this.findOwnedBrowserPidsFn = opts.findOwnedBrowserPids ?? findOwnedBrowserPids;
    this.skipDefaultOwnedBrowserScan = this.unsafeDisableIdentityGates
      && opts.findOwnedBrowserPids === undefined;
    this.findProfileDirHolderPidsFn = opts.findProfileDirHolderPids ?? findProfileDirHolderPids;
    this.skipDefaultProfileDirHolderScan = this.unsafeDisableIdentityGates
      && opts.findProfileDirHolderPids === undefined;
    this.browserCloseFn = opts.browserClose ?? defaultBrowserClose;
    this.gracefulStopMs = opts.gracefulStopMs ?? 4000;
    this.cdpReadyTimeoutMs = opts.cdpReadyTimeoutMs ?? DEFAULT_CDP_READY_TIMEOUT_MS;
    this.resetStorageOnUncleanExit = opts.resetStorageOnUncleanExit ?? false;
    this.log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  }

  /**
   * ABSOLUTE persistent user-data dir for a profile. Must be absolute: it's passed verbatim as Chromium's
   * `--user-data-dir`, and a relative path there is resolved against the BROWSER process's working
   * directory — which, under the Windows session launcher, is the CloakBrowser binary folder, not
   * aliasmode's. A relative dataRoot ("profiles") therefore made every profile write a second copy of its
   * data into `.cloakbrowser\chromium-*\profiles\<id>` (ballooning that folder to 100s of GB) while
   * aliasmode's own repair/cache-clear operated on the empty `aliasmode\profiles\<id>`. Resolving here
   * pins both sides to the same real directory.
   */
  userDataDir(profileId: string): string {
    assertSafeProfileId(profileId);
    const root = resolve(this.dataRoot);
    const dir = resolve(join(root, profileId));
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (dir === root || !dir.startsWith(prefix)) {
      throw new Error(`profile user-data directory escapes configured root for id ${JSON.stringify(profileId)}`);
    }
    return dir;
  }

  /** Validate the deployment pin without reading the configured binary. */
  private approvedBinarySha256(): string {
    if (this.unsafeDisableIdentityGates) {
      return /^[a-f0-9]{64}$/.test(this.expectedBinarySha256)
        ? this.expectedBinarySha256
        : "0".repeat(64);
    }
    if (!/^[a-f0-9]{64}$/.test(this.expectedBinarySha256)) {
      throw new Error(
        "approved CloakBrowser kernel hash is not configured; set " +
        "CLOAKBROWSER_BINARY_SHA256 to the 64-character SHA-256 of the deployed binary",
      );
    }
    return this.expectedBinarySha256;
  }

  /** Hash and canonicalize the exact executable before every fresh generation. */
  private async verifyConfiguredBinary(forceHash = false): Promise<{ path: string; sha256: string }> {
    const expected = this.approvedBinarySha256();
    if (this.unsafeDisableIdentityGates) return { path: this.binaryPath, sha256: expected };
    if (!this.binaryPath) {
      throw new Error(
        "CloakBrowser binary path not set. Set CLOAKBROWSER_BINARY_PATH or pass binaryPath.",
      );
    }

    let path: string;
    let stat: ReturnType<typeof statSync>;
    try {
      path = realpathSync(this.binaryPath);
      stat = statSync(path);
    } catch (error) {
      throw new Error(
        `approved CloakBrowser binary cannot be read at ${JSON.stringify(this.binaryPath)}: ` +
        (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!stat.isFile()) throw new Error(`CloakBrowser binary is not a regular file: ${path}`);

    const key = [path, stat.dev, stat.ino, stat.size, stat.mtimeMs].join(":");
    if (!forceHash && this.verifiedBinaryCache?.key === key) return this.verifiedBinaryCache;
    if (!forceHash && this.binaryVerificationInFlight?.key === key) return this.binaryVerificationInFlight.promise;

    let promise!: Promise<{ key: string; path: string; sha256: string }>;
    promise = sha256File(path)
      .then((actual) => {
        // Detect an updater replacing the executable while it is being read.
        // The forced pre-spawn pass below also closes the longer preflight
        // window between the initial approval check and process creation.
        let finalPath: string;
        let finalStat: ReturnType<typeof statSync>;
        try {
          finalPath = realpathSync(this.binaryPath);
          finalStat = statSync(path);
        } catch (error) {
          throw new Error(
            `approved CloakBrowser binary changed while it was being verified: ` +
            (error instanceof Error ? error.message : String(error)),
          );
        }
        const finalKey = [finalPath, finalStat.dev, finalStat.ino, finalStat.size, finalStat.mtimeMs].join(":");
        if (finalPath !== path || finalKey !== key || !finalStat.isFile()) {
          throw new Error("approved CloakBrowser binary changed while it was being verified; refusing to launch");
        }
        if (actual !== expected) {
          throw new Error(
            `CloakBrowser kernel hash mismatch for ${path}: expected ${expected}, measured ${actual}; refusing to launch`,
          );
        }
        const verified = { key, path, sha256: actual };
        this.verifiedBinaryCache = verified;
        return verified;
      })
      .finally(() => {
        if (this.binaryVerificationInFlight?.promise === promise) this.binaryVerificationInFlight = undefined;
      });
    if (!forceHash) this.binaryVerificationInFlight = { key, promise };
    return promise;
  }

  /**
   * Durable, secret-safe revision of every input that determines the browser
   * persona. Proxy credentials are covered by the hash but never persisted.
   */
  private launchPersonaDigest(profile: Profile, binarySha256: string): string {
    const extensions = (profile.extensions ?? []).map((id) => ({
      id,
      loadDir: this.store.getExtension(id)?.loadDir ?? null,
    }));
    const serialized = JSON.stringify({
      schema: 1,
      binarySha256,
      host: [this.hostPlatform, this.hostArch],
      headless: this.headless,
      windowScale: [this.windowWidthScale, this.windowHeightScale],
      ua: profile.ua,
      platform: profile.platform,
      proxy: profile.proxy,
      ...(profile.proxy ? { proxyWebRtcPolicy: "disable_non_proxied_udp" } : {}),
      timezone: profile.timezone,
      screen: [profile.screenWidth, profile.screenHeight],
      fingerprintSeed: profile.fingerprintSeed,
      extensions,
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  /** A survivor is reusable only with its exact launch-time kernel and persona. */
  private assertStoredLaunchPersona(profile: Profile, launch: LaunchInfo, approvedSha256: string): void {
    if (!launch.binaryPath || !launch.userDataDir) {
      throw new Error("legacy launch is missing its executable or user-data identity");
    }
    if (!launch.binarySha256 || launch.binarySha256 !== approvedSha256) {
      throw new Error(
        `live browser kernel revision ${launch.binarySha256 || "<unrecorded>"} ` +
        `does not match approved revision ${approvedSha256}`,
      );
    }
    const expectedPersona = this.launchPersonaDigest(profile, approvedSha256);
    if (!launch.personaDigest || launch.personaDigest !== expectedPersona) {
      throw new Error("live browser persona or launch mode differs from the current approved profile revision");
    }
  }

  private assertHostCompatibility(profile: Profile): void {
    if (!this.enforceHostCompatibility) return;
    if (isMobileUserAgent(profile.ua)) {
      throw new Error(
        "unsupported mobile persona: AliasMode launches a desktop browser and cannot coherently emulate mobile touch, model, sensors, codecs, or APIs",
      );
    }
    // Cross-OS desktop spoofing is supported: CloakBrowser applies the persona's
    // platform/brand via --fingerprint-* flags regardless of the host OS (the
    // same way AdsPower/Multilogin run a Windows persona on a Mac), so the host
    // OS/arch is no longer pinned to the persona. We still require a recognized
    // DESKTOP persona — a desktop browser cannot coherently emulate a mobile one.
    if (profile.ua.trim() && !platformFromUA(profile.ua)) {
      throw new Error("unsupported imported user agent: no recognized desktop platform");
    }
  }

  /**
   * Build the full CloakBrowser argv for a launch. Identity flags come from
   * the stored profile; `port`/`userDataDir` are per-launch session detail;
   * `launchArgs` are the ephemeral chrome flags automation passes through.
   */
  buildArgs(
    profile: Profile,
    port: number,
    userDataDir: string,
    launchArgs: string[],
    relayPort?: number,
  ): string[] {
    const { chromeArgs } = splitLaunchUrls(launchArgs);
    const forwardedArgs = validateForwardedLaunchArgs(chromeArgs);
    // Open the window at a FRACTION of the profile's resolution (default: 65% width,
    // 90% height → a tall, narrow window so the operator can line several profiles up
    // side by side instead of each browser filling the display. This is only the OS
    // window size — the spoofed screen.width/height come from --fingerprint-screen-*
    // above, so it doesn't change the fingerprint (it just looks like a normal
    // non-maximized window, which real users have). The WIDTH floor (800) stops a profile
    // that drew a small seed resolution (e.g. 1366 -> 683px) from opening as an unusable sliver.
    const winW = Math.max(800, Math.round(profile.screenWidth * this.windowWidthScale));
    const winH = Math.max(480, Math.round(profile.screenHeight * this.windowHeightScale));
    const args = [
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=127.0.0.1`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${winW},${winH}`,
      `--window-position=0,0`,
      // The session launcher opens the window MINIMIZED (/MIN) so it doesn't steal focus, and a
      // minimized/occluded Chromium window is treated as backgrounded — it throttles JS timers and
      // deprioritizes the renderer. That makes the CDP-driven login crawl and blow the 180s reconnect
      // timeout (the operator saw browsers "only work when clicked" — focusing them un-throttles).
      // These keep an unfocused window at full speed; they touch only internal scheduling, not any
      // JS-visible surface, so the fingerprint is unchanged.
      `--disable-background-mode`,
      `--disable-background-timer-throttling`,
      `--disable-backgrounding-occluded-windows`,
      `--disable-renderer-backgrounding`,
      ...deriveFingerprintFlags(profile),
    ];
    if (profile.proxy) {
      args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    }
    // We launch the raw stealth chromium binary, which behaves like stock
    // Chromium: the PRESENCE of --headless (any value, even "false") turns
    // headless ON. So headful = omit the flag entirely; headless = pass it.
    // Headful matches AdsPower (real windows) and avoids the headless signal.
    if (this.headless) args.push("--headless=new");
    // Relayed proxies use a loopback HTTP endpoint. Everything else uses the
    // upstream proxy flag directly.
    if (relayPort) args.push(`--proxy-server=http://127.0.0.1:${relayPort}`);
    else {
      const proxy = proxyServerFlag(profile);
      if (proxy) args.push(proxy);
    }
    // Load any assigned (unpacked) extensions. Resolve ids → install dirs and
    // skip any that were since deleted. --disable-extensions-except keeps the
    // set to exactly what's assigned. (Proxy auth no longer needs an extension — the relay does it.)
    const extDirs = (profile.extensions ?? [])
      .map((id) => this.store.getExtension(id)?.loadDir)
      .filter((d): d is string => !!d);
    if (extDirs.length) {
      args.push(`--load-extension=${extDirs.join(",")}`);
      args.push(`--disable-extensions-except=${extDirs.join(",")}`);
    }
    // OWNERSHIP MARKERS ARE LOAD-BEARING: AliasMode contributes its distinct
    // --aliasmode-launcher-pid through baseArgs, while an automation client may
    // contribute --automation-launcher-pid through chromeArgs. Never collapse the
    // two namespaces: Automation must be able to reap its abandoned browser after
    // it crashes even when this long-running manager remains alive. Keep base
    // args before caller-supplied ephemeral args as the general override order.
    args.push(...this.baseArgs, ...forwardedArgs);
    return args;
  }

  async navigate(ws: string, urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    await this.navigateFn(ws, urls);
  }

  private identityCertificationKey(profileId: string): string | null {
    const profile = this.store.getProfile(profileId);
    const launch = this.store.getLaunch(profileId);
    if (!profile || !launch) return null;
    return JSON.stringify([
      profile.ua,
      profile.proxy,
      profile.proxyError ?? null,
      profile.timezone,
      profile.platform,
      profile.extensions,
      profile.screenWidth,
      profile.screenHeight,
      profile.fingerprintSeed,
      launch.debugPort,
      launch.ws,
      launch.startedAt,
      launch.binaryPath,
      launch.userDataDir,
      launch.binarySha256,
      launch.personaDigest,
    ]);
  }

  private markIdentityCertified(profileId: string): void {
    const key = this.identityCertificationKey(profileId);
    if (key) this.certifiedLaunches.set(profileId, key);
  }

  private isIdentityCertified(profileId: string): boolean {
    const key = this.identityCertificationKey(profileId);
    return !!key && this.certifiedLaunches.get(profileId) === key;
  }

  private clearIdentityCertification(profileId: string): void {
    this.certifiedLaunches.delete(profileId);
  }

  private requireUnchangedProfile(profileId: string, snapshot: string, stage: string): Profile {
    const current = this.store.getProfile(profileId);
    if (!current) throw new Error(`profile ${profileId} was deleted during ${stage}; launch aborted`);
    if (JSON.stringify(current) !== snapshot) {
      throw new Error(`profile ${profileId} changed during ${stage}; launch aborted—retry with the current identity`);
    }
    return current;
  }

  /**
   * Kill any process still holding this profile's persistent user-data dir before a
   * FRESH spawn. Reaching the fresh-launch path means aliasmode already established that
   * no launch it tracks owns this profile, so such a process is a leak from an earlier
   * run (a crashed manager, a force-killed reconnect, an automation run that died mid-login).
   *
   * Leaving it is FATAL and silent on Windows: Chromium's process singleton there is a
   * message window keyed on the user-data dir — not the POSIX SingletonLock file
   * clearStaleProfileState deletes — so a second launch on the same dir hands its command
   * line to the LIVE instance and exits immediately. Nothing ever listens on the new debug
   * port, and the launch dies as an unexplained "CDP endpoint not ready within 60000ms".
   *
   * findOwnedBrowserPids cannot catch these: it matches the RECORDED debug port as well as
   * the dir, so a leaked browser from an earlier port never matches it.
   */
  private async reapForeignProfileDirHolders(profileId: string, userDataDir: string): Promise<void> {
    if (this.skipDefaultProfileDirHolderScan) return;
    const scan = async (): Promise<number[]> => {
      let holders: number[] | null;
      try {
        holders = await this.findProfileDirHolderPidsFn(userDataDir);
      } catch {
        throw new Error(`profile ${profileId}: profile directory holder scan failed; launch aborted`);
      }
      if (holders === null) {
        throw new Error(`profile ${profileId}: profile directory holder scan was inconclusive; launch aborted`);
      }
      return holders;
    };

    const holders = await scan();
    if (holders.length === 0) return;
    this.log(
      `profile ${profileId}: ${holders.length} leaked process(es) still hold ${userDataDir} ` +
      `(pids ${holders.join(", ")}); reaping before launch so the new browser cannot hand off to them`,
    );
    for (const pid of holders) {
      try {
        await this.killPidFn(pid);
      } catch (err) {
        this.log(`profile ${profileId}: could not reap leaked pid ${pid} (${err instanceof Error ? err.message : err})`);
      }
    }

    const deadline = Date.now() + this.teardownTimeoutMs;
    while (true) {
      const remaining = await scan();
      if (remaining.length === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(`profile ${profileId}: profile directory is still held after cleanup; launch aborted`);
      }
      await Bun.sleep(this.teardownPollMs);
    }
  }

  private async rejectUnsafeExistingLaunch(profileId: string, stage: string, error: unknown): Promise<never> {
    const detail = error instanceof Error ? error.message : String(error);
    if (!this.store.getLaunch(profileId) && !this.procs.has(profileId)) throw error;
    this.clearIdentityCertification(profileId);
    const stopped = await this.doStop(profileId);
    if (error instanceof BrowserLaunchError || error instanceof SessionRestoreError) throw error;
    if (stopped) {
      throw new Error(`${detail}; unsafe existing browser was stopped during ${stage} and process/CDP death was confirmed`);
    }
    throw new Error(`${detail}; unsafe existing browser could not be confirmed stopped during ${stage}; launch ownership was retained`);
  }

  /**
   * Start (or return the already-running) browser for `profileId`.
   * Returns the CDP ws endpoint and debug port, AdsPower-style.
   *
   * Concurrent calls for the same profile coalesce onto one launch — see
   * `startsInFlight` — so an overlap can never spawn two browsers on the same
   * persistent user-data dir.
   */
  async start(
    profileId: string,
    launchArgs: string[] = [],
    opts: LaunchStartOptions = {},
  ): Promise<LaunchStartResult> {
    const stopping = this.stopsInFlight.get(profileId);
    const inFlight = this.startsInFlight.get(profileId);
    // Coalesce only starts in the same lifecycle generation. If the existing
    // start predates a stop, this call is the replacement queued after it.
    if (inFlight && (!stopping || this.startAfterStop.get(profileId) === stopping)) return inFlight;
    // Capture the predecessor before installing this start. The body is deferred
    // until after the map entry exists so even a synchronously-reentrant injected
    // fetch/spawn cannot start a duplicate. Capturing also avoids a wait cycle:
    // only the later transition waits for the one that was already registered.
    let promise!: Promise<LaunchStartResult>;
    promise = Promise.resolve()
      .then(async () => {
        if (stopping) {
          this.log(`start ${profileId}: waiting for in-flight stop to settle`);
          await stopping;
        }
        return await this.doStart(profileId, launchArgs, opts);
      })
      .catch((error) => {
        if (error instanceof BrowserLaunchError || error instanceof SessionRestoreError) throw error;
        throw new BrowserLaunchError("preflight");
      })
      .finally(() => {
        if (this.startsInFlight.get(profileId) === promise) {
          this.startsInFlight.delete(profileId);
        }
        if (this.startAfterStop.get(profileId) === stopping) this.startAfterStop.delete(profileId);
      });
    this.startsInFlight.set(profileId, promise);
    if (stopping) this.startAfterStop.set(profileId, stopping);
    else this.startAfterStop.delete(profileId);
    return promise;
  }

  private async doStart(
    profileId: string,
    launchArgs: string[],
    opts: LaunchStartOptions = {},
  ): Promise<LaunchStartResult> {
    const { chromeArgs, startupUrls } = splitLaunchUrls(launchArgs);
    // Reject unsafe ids and switches before touching the profile directory or
    // opening a proxy connection.
    assertSafeProfileId(profileId);
    validateForwardedLaunchArgs(chromeArgs);
    let profile = this.store.getProfile(profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    if (profile.proxyError) {
      throw new Error(`profile ${profileId} has a quarantined legacy proxy: ${profile.proxyError}; edit or clear the proxy before launch`);
    }
    let profileSnapshot = JSON.stringify(profile);
    let approvedBinarySha256: string;
    try {
      if (profile.proxy?.type === "https" && profile.proxy.user) {
        throw new Error(
          "authenticated HTTPS proxies are not supported: the credential relay cannot preserve TLS to the upstream; " +
          "use authenticated HTTP or SOCKS5",
        );
      }
      this.assertHostCompatibility(profile);
      approvedBinarySha256 = this.approvedBinarySha256();
    } catch (error) {
      return await this.rejectUnsafeExistingLaunch(profileId, "host/persona verification", error);
    }

    // Idempotent when CDP is healthy. If Chromium is still alive but CDP is
    // unavailable, fail AdsPower-style instead of returning a websocket we
    // already know cannot be used. Automation' established response to a nonzero
    // start is stop + one retry; stop() can now reap that process by its PID,
    // which recovers this run without ever double-launching the profile.
    let existing = this.store.getLaunch(profileId);
    if (existing) {
      try {
        this.assertStoredLaunchPersona(profile, existing, approvedBinarySha256);
      } catch (error) {
        return await this.rejectUnsafeExistingLaunch(profileId, "launch-time persona verification", error);
      }
      const trackedProc = this.procs.get(profileId);
      const liveness = await this.inspectLaunchLiveness(profileId, existing, trackedProc, true);
      if (liveness.cdpAlive) {
        // A responding port alone is never ownership proof, including for a
        // retained in-memory handle whose PID may have died and been recycled.
        if (liveness.process === "dead") {
          if (!await this.confirmPersistedLaunchStopped(profileId, existing)) {
            this.liveReserved.add(existing.debugPort);
            throw new Error(`profile ${profileId} exact Linux tree disappearance is unproven; stop and retry`);
          }
          this.log(`profile ${profileId} CDP port is occupied but no owned browser process matches; launching fresh`);
          if (!this.forgetLaunch(profileId, existing)) {
            throw new Error(`profile ${profileId} launch changed while stale ownership was being cleared; retry`);
          }
          existing = null;
        } else if (liveness.process !== "alive") {
          this.liveReserved.add(existing.debugPort);
          const message = `profile ${profileId} CDP responds on port ${existing.debugPort} but browser ownership is inconclusive; stop and retry`;
          this.log(`${message} (kept the tracked launch)`);
          throw new Error(message);
        }
        if (!existing) {
          // Exact scan proved the recorded launch is gone; continue to a fresh
          // allocation (the unrelated responding port remains OS-reserved).
        } else {
          const currentWs = liveness.cdpWs!;
          profile = this.requireUnchangedProfile(profileId, profileSnapshot, "live-browser CDP reattach");
          if (trackedProc) this.verifiedExternal.delete(profileId);
          else this.verifiedExternal.set(profileId, {
            pid: liveness.pid,
            debugPort: existing.debugPort,
            ws: currentWs,
            verifiedAt: Date.now(),
          });
          if (existing.ws !== currentWs) {
            this.log(`profile ${profileId} CDP websocket changed on port ${existing.debugPort}; refreshing the stored endpoint`);
            existing = { ...existing, ws: currentWs };
            this.store.recordLaunch(existing);
          }
          // Remote restore uses a sentinel base to mark this survivor
          // provisional. Persist it before any later await or successful return
          // so a manager crash cannot leave an old lineage looking current.
          if (
            opts.sessionBaseVersion !== undefined
            && existing.sessionBaseVersion !== opts.sessionBaseVersion
          ) {
            existing = { ...existing, sessionBaseVersion: opts.sessionBaseVersion };
            this.store.recordLaunch(existing);
          }
          // A browser surviving a manager restart lost its in-memory relay;
          // rebind it on the recorded port so the running browser's
          // --proxy-server keeps working. The browser was verified at its
          // original launch; relay restoration is pure loopback setup.
          if (!this.isIdentityCertified(profileId)) {
            try {
              await this.ensureSurvivorRelay(profile, existing);
              this.requireUnchangedProfile(profileId, profileSnapshot, "live-browser relay restoration");
              this.markIdentityCertified(profileId);
            } catch (error) {
              return await this.rejectUnsafeExistingLaunch(profileId, "live-browser relay restoration", error);
            }
          }
          this.log(
            trackedProc
              ? `profile ${profileId} already running on port ${existing.debugPort}`
              : `profile ${profileId} already running on port ${existing.debugPort} (reattached after restart)`,
          );
          this.liveReserved.add(existing.debugPort);
          return {
            ws: currentWs,
            port: existing.debugPort,
          };
        }
      }
      if (existing && liveness.process !== "dead") {
        this.liveReserved.add(existing.debugPort);
        const processDetail = liveness.process === "alive"
          ? `owned process ${liveness.pid} is alive`
          : liveness.process === "recovering"
            ? "browser PID is still being recovered"
            : "browser process ownership scan is inconclusive";
        const message = `profile ${profileId} ${processDetail} but CDP is not responding on port ${existing.debugPort}; stop and retry`;
        this.log(`${message} (kept the tracked launch)`);
        throw new Error(message);
      }
      // CDP is unreachable and an exact executable/port/user-data-dir process
      // scan found no owner. Only this authoritative "none" permits reuse.
      if (existing) {
        if (!await this.confirmPersistedLaunchStopped(profileId, existing)) {
          this.liveReserved.add(existing.debugPort);
          throw new Error(`profile ${profileId} exact Linux tree disappearance is unproven; stop and retry`);
        }
        this.log(`profile ${profileId} has no owned browser process; launching fresh`);
        if (!this.forgetLaunch(profileId, existing)) {
          throw new Error(`profile ${profileId} launch changed while stale ownership was being cleared; retry`);
        }
        existing = null;
      }
    }

    // A fresh generation is never spawned until the configured executable has
    // been canonicalized and matched byte-for-byte against the deployment pin.
    const verifiedBinary = await this.verifyConfiguredBinary();
    const launchBinaryPath = verifiedBinary.path;

    const userDataDir = this.userDataDir(profileId);
    const personaDigest = this.launchPersonaDigest(profile, verifiedBinary.sha256);
    mkdirSync(userDataDir, { recursive: true });

    // Reap leaked browsers still holding this dir BEFORE the repair/clear steps below
    // touch its files or a second Chromium is spawned onto it.
    await this.reapForeignProfileDirHolders(profileId, userDataDir);

    // Repair a corrupt Preferences before launch. A previous unclean exit (force-kill
    // mid-write, or two Chromes racing the same persistent dir when a browser leaked)
    // can leave Default/Preferences unparseable — Chromium then pops a modal "Your
    // preferences can not be read" dialog that BLOCKS the page, so automation login hangs
    // and the rotated session never saves. Deleting only the corrupt prefs lets Chromium
    // regenerate defaults; the login session is untouched (cookies live in
    // Default/Network/Cookies, the cookie-encryption key in the root Local State).
    this.repairCorruptPrefs(profileId);

    // …and clear the OTHER leftovers an unclean exit leaves behind, which repairCorruptPrefs
    // doesn't cover: a stale Singleton lock (the next Chrome stalls trying to hand off to the
    // dead singleton — the same SingletonLock hazard killByPid guards against) and a "Crashed"
    // exit marker (valid JSON, so repairCorruptPrefs keeps it, but it surfaces a session-restore
    // prompt over the automated page). Without this, a profile whose browser was force-killed on
    // a hung reconnect comes up WEDGED every launch, so every reconnect on it hangs — which then
    // force-kills it again: a self-perpetuating loop. Only runs on the fresh-launch path, where
    // aliasmode has already established no live browser holds this profile, so these ARE leftovers.
    // resetStorage gates the crash-corruption storage reset for THIS launch (default true for direct
    // callers; remote mode passes false when the bundle it's about to inject can't restore the login —
    // e.g. a first-migration Telegram open with no hub session — so we never wipe the only local auth).
    this.clearStaleProfileState(profileId, opts.resetStorage ?? true);
    if (profile.proxy) this.persistWebRtcPolicyPreference(profileId);

    // Identity bookmark (#2): `<name> · #<serial>` on a visible bookmark bar, pointing at the card.
    if (SESSION_LAUNCH) {
      writeIdentityBookmark(userDataDir, `${profile.name || "profile"} · #${this.store.getSerial(profileId) ?? "?"}`, profileCardUrl(profileId));
    }

    const port = allocatePort({
      ...this.portRange,
      inUse: this.liveReserved,
      ...(this.portProbeFn ? { probe: this.portProbeFn } : {}),
    });
    this.liveReserved.add(port);

    let proc: SpawnedProcess | undefined;
    let spawnAttempted = false;
    let relayPort: number | undefined;
    let launchStartedAt = Date.now();
    try {
      // Bring up the loopback HTTP/auth-or-SOCKS bridge before launch. Started
      // here (inside the try) so a later failure rolls it back too.
      if (needsProxyRelay(profile)) {
        const p = profile.proxy!;
        let relay: ProxyRelay;
        try {
          relay = await startProxyRelay(
            {
              type: p.type === "socks5" ? "socks5" : "http",
              host: p.host,
              port: Number(p.port),
              user: p.user,
              pass: p.pass,
            },
            {},
          );
        } catch {
          throw new BrowserLaunchError("relay_setup");
        }
        // Defensive cleanup for a stale in-memory relay whose launch row was
        // removed before this fresh start. Never overwrite the only reference to
        // a listening server/socket set.
        this.closeRelay(profileId);
        this.relays.set(profileId, relay);
        relayPort = relay.port;
        this.log(`proxy relay ready for ${profileId}`);
        profile = this.requireUnchangedProfile(profileId, profileSnapshot, "proxy relay startup");
      }
      const args = this.buildArgs(profile, port, userDataDir, chromeArgs, relayPort);
      this.log(`launching ${profileId} on port ${port} (seed ${profile.fingerprintSeed})`);
      launchStartedAt = Date.now();
      this.verifiedExternal.delete(profileId);
      this.clearIdentityCertification(profileId);
      profile = this.requireUnchangedProfile(profileId, profileSnapshot, "browser spawn");
      // Relay setup is asynchronous. Re-read and re-hash immediately before
      // the durable reservation and synchronous spawn so an atomic package/update
      // replacement cannot inherit the approval measured at launch start.
      const spawnVerifiedBinary = await this.verifyConfiguredBinary(true);
      this.log(`${profileId}: launch stage binary verified`);
      profile = this.requireUnchangedProfile(profileId, profileSnapshot, "final browser binary verification");
      if (
        spawnVerifiedBinary.path !== launchBinaryPath
        || spawnVerifiedBinary.sha256 !== verifiedBinary.sha256
      ) {
        throw new Error("approved CloakBrowser binary changed during launch preparation; refusing to spawn");
      }
      // Reserve durable ownership before invoking the spawner. If the manager
      // hard-crashes after process creation but before spawn() returns, startup
      // reconciliation can still exact-scan this port/path tuple and recover
      // the browser instead of launching a duplicate beside it.
      const provisionalLaunch: LaunchInfo = {
        profileId,
        pid: 0,
        debugPort: port,
        ws: "",
        startedAt: launchStartedAt,
        relayPort,
        sessionBaseVersion: opts.sessionBaseVersion,
        binaryPath: spawnVerifiedBinary.path,
        userDataDir,
        binarySha256: spawnVerifiedBinary.sha256,
        personaDigest,
      };
      this.store.recordLaunch(provisionalLaunch);
      spawnAttempted = true;
      try {
        proc = this.spawnFn(spawnVerifiedBinary.path, args);
      } catch {
        throw new BrowserLaunchError("process_spawn");
      }
      this.procs.set(profileId, proc);
      this.log(`${profileId}: launch stage browser spawned`);
      this.store.recordLaunch({
        ...provisionalLaunch,
        pid: proc.pid,
        processGroupId: proc.processGroupId,
        rootStartTime: proc.rootStartTime,
      });

      const ws = await this.waitForCdp(port, proc);
      this.log(`${profileId}: launch stage CDP ready`);
      profile = this.requireUnchangedProfile(profileId, profileSnapshot, "browser startup");

      // Fresh ungoogled Chromium profiles can default to "No Search", which
      // treats address-bar phrases as hostnames (https://<phrase>). Configure
      // a real provider before navigation, but never make search setup capable
      // of failing an otherwise healthy account launch.
      if (this.ensureSearchProviderFn) {
        try {
          const result = await this.ensureSearchProviderFn(ws);
          if (result.status === "configured") {
            this.log(`${profileId}: configured ${result.engine} as the address-bar search provider`);
          } else if (result.status === "already-default") {
            this.log(`${profileId}: ${result.engine} is already the address-bar search provider`);
          } else {
            this.log(`${profileId}: kept existing address-bar search provider ${result.engine}`);
          }
        } catch (err) {
          this.log(`search provider setup failed for ${profileId} (continuing): ${err instanceof Error ? err.message : err}`);
        }
      }

      // Label the window so the operator can tell which account this browser is
      // among many open profiles (the cue AdsPower's panel gave). Registered
      // before navigation so the title script is in place when the platform page
      // loads. Strictly best-effort — never fail or stall a launch on it.
      if (!this.skipDefaultWindowLabel) {
        try {
          const serial = this.store.getSerial(profileId);
          await this.labelWindowFn(ws, buildWindowLabel(profile.name, serial));
        } catch (err) {
          this.log(`window label failed for ${profileId} (continuing): ${err instanceof Error ? err.message : err}`);
        }
      }

      // Identity card (#3): open the AdsPower-style landing page in its OWN tab (leaves the
      // automation's tab 0 untouched). Visible-mode only; best-effort.
      if (SESSION_LAUNCH) {
        try {
          await openProfileCardTab(ws, profileCardUrl(profileId));
        } catch (err) {
          this.log(`profile card tab failed for ${profileId} (continuing): ${err instanceof Error ? err.message : err}`);
        }
      }

      // Cookie injection is a one-time BOOTSTRAP to migrate the AdsPower
      // session, not an ongoing login mechanism:
      //   - Skip if the export has no platform-specific usable cookie — replaying
      //     dead cookies can't log anyone in; automation credential auto-login owns
      //     recovery for logged-out accounts (and its fresh session persists in
      //     the user-data dir, so the next launch sees a live session and skips).
      //   - Otherwise inject ONLY when there's no live platform session. Once
      //     logged in (original or auto-login-refreshed), that session — including
      //     rotated cookies — persists; re-injecting the stale export would revert
      //     it, so ensureCookies leaves it untouched.
      // Best-effort: a failed check/injection must not fail the launch.
      profile = this.requireUnchangedProfile(profileId, profileSnapshot, "session injection");
      if (profile.cookies.length > 0) {
        const target = cookieBootstrapTarget(profile.cookies);
        if (!target) {
          this.log(`${profileId}: no usable X/Telegram session cookies in export — leaving login to the app's auto-login`);
        } else {
          try {
            const { injected } = await this.ensureCookiesFn(ws, profile.cookies);
            this.log(
              injected
                ? `injected ${profile.cookies.length} cookies into ${profileId} (no live ${target.name} session)`
                : `${profileId} already logged in to ${target.name} — kept its existing session`,
            );
            if (injected && !profile.seeded) {
              this.store.markSeeded(profileId);
              profile = this.store.getProfile(profileId)!;
              profileSnapshot = JSON.stringify(profile);
            }
          } catch (err) {
            this.log(`cookie ensure failed for ${profileId} (continuing): ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      // Open the account's platform home page once the session is seeded —
      // unless the caller already passed startup URLs. Deferred to a post-seed
      // CDP navigation (never an argv URL) so the first page load runs with the
      // injected cookies in place rather than rendering logged-out. Remote mode
      // suppresses this (autoNavigate=false) and navigates itself only after it
      // has written the authoritative hub session.
      if (opts.autoNavigate ?? true) {
        profile = this.requireUnchangedProfile(profileId, profileSnapshot, "account navigation");
        // Standalone mode has no roamed bundle carrying the last A/K choice, so platformHomeUrl keeps
        // its historical K fallback. Remote mode passes the captured client explicitly (defaulting A).
        const home = platformHomeUrl(profile.platform);
        const urlsToOpen = startupUrls.length > 0 ? startupUrls : home ? [home] : [];
        if (urlsToOpen.length > 0) {
          try {
            await this.navigate(ws, urlsToOpen);
          } catch (err) {
            this.log(`startup navigation failed for ${profileId} (continuing): ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      // The Windows session helper fills proc.pid asynchronously. CDP can be
      // ready before its stdout arrives, so make one exact identity scan now,
      // while the process is known-good, rather than unnecessarily persisting
      // PID 0. Concurrent launches share the raw host snapshot below.
      if (proc.pid <= 0) {
        try {
          const recovered = await this.findOwnedBrowserPidsFn({
            profileId,
            debugPort: port,
            userDataDir,
            binaryPath: launchBinaryPath,
          });
          for (const pid of recovered ?? []) {
            try {
              if (pid > 0 && this.isPidAliveFn(pid)) {
                proc.pid = pid;
                this.log(`recovered browser PID ${pid} for ${profileId} before recording launch`);
                break;
              }
            } catch {
              // Unknown remains conservative: record PID 0 and let later exact
              // reconciliation retry rather than trusting an unverifiable PID.
            }
          }
        } catch {
          // The launch itself is healthy over CDP. A failed ownership scan must
          // not fail it; PID 0 keeps later teardown conservative.
        }
      }

      this.requireUnchangedProfile(profileId, profileSnapshot, "launch commit");
      const info: LaunchInfo = {
        profileId,
        pid: proc.pid,
        debugPort: port,
        ws,
        startedAt: launchStartedAt,
        relayPort,
        sessionBaseVersion: opts.sessionBaseVersion,
        binaryPath: launchBinaryPath,
        userDataDir,
        binarySha256: verifiedBinary.sha256,
        personaDigest,
        processGroupId: proc.processGroupId,
        rootStartTime: proc.rootStartTime,
      };
      this.store.recordLaunch(info);
      this.markIdentityCertified(profileId);
      return { ws, port };
    } catch (err) {
      // Roll back partial state so a failed start can't leak a zombie — including the relay, which
      // is brought up before the browser, so an error after that point would strand a listener.
      // Use the same exact-identity + tree-kill policy as normal stop(). Even
      // this retained SpawnedProcess PID may have died and been recycled while
      // CDP readiness was timing out; proc.kill()/signal-0 alone is unsafe.
      let teardownConfirmed = !spawnAttempted;
      if (spawnAttempted) {
        const pendingLaunch: LaunchInfo = {
          profileId,
          pid: proc?.pid ?? 0,
          debugPort: port,
          ws: "",
          startedAt: launchStartedAt,
          relayPort,
          sessionBaseVersion: opts.sessionBaseVersion,
          binaryPath: launchBinaryPath,
          userDataDir,
          binarySha256: verifiedBinary.sha256,
          personaDigest,
          processGroupId: proc?.processGroupId,
          rootStartTime: proc?.rootStartTime,
        };
        try {
          const owned = await this.exactOwnedPids(profileId, pendingLaunch);
          if (owned === null) {
            this.log(`failed start ${profileId}: ownership scan inconclusive; refusing an unsafe PID-only kill`);
          } else if (!proc && owned.length === 0) {
            // A spawner can create the OS child and then throw before returning
            // its handle; an immediate process snapshot may race that child's
            // argv visibility. Preserve the PID-0 row for a later exact scan.
            this.log(`failed start ${profileId}: spawner returned no handle; retaining provisional ownership for reconciliation`);
          } else {
            let proof: LinuxTerminationProof | null = null;
            if (owned.length > 0) {
              if (this.hostPlatform === "linux" && this.readProcessSnapshotFn) {
                proof = await this.prepareLinuxTermination(profileId, pendingLaunch);
                if (!proof) throw new Error("Linux root/tree ownership could not be proven");
                await this.signalLinuxTermination(profileId, pendingLaunch, proof);
              } else {
                for (const pid of owned) await this.killPidFn(pid);
              }
            }
            if (owned.length === 0 && this.hostPlatform === "linux" && this.readProcessSnapshotFn) {
              proof = this.persistedGroupProof(pendingLaunch);
              if (!proof) throw new Error("pre-patch Linux tree cannot be anchored after its root disappeared");
            }
            teardownConfirmed = await this.confirmLaunchStopped(
              profileId,
              pendingLaunch,
              proof ?? undefined,
              owned.length > 0,
            );
          }
        } catch (error) {
          this.log(`failed start ${profileId}: exact teardown failed (${error}); refusing an unsafe PID-only kill`);
        }

        if (!teardownConfirmed) {
          // Preserve every ownership resource so the caller's stop+retry path
          // can safely re-scan. Forgetting an inconclusive partial launch would
          // permit this port and user-data dir to be reused beside a live Chrome.
          this.store.recordLaunch(pendingLaunch);
          this.liveReserved.add(port);
          this.log(`failed start ${profileId}: teardown unconfirmed; retained launch ownership for retry`);
        }
      }
      if (teardownConfirmed) {
        const retained = this.store.getLaunch(profileId);
        if (retained && retained.debugPort === port && retained.startedAt === launchStartedAt) {
          if (!this.forgetLaunch(profileId, retained)) teardownConfirmed = false;
        } else if (retained) {
          teardownConfirmed = false;
          this.log(`failed start ${profileId}: launch generation changed during rollback; retained replacement ownership`);
        } else {
          this.closeRelay(profileId);
          this.procs.delete(profileId);
          this.liveReserved.delete(port);
          this.clearIdentityCertification(profileId);
        }
      }
      throw err;
    }
  }

  /**
   * Inspect the two independent browser-liveness signals with one policy used
   * by start(), stop(), and reconciliation. A PID 0 is never process-alive:
   * only an in-memory session-launch handle gets a short recovery grace, after
   * which an unreachable launch becomes stale. A persisted PID-0 row after a
   * manager restart has no recovery source and is therefore immediately
   * `unknown` (CDP can still independently prove it alive).
   */
  private async inspectLaunchLiveness(
    profileId: string,
    launch: LaunchInfo,
    proc = this.procs.get(profileId),
    scanEvenWhenCdpAlive = false,
  ): Promise<LaunchLiveness> {
    const cdpWs = await this.probeLaunchCdp(launch);
    const cdpAlive = cdpWs !== null;
    const trackedPid = (proc?.pid ?? 0) > 0 ? proc!.pid : launch.pid;

    // signal-0 is only a hint, even for an in-memory handle: the process can be
    // externally killed and its PID recycled while the SpawnedProcess object is
    // retained. A healthy CDP endpoint needs no process kill; every CDP-dead or
    // forced-stop path falls through to exact executable/argv ownership below.
    if (proc && trackedPid > 0) {
      try {
        const alive = this.isPidAliveFn(trackedPid);
        if (alive) {
          if (cdpAlive && !scanEvenWhenCdpAlive) {
            return { cdpAlive, cdpWs, pid: trackedPid, ownedPids: [], process: "unknown" };
          }
        }
      } catch {
        // Fall through to the exact scan. A signal-0 error is unknown, not dead,
        // but the executable/argv scan may still establish ownership safely.
      }
    }

    const recovering = !!proc
      && trackedPid <= 0
      && Date.now() - launch.startedAt <= this.pidRecoveryGraceMs;
    if (recovering && cdpAlive && !scanEvenWhenCdpAlive) {
      return { cdpAlive, cdpWs, pid: 0, ownedPids: [], process: "recovering" };
    }
    if (cdpAlive && !scanEvenWhenCdpAlive) {
      return { cdpAlive, cdpWs, pid: trackedPid, ownedPids: [], process: "unknown" };
    }
    if (this.skipDefaultOwnedBrowserScan && proc && trackedPid > 0) {
      try {
        const alive = this.isPidAliveFn(trackedPid);
        return {
          cdpAlive,
          cdpWs,
          pid: trackedPid,
          ownedPids: alive ? [trackedPid] : [],
          process: alive ? "alive" : "dead",
        };
      } catch {
        return { cdpAlive, cdpWs, pid: trackedPid, ownedPids: [], process: "unknown" };
      }
    }

    const identity = this.recordedProcessIdentity(profileId, launch);
    let scanned: number[] | null = null;
    if (identity) {
      try {
        scanned = await this.findOwnedBrowserPidsFn(identity);
      } catch {
        scanned = null;
      }
    }
    if (scanned === null) {
      return { cdpAlive, cdpWs, pid: trackedPid, ownedPids: [], process: "unknown" };
    }

    const alivePids: number[] = [];
    for (const pid of [...new Set(scanned)].filter((value) => value > 0)) {
      try {
        if (this.isPidAliveFn(pid)) alivePids.push(pid);
      } catch {
        // A failed signal-0 check makes the overall scan inconclusive. Do not
        // turn a permissions/transient error into permission to forget/kill.
        return { cdpAlive, cdpWs, pid: trackedPid, ownedPids: [], process: "unknown" };
      }
    }
    if (alivePids.length === 0) {
      return { cdpAlive, cdpWs, pid: trackedPid, ownedPids: [], process: "dead" };
    }

    // PID recovery can complete via the exact process scan even if the Windows
    // helper's stdout never arrived. Persist it so a later manager restart has
    // a useful diagnostic/fast-path candidate (still re-verified before kill).
    const recoveredPid = alivePids[0]!;
    if (proc && proc.pid <= 0) proc.pid = recoveredPid;
    if (launch.pid <= 0) {
      const current = this.store.getLaunch(profileId);
      if (current
        && current.debugPort === launch.debugPort
        && current.startedAt === launch.startedAt
        && current.ws === launch.ws) {
        this.store.recordLaunch({ ...current, pid: recoveredPid });
      }
    }
    return { cdpAlive, cdpWs, pid: recoveredPid, ownedPids: alivePids, process: "alive" };
  }

  /**
   * Exact process identity belongs to the launch generation, not the current
   * manager configuration. A kernel/data-root change after restart must never
   * make an old live browser look dead and permit a duplicate launch.
   */
  private recordedProcessIdentity(profileId: string, launch: LaunchInfo): BrowserProcessIdentity | null {
    if (!launch.binaryPath || !launch.userDataDir) return null;
    return {
      profileId,
      debugPort: launch.debugPort,
      binaryPath: launch.binaryPath,
      userDataDir: launch.userDataDir,
    };
  }

  /**
   * Pre-hardening launch rows did not persist process identity. They may be
   * adopted only for teardown, and only when an exact scan positively matches
   * the current configured binary/data directory plus the recorded port. An
   * empty or inconclusive scan is never evidence that an old browser is gone:
   * deployment configuration may have changed since it was launched.
   */
  private async adoptLegacyLaunchIdentity(
    profileId: string,
    launch: LaunchInfo,
  ): Promise<LaunchInfo | null> {
    if (launch.binaryPath && launch.userDataDir) return launch;
    let binaryPath = launch.binaryPath;
    let userDataDir = launch.userDataDir;
    try {
      binaryPath ||= this.unsafeDisableIdentityGates ? this.binaryPath : realpathSync(this.binaryPath);
      userDataDir ||= this.userDataDir(profileId);
    } catch (error) {
      this.log(`legacy launch ${profileId}: configured process identity is unavailable (${error})`);
      return null;
    }
    if (!binaryPath || !userDataDir) return null;

    let matches: number[] | null;
    try {
      matches = await this.findOwnedBrowserPidsFn({
        profileId,
        debugPort: launch.debugPort,
        binaryPath,
        userDataDir,
      });
    } catch {
      matches = null;
    }
    if (!matches?.length) return null;
    let recoveredPid = 0;
    for (const pid of [...new Set(matches)].filter((value) => value > 0)) {
      try {
        if (this.isPidAliveFn(pid)) {
          recoveredPid = pid;
          break;
        }
      } catch {
        return null;
      }
    }
    if (!recoveredPid) return null;

    const current = this.store.getLaunch(profileId);
    if (!current
      || current.debugPort !== launch.debugPort
      || current.startedAt !== launch.startedAt) {
      return null;
    }
    const adopted = {
      ...current,
      pid: current.pid > 0 ? current.pid : recoveredPid,
      binaryPath,
      userDataDir,
    };
    this.store.recordLaunch(adopted);
    this.log(`legacy launch ${profileId}: exact process identity adopted for mandatory teardown before reuse`);
    return adopted;
  }

  /**
   * Release resources only if `launch` is still the profile's current launch
   * generation. PID, websocket and session-base fields may legitimately refresh
   * during one generation, so the stable generation key is start time + debug
   * port. A stale teardown must never clear a replacement's row, process handle,
   * relay, or reservation.
   */
  private forgetLaunch(profileId: string, launch: LaunchInfo): boolean {
    const current = this.store.getLaunch(profileId);
    if (!current
      || current.profileId !== launch.profileId
      || current.debugPort !== launch.debugPort
      || current.startedAt !== launch.startedAt) {
      return false;
    }
    // Delete durable ownership first. If SQLite refuses the write, leave every
    // in-memory resource intact so a later retry still knows what it owns.
    this.store.clearLaunch(profileId);
    this.liveReserved.delete(launch.debugPort);
    this.closeRelay(profileId);
    this.procs.delete(profileId);
    this.verifiedExternal.delete(profileId);
    this.clearIdentityCertification(profileId);
    // Every successful call site has positively established that this exact
    // launch generation is dead. Cleaning here covers explicit stops, direct
    // window closes discovered by reconciliation, and failed-start rollback.
    // start() cannot reuse the profile until its lifecycle transition finishes.
    this.clearPostStopCache(profileId);
    return true;
  }

  private async exactOwnedPids(profileId: string, launch: LaunchInfo): Promise<number[] | null> {
    if (this.skipDefaultOwnedBrowserScan) {
      const proc = this.procs.get(profileId);
      const trackedPid = proc?.pid ?? 0;
      if (trackedPid <= 0) return null;
      try {
        return this.isPidAliveFn(trackedPid) ? [trackedPid] : [];
      } catch {
        return null;
      }
    }
    const identity = this.recordedProcessIdentity(profileId, launch);
    if (!identity) return null;
    try {
      const pids = await this.findOwnedBrowserPidsFn(identity);
      if (pids === null) return null;
      const alive: number[] = [];
      for (const pid of [...new Set(pids.filter((value) => value > 0))]) {
        try {
          if (this.isPidAliveFn(pid)) alive.push(pid);
        } catch {
          return null;
        }
      }
      return alive;
    } catch {
      return null;
    }
  }

  private exactLinuxRoot(exactPids: number[], snapshot: HostProcessSnapshot): number | null {
    if (snapshot.incomplete || exactPids.length === 0) return null;
    const byPid = new Map(snapshot.records.map((record) => [record.pid, record]));
    const isAncestor = (candidate: number, pid: number): boolean => {
      const seen = new Set<number>();
      let current = pid;
      while (!seen.has(current)) {
        if (current === candidate) return true;
        seen.add(current);
        const parent = byPid.get(current)?.parentPid;
        if (!parent || parent === current) return false;
        current = parent;
      }
      return false;
    };
    const roots = exactPids.filter((candidate) =>
      exactPids.every((pid) => isAncestor(candidate, pid))
    );
    return roots.length === 1 ? roots[0]! : null;
  }

  private persistedGroupProof(launch: LaunchInfo): LinuxTerminationProof | null {
    return launch.pid > 0
      && launch.processGroupId === launch.pid
      && !!launch.rootStartTime
      ? {
          kind: "group",
          rootPid: launch.pid,
          rootStartTime: launch.rootStartTime,
        }
      : null;
  }

  /** Build a Linux kill proof only after exact root identity and /proc identity agree. */
  private async prepareLinuxTermination(profileId: string, launch: LaunchInfo): Promise<LinuxTerminationProof | null> {
    if (this.hostPlatform !== "linux" || !this.readProcessSnapshotFn) return null;
    const exact = await this.exactOwnedPids(profileId, launch);
    if (!exact?.length) return null;
    const snapshot = await this.readProcessSnapshotFn();
    if (!snapshot) return null;

    if (launch.processGroupId !== undefined || launch.rootStartTime !== undefined) {
      const proof = this.persistedGroupProof(launch);
      const root = proof && exact.includes(proof.rootPid)
        ? snapshot.records.find((record) => record.pid === proof.rootPid)
        : null;
      if (!proof
        || root?.startTime !== proof.rootStartTime
        || root.processGroupId !== proof.rootPid) return null;
      return proof;
    }

    if (snapshot.incomplete) return null;
    const rootPid = this.exactLinuxRoot(exact, snapshot);
    if (!rootPid) return null;
    const root = snapshot.records.find((record) => record.pid === rootPid);
    if (!root?.startTime) return null;
    const members = collectLinuxProcessTree(rootPid, snapshot);
    if (!members) return null;
    // Revalidate the exact root after the ancestry snapshot so a recycled PID can
    // never turn a stale launch row into authority over an unrelated tree.
    const revalidated = await this.exactOwnedPids(profileId, launch);
    const current = await this.readProcessSnapshotFn();
    if (!revalidated || !current || this.exactLinuxRoot(revalidated, current) !== rootPid) return null;
    const currentRoot = current.records.find((record) => record.pid === rootPid);
    if (currentRoot?.startTime !== root.startTime) return null;
    return { kind: "tree", rootPid, rootStartTime: root.startTime, members };
  }

  private async signalLinuxTermination(
    profileId: string,
    launch: LaunchInfo,
    proof: LinuxTerminationProof,
  ): Promise<void> {
    if (!this.readProcessSnapshotFn) throw new Error("Linux process snapshot unavailable");
    if (proof.kind === "group") {
      const exact = await this.exactOwnedPids(profileId, launch);
      const snapshot = await this.readProcessSnapshotFn();
      const root = exact?.includes(proof.rootPid)
        ? snapshot?.records.find((record) => record.pid === proof.rootPid)
        : null;
      if (!exact?.length
        || root?.startTime !== proof.rootStartTime
        || root.processGroupId !== proof.rootPid) {
        throw new Error("Linux browser process-group identity changed before signaling");
      }
      await this.killProcessGroupFn(proof.rootPid);
      return;
    }

    const deadline = Date.now() + this.teardownTimeoutMs;
    while (true) {
      const exact = await this.exactOwnedPids(profileId, launch);
      const snapshot = await this.readProcessSnapshotFn();
      const root = exact && snapshot && this.exactLinuxRoot(exact, snapshot) === proof.rootPid
        ? snapshot.records.find((record) => record.pid === proof.rootPid)
        : null;
      if (!exact?.length || root?.startTime !== proof.rootStartTime) {
        throw new Error("Linux browser root identity changed before tree signaling");
      }
      const members = collectLinuxProcessTree(proof.rootPid, snapshot!);
      if (!members) throw new Error("Linux browser ancestry became inconclusive before signaling");
      for (const member of members) {
        if (!proof.members.some((known) => known.pid === member.pid && known.startTime === member.startTime)) {
          proof.members.push(member);
        }
      }
      const target = members.find((member) => member.pid !== proof.rootPid);
      if (!target) {
        await this.killPidFn(proof.rootPid);
        return;
      }
      await this.killPidFn(target.pid);
      if (Date.now() >= deadline) throw new Error("Linux browser descendants did not stop within teardown deadline");
    }
  }

  private async launchStoppedOnce(
    profileId: string,
    launch: LaunchInfo,
    proof?: LinuxTerminationProof,
  ): Promise<{ stopped: boolean; reason?: string }> {
    const currentWs = await this.probeLaunchCdp(launch);
    if (currentWs !== null && (!launch.ws || currentWs === launch.ws)) {
      return { stopped: false, reason: `recorded CDP browser still answers on port ${launch.debugPort}` };
    }
    const scanned = await this.exactOwnedPids(profileId, launch);
    if (scanned === null) return { stopped: false, reason: "exact host process scan was inconclusive" };
    if (scanned.length > 0) return { stopped: false, reason: `owned browser pid ${scanned[0]} is still alive` };

    if (proof) {
      const snapshot = await this.readProcessSnapshotFn?.();
      if (!snapshot || snapshot.incomplete) return { stopped: false, reason: "Linux process-tree scan was inconclusive" };
      if (proof.kind === "group") {
        if (snapshot.records.some((record) => record.processGroupId === proof.rootPid)) {
          return { stopped: false, reason: `owned process group ${proof.rootPid} still has members` };
        }
      } else if (proof.members.some((member) => snapshot.records.some(
        (record) => record.pid === member.pid && record.startTime === member.startTime,
      ))) {
        return { stopped: false, reason: "owned Linux browser tree still has members" };
      }
    }
    if (currentWs !== null) {
      this.log(`stop ${profileId}: debug port ${launch.debugPort} was recycled by a different CDP browser; ignoring it`);
    }
    return { stopped: true };
  }

  /** Bounded authoritative CDP plus exact root/tree disappearance check. */
  private async confirmLaunchStopped(
    profileId: string,
    launch: LaunchInfo,
    proof?: LinuxTerminationProof,
    poll = false,
  ): Promise<boolean> {
    const deadline = Date.now() + (poll ? this.teardownTimeoutMs : 0);
    while (true) {
      const result = await this.launchStoppedOnce(profileId, launch, proof);
      if (result.stopped) return true;
      if (Date.now() >= deadline) {
        this.log(`stop ${profileId}: ${result.reason ?? "teardown could not be confirmed"}`);
        return false;
      }
      await sleep(this.teardownPollMs);
    }
  }

  private async confirmPersistedLaunchStopped(profileId: string, launch: LaunchInfo): Promise<boolean> {
    if (this.hostPlatform !== "linux" || !this.readProcessSnapshotFn) return true;
    const proof = this.persistedGroupProof(launch);
    return !!proof && await this.confirmLaunchStopped(profileId, launch, proof);
  }

  private closeRelay(profileId: string): void {
    const relay = this.relays.get(profileId);
    if (relay) {
      try {
        relay.close();
      } catch {}
      this.relays.delete(profileId);
    }
  }

  /**
   * Recreate a restart-survivor's proxy relay only after the
   * caller has established lifecycle ownership and checked its durable persona.
   * reconcileOrphans deliberately never calls this: merely discovering a live
   * process must not restore its account network before hub claim/certification.
   */
  private async ensureSurvivorRelay(profile: Profile, launch: LaunchInfo): Promise<void> {
    if (!needsProxyRelay(profile)) return;
    if (this.relays.has(profile.id)) return;
    if (!launch.relayPort) {
      throw new Error(`proxied survivor ${profile.id} predates the required relay; close it and reopen with the current manager`);
    }
    let relay: ProxyRelay;
    try {
      relay = await startProxyRelay(
        {
          type: profile.proxy!.type === "socks5" ? "socks5" : "http",
          host: profile.proxy!.host,
          port: Number(profile.proxy!.port),
          user: profile.proxy!.user,
          pass: profile.proxy!.pass,
        },
        { port: launch.relayPort },
      );
    } catch {
      throw new BrowserLaunchError("relay_setup");
    }
    const current = this.store.getLaunch(profile.id);
    const sameGeneration = current?.debugPort === launch.debugPort
      && current.startedAt === launch.startedAt;
    if (!sameGeneration || this.relays.has(profile.id)) {
      relay.close();
      if (!sameGeneration) throw new Error(`launch generation changed while restoring proxy relay for ${profile.id}`);
      return;
    }
    this.relays.set(profile.id, relay);
    this.log(`reattached proxy relay for ${profile.id}`);
  }

  /**
   * Stop the browser for `profileId`; true only when teardown is confirmed.
   * Concurrent stops coalesce, and start() will wait for this full transition
   * (including its final launch-row cleanup) before reusing the profile.
   */
  async stop(profileId: string): Promise<boolean> {
    const existingStop = this.stopsInFlight.get(profileId);
    const starting = this.startsInFlight.get(profileId);
    const startQueuedAfterExistingStop = !!existingStop && !!starting &&
      this.startAfterStop.get(profileId) === existingStop;
    if (existingStop && !startQueuedAfterExistingStop) return existingStop;
    // See start(): defer until this stop is discoverable, but wait only for the
    // start that was already registered when stop() was called.
    let promise!: Promise<boolean>;
    promise = Promise.resolve()
      .then(async () => {
        if (existingStop) await existingStop;
        if (starting) {
          this.log(`stop ${profileId}: waiting for in-flight start to settle`);
          await starting.catch(() => {});
        }
        return await this.doStop(profileId);
      })
      .finally(() => {
        if (this.stopsInFlight.get(profileId) === promise) {
          this.stopsInFlight.delete(profileId);
        }
      });
    this.stopsInFlight.set(profileId, promise);
    return promise;
  }

  private async doStop(profileId: string): Promise<boolean> {
    let launch = this.store.getLaunch(profileId);
    if (launch && (!launch.binaryPath || !launch.userDataDir)) {
      const adopted = await this.adoptLegacyLaunchIdentity(profileId, launch);
      if (!adopted) {
        this.liveReserved.add(launch.debugPort);
        this.log(
          `stop ${profileId}: legacy launch has no recorded process identity and did not exactly match the current deployment; ` +
          "keeping it quarantined (close browsers before upgrading, or restore the original binary/data-root configuration)",
        );
        return false;
      }
      launch = adopted;
    }
    const proc = this.procs.get(profileId);
    const initial = launch
      ? await this.inspectLaunchLiveness(profileId, launch, proc, true)
      : null;
    let teardownConfirmed = !launch && !proc;
    const requiresLinuxProof = this.hostPlatform === "linux" && !!this.readProcessSnapshotFn;
    let linuxProof: LinuxTerminationProof | null = null;
    if (requiresLinuxProof && launch) {
      linuxProof = initial?.process === "alive"
        ? await this.prepareLinuxTermination(profileId, launch)
        : this.persistedGroupProof(launch);
    }
    try {
      // Graceful first: ask the browser to close over CDP so Chromium commits its
      // cookie/session store to disk and exits on its own. A bare SIGKILL /
      // taskkill /F (below) would drop a just-acquired session that hadn't reached
      // Chromium's periodic commit yet — and force-killing DURING a graceful close
      // interrupts the flush, so we must wait for the real exit. browserCloseFn
      // returns true once the debug endpoint is gone, but an OS process can
      // survive after dropping its listener. Exact process verification below
      // is still the final source of truth.
      // Browser.close is destructive too: only send it after the same exact
      // executable/port/user-data identity check required before an OS kill.
      // A recycled port can expose an unrelated but valid CDP endpoint.
      const wasAlive = initial?.cdpAlive === true && initial.process === "alive";
      const hasLinuxTreeProof = !requiresLinuxProof || !!linuxProof;
      if (wasAlive && hasLinuxTreeProof && launch?.ws) {
        try {
          if (await this.browserCloseFn(initial?.cdpWs ?? launch.ws, this.gracefulStopMs)) {
            if (await this.confirmLaunchStopped(profileId, launch, linuxProof ?? undefined, true)) {
              if (this.forgetLaunch(profileId, launch)) return true;
              this.log(`stop ${profileId}: launch generation changed after graceful close; leaving the replacement owned`);
              return false;
            }
            this.log(`stop ${profileId}: graceful CDP close completed but an owned process may remain; forcing exact owners`);
          }
        } catch (err) {
          this.log(`stop ${profileId}: graceful close failed (${err}); forcing`);
        }
      }

      if (launch) {
        // Force an exact ownership scan here even when CDP answers. Persisted
        // signal-0 alone is unsafe: that PID may belong to an unrelated process
        // after OS recycling. This applies to retained in-memory handles too.
        const forceState = await this.inspectLaunchLiveness(profileId, launch, proc, true);
        if (forceState.process === "alive") {
          if (requiresLinuxProof) {
            linuxProof ||= await this.prepareLinuxTermination(profileId, launch);
            if (!linuxProof) {
              this.log(`stop ${profileId}: Linux root/tree ownership could not be proven; refusing to signal`);
            } else {
              await this.signalLinuxTermination(profileId, launch, linuxProof);
              teardownConfirmed = await this.confirmLaunchStopped(profileId, launch, linuxProof, true);
            }
          } else {
            for (const pid of forceState.ownedPids) await this.killPidFn(pid);
            teardownConfirmed = await this.confirmLaunchStopped(profileId, launch, undefined, true);
          }
        } else if (forceState.process === "dead") {
          if (requiresLinuxProof && !linuxProof) {
            this.log(`stop ${profileId}: pre-patch Linux tree cannot be anchored after its root disappeared; retaining ownership`);
          } else {
            teardownConfirmed = await this.confirmLaunchStopped(profileId, launch, linuxProof ?? undefined);
          }
        } else {
          // PID recovery/scan failure is not death evidence. Keep every resource
          // so a later exact scan can recover it and no duplicate can launch.
        }
      }
    } catch (err) {
      this.log(`stop ${profileId}: kill failed: ${err}`);
      teardownConfirmed = false;
    }

    if (teardownConfirmed) {
      if (launch && !this.forgetLaunch(profileId, launch)) {
        teardownConfirmed = false;
        this.log(`stop ${profileId}: launch generation changed during teardown; leaving the replacement owned`);
      }
      else {
        this.closeRelay(profileId);
        this.procs.delete(profileId);
      }
    } else if (launch) {
      this.liveReserved.add(launch.debugPort);
      this.log(
        `stop ${profileId}: teardown could not be confirmed (pid=${initial?.pid ?? 0}, cdp=${initial?.cdpAlive ? "alive" : "unreachable"}); keeping launch ownership`,
      );
    }
    return teardownConfirmed;
  }

  /** True iff the profile still has a visible page target for its current generation. */
  async hasPageTargets(profileId: string): Promise<boolean> {
    const launch = this.store.getLaunch(profileId);
    if (!launch) return false;
    try {
      const response = await this.fetchFn(`http://127.0.0.1:${launch.debugPort}/json/list`);
      if (!response.ok) return true;
      const targets = await response.json() as Array<{ type?: unknown }>;
      const current = this.store.getLaunch(profileId);
      if (!current || current.debugPort !== launch.debugPort || current.startedAt !== launch.startedAt) {
        return true;
      }
      return targets.some((target) => target?.type === "page");
    } catch {
      // Surface detection must never reinterpret an uncertain CDP probe as a user close.
      return true;
    }
  }

  /** In-memory page target fingerprint for dirty-session detection; null means the probe was uncertain or stale. */
  async pageTargetFingerprint(
    profileId: string,
    expected: { debugPort: number; startedAt: number },
  ): Promise<string | null> {
    const launch = this.store.getLaunch(profileId);
    if (!launch || launch.debugPort !== expected.debugPort || launch.startedAt !== expected.startedAt) return null;
    try {
      const response = await this.fetchFn(`http://127.0.0.1:${launch.debugPort}/json/list`);
      if (!response.ok) return null;
      const raw = await response.json();
      if (!Array.isArray(raw)) return null;
      const targets = raw.flatMap((target) =>
        target?.type === "page" && typeof target.id === "string" && typeof target.url === "string"
          ? [{ id: target.id, url: target.url }]
          : []
      ).sort((left, right) => left.id.localeCompare(right.id) || left.url.localeCompare(right.url));
      const current = this.store.getLaunch(profileId);
      if (!current || current.debugPort !== expected.debugPort || current.startedAt !== expected.startedAt) return null;
      return JSON.stringify(targets);
    } catch {
      return null;
    }
  }

  browserStorageWatchPaths(profileId: string): string[] {
    const root = this.store.getLaunch(profileId)?.userDataDir ?? this.userDataDir(profileId);
    return [
      join(root, "Default", "Network"),
      join(root, "Default", "Local Storage", "leveldb"),
      join(root, "Default", "IndexedDB"),
    ];
  }

  /** Block destructive profile deletion while any owned lifecycle can still use its data directory. */
  profileDeletionBlocked(profileId: string): boolean {
    return this.startsInFlight.has(profileId)
      || this.stopsInFlight.has(profileId)
      || this.procs.has(profileId)
      || this.store.getLaunch(profileId) !== null;
  }

  /** True iff the profile's browser is currently reachable over CDP. */
  async active(profileId: string): Promise<boolean> {
    const launch = this.store.getLaunch(profileId);
    if (!launch) return false;
    const trackedProc = this.procs.get(profileId);
    const currentWs = await this.probeLaunchCdp(launch);
    if (!currentWs) return false;
    const afterProbe = this.store.getLaunch(profileId);
    if (!afterProbe
      || afterProbe.debugPort !== launch.debugPort
      || afterProbe.startedAt !== launch.startedAt
      || afterProbe.ws !== launch.ws) {
      return false;
    }

    // The hot Telegram checkpoint calls active() every few seconds. A current
    // manager handle, unchanged browser UUID, and live PID are a cheap launch-
    // generation proof. Any suspicious transition falls back to the exact
    // executable/port/user-data scan before we trust or refresh the endpoint.
    if (!trackedProc) {
      const proof = this.verifiedExternal.get(profileId);
      const proofMatches = proof?.debugPort === launch.debugPort
        && proof.ws === currentWs
        && proof.pid > 0
        && Date.now() - proof.verifiedAt <= EXTERNAL_OWNERSHIP_PROOF_TTL_MS;
      if (proofMatches) {
        try {
          if (this.isPidAliveFn(proof.pid)) return true;
        } catch {
          // Fall through to an exact scan.
        }
      }
      this.verifiedExternal.delete(profileId);
    }

    let needsExactScan = !trackedProc || currentWs !== launch.ws || trackedProc.pid <= 0;
    if (trackedProc && !needsExactScan) {
      try {
        needsExactScan = !this.isPidAliveFn(trackedProc.pid);
      } catch {
        needsExactScan = true;
      }
    }
    if (!needsExactScan) return true;

    const liveness = await this.inspectLaunchLiveness(
      profileId,
      launch,
      trackedProc,
      true,
    );
    if (!liveness.cdpAlive) return false;
    if (liveness.process !== "alive") return false;
    const currentLaunch = this.store.getLaunch(profileId);
    if (!currentLaunch
      || currentLaunch.debugPort !== launch.debugPort
      || currentLaunch.startedAt !== launch.startedAt
      || currentLaunch.ws !== launch.ws) {
      this.verifiedExternal.delete(profileId);
      return false;
    }
    const verifiedWs = liveness.cdpWs!;
    if (!trackedProc) {
      this.verifiedExternal.set(profileId, {
        pid: liveness.pid,
        debugPort: launch.debugPort,
        ws: verifiedWs,
        verifiedAt: Date.now(),
      });
    }
    if (verifiedWs !== launch.ws) {
      this.store.recordLaunch({ ...currentLaunch, ws: verifiedWs });
      this.log(`profile ${profileId} active CDP websocket changed on port ${launch.debugPort}; refreshed stored endpoint`);
    }
    return true;
  }

  /** Reapply host and proxy-egress gates to a browser that survived a manager restart. */
  async verifyRunningIdentity(profileId: string): Promise<void> {
    assertSafeProfileId(profileId);
    let profile = this.store.getProfile(profileId);
    if (!profile) throw new Error(`cannot verify survivor ${profileId}: profile is missing`);
    const snapshot = JSON.stringify(profile);
    this.assertHostCompatibility(profile);
    const approvedBinarySha256 = this.approvedBinarySha256();
    if (!(await this.active(profileId))) throw new Error(`cannot verify survivor ${profileId}: browser identity/CDP is unavailable`);

    const launch = this.store.getLaunch(profileId);
    if (!launch) throw new Error(`cannot verify survivor ${profileId}: launch record is missing`);
    this.assertStoredLaunchPersona(profile, launch, approvedBinarySha256);
    const generation = `${launch.debugPort}:${launch.startedAt}`;
    profile = this.requireUnchangedProfile(profileId, snapshot, "survivor CDP verification");
    if (!profile.proxy) {
      this.markIdentityCertified(profileId);
      return;
    }
    let current = this.store.getLaunch(profileId);
    if (!current || `${current.debugPort}:${current.startedAt}` !== generation) {
      throw new Error(`cannot verify survivor ${profileId}: launch generation changed before relay restoration`);
    }
    await this.ensureSurvivorRelay(profile, current);
    profile = this.requireUnchangedProfile(profileId, snapshot, "survivor relay restoration");
    current = this.store.getLaunch(profileId);
    if (!current || `${current.debugPort}:${current.startedAt}` !== generation) {
      throw new Error(`cannot verify survivor ${profileId}: launch generation changed during relay restoration`);
    }
    this.markIdentityCertified(profileId);
    this.log(`survivor identity verified for ${profileId}: host persona + relay restored`);
  }

  /**
   * Safe externally-visible Active state. Raw active() is only a liveness
   * primitive; a survivor is not exposed until this manager has certified its
   * full identity once for the unchanged profile/launch generation.
   */
  async certifiedActive(profileId: string): Promise<boolean> {
    const starting = this.startsInFlight.get(profileId);
    if (starting) await starting.catch(() => {});
    if (!(await this.active(profileId).catch(() => false))) {
      this.clearIdentityCertification(profileId);
      return false;
    }
    if (this.isIdentityCertified(profileId)) return true;
    const existing = this.certificationsInFlight.get(profileId);
    if (existing) return existing;
    const target = this.store.getLaunch(profileId);
    const targetGeneration = target ? `${target.debugPort}:${target.startedAt}` : "";
    let promise!: Promise<boolean>;
    promise = (async () => {
      try {
        await this.verifyRunningIdentity(profileId);
        return this.isIdentityCertified(profileId) && await this.active(profileId).catch(() => false);
      } catch (error) {
        this.clearIdentityCertification(profileId);
        const current = this.store.getLaunch(profileId);
        if (!current || `${current.debugPort}:${current.startedAt}` !== targetGeneration) return false;
        const stopped = await this.stop(profileId).catch(() => false);
        const detail = error instanceof Error ? error.message : String(error);
        this.log(
          stopped
            ? `survivor identity certification failed (${detail}); browser stopped with confirmed death`
            : `survivor identity certification failed (${detail}); stop was not confirmed and ownership was retained`,
        );
        return false;
      } finally {
        if (this.certificationsInFlight.get(profileId) === promise) this.certificationsInFlight.delete(profileId);
      }
    })();
    this.certificationsInFlight.set(profileId, promise);
    return promise;
  }

  /**
   * Certify every persisted survivor before serving standalone Active status.
   * Each survivor's certification is an independent per-profile network probe
   * (proxy egress + CDP), so run them with bounded concurrency rather
   * than serially — otherwise a fleet of survivors behind slow proxies stalls
   * dashboard startup for the sum of every probe's latency.
   */
  async certifySurvivors(): Promise<{ certified: number; stopped: number }> {
    let certified = 0;
    let stopped = 0;
    const launches = this.store.listLaunches();
    const certifyOne = async (launch: LaunchInfo): Promise<void> => {
      if (
        !launch.binaryPath
        || !launch.userDataDir
        || !launch.binarySha256
        || !launch.personaDigest
      ) {
        const confirmed = await this.stop(launch.profileId).catch(() => false);
        if (!confirmed) {
          this.log(
            `legacy survivor ${launch.profileId} could not be safely stopped; it remains reserved and is not exposed as Active`,
          );
        }
        stopped++;
        return;
      }
      if (await this.certifiedActive(launch.profileId)) certified++;
      else stopped++;
    };
    const CONCURRENCY = 8;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < launches.length) {
        const launch = launches[next++]!;
        await certifyOne(launch);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, launches.length) }, () => worker()),
    );
    return { certified, stopped };
  }

  private async inspectForReconcile(
    launch: LaunchInfo,
    trackedProc: SpawnedProcess | undefined,
  ): Promise<{ liveness: LaunchLiveness; exactVerified: boolean }> {
    if (!trackedProc) {
      const proof = this.verifiedExternal.get(launch.profileId);
      if (proof?.debugPort === launch.debugPort && proof.pid > 0
        && Date.now() - proof.verifiedAt <= EXTERNAL_OWNERSHIP_PROOF_TTL_MS) {
        let processAlive = false;
        try { processAlive = this.isPidAliveFn(proof.pid); } catch {}
        if (processAlive) {
          const cdpWs = await this.probeLaunchCdp(launch);
          if (cdpWs === null || cdpWs === proof.ws) {
            return {
              exactVerified: false,
              liveness: {
                cdpAlive: cdpWs !== null,
                cdpWs,
                pid: proof.pid,
                ownedPids: [proof.pid],
                process: "alive",
              },
            };
          }
        }
        this.verifiedExternal.delete(launch.profileId);
      }
    }
    return {
      liveness: await this.inspectLaunchLiveness(launch.profileId, launch, trackedProc, !trackedProc),
      exactVerified: !trackedProc,
    };
  }

  private async probeLaunchCdp(launch: LaunchInfo): Promise<string | null> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${launch.debugPort}/json/version`);
      if (!res.ok) return null;
      // A bare HTTP 200 isn't proof the browser is alive: after a crash + OS
      // port reuse, an unrelated local service could answer here. Require a real
      // CDP payload so active() never lies — otherwise stop() could kill a
      // recycled PID and doStart() could reattach to a stale ws.
      const data = await res.json();
      const ws = data?.webSocketDebuggerUrl;
      return typeof ws === "string" && ws.startsWith("ws") ? ws : null;
    } catch {
      return null;
    }
  }

  /**
   * One-line diagnosis of why a CDP connect might be failing for a running profile: is the process
   * alive, does the debug port still answer /json/version, and does the browser ws it now reports match
   * the one we recorded at launch (a mismatch = we're connecting to a STALE target that will just hang).
   * Purely observational; used to make connectOverCDP timeouts actionable instead of opaque.
   */
  async diagnoseCdp(profileId: string): Promise<string> {
    const launch = this.store.getLaunch(profileId);
    if (!launch) return "no launch record";
    const parts: string[] = [`pid=${launch.pid}`, `port=${launch.debugPort}`];
    try {
      process.kill(launch.pid, 0); // signal 0 = existence check (throws if the process is gone)
      parts.push("proc=alive");
    } catch {
      parts.push("proc=DEAD");
    }
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${launch.debugPort}/json/version`);
      if (!res.ok) {
        parts.push("/json/version=not-ok");
      } else {
        const data: any = await res.json().catch(() => ({}));
        const cur = typeof data?.webSocketDebuggerUrl === "string" ? data.webSocketDebuggerUrl : "";
        parts.push("/json/version=ok");
        if (cur && launch.ws && cur !== launch.ws) parts.push(`ws=STALE (recorded ${launch.ws}, port now reports ${cur})`);
        else if (cur) parts.push("ws=matches");
        else parts.push("ws=missing-in-version");
      }
    } catch (e) {
      parts.push(`/json/version=unreachable (${e instanceof Error ? e.message : e})`);
    }
    return parts.join(" ");
  }

  /**
   * Raise this profile's browser window to the foreground — for finding one
   * window among many open profiles. Uses CDP Browser.setWindowBounds: a
   * minimize→normal cycle which forces the window manager to re-raise + focus.
   */
  async bringToFront(profileId: string): Promise<void> {
    const launch = this.store.getLaunch(profileId);
    if (!launch) throw new Error("profile is not running");
    await raiseWindow(launch.ws);
  }

  /**
   * Trim a profile's disk caches — the manager's equivalent of AdsPower's V2
   * delete-cache, which automation fires after every session. Without it the
   * persistent user-data dirs grow without bound over a long migration.
   *
   * Deletes ONLY cache directories (see CACHE_DIRS); never the cookies/session
   * state. Skips a live browser: on Windows its cache files are locked, and
   * deleting them under a running Chrome risks corruption. Never throws.
   */
  async clearCache(profileId: string): Promise<{ cleared: boolean }> {
    return this.clearCacheDirs(profileId, CACHE_DIRS, "clearCache");
  }

  private clearPostStopCache(profileId: string): void {
    const { cleared } = this.clearCacheDirs(profileId, POST_STOP_CACHE_DIRS, "post-stop cache cleanup");
    if (cleared) this.log(`${profileId}: rebuildable disk caches cleared after confirmed stop`);
  }

  private clearCacheDirs(
    profileId: string,
    cacheDirs: readonly string[],
    op: string,
  ): { cleared: boolean } {
    // The id arrives from an unauthenticated local HTTP body. Only clear caches
    // for a KNOWN profile, and only inside the data root — a "../" id must never
    // let a request rm cache directories elsewhere on disk.
    if (!this.store.getProfile(profileId)) return { cleared: false };
    // A retained row means teardown was not confirmed even when CDP is dead.
    // Never delete cache files under that possibly-live Chromium process.
    if (this.store.getLaunch(profileId)) return { cleared: false };
    const base = this.containedUserDataDir(profileId, op);
    if (!base) return { cleared: false };
    let cleared = false;
    for (const rel of cacheDirs) {
      const dir = join(base, rel);
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          cleared = true;
        }
      } catch {
        /* best-effort: a locked/missing dir must not fail cleanup */
      }
    }
    return { cleared };
  }

  /**
   * Delete a profile's Preferences / Secure Preferences ONLY when they're
   * corrupt (zero-length, unparseable JSON, or a non-object root), so Chromium regenerates defaults
   * instead of showing the blocking "Your preferences can not be read" dialog.
   *
   * Session-safe by construction: it never touches the cookie jar
   * (Default/Network/Cookies) or the root Local State (which holds the Windows
   * cookie-encryption key) — only the settings files. And because Chromium writes
   * Preferences atomically (temp + rename), a HEALTHY live browser's file always
   * reads as valid JSON, so this can't fire against a profile that's mid-write.
   * Fully best-effort: a locked or missing file must never fail a launch.
   */
  private repairCorruptPrefs(profileId: string): void {
    const base = this.containedUserDataDir(profileId, "repairCorruptPrefs");
    if (!base) return;
    for (const rel of ["Default/Preferences", "Default/Secure Preferences"]) {
      const file = join(base, rel);
      try {
        if (!existsSync(file)) continue;
        const raw = readFileSync(file, "utf8");
        let valid = false;
        try {
          const parsed = JSON.parse(raw);
          valid = raw.trim().length > 0
            && typeof parsed === "object"
            && parsed !== null
            && !Array.isArray(parsed);
        } catch {
          valid = false;
        }
        if (!valid) {
          rmSync(file, { force: true });
          this.log(`repaired corrupt ${rel} for ${profileId} (regenerated by Chromium; session cookies left intact)`);
        }
      } catch {
        /* best-effort: a locked/unreadable prefs file must not block the launch */
      }
    }
  }

  /** Persist the WebRTC routing floor as profile state as well as argv state. */
  private persistWebRtcPolicyPreference(profileId: string): void {
    const base = this.containedUserDataDir(profileId, "persistWebRtcPolicyPreference");
    if (!base) throw new Error(`cannot persist WebRTC policy for unsafe profile id ${JSON.stringify(profileId)}`);
    const dir = join(base, "Default");
    const file = join(dir, "Preferences");
    mkdirSync(dir, { recursive: true });
    let prefs: any = {};
    if (existsSync(file)) {
      try {
        prefs = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(
          `cannot persist WebRTC policy for ${profileId}: Preferences is unreadable (${error instanceof Error ? error.message : error})`,
        );
      }
    }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
      throw new Error(`cannot persist WebRTC policy for ${profileId}: Preferences root is not an object`);
    }
    const prior = prefs.webrtc;
    prefs.webrtc = {
      ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
      ip_handling_policy: "disable_non_proxied_udp",
    };
    try {
      writeFileSync(file, JSON.stringify(prefs));
    } catch (error) {
      throw new Error(`cannot persist WebRTC policy for ${profileId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Clear the leftovers an UNCLEAN exit (force-kill, crash) leaves in a persistent profile that
   * make its next launch come up wedged. Complements repairCorruptPrefs (which only handles an
   * unparseable Preferences). Runs on the fresh-launch path only — doStart reaches here after
   * confirming no in-proc handle and a dead recorded CDP port, so anything below is leftover, not
   * in use. Best-effort throughout: a locked/unreadable file must never block a launch.
   */
  private clearStaleProfileState(profileId: string, resetStorageSafe = true): void {
    const base = this.containedUserDataDir(profileId, "clearStaleProfileState");
    if (!base) return;

    // Track whether the last run ended UNCLEANLY. Either signal below implies a crash/force-kill, which
    // is also exactly when the volatile leveldb stores get left corrupt (see step 3).
    let uncleanExit = false;

    // 1) Stale process-singleton files (profile root). A clean shutdown removes these; a
    // force-kill leaves them, and the next Chrome then stalls trying to reach the dead singleton
    // before taking the dir over — long enough that the reconnect's first CDP call times out and
    // the browser reads as "wedged". Safe to delete here: no live browser holds this profile. Their
    // presence is also a crash signal that survives even a corrupt/regenerated Preferences.
    for (const rel of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        const file = join(base, rel);
        if (existsSync(file)) {
          rmSync(file, { force: true });
          uncleanExit = true;
          this.log(`cleared stale ${rel} for ${profileId}`);
        }
      } catch (error) {
        this.log(`failed to clear stale ${rel} for ${profileId}: ${error instanceof Error ? error.message : error}`);
      }
    }

    // 2) Reset the "did not exit cleanly" marker in Default/Preferences (NOT Secure Preferences —
    // that carries MACs we must not resign). exit_type="Crashed" is valid JSON, so repairCorruptPrefs
    // leaves it; on the next launch Chromium then offers to restore the previous session, which can
    // interpose over the automated first page. Flip it back to a clean exit. Only rewrite when it
    // actually needs it, and preserve every other preference untouched.
    try {
      const file = join(base, "Default", "Preferences");
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const prof = parsed?.profile;
        if (prof && typeof prof === "object" && prof.exit_type !== undefined && prof.exit_type !== "Normal") {
          const was = prof.exit_type;
          prof.exit_type = "Normal";
          prof.exited_cleanly = true;
          writeFileSync(file, JSON.stringify(parsed));
          uncleanExit = true;
          this.log(`reset unclean-exit marker (exit_type=${JSON.stringify(was)}) in Default/Preferences for ${profileId}`);
        }
      }
    } catch {
      /* best-effort: unparseable prefs were already handled by repairCorruptPrefs */
    }

    // 3) After an unclean exit, a half-written leveldb store (Local Storage / IndexedDB / …) makes
    // Chromium pop "Something went wrong opening your profile. Some features may be unavailable." on the
    // next launch — and repairCorruptPrefs/step 2 don't cover those stores. When the login is re-injected
    // from the hub (remote mode → resetStorageOnUncleanExit), reset them so Chromium regenerates them
    // clean; writeSession then repopulates cookies + origin storage. This auto-heals a profile a crash
    // corrupted, with no manual folder-deleting. Best-effort; a locked file must never block a launch.
    if (this.resetStorageOnUncleanExit) {
      if (uncleanExit && !resetStorageSafe) {
        // Unclean exit, but the bundle we're about to inject can't restore the login (e.g. a first-
        // migration Telegram open with no hub session). Resetting would delete the only local copy of a
        // localStorage-based (Telegram) login, so we DON'T — better a possible restore prompt than a wipe.
        this.log(`${profileId}: unclean prior exit but no restorable session to inject — keeping volatile storage (won't risk wiping a local login)`);
      } else if (uncleanExit) {
        let reset = 0;
        for (const rel of RESETTABLE_SESSION_STORES) {
          try {
            const target = join(base, ...rel.split("/"));
            if (existsSync(target)) {
              rmSync(target, { recursive: true, force: true });
              reset++;
            }
          } catch {
            /* best-effort */
          }
        }
        this.log(`${profileId}: unclean prior exit — reset ${reset} volatile store(s) so Chromium starts clean (login re-injected from the hub)`);
      } else {
        // Logged so we can tell, per profile, whether a "something went wrong" launch was preceded by a
        // detectable crash. If a profile pops the dialog but this says "clean", the corruption arrived
        // without a signal we key on — the trigger needs widening.
        this.log(`${profileId}: clean prior exit — volatile storage kept`);
      }
    }
  }

  /**
   * Resolve a profile's user-data dir, but only if it stays inside the data
   * root. Ids arrive from an unauthenticated local HTTP body; a "../" id must
   * never let a request touch paths elsewhere on disk. Returns null (and logs)
   * if the resolved path escapes the root.
   */
  private containedUserDataDir(profileId: string, op: string): string | null {
    try {
      return this.userDataDir(profileId);
    } catch (error) {
      this.log(`${op}: refusing unsafe/out-of-root path for ${JSON.stringify(profileId)} (${error instanceof Error ? error.message : error})`);
      return null;
    }
  }

  /**
   * Remove a profile's ENTIRE persistent user-data dir (session + cache).
   * Refuses any path outside the data root — same containment as clearCache — so
   * a crafted or legacy "../" id can never aim rmSync elsewhere. Returns false
   * when refused (the caller can still drop the SQLite row, which is path-safe).
   */
  removeUserDataDir(profileId: string): boolean {
    const dir = this.containedUserDataDir(profileId, "removeUserDataDir");
    if (!dir) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async reconcileOrphan(
    profileId: string,
    expected: { debugPort: number; startedAt: number },
  ): Promise<"alive" | "dead" | "generation_changed"> {
    const launch = this.store.getLaunch(profileId);
    if (!launch) return "dead";
    if (launch.debugPort !== expected.debugPort || launch.startedAt !== expected.startedAt) {
      return "generation_changed";
    }
    const trackedProc = this.procs.get(profileId);
    const { liveness, exactVerified } = await this.inspectForReconcile(launch, trackedProc);
    const current = this.store.getLaunch(profileId);
    if (!current) return "dead";
    if (current.debugPort !== expected.debugPort || current.startedAt !== expected.startedAt) {
      return "generation_changed";
    }

    if (!trackedProc) {
      if (liveness.process === "alive" && exactVerified) {
        this.verifiedExternal.set(profileId, {
          pid: liveness.pid,
          debugPort: launch.debugPort,
          ws: liveness.cdpWs ?? current.ws,
          verifiedAt: Date.now(),
        });
      } else if (liveness.process !== "alive") {
        this.verifiedExternal.delete(profileId);
      }
    }
    if (liveness.process !== "dead") {
      this.liveReserved.add(launch.debugPort);
      if (liveness.cdpAlive && liveness.process === "alive" && liveness.cdpWs && liveness.cdpWs !== current.ws) {
        this.store.recordLaunch({ ...current, ws: liveness.cdpWs });
      }
      return "alive";
    }
    if (!await this.confirmPersistedLaunchStopped(profileId, current)) {
      this.liveReserved.add(launch.debugPort);
      return "alive";
    }
    if (this.forgetLaunch(profileId, current)) return "dead";
    const latest = this.store.getLaunch(profileId);
    return latest && (latest.debugPort !== expected.debugPort || latest.startedAt !== expected.startedAt)
      ? "generation_changed"
      : "alive";
  }

  /**
   * Reconcile the launches table with reality: clear a recorded launch only when
   * neither its CDP endpoint nor its recorded process is alive. A slow CDP probe
   * alone is not process-death evidence. Runs on startup and on every dashboard
   * poll, so failing to release the reservation here would leak a port from the range on each
   * external (automation debug-port) teardown until restart.
   *
   * We deliberately do NOT kill by the stored PID here. Once both CDP and the
   * process-liveness check say it is gone, the OS may recycle that PID for an
   * unrelated process — a blind SIGKILL would take down an innocent victim.
   * (start() owns the live-after-restart case: it probes the recorded endpoint
   * and reuses it rather than double-launching.)
   */
  async reconcileOrphans(): Promise<{ cleared: number }> {
    let cleared = 0;
    // Probe profiles in parallel so every exact identity filter shares one
    // in-flight CIM/proc snapshot during a startup or dashboard sweep.
    const inspected = await Promise.all(this.store.listLaunches().map(async (launch) => {
      const trackedProc = this.procs.get(launch.profileId);
      const { liveness, exactVerified } = await this.inspectForReconcile(launch, trackedProc);
      return { launch, trackedProc, liveness, exactVerified };
    }));
    for (const { launch, trackedProc, liveness, exactVerified } of inspected) {
      const currentLaunch = this.store.getLaunch(launch.profileId);
      if (!currentLaunch
        || currentLaunch.debugPort !== launch.debugPort
        || currentLaunch.startedAt !== launch.startedAt
        || currentLaunch.ws !== launch.ws) {
        continue; // stop/restart won while the parallel probe was in flight
      }
      if (!trackedProc) {
        if (liveness.process === "alive" && exactVerified) {
          this.verifiedExternal.set(launch.profileId, {
            pid: liveness.pid,
            debugPort: launch.debugPort,
            ws: liveness.cdpWs ?? launch.ws,
            verifiedAt: Date.now(),
          });
        } else if (liveness.process !== "alive") {
          this.verifiedExternal.delete(launch.profileId);
        }
      }
      // CDP reachability is not process death. On a pressured host the 800ms
      // loopback probe can time out even though Chromium is still alive. Keep
      // that launch visible/stoppable instead of deleting its only ownership
      // record. A current-process Windows session handle with PID 0 receives a
      // bounded recovery grace; unlike the old unconditional branch it cannot
      // reserve a dead launch's port forever.
      if (liveness.process !== "dead") {
        // A browser from a previous manager run is still up; re-reserve its port.
        this.liveReserved.add(launch.debugPort);
        if (liveness.cdpAlive && liveness.process === "alive" && liveness.cdpWs && liveness.cdpWs !== launch.ws) {
          this.store.recordLaunch({ ...currentLaunch, ws: liveness.cdpWs });
        }
        const operationallyVerified = liveness.cdpAlive
          && (!!trackedProc || liveness.process === "alive");
        if (!operationallyVerified) {
          const reason = liveness.process === "recovering"
            ? "PID recovery grace"
            : liveness.process === "unknown"
              ? "ownership scan inconclusive"
              : `owned pid=${liveness.pid}`;
          this.log(`reconcileOrphans quarantined unverified launch for ${launch.profileId} (${reason}, port=${launch.debugPort})`);
        }
        continue;
      }
      if (!await this.confirmPersistedLaunchStopped(launch.profileId, currentLaunch)) {
        this.liveReserved.add(launch.debugPort);
        this.log(`reconcileOrphans retained ${launch.profileId}: exact Linux tree disappearance was not proven`);
        continue;
      }
      if (this.forgetLaunch(launch.profileId, currentLaunch)) cleared++;
    }
    if (cleared > 0) this.log(`reconcileOrphans cleared ${cleared} dead launch record(s)`);
    return { cleared };
  }

  private async waitForCdp(port: number, proc?: SpawnedProcess): Promise<string> {
    const deadline = Date.now() + this.cdpReadyTimeoutMs;
    const url = `http://127.0.0.1:${port}/json/version`;
    // Latch a PROVEN spawn failure (see SpawnedProcess.spawnFailed). Held in an object
    // so the closure's write is visible to the loop below without narrowing games.
    const spawn: { failure: string | null } = { failure: null };
    void proc?.spawnFailed?.then(
      (reason) => { if (reason) spawn.failure = reason; },
      () => {},
    );
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchFn(url);
        if (res.ok) {
          const data = await res.json();
          const ws = data?.webSocketDebuggerUrl;
          if (typeof ws === "string" && ws.startsWith("ws")) return ws;
        }
      } catch {
        // Keep polling until the bounded readiness deadline.
      }
      // Checked AFTER the probe so a healthy browser always wins over a stale or
      // pessimistic spawner diagnostic; only an unreachable CDP fails on it. This turns
      // a mute timeout into an immediate safe launch category.
      if (spawn.failure) {
        throw new BrowserLaunchError("process_spawn");
      }
      await sleep(250);
    }
    throw new BrowserLaunchError("cdp_readiness");
  }
}

/**
 * Raise a browser window via raw CDP over its browser-level websocket. We talk
 * JSON-RPC directly (rather than Playwright) because the raise uses Browser-domain
 * commands: find a page target, get its window, then minimize→normal it.
 */
function raiseWindow(browserWsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl);
    let nextId = 1;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    const send = (method: string, params?: unknown) =>
      new Promise<any>((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    const done = (err?: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => done(new Error("bringToFront: CDP timed out")), 5000);
    ws.onerror = () => done(new Error("bringToFront: websocket error"));
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (msg && msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || "CDP error")); else res(msg.result);
      }
    };
    ws.onopen = async () => {
      try {
        const { targetInfos } = await send("Target.getTargets");
        const page = (targetInfos as any[]).find((t) => t.type === "page") ?? (targetInfos as any[])[0];
        if (!page) throw new Error("no window to raise");
        const win = await send("Browser.getWindowForTarget", { targetId: page.targetId });
        const windowId = win?.windowId;
        if (windowId == null) throw new Error("no window to raise");
        // Restore first if it was minimized.
        if (win?.bounds?.windowState && win.bounds.windowState !== "normal") {
          await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        }
        if (process.platform === "linux") {
          // WSLg/Linux: windowState (minimize/restore) is a no-op, so it can't raise. But GEOMETRY
          // changes ARE honored — a brief height wiggle forces the compositor to re-present and
          // foreground the window. Touch ONLY width/height (never left/top) so it doesn't drift.
          const b = (await send("Browser.getWindowForTarget", { targetId: page.targetId }))?.bounds;
          if (b && typeof b.width === "number" && typeof b.height === "number") {
            const shrink = Math.max(240, b.height - 90);
            await send("Browser.setWindowBounds", { windowId, bounds: { width: b.width, height: shrink } });
            await sleep(200);
            await send("Browser.setWindowBounds", { windowId, bounds: { width: b.width, height: b.height } });
          }
        } else {
          // Windows/macOS: a background app can't call SetForegroundWindow at will, but RESTORING a
          // window FROM minimized is the OS-sanctioned exception that brings it to the front + focuses
          // it. A quick minimize→normal cycle is the reliable raise on the operator's Windows desktop.
          await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
          await sleep(120);
          await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        }
        // Also issue the platform activate, in case the WM honors it alongside.
        await send("Target.activateTarget", { targetId: page.targetId });
        done();
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const IS_WINDOWS = process.platform === "win32";

/** Signal-0 process liveness without sending a terminating signal. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still proves the process exists; we merely lack permission to
    // signal it. Every other failure (notably ESRCH) means it is gone.
    return (err as { code?: string })?.code === "EPERM";
  }
}

function normalizedExecutablePath(path: string, windows = IS_WINDOWS): string {
  let normalized = path.trim().replace(/^"|"$/g, "");
  // Linux marks the /proc/<pid>/exe symlink this way when the on-disk binary
  // was atomically replaced. The running process still belongs to the exact
  // launch path and must remain manageable instead of looking foreign/dead.
  if (!windows) normalized = normalized.replace(/ \(deleted\)$/, "");
  try { normalized = realpathSync(normalized); } catch { normalized = resolve(normalized); }
  return windows ? normalized.replace(/\//g, "\\").toLowerCase() : normalized;
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match one complete argv item in a Windows command-line string. */
function windowsCommandHasExactArg(commandLine: string, arg: string): boolean {
  return new RegExp(`(?:^|[\\s"])${regexpEscape(arg)}(?=$|[\\s"])`, "i").test(commandLine);
}

/** Parse PPID, process group and start time from Linux /proc/<pid>/stat. */
export function parseLinuxProcStat(raw: string): Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime"> | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isInteger(parentPid) || !Number.isInteger(processGroupId) || !/^\d+$/.test(startTime ?? "")) return null;
  return { parentPid, processGroupId, startTime };
}

/** Exact root-anchored Linux ancestry, deepest children first and root last. */
export function collectLinuxProcessTree(
  rootPid: number,
  snapshot: HostProcessSnapshot,
): Array<{ pid: number; startTime: string; depth: number }> | null {
  if (snapshot.incomplete) return null;
  const byPid = new Map<number, HostProcessRecord>();
  for (const record of snapshot.records) {
    if (byPid.has(record.pid)) return null;
    byPid.set(record.pid, record);
  }
  const root = byPid.get(rootPid);
  if (!root?.startTime || root.parentPid === undefined) return null;
  const members = new Map<number, { pid: number; startTime: string; depth: number }>();
  members.set(rootPid, { pid: rootPid, startTime: root.startTime, depth: 0 });
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of snapshot.records) {
      if (members.has(record.pid) || !record.startTime || record.parentPid === undefined) continue;
      const parent = members.get(record.parentPid);
      if (!parent) continue;
      members.set(record.pid, { pid: record.pid, startTime: record.startTime, depth: parent.depth + 1 });
      changed = true;
    }
  }
  return [...members.values()].sort((a, b) => b.depth - a.depth || b.pid - a.pid);
}

function readLinuxProcOwnership(pid: number): Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime"> {
  const ownership = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (!ownership) throw new Error(`invalid /proc/${pid}/stat`);
  return ownership;
}

function readLinuxProcessRecord(pid: number): HostProcessRecord | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return { pid, executablePath: null, ...readLinuxProcOwnership(pid) };
  } catch {
    return null;
  }
}

async function readHostProcessSnapshot(): Promise<HostProcessSnapshot | null> {
  if (IS_WINDOWS) {
    try {
      const script = [
        "Get-CimInstance -Query 'SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE CommandLine IS NOT NULL' -OperationTimeoutSec 50 -ErrorAction Stop",
        "ConvertTo-Json -Compress",
      ].join(" | ");
      const child = Bun.spawn(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        { stdout: "pipe", stderr: "ignore" },
      );
      const result = await readSnapshotChildBounded(
        child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
        WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
      );
      if (!result || result.exitCode !== 0) return null;
      const parsed = result.raw.trim() ? JSON.parse(result.raw) : [];
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const records: HostProcessRecord[] = [];
      for (const row of rows) {
        const pid = Number(row.ProcessId);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        records.push({
          pid,
          executablePath: typeof row?.ExecutablePath === "string" && row.ExecutablePath ? row.ExecutablePath : null,
          commandLine: typeof row?.CommandLine === "string" ? row.CommandLine : "",
        });
      }
      return { records, incomplete: false };
    } catch {
      return null;
    }
  }

  if (process.platform === "linux") {
    try {
      const records: HostProcessRecord[] = [];
      let scanIncomplete = false;
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        let before: Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime">;
        try {
          before = readLinuxProcOwnership(pid);
        } catch (err) {
          if ((err as { code?: string })?.code !== "ENOENT") scanIncomplete = true;
          continue;
        }
        let argv: string[];
        try {
          argv = readFileSync(`/proc/${entry}/cmdline`)
            .toString("utf8")
            .split("\0")
            .filter(Boolean);
        } catch (err) {
          if ((err as { code?: string })?.code !== "ENOENT") scanIncomplete = true;
          continue;
        }
        let executablePath: string | null = null;
        try {
          executablePath = readlinkSync(`/proc/${entry}/exe`);
        } catch {
          // Keep the record with a null executable. It is ambiguous only if its
          // exact launch args match the identity being filtered; an unrelated
          // protected process must not poison every Linux empty result.
        }
        let after: Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime">;
        try {
          after = readLinuxProcOwnership(pid);
        } catch (err) {
          if ((err as { code?: string })?.code !== "ENOENT") scanIncomplete = true;
          continue;
        }
        if (before.startTime !== after.startTime) {
          scanIncomplete = true;
          continue;
        }
        const flattenedCommandLine = argv.length === 1 && /\s--/.test(argv[0]!);
        records.push({
          pid,
          executablePath,
          ...(flattenedCommandLine ? { commandLine: argv[0] } : { argv }),
          ...after,
        });
      }
      return { records, incomplete: scanIncomplete };
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    // macOS has no /proc and no dependency-free way to read a tokenized argv, so
    // read the flattened command line from `ps` and match args as exact
    // whitespace-delimited tokens (windowsCommandHasExactArg tolerates spaces in
    // a value and rejects prefix collisions like port 9333 vs 93330). The
    // executable is argv[0]; if that path itself contains spaces it degrades to
    // "ambiguous" (preserve the lock) rather than a false confirmed-absence.
    try {
      const child = Bun.spawn(["ps", "-axww", "-o", "pid=", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
      const result = await readSnapshotChildBounded(
        child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
        DARWIN_PROCESS_SCAN_TIMEOUT_MS,
      );
      if (!result || result.exitCode !== 0) return null;
      return parseDarwinPsSnapshot(result.raw);
    } catch {
      return null;
    }
  }

  // No equally exact, dependency-free command-line scanner is available here.
  return null;
}

async function readWindowsProcessImageNames(): Promise<Set<string> | null> {
  if (!IS_WINDOWS) return null;
  try {
    const child = Bun.spawn(
      ["tasklist.exe", "/FO", "CSV", "/NH"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const result = await readSnapshotChildBounded(
      child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
      WINDOWS_TASKLIST_TIMEOUT_MS,
    );
    if (!result || result.exitCode !== 0) return null;
    return parseTasklistImageNames(result.raw);
  } catch {
    return null;
  }
}

/** Parse the stable `pid= args=` shape emitted by macOS ps. */
export function parseDarwinPsSnapshot(raw: string): HostProcessSnapshot {
  const records: HostProcessRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimStart();
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const commandLine = match[2] ?? "";
    // This is exact for the common no-space case. matchOwnedBrowserPids also
    // validates commandLine against the full expected executable path, which
    // safely recovers app bundle paths such as `/Applications/Cloak Browser…`.
    const executablePath = commandLine.split(/\s+/, 1)[0] || null;
    records.push({ pid, executablePath, executablePathExact: false, commandLine });
  }
  return { records, incomplete: false };
}

function commandLineStartsWithExecutable(commandLine: string, executablePath: string): boolean {
  const line = commandLine.trimStart();
  return line === executablePath
    || line.startsWith(`${executablePath} `)
    || line === `"${executablePath}"`
    || line.startsWith(`"${executablePath}" `);
}

// One raw CIM or /proc snapshot serves all ownership checks that overlap in
// time (for example a 25-browser teardown wave). The coalescer clears as soon
// as the read settles: an empty result is never reused after a process starts.
const readSharedHostProcessSnapshot = createFailureBackoffReader(
  readHostProcessSnapshot,
  (snapshot) => snapshot === null,
  FAILED_PROCESS_SCAN_BACKOFF_MS,
);
const readSharedWindowsProcessImageNames = createInFlightSnapshotReader(readWindowsProcessImageNames);

/**
 * Find only Chromium processes that carry this launch's full stable identity.
 * A stored PID alone is never sufficient after restart because the OS may have
 * recycled it. null is deliberately distinct from []: scan failure/ambiguity
 * must preserve ownership, while a successful exact scan with no matches can
 * prove a PID-less/dead row stale.
 */
async function findOwnedBrowserPids(identity: BrowserProcessIdentity): Promise<number[] | null> {
  const snapshot = await readSharedHostProcessSnapshot();
  if (!snapshot) {
    if (IS_WINDOWS) {
      const names = await readSharedWindowsProcessImageNames();
      if (names) {
        const candidates = new Set([
          "chrome.exe",
          "sunbrowser.exe",
          basename(identity.binaryPath).toLowerCase(),
        ]);
        if (![...candidates].some((name) => names.has(name))) return [];
      }
    }
    return null;
  }

  return matchOwnedBrowserPids(identity, snapshot);
}

/** Pure exact-identity classifier, exported for deterministic lifecycle tests. */
export function matchOwnedBrowserPids(
  identity: BrowserProcessIdentity,
  snapshot: HostProcessSnapshot,
): number[] | null {

  const portArg = `--remote-debugging-port=${identity.debugPort}`;
  const dataArg = `--user-data-dir=${identity.userDataDir}`;
  const expectedBinary = normalizedExecutablePath(identity.binaryPath);
  const matches: number[] = [];
  let ambiguousIdentity = snapshot.incomplete;

  for (const record of snapshot.records) {
    const hasIdentityArgs = record.argv
      ? record.argv.includes(portArg) && record.argv.includes(dataArg)
      : windowsCommandHasExactArg(record.commandLine ?? "", portArg)
        && windowsCommandHasExactArg(record.commandLine ?? "", dataArg);
    if (!hasIdentityArgs) continue;
    const flattenedExecutableMatches = record.executablePathExact === false
      && !record.argv
      && !!record.commandLine
      && commandLineStartsWithExecutable(record.commandLine, identity.binaryPath);
    if (!record.executablePath && !flattenedExecutableMatches) {
      ambiguousIdentity = true;
      continue;
    }
    if (flattenedExecutableMatches
      || (record.executablePath && normalizedExecutablePath(record.executablePath) === expectedBinary)) {
      matches.push(record.pid);
    }
    else {
      // Exact port+UDD args owned by a different/unreadable executable still
      // occupy this browser generation's resources. Treat that as quarantine,
      // never authoritative absence that permits a duplicate launch.
      ambiguousIdentity = true;
    }
  }

  return ambiguousIdentity && matches.length === 0 ? null : matches;
}

/**
 * Every process holding this exact persistent user-data dir, on ANY debug port —
 * the leaked-browser question findOwnedBrowserPids structurally cannot answer,
 * because it matches the recorded debug port too. See reapForeignProfileDirHolders.
 */
async function findProfileDirHolderPids(userDataDir: string): Promise<number[] | null> {
  const snapshot = await readSharedHostProcessSnapshot();
  if (!snapshot) return null;
  return matchProfileDirHolderPids(userDataDir, snapshot);
}

/** Pure dir-holder classifier, exported for deterministic lifecycle tests. */
export function matchProfileDirHolderPids(
  userDataDir: string,
  snapshot: HostProcessSnapshot,
): number[] | null {
  const dataArg = `--user-data-dir=${userDataDir}`;
  const holders: number[] = [];
  for (const record of snapshot.records) {
    // Exact-arg matching, never substring: `--user-data-dir=<dir>2` and
    // `<dir>\..\other` are DIFFERENT profiles and must never be reaped here.
    const holdsDir = record.argv
      ? record.argv.includes(dataArg)
      : windowsCommandHasExactArg(record.commandLine ?? "", dataArg);
    if (holdsDir) holders.push(record.pid);
  }
  // An incomplete scan that found nothing is inconclusive, not an authoritative "none".
  return snapshot.incomplete && holders.length === 0 ? null : holders;
}

/** Cross-platform best-effort kill by pid. Used for cross-process orphans. */
async function killByPid(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (IS_WINDOWS) {
    try {
      const proc = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
      // Await completion: if stop() resolves before the browser is actually
      // gone, a fast re-start() on the same user-data dir hits SingletonLock.
      await proc.exited;
    } catch {}
    return;
  }
  await signalUnixTarget(pid);
}

async function signalUnixTarget(target: number): Promise<void> {
  try {
    process.kill(target, "SIGKILL");
  } catch (err) {
    if ((err as { code?: string })?.code !== "ESRCH") throw err;
  }
}

/**
 * Graceful browser shutdown over CDP: connect to the browser-level ws endpoint,
 * send Browser.close (which makes Chromium flush its cookie/session store to disk
 * and tear down its own process tree), then poll the debug port until it stops
 * answering. That proves only that CDP dropped its listener; stop() follows it
 * with an exact OS process scan because a wedged Chromium can survive without
 * the port. Returns false if the listener did not close within `timeoutMs`.
 * Waiting first avoids force-killing while Chromium is flushing. Uses the CDP
 * command (not an OS signal or window close) because a page beforeunload handler
 * can block a window close, but Browser.close cannot.
 */
async function defaultBrowserClose(ws: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const port = Number(ws.match(/^wss?:\/\/[^/]*:(\d+)\//)?.[1]);
  if (!Number.isFinite(port)) return false;

  // Send Browser.close (best-effort; the port poll below is the source of truth).
  await new Promise<void>((resolve) => {
    let sock: WebSocket | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock?.close(); } catch {}
      resolve();
    };
    const t = setTimeout(done, Math.min(2000, timeoutMs));
    try { sock = new WebSocket(ws); } catch { return done(); }
    sock.addEventListener("open", () => {
      try { sock!.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch {}
    });
    sock.addEventListener("message", done); // command acknowledged
    sock.addEventListener("close", done);
    sock.addEventListener("error", done);
  });

  // Poll the debug endpoint until it's dead = process exited, cookies committed.
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
      await res.text().catch(() => {});
    } catch (err) {
      // An AbortSignal timeout means only that an overloaded debug endpoint did
      // not answer within 800ms. Keep polling until the graceful-close budget is
      // exhausted, then return false so stop() performs its authoritative tree
      // kill. Connection-refused/reset failures do prove the listener is gone.
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        await sleep(150);
        continue;
      }
      return true;
    }
    await sleep(150);
  }
  return false;
}

function defaultBinaryPath(): string {
  const configured = process.env.CLOAKBROWSER_BINARY_PATH ?? "";
  if (configured) return configured;
  const bundled = join(process.cwd(), "cloakbrowser", "chrome.exe");
  return IS_WINDOWS && existsSync(bundled) ? bundled : "";
}

export function shouldLaunchViaWindowsSession(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const modern = (env.ALIASMODE_SESSION_LAUNCH ?? "").trim().toLowerCase();
  const legacy = (env.ALIASMODE_LAUNCH_IN_SESSION ?? "").trim().toLowerCase();
  if ([modern, legacy].some((v) => ["0", "false", "no", "off"].includes(v))) return false;
  if ([modern, legacy].some((v) => ["1", "true", "yes", "on"].includes(v))) return true;
  return (env.SESSIONNAME ?? "").trim().toLowerCase() === "services";
}

/**
 * Quote a single argument for a Windows command line the way CreateProcess's
 * argv parser expects (the same rules CommandLineToArgvW uses): backslashes
 * are literal UNLESS they immediately precede a quote, in which case each one
 * must be doubled (plus one more to escape the quote itself). A naive
 * `s.replace(/"/g, '\\"')` gets this wrong for any argument that ends in a
 * backslash or mixes backslashes with quotes — the stray backslash escapes
 * the closing quote instead of ending the argument, corrupting the next
 * argument's boundary.
 */
export function quoteWindowsCommandArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
    } else if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + ch;
      slashes = 0;
    } else {
      out += "\\".repeat(slashes) + ch;
      slashes = 0;
    }
  }
  out += "\\".repeat(slashes * 2) + '"';
  return out;
}

async function killProcessGroup(processGroupId: number): Promise<void> {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return;
  await signalUnixTarget(-processGroupId);
}

export const defaultSpawn: SpawnFn = (binary, args) => {
  const detached = process.platform === "linux";
  const proc = Bun.spawn([binary, ...args], { stdout: "ignore", stderr: "ignore", detached });
  const root = detached ? readLinuxProcessRecord(proc.pid) : null;
  const ownsGroup = root?.processGroupId === proc.pid;
  return {
    pid: proc.pid,
    kill: () => proc.kill(),
    ...(ownsGroup ? { processGroupId: proc.pid, rootStartTime: root.startTime } : {}),
  };
};

// Path to the PowerShell session-launch helper (repo-relative to this module).
const SESSION_HELPER = join(import.meta.dir, "packaging", "launch-in-session.ps1");

/**
 * Windows-only spawn that launches the browser ON THE INTERACTIVE USER'S DESKTOP,
 * so windows are VISIBLE even when aliasmode runs as a service (Session 0). A service
 * can't show windows itself, so it delegates to a per-launch interactive scheduled
 * task via launch-in-session.ps1, which returns the browser's real PID (found by its
 * --remote-debugging-port) for clean teardown. Enabled automatically for NSSM/service
 * sessions, or explicitly with ALIASMODE_SESSION_LAUNCH=1.
 */
function sessionLaunchSpawn(
  binary: string,
  args: string[],
  log: (msg: string) => void = () => {},
): SpawnedProcess {
  const cmdline = [binary, ...args].map(quoteWindowsCommandArg).join(" ");
  const portArg = args.find((a) => a.startsWith("--remote-debugging-port="));
  const port = portArg ? portArg.slice("--remote-debugging-port=".length) : "0";
  let reportSpawnResult: (reason: string | null) => void = () => {};
  const spawnFailed = new Promise<string | null>((resolve) => { reportSpawnResult = resolve; });
  // NON-BLOCKING: fire the helper async and fill in the PID later. Using Bun.spawnSync here
  // blocked aliasmode's event loop for the whole launch (~seconds each), so dozens of concurrent
  // /browser/start calls serialized and timed out at 120s. proc.pid is read later at stop() time.
  const proc: SpawnedProcess = {
    pid: 0,
    kill: () => { if (proc.pid > 0) { try { Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]); } catch {} } },
    spawnFailed,
  };
  try {
    const child = Bun.spawn(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SESSION_HELPER, "-CommandLine", cmdline, "-Port", port],
      { stdout: "pipe", stderr: "pipe" },
    );
    // Read the recovered browser PID off the helper's stdout without blocking
    // the loop, but do not retain a hung PowerShell/stdout promise forever.
    // After the bound, exact process scanning in Launcher recovers the PID (or
    // reports unknown) without treating PID 0 as proof of life.
    //
    // stderr and the EXIT CODE are load-bearing, not noise: the helper reports the
    // resolved interactive user, the scheduled task's state/lastResult, and exits 2 when
    // nobody is logged in at all ("No interactive user found"). Discarding them (stderr
    // was "ignore", the exit code was never read) made every spawn-side outage
    // indistinguishable from a slow browser — a silent 60s CDP timeout per launch, on
    // every profile, with nothing in the log to say why.
    (async () => {
      try {
        const result = await Promise.race([
          Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]).then(([out, err, exitCode]) => ({ out, err, exitCode })),
          sleep(SESSION_PID_RECOVERY_TIMEOUT_MS).then(() => null),
        ]);
        if (!result) {
          try { child.kill(); } catch {}
          // A hung helper is not proof the browser failed; the CDP poll decides.
          reportSpawnResult(null);
          return;
        }
        const { out, err, exitCode } = result;
        for (const line of err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          log(`session-launch: ${line}`);
        }
        const found = parseInt(out.trim().split(/\s+/).filter(Boolean).pop() || "0", 10);
        if (found > 0) proc.pid = found;
        if (exitCode !== 0) {
          const detail = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
          reportSpawnResult(
            `interactive session launch helper exited ${exitCode}${detail ? `: ${detail}` : ""}`,
          );
          return;
        }
        // Exit 0 with no PID is not proof of failure — the helper's own scan can lag
        // behind a browser that is still coming up. Let the CDP poll be the judge.
        reportSpawnResult(null);
      } catch { /* pid stays 0; graceful CDP close still tears the browser down */
        reportSpawnResult(null);
      }
    })();
  } catch (err) {
    // Could not even run PowerShell/the helper: the browser provably never started.
    const detail = err instanceof Error ? err.message : String(err);
    log(`session-launch: could not run ${SESSION_HELPER}: ${detail}`);
    reportSpawnResult(`could not run the interactive session launch helper: ${detail}`);
  }
  return proc;
}

/** True when browsers should be launched onto the interactive desktop (service + opt-in). */
const SESSION_LAUNCH = shouldLaunchViaWindowsSession();

/** aliasmode's own HTTP port, so the profile card can be served/opened over loopback. */
const ALIASMODE_PORT = process.env.ALIASMODE_PORT ? Number(process.env.ALIASMODE_PORT) : 50400;
function profileCardUrl(profileId: string): string {
  return `http://127.0.0.1:${ALIASMODE_PORT}/card?id=${encodeURIComponent(profileId)}`;
}

/**
 * Open the profile identity card (AdsPower-style landing page) in a NEW tab, so the
 * automation's own tab (tab 0) is never disturbed. Best-effort — never fails a launch.
 */
async function openProfileCardTab(ws: string, url: string): Promise<void> {
  await runPlaywrightWorker("profile-card", {
    endpoint: ws,
    url,
    connectTimeoutMs: 10_000,
  });
}

/**
 * Put an identity bookmark (`<name> · #<serial>` → the card) on the bookmark bar and make
 * the bar visible. Best-effort and self-contained: writes a fresh Bookmarks file (automation
 * profiles carry no user bookmarks) and safely merges the show-bar pref into a VALID
 * Preferences (a corrupt one is left for repairCorruptPrefs). Never throws into a launch.
 */
function writeIdentityBookmark(userDataDir: string, name: string, url: string): void {
  try {
    const dir = join(userDataDir, "Default");
    mkdirSync(dir, { recursive: true });
    const bookmarks = {
      roots: {
        bookmark_bar: { children: [{ name, type: "url", url }], name: "Bookmarks bar", type: "folder" },
        other: { children: [], name: "Other bookmarks", type: "folder" },
        synced: { children: [], name: "Mobile bookmarks", type: "folder" },
      },
      version: 1,
    };
    writeFileSync(join(dir, "Bookmarks"), JSON.stringify(bookmarks));
    const prefsPath = join(dir, "Preferences");
    let prefs: any = {};
    if (existsSync(prefsPath)) {
      try { prefs = JSON.parse(readFileSync(prefsPath, "utf8")); } catch { return; } // corrupt → leave for repair
    }
    if (typeof prefs !== "object" || prefs === null) return;
    prefs.bookmark_bar = { ...(prefs.bookmark_bar ?? {}), show_on_all_tabs: true };
    writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch { /* best-effort: identity extras must never fail a launch */ }
}

const defaultNavigate: LaunchNavigator = async (ws, urls) => {
  await runPlaywrightWorker("navigate", {
    endpoint: ws,
    urls,
    connectTimeoutMs: 30_000,
  });
};

/** The window-title prefix that identifies a profile: `<name> · #<serial> — `. */
export function buildWindowLabel(name: string, serial: number | null): string {
  const n = (name || "").trim() || "profile";
  return serial != null ? `${n} · #${serial} — ` : `${n} — `;
}

/**
 * In-page script that keeps `label` prefixed on the window/tab title. The
 * platform (X is an SPA) rewrites document.title constantly, so a one-shot set
 * won't stick: re-apply on every title mutation, plus a slow interval as a
 * belt-and-suspenders. The `startsWith(label)` guard makes our own write a
 * no-op so the MutationObserver can't loop. Self-contained (serialized to the
 * page) and fully defensive — it must never throw into the host page.
 */
function buildLabelScript(label: string): string {
  const L = JSON.stringify(label);
  return `(() => { try {
    var L = ${L};
    var apply = function(){ try { if (document.title.indexOf(L) !== 0) document.title = L + document.title; } catch(e){} };
    var start = function(){
      apply();
      try {
        var el = document.querySelector('title') || document.head || document.documentElement;
        if (el) new MutationObserver(apply).observe(el, { subtree: true, childList: true, characterData: true });
      } catch(e){}
      try { setInterval(apply, 3000); } catch(e){}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  } catch(e){} })();`;
}

/**
 * Default window labeler: connect Playwright over CDP, register the title script
 * for future navigations, and apply it to the already-open page(s) now. Like the
 * other CDP helpers, close() only detaches the client (the browser keeps running).
 * Short connect timeout so a launch is never held up on labeling.
 */
const defaultLabelWindow: WindowLabeler = async (ws, label) => {
  await runPlaywrightWorker("label-window", {
    endpoint: ws,
    script: buildLabelScript(label),
    connectTimeoutMs: 10_000,
  });
};

/**
 * Default cookie injector: connect Playwright over CDP, add cookies to the
 * default context, then disconnect. connectOverCDP's close() detaches the
 * client without terminating the browser, leaving the persistent dir seeded.
 */
const defaultEnsureCookies: CookieEnsurer = async (ws, cookies) => {
  const target = cookieBootstrapTarget(cookies);
  if (!target) return { injected: false };
  return runPlaywrightWorker<{ injected: boolean }>("ensure-cookies", {
    endpoint: ws,
    url: target.url,
    target: target.name,
    cookies,
    connectTimeoutMs: 30_000,
  });
};

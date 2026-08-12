#!/usr/bin/env bun
/**
 * AliasMode browser profile manager CLI.
 *
 * Easiest path (drop-in):
 *   1. Put your AdsPower export .txt file(s) in inbox/
 *   2. export CLOAKBROWSER_BINARY_PATH=/path/to/cloakbrowser
 *      export CLOAKBROWSER_BINARY_SHA256=<approved 64-character sha256>
 *   3. bun cli.ts start      # imports inbox, then serves on :50400
 *   4. Set a campaign's "Base URL" to http://127.0.0.1:50400 and run it.
 *
 * Other commands:
 *   bun cli.ts install-browser     # download, verify, and pin CloakBrowser
 *   bun cli.ts import [file|dir]   # default: import the inbox
 *   bun cli.ts serve   [--port 50400] [--headless]
 *   bun cli.ts list
 *
 * Common flags: --db <path>  --state-root <dir>  --migrate-from <legacy-dir>
 *               --data-root <dir>  --port <n>
 */

import { parseExport, decodeText, splitRecords } from "./parse.ts";
import { ProfileStore } from "./store.ts";
import { Launcher, type ProxyVerifier } from "./launcher.ts";
import { serveDashboard } from "./web.ts";
import { LifecycleAdmissionController, type LifecycleAdmissionOptions } from "./lifecycle-admission.ts";
import { HubClient } from "./hub-client.ts";
import { RemoteCoordinator } from "./remote.ts";
import {
  playwrightTransportAttribution,
  readSession,
  readSessionInSubprocess,
  READ_SESSION_WORKER_ARG,
  runReadSessionWorker,
  writeSession,
  applySessionToEndpoint,
} from "./session.ts";
import { importBuffers, importInbox, watchInbox } from "./inbox.ts";
import { ensureStateDirectories, profileDataPaths, resolveStateRoot, statePaths, type StatePaths } from "./paths.ts";
import { migrateLegacyState } from "./migration.ts";
import {
  AppConfigStore,
  legacyHubUrl,
  normalizeSecureServiceUrl,
  type AppConfig,
} from "./app-config.ts";
import { CloudAuthRuntime } from "./cloud-auth.ts";
import { CloudConnectionRuntime } from "./cloud-connection.ts";
import { CloudBrowserCoordinator } from "./cloud-browser.ts";
import { PendingSyncQueue, PendingSyncRuntime } from "./pending-sync.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import type { Profile } from "./types.ts";
import { SupabaseAuthClient } from "./supabase-auth.ts";
import { runDiagnostics } from "./diagnose.ts";
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { defaultOperatorName } from "./operator.ts";
import { ensureDuckDuckGoDefault } from "./search-provider.ts";
import { installCloakBrowser } from "./browser-install.ts";
import { verifyRelayEgress } from "./egress.ts";
import { canonicalIp } from "./ip.ts";
import { ALIASMODE_VERSION } from "./version.ts";
import {
  DESKTOP_PROTOCOL,
  DesktopCredentialBridge,
  ManagedDesktopRuntime,
  desktopHealthMetadata,
  desktopReadyRecord,
  isDesktopShutdownCommand,
  type DesktopHealthMetadata,
} from "./desktop-runtime.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export const OFFICIAL_CLOUD_URL = "https://cloud.aliasmode.com";
export const OFFICIAL_CLOUD_ANON_KEY = "aliasmode-direct-gotrue";

export interface CloudRuntimeConfiguration {
  apiUrl: string;
  authUrl: string;
  anonKey: string;
}

function nonblank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function selectedCloudUrl(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  return nonblank(env.ALIASMODE_CLOUD_URL) ?? config.cloudUrl ?? OFFICIAL_CLOUD_URL;
}

export function cloudRuntimeConfiguration(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): CloudRuntimeConfiguration | null {
  if (config.mode !== "cloud") return null;
  const cloudUrl = normalizeSecureServiceUrl(
    selectedCloudUrl(config, env),
    "AliasMode Cloud",
  );
  return {
    apiUrl: cloudUrl,
    authUrl: normalizeSecureServiceUrl(
      nonblank(env.ALIASMODE_SUPABASE_URL) ?? cloudUrl,
      "AliasMode Auth",
    ),
    anonKey: nonblank(env.ALIASMODE_SUPABASE_ANON_KEY) ?? OFFICIAL_CLOUD_ANON_KEY,
  };
}

export function lifecycleAdmissionOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): LifecycleAdmissionOptions {
  const options: LifecycleAdmissionOptions = {};
  const read = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const limit = read("ALIASMODE_LIFECYCLE_CAP");
  const queueWaitMs = read("ALIASMODE_LIFECYCLE_WAIT_MS");
  if (limit !== undefined) options.limit = limit;
  if (queueWaitMs !== undefined) options.queueWaitMs = queueWaitMs;
  return options;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function startMemoryAttributionLog(coord?: RemoteCoordinator): void {
  const report = () => {
    const memory = process.memoryUsage();
    const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const unattributedRss = Math.max(0, memory.rss - memory.heapTotal - memory.external);
    const transports = playwrightTransportAttribution();
    const attribution = coord?.memoryAttribution();
    const captureDetails = attribution
      ? ` captures=${attribution.sessionCapturesSettled}/${attribution.sessionCapturesStarted}` +
        ` captureErrors=${attribution.sessionCaptureErrors} pendingReads=${attribution.pendingSessionReads}` +
        ` capturedTotal=${mb(attribution.sessionCaptureBytes)}MB largestCapture=${mb(attribution.largestSessionCaptureBytes)}MB` +
        ` syncs=${attribution.pendingSessionSyncs} pushes=${attribution.pendingPushes}` +
        ` heartbeats=${attribution.pendingHeartbeats} opening=${attribution.opening} closing=${attribution.closing}` +
        ` retained=${attribution.retainedCleanups} telegram=${attribution.telegramProfiles}`
      : "";
    console.log(
      `[memory] rss=${mb(memory.rss)}MB heap=${mb(memory.heapUsed)}/${mb(memory.heapTotal)}MB ` +
      `external=${mb(memory.external)}MB buffers=${mb(memory.arrayBuffers)}MB unattributedRss=${mb(unattributedRss)}MB` +
      ` parentTransports=${transports.active}/${transports.opened}/${transports.closed} forcedTransports=${transports.forced}` +
      captureDetails,
    );
  };
  report();
  const timer = setInterval(report, 60_000);
  timer.unref?.();
}

export interface RemoteShutdownDrainOptions {
  /** How long to observe one cleanup call before logging that it is still pending. */
  attemptLogMs?: number;
  /** Delay before retrying after releaseAll settles without confirmation. */
  retryMs?: number;
  /**
   * Total cleanup budget. Expiry rejects without releasing locks or deleting
   * launch rows, so the next process can safely reconcile/reclaim them.
   */
  maxDrainMs?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_REMOTE_SHUTDOWN_TIMEOUT_MS = 3 * 60_000;

export class RemoteShutdownTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly attempts: number,
  ) {
    super(
      `remote shutdown cleanup was not confirmed within ${timeoutMs}ms after ${attempts} attempt(s); ` +
      "launch records and any unconfirmed hub locks were intentionally retained",
    );
    this.name = "RemoteShutdownTimeoutError";
  }
}

/**
 * Keep a remote shutdown fail-closed until every browser stop and hub unlock is
 * confirmed, up to a process-level shutdown budget. A slow releaseAll call is
 * observed in bounded windows for useful logs, but never overlapped with
 * another call: two concurrent close/release passes could race the same
 * profile. A settled false/error is retried because retained browser cleanup
 * continues in the background. Budget expiry preserves durable ownership and
 * rejects so the caller can exit non-zero instead of squatting on its API port
 * forever; a replacement process then reconciles the retained launch rows.
 */
export async function drainRemoteShutdown(
  releaseAll: () => Promise<boolean>,
  opts: RemoteShutdownDrainOptions = {},
): Promise<void> {
  const attemptLogMs = Math.max(1, opts.attemptLogMs ?? 30_000);
  const retryMs = Math.max(1, opts.retryMs ?? 5_000);
  const maxDrainMs = Math.max(1, opts.maxDrainMs ?? DEFAULT_REMOTE_SHUTDOWN_TIMEOUT_MS);
  const log = opts.log ?? ((message: string) => console.error(message));
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + maxDrainMs;
  let attempt = 0;

  while (true) {
    const remainingBeforeAttempt = deadline - now();
    if (remainingBeforeAttempt <= 0) throw new RemoteShutdownTimeoutError(maxDrainMs, attempt);
    attempt++;
    const pending = Promise.resolve().then(releaseAll);
    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new RemoteShutdownTimeoutError(maxDrainMs, attempt);
      const observed = await observeShutdownAttempt(pending, Math.min(attemptLogMs, remaining));
      if (!observed.settled) {
        if (now() >= deadline) throw new RemoteShutdownTimeoutError(maxDrainMs, attempt);
        log(`shutdown cleanup attempt ${attempt} is still pending after ${attemptLogMs}ms; continuing to wait without overlapping it`);
        continue;
      }
      if (observed.ok && observed.confirmed) {
        if (attempt > 1) log(`shutdown cleanup confirmed on attempt ${attempt}`);
        return;
      }
      const detail = observed.ok ? "teardown or unlock remains unconfirmed" : `failed (${observed.error})`;
      log(`shutdown cleanup attempt ${attempt} ${detail}; retrying in ${retryMs}ms`);
      break;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new RemoteShutdownTimeoutError(maxDrainMs, attempt);
    await wait(Math.min(retryMs, remaining));
  }
}

async function observeShutdownAttempt(
  pending: Promise<boolean>,
  timeoutMs: number,
): Promise<
  | { settled: false }
  | { settled: true; ok: true; confirmed: boolean }
  | { settled: true; ok: false; error: string }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  const settled = pending.then(
    (confirmed) => ({ settled: true as const, ok: true as const, confirmed }),
    (error) => ({
      settled: true as const,
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function attachDesktopControl(
  runtime: ManagedDesktopRuntime,
  health: DesktopHealthMetadata,
  port: number,
  credentials: DesktopCredentialBridge,
): void {
  let input = "";
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    void runtime.shutdown()
      .then(() => {
        process.stdout.write(
          `${JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "shutdown-complete", nonce: health.instance })}\n`,
          () => process.exit(0),
        );
      })
      .catch((error) => {
        console.error(`desktop shutdown cleanup unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
        process.stdout.write(
          `${JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "shutdown-failed", nonce: health.instance })}\n`,
          () => process.exit(1),
        );
      });
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (credentials.handleLine(line)) continue;
      if (isDesktopShutdownCommand(line, health.instance)) shutdown();
    }
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(`${JSON.stringify(desktopReadyRecord(health.instance, port))}\n`);
}

function makeLauncher(
  store: ProfileStore,
  rest: string[],
  remoteMode = false,
  defaultDataRoot = "profiles",
  verifyProxy?: ProxyVerifier,
): Launcher {
  return new Launcher({
    store,
    dataRoot: defaultDataRoot,
    headless: has(rest, "headless"),
    // Explicit canary-only escape hatch for constrained test hosts where a
    // full browser identity probe cannot complete. Never enable in production.
    unsafeDisableIdentityGates: has(rest, "unsafe-disable-identity-gates"),
    // AliasMode owns the browser process, but it is not the external campaign
    // client that requested it. Keep the ownership namespaces distinct so that
    // client can identify a dead browser while AliasMode stays up.
    // A forwarded external launcher marker remains in launchArgs untouched.
    // Containers with user namespaces disabled can opt out of Chromium's
    // sandbox explicitly; normal hosts keep the sandbox enabled by default.
    baseArgs: [
      `--aliasmode-launcher-pid=${process.pid}`,
      ...(has(rest, "no-sandbox") ? ["--no-sandbox"] : []),
    ],
    ensureSearchProvider: ensureDuckDuckGoDefault,
    ...(verifyProxy ? { verifyProxy } : {}),
    // In remote mode the coordinator injects the roamed session over CDP, so the launcher's own
    // bootstrap cookie injection is turned off — and because the login is re-injected from the hub,
    // it's safe to reset a crash-corrupted profile's volatile storage on launch (auto-heals the
    // "something went wrong opening your profile" dialog) instead of the login being disk-authoritative.
    ...(remoteMode ? { ensureCookies: async () => ({ injected: false }), resetStorageOnUncleanExit: true } : {}),
  });
}

function makeCloudBrowser(
  launcher: Launcher,
  store: ProfileStore,
  connection: CloudConnectionRuntime | undefined,
  pendingSync: PendingSyncRuntime | undefined,
): CloudBrowserCoordinator | undefined {
  if (!connection || !pendingSync) return undefined;
  return new CloudBrowserCoordinator({
    cloud: connection.client,
    launcher,
    store,
    queue: () => pendingSync.queue(),
    accountId: () => connection.accountId(),
    deviceId: () => connection.deviceId(),
    readSession: readSessionInSubprocess,
    applySession: applySessionToEndpoint,
  });
}

function installCloudShutdown(cloudBrowser: CloudBrowserCoordinator): void {
  let shutdownInFlight: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownInFlight) {
      process.exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    console.error(`received ${signal}; capturing and closing Cloud browsers`);
    shutdownInFlight = drainRemoteShutdown(
      () => cloudBrowser.releaseAll(true),
      { maxDrainMs: DEFAULT_REMOTE_SHUTDOWN_TIMEOUT_MS },
    )
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`Cloud shutdown cleanup unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function importPath(store: ProfileStore, target: string | undefined, defaultInbox: string): Promise<void> {
  // No arg, or a directory → import the inbox / that directory.
  if (!target || target.startsWith("--") || isDir(target ?? "")) {
    const dir = !target || target.startsWith("--") ? defaultInbox : target;
    const r = await importInbox(store, dir);
    console.log(`imported ${r.profiles} profile(s) from ${r.files} file(s) in ${dir}; stripped ${r.cookiesStripped} extension cookie(s); reported ${r.errors.length} invalid record(s)`);
    return;
  }
  // A single file.
  const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
  const result = await importBuffers(store, [{ name: target, bytes }]);
  console.log(
    `imported ${result.profiles} profile(s) from ${target}; stripped ${result.cookiesStripped} ` +
    `extension cookie(s); skipped ${result.skipped}; reported ${result.errors.length} invalid record(s)`,
  );
}

export async function dispatchReadSessionWorker(
  argv: string[],
  deps: Parameters<typeof runReadSessionWorker>[1] = {
    readSession,
    write: (value) => Bun.write(Bun.stdout, value),
    exit: (code) => process.exit(code),
  },
): Promise<boolean> {
  if (argv[0] !== READ_SESSION_WORKER_ARG) return false;
  await runReadSessionWorker(argv, deps);
  return true;
}

export interface CompiledSidecarSmokeDeps {
  writeSession: (endpoint: string, bundle: string) => Promise<void>;
  readSession: (endpoint: string) => Promise<string>;
  navigate: (endpoint: string) => Promise<void>;
  assertAlive: (endpoint: string) => Promise<void>;
  webSocketEndpoint: (endpoint: string) => Promise<string>;
}

async function assertCdpAlive(endpoint: string): Promise<void> {
  const versionUrl = new URL(endpoint);
  if (versionUrl.protocol !== "http:" && versionUrl.protocol !== "https:") {
    throw new Error("compiled sidecar smoke requires an HTTP CDP endpoint");
  }
  versionUrl.pathname = "/json/version";
  versionUrl.search = "";
  versionUrl.hash = "";
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("compiled sidecar smoke lost the CDP endpoint");
}

async function currentCdpWebSocketEndpoint(endpoint: string): Promise<string> {
  const versionUrl = new URL(endpoint);
  if (versionUrl.protocol !== "http:" && versionUrl.protocol !== "https:") {
    throw new Error("compiled sidecar smoke requires an HTTP CDP endpoint");
  }
  versionUrl.pathname = "/json/version";
  versionUrl.search = "";
  versionUrl.hash = "";
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("compiled sidecar smoke could not resolve the CDP websocket");
  const body = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string" || !/^wss?:\/\//.test(body.webSocketDebuggerUrl)) {
    throw new Error("compiled sidecar smoke received an invalid CDP websocket");
  }
  return body.webSocketDebuggerUrl;
}

async function navigateSmokePage(endpoint: string): Promise<void> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
  } finally {
    await browser.close();
  }
}

export async function runCompiledSidecarSmoke(
  endpoint: string,
  deps: CompiledSidecarSmokeDeps = {
    writeSession,
    readSession: readSessionInSubprocess,
    navigate: navigateSmokePage,
    assertAlive: assertCdpAlive,
    webSocketEndpoint: currentCdpWebSocketEndpoint,
  },
): Promise<void> {
  const smokeCookie = {
    name: "aliasmode_smoke",
    value: "live",
    domain: ".x.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  };
  const smokeBundle = JSON.stringify({
    cookies: [smokeCookie],
    origins: [{
      origin: "https://web.telegram.org",
      localStorage: [{ name: "aliasmode_smoke", value: "live" }],
    }],
  });
  await deps.writeSession(endpoint, smokeBundle);
  await deps.assertAlive(endpoint);
  // The second authoritative write exercises cookie clearing against pre-existing browser state.
  await deps.writeSession(endpoint, smokeBundle);
  await deps.assertAlive(endpoint);
  // Cloud uses an identity-bound current websocket. Exercise that exact transport too.
  const webSocketEndpoint = await deps.webSocketEndpoint(endpoint);
  await deps.writeSession(webSocketEndpoint, smokeBundle);
  await deps.assertAlive(endpoint);
  await deps.navigate(endpoint);
  await deps.assertAlive(endpoint);
  const bundle = JSON.parse(await deps.readSession(endpoint));
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.cookies)) {
    throw new Error("compiled sidecar capture returned an invalid session bundle");
  }
  if (!bundle.cookies.some((cookie: any) => cookie?.name === smokeCookie.name && cookie?.value === smokeCookie.value)) {
    throw new Error("compiled sidecar capture lost the restored cookie");
  }
  await deps.assertAlive(endpoint);
}

export interface CloudLauncherSmokeRuntime {
  coordinator: Pick<CloudBrowserCoordinator, "open" | "close" | "releaseAll">;
  launcher: Pick<Launcher, "active" | "stop">;
  store: Pick<ProfileStore, "getLaunch">;
}

export async function exerciseCloudLauncherSmoke(
  runtime: CloudLauncherSmokeRuntime,
  profileId = "aliasmode-cloud-smoke",
): Promise<void> {
  for (let cycle = 0; cycle < 3; cycle++) {
    const opened = await runtime.coordinator.open(profileId);
    if (!opened.ok) throw new Error(opened.error ?? "Cloud launcher smoke could not open the profile");
    if (!await runtime.launcher.active(profileId)) {
      throw new Error("Cloud launcher smoke browser was not alive after restore");
    }
    if (!runtime.store.getLaunch(profileId)) {
      throw new Error("Cloud launcher smoke lost durable launch ownership");
    }
    if (!await runtime.coordinator.close(profileId)) {
      throw new Error("Cloud launcher smoke could not close the profile safely");
    }
    if (await runtime.launcher.active(profileId)) {
      throw new Error("Cloud launcher smoke browser survived confirmed close");
    }
    if (runtime.store.getLaunch(profileId)) {
      throw new Error("Cloud launcher smoke retained a launch after confirmed close");
    }
  }
}

type CloudLauncherSmokeProxy = {
  profileProxy: NonNullable<Profile["proxy"]>;
  verifyProxy: ProxyVerifier;
};

function cloudLauncherSmokeProxy(
  rest: string[],
  env: NodeJS.ProcessEnv = process.env,
): CloudLauncherSmokeProxy | null {
  const type = flag(rest, "proxy-type");
  if (!type) return null;
  if (type !== "http" && type !== "socks5") {
    throw new Error("Cloud launcher smoke proxy type must be http or socks5");
  }
  const host = env.ALIASMODE_LIVE_PROXY_HOST?.trim() ?? "";
  const port = env.ALIASMODE_LIVE_PROXY_PORT?.trim() ?? "";
  const user = env.ALIASMODE_LIVE_PROXY_USER ?? "";
  const pass = env.ALIASMODE_LIVE_PROXY_PASS ?? "";
  const expectedIp = canonicalIp(env.ALIASMODE_LIVE_PROXY_IP?.trim() ?? "");
  if (!host || !port || !user || !pass || !expectedIp) {
    throw new Error("Cloud launcher smoke proxy environment is incomplete");
  }
  return {
    profileProxy: { type, host, port, user, pass },
    verifyProxy: async (relayPort) => {
      const egress = await verifyRelayEgress(relayPort);
      if (canonicalIp(egress.ip) !== expectedIp) {
        throw new Error("Cloud launcher smoke proxy egress did not match");
      }
      return egress;
    },
  };
}

async function runCloudLauncherSmoke(paths: StatePaths, rest: string[]): Promise<void> {
  const profileId = "aliasmode-cloud-smoke";
  const store = new ProfileStore(paths.cloudDatabase);
  const queue = new PendingSyncQueue(paths.pendingSync, new Uint8Array(32).fill(1));
  const smokeProxy = cloudLauncherSmokeProxy(rest);
  // Exercise the persisted proxy-only preparation path that clean CI profiles previously missed.
  if (smokeProxy) {
    const defaultProfileDir = resolve(paths.cloudProfiles, profileId, "Default");
    mkdirSync(defaultProfileDir, { recursive: true });
    writeFileSync(resolve(defaultProfileDir, "Preferences"), "[]");
  }
  const launcher = makeLauncher(
    store,
    rest,
    true,
    paths.cloudProfiles,
    smokeProxy?.verifyProxy,
  );
  const profile: Profile = {
    id: profileId,
    accId: "",
    name: "Cloud launcher smoke",
    group: "",
    platform: "",
    username: "",
    password: "",
    email: "",
    emailPassword: "",
    twofa: "",
    proxy: smokeProxy?.profileProxy ?? null,
    extensions: [],
    tags: [],
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
    timezone: "UTC",
    screenWidth: 1280,
    screenHeight: 720,
    fingerprintSeed: 1,
    cookies: [],
    seeded: false,
  };
  let payload = encodePortableProfile(profile, JSON.stringify({
    cookies: [{
      name: "auth_token",
      value: "aliasmode-smoke",
      domain: ".x.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    }],
    origins: [],
  }));
  let version = 1;
  let registration = 0;
  const cloud = {
    async listProfiles() { throw new Error("Cloud launcher smoke must not list remote profiles"); },
    async createProfile() { throw new Error("Cloud launcher smoke must not create remote profiles"); },
    async openProfile() {
      registration++;
      return {
        ok: true as const,
        registrationId: `smoke-registration-${registration}`,
        baseVersion: version,
        payload,
        activeOpens: [],
      };
    },
    async heartbeat() {
      return { ok: true as const, revoked: false as const, activeOpens: [] };
    },
    async closeOpen(_registrationId: string, request: { expectedVersion: number; payload: typeof payload }) {
      if (request.expectedVersion !== version) throw new Error("Cloud launcher smoke received a stale close");
      if (!request.payload.session.cookies.some((cookie) =>
        cookie.name === "auth_token" && cookie.value === "aliasmode-smoke"
      )) {
        throw new Error("Cloud launcher smoke did not capture the restored session");
      }
      payload = request.payload;
      version++;
      return { ok: true as const, status: "accepted" as const, version };
    },
    async abandon() { return { ok: true as const, status: "abandoned" as const }; },
  };
  const coordinator = new CloudBrowserCoordinator({
    cloud: cloud as any,
    launcher,
    store,
    queue: () => queue,
    accountId: () => "smoke-account",
    deviceId: () => "smoke-device",
    readSession: readSessionInSubprocess,
    applySession: applySessionToEndpoint,
    heartbeatMs: 0,
  });

  try {
    await exerciseCloudLauncherSmoke({ coordinator, launcher, store }, profileId);
  } finally {
    await coordinator.releaseAll(true).catch(() => false);
    await launcher.stop(profileId).catch(() => false);
    queue.close();
    store.close();
  }
}

async function main() {
  // Playwright-over-CDP on Bun emits occasional stray websocket rejections
  // ("ws.WebSocket 'upgrade' event is not implemented in bun"). Left unhandled,
  // Bun exits the process — which would crash the long-running manager or cut a
  // diagnose run short. Log and continue instead.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    // ONLY the known Bun+Playwright ws-upgrade noise is non-fatal. Anything
    // else (a DB failure, an unhandled launcher path) is a real bug — surface it
    // loudly and exit rather than masking it as "(non-fatal)" and continuing in
    // a possibly-corrupt state. The service supervisor restarts us.
    if (msg.includes("not implemented in bun") || msg.includes("WebSocket 'upgrade'")) {
      console.error(`[aliasmode] (non-fatal) Bun ws-upgrade noise: ${msg}`);
      return;
    }
    console.error(`[aliasmode] FATAL unhandled rejection: ${msg}`);
    process.exit(1);
  });

  const argv = process.argv.slice(2);
  if (await dispatchReadSessionWorker(argv)) return;

  const [cmd, ...rest] = argv;
  const paths = statePaths(resolveStateRoot(rest));
  const desktop = has(rest, "desktop-stdio");
  if (desktop && cmd !== "start") throw new Error("--desktop-stdio is supported only by the start command");
  const desktopHealth = desktop
    ? desktopHealthMetadata(process.env, flag(rest, "desktop-root"))
    : null;
  const desktopCredentials = desktopHealth
    ? new DesktopCredentialBridge(desktopHealth.instance)
    : null;
  const migrationSource = flag(rest, "migrate-from") ?? process.env.ALIASMODE_LEGACY_ROOT;
  if (migrationSource && (cmd === "start" || cmd === "serve")) {
    const migration = migrateLegacyState(migrationSource, paths);
    if (migration.status === "migrated") {
      console.log(`migrated ${migration.profileCount} legacy profile(s) into ${paths.root}`);
    }
  }
  ensureStateDirectories(paths);
  if (cmd === "__cloud-launcher-smoke") {
    await runCloudLauncherSmoke(paths, rest);
    console.log("compiled sidecar opened, restored, captured, and closed a fresh and repeated cached Cloud profile");
    return;
  }
  const appConfig = new AppConfigStore(paths.config);
  const savedMode = appConfig.read();
  const defaultCloudUrl = selectedCloudUrl(savedMode);
  const cloudConfig = cloudRuntimeConfiguration(savedMode);
  const cloudAuth = cloudConfig
    ? new CloudAuthRuntime(
        new SupabaseAuthClient({
          baseUrl: cloudConfig.authUrl,
          anonKey: cloudConfig.anonKey,
        }),
        undefined,
        desktopCredentials
          ? (refreshToken) => desktopCredentials.persistRefreshToken(refreshToken)
          : undefined,
        desktopCredentials
          ? () => desktopCredentials.clearCloudSessionCredentials()
          : undefined,
      )
    : undefined;
  const configuredDbPath = flag(rest, "db");
  const configuredDataRoot = flag(rest, "data-root");
  const identityDbPath = configuredDbPath ?? paths.database;
  const cloudProfileCache = savedMode.mode === "cloud" && (cmd === "start" || cmd === "serve");
  const activeProfilePaths = profileDataPaths(paths, cloudProfileCache, configuredDbPath, configuredDataRoot);
  const dbPath = activeProfilePaths.database;
  const profileDataRoot = activeProfilePaths.profiles;
  const cloudConnection = cloudAuth && cloudConfig
    ? new CloudConnectionRuntime({
        baseUrl: cloudConfig.apiUrl,
        accessToken: () => cloudAuth.accessTokenOrRefresh(),
        installation: {
          installationId: defaultOperatorName(identityDbPath),
          label: hostname(),
          platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
          appVersion: process.env.ALIASMODE_APP_VERSION ?? ALIASMODE_VERSION,
        },
      })
    : undefined;
  const pendingSync = cloudAuth ? new PendingSyncRuntime(paths.pendingSync) : undefined;
  const lifecycleAdmissionOptions = cmd === "start" || cmd === "serve"
    ? lifecycleAdmissionOptionsFromEnv()
    : undefined;
  const lifecycleAdmission = lifecycleAdmissionOptions
    ? new LifecycleAdmissionController(lifecycleAdmissionOptions)
    : undefined;

  switch (cmd) {
    case "__sidecar-smoke": {
      const endpoint = flag(rest, "cdp-endpoint");
      if (!endpoint) throw new Error("compiled sidecar smoke requires --cdp-endpoint");
      await runCompiledSidecarSmoke(endpoint);
      console.log("compiled sidecar restored, navigated, and captured a session over Playwright CDP");
      break;
    }
    case "install-browser": {
      console.log("Installing the official CloakBrowser binary (one-time download)...");
      const installed = await installCloakBrowser({ cwd: paths.root });
      console.log(`CloakBrowser installed and pinned:\n${installed.path}\nSHA-256 ${installed.sha256}`);
      console.log("Restart AliasMode to use it.");
      break;
    }
    case "import": {
      const store = new ProfileStore(dbPath);
      await importPath(store, rest[0], paths.inbox);
      console.log(`store now holds ${store.count()} profile(s) at ${dbPath}`);
      store.close();
      break;
    }
    case "start": {
      const store = new ProfileStore(dbPath);
      const port = Number(flag(rest, "port") ?? 50400);

      // Persisted mode is authoritative. The legacy HUB_URL fallback exists only
      // for existing installations that have not completed first-run selection.
      const configuredMode = savedMode;
      const hubUrl = legacyHubUrl(configuredMode);
      if (hubUrl) {
        const password = process.env.HUB_PASSWORD ?? "";
        if (!password) {
          console.error("Remote mode needs HUB_PASSWORD set — the shared hub secret, or a per-operator token from `bun cli.ts user add <name>`.");
          process.exit(1);
        }
        // Each box has a stable, unique operator id (OPERATOR_NAME or an
        // auto-generated persisted id). With the shared hub secret the hub
        // attributes locks to this id; a per-operator token overrides it.
        const owner = defaultOperatorName(identityDbPath);
        console.log(`local instance "${owner}" (hub lock attribution: this box's operator id)`);
        const launcher = makeLauncher(store, rest, true, profileDataRoot);
        await launcher.reconcileOrphans();
        const coord = new RemoteCoordinator({
          hub: new HubClient(hubUrl, password, owner),
          launcher,
          store,
          readSession: readSessionInSubprocess,
          writeSession,
        });
        // Re-claim the lock + resume heartbeats for browsers that survived a
        // restart (reconcileOrphans kept their rows), so their lease can't lapse
        // and let another operator open the same account.
        await coord.reclaimSurvivors();
        startMemoryAttributionLog(coord);
        const configuredShutdownTimeout = Number(process.env.ALIASMODE_SHUTDOWN_TIMEOUT_MS);
        const shutdownTimeoutMs = Number.isFinite(configuredShutdownTimeout) && configuredShutdownTimeout > 0
          ? Math.max(1_000, Math.floor(configuredShutdownTimeout))
          : DEFAULT_REMOTE_SHUTDOWN_TIMEOUT_MS;
        console.log(`remote mode: hub ${hubUrl} (authenticated operator identity is token-derived)`);
        const server = serveDashboard({
          launcher,
          store,
          remote: coord,
          port,
          lifecycleAdmission,
          appConfig,
          paths,
          defaultCloudUrl,
          cloudAuth,
          cloudConnection,
          pendingSync,
          health: desktopHealth,
        });

        if (desktopHealth) {
          const assignedPort = server.port;
          if (!assignedPort) throw new Error("desktop sidecar did not receive a loopback port");
          attachDesktopControl(new ManagedDesktopRuntime({
            server,
            admission: lifecycleAdmission!,
            store,
            launcher,
            remoteShutdown: (remainingMs) => drainRemoteShutdown(
              () => coord.releaseAll(),
              { maxDrainMs: Math.min(shutdownTimeoutMs, remainingMs) },
            ),
          }), desktopHealth, assignedPort, desktopCredentials!);
          break;
        }

        let shutdownInFlight: Promise<void> | null = null;
        let firstShutdownSignal: NodeJS.Signals | null = null;
        const shutdown = (signal: NodeJS.Signals) => {
          if (shutdownInFlight) {
            const exitCode = signal === "SIGINT" ? 130 : 143;
            console.error(
              `received ${signal} while ${firstShutdownSignal ?? "shutdown"} cleanup is still unconfirmed; ` +
              "forcing a non-zero exit with launch records and locks retained for next-start recovery",
            );
            process.exit(exitCode);
            return;
          }
          firstShutdownSignal = signal;
          console.error(
            `received ${signal}; waiting up to ${shutdownTimeoutMs}ms for browser teardown and hub unlock ` +
            "(send the signal again to force a non-zero exit)",
          );
          shutdownInFlight = drainRemoteShutdown(
            () => coord.releaseAll(),
            { maxDrainMs: shutdownTimeoutMs },
          )
            .then(() => process.exit(0))
            .catch((error) => {
              // Never claim clean shutdown or delete durable ownership after a
              // timeout. A same-operator restart can reclaim locks immediately,
              // reconcile launch rows, and retry exact browser cleanup.
              console.error(`shutdown cleanup unconfirmed: ${error instanceof Error ? error.message : String(error)}; exiting non-zero`);
              process.exit(1);
            });
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        break;
      }

      // Local (standalone) mode: reconcile/certify durable launch ownership
      // before imports. Otherwise a stale crash row makes the hardened importer
      // reject startup before it has a chance to prove the row dead.
      console.log("standalone mode (no HUB_URL) — local only, NOT connected to a hub");
      const launcher = makeLauncher(store, rest, savedMode.mode === "cloud", profileDataRoot);
      await launcher.reconcileOrphans();
      if (savedMode.mode !== "cloud") await launcher.certifySurvivors();
      const cloudBrowser = makeCloudBrowser(launcher, store, cloudConnection, pendingSync);
      startMemoryAttributionLog();
      if (configuredMode.mode === "cloud") {
        console.log("cloud mode: waiting for verified authentication before loading profiles");
        if (cloudBrowser && !desktopHealth) installCloudShutdown(cloudBrowser);
        const server = serveDashboard({
          launcher,
          store,
          port,
          lifecycleAdmission,
          appConfig,
          paths,
          defaultCloudUrl,
          cloudAuth,
          cloudConnection,
          pendingSync,
          cloudBrowser,
          health: desktopHealth,
        });
        if (desktopHealth) {
          const assignedPort = server.port;
          if (!assignedPort) throw new Error("desktop sidecar did not receive a loopback port");
          attachDesktopControl(new ManagedDesktopRuntime({
            server,
            admission: lifecycleAdmission!,
            store,
            launcher,
            ...(cloudBrowser ? {
              remoteShutdown: (remainingMs: number) => drainRemoteShutdown(
                () => cloudBrowser.releaseAll(true),
                { maxDrainMs: Math.min(DEFAULT_REMOTE_SHUTDOWN_TIMEOUT_MS, remainingMs) },
              ),
            } : {}),
          }), desktopHealth, assignedPort, desktopCredentials!);
        }
        break;
      }
      const r = await importInbox(store, paths.inbox).catch((error) => {
        // A live certified survivor can legitimately block a queued identity
        // replacement. Keep serving the safe stored profile and let the inbox
        // watcher retry after it closes; never discard the import error.
        console.error(`startup inbox import deferred: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (r) console.log(`imported ${r.profiles} profile(s) from ${r.files} file(s); store holds ${store.count()}`);
      const stopInbox = watchInbox(store, paths.inbox);
      const server = serveDashboard({
        launcher,
        store,
        port,
        lifecycleAdmission,
        appConfig,
        paths,
        defaultCloudUrl,
        cloudAuth,
        cloudConnection,
        pendingSync,
        health: desktopHealth,
      });
      if (desktopHealth) {
        const assignedPort = server.port;
        if (!assignedPort) throw new Error("desktop sidecar did not receive a loopback port");
        attachDesktopControl(new ManagedDesktopRuntime({
          server,
          admission: lifecycleAdmission!,
          store,
          launcher,
          stopInbox,
        }), desktopHealth, assignedPort, desktopCredentials!);
      }
      break;
    }
    case "serve": {
      const store = new ProfileStore(dbPath);
      const launcher = makeLauncher(store, rest, savedMode.mode === "cloud", profileDataRoot);
      await launcher.reconcileOrphans();
      if (savedMode.mode !== "cloud") await launcher.certifySurvivors();
      const cloudBrowser = makeCloudBrowser(launcher, store, cloudConnection, pendingSync);
      startMemoryAttributionLog();
      if (cloudBrowser) installCloudShutdown(cloudBrowser);
      serveDashboard({
        launcher,
        store,
        port: Number(flag(rest, "port") ?? 50400),
        lifecycleAdmission,
        appConfig,
        paths,
        defaultCloudUrl,
        cloudAuth,
        cloudConnection,
        pendingSync,
        cloudBrowser,
      });
      break;
    }
    case "diagnose": {
      const store = new ProfileStore(dbPath);
      const all = store.listProfiles();
      store.close();
      const profiles = all.slice(0, Number(flag(rest, "count") ?? 10));
      if (profiles.length === 0) {
        console.error("no profiles imported yet — run `import` or `start` first");
        process.exit(1);
      }
      mkdirSync(paths.reports, { recursive: true });
      const out = flag(rest, "out") ?? resolve(paths.reports, "diagnose-latest.json");
      // Write after every profile so a partial/interrupted run still leaves a
      // usable report on disk instead of nothing.
      const report = await runDiagnostics({
        baseUrl: `http://127.0.0.1:${Number(flag(rest, "port") ?? 50400)}`,
        profiles,
        relaunch: has(rest, "relaunch"),
        collectLogin: !has(rest, "no-login"),
        onProgress: (r) => writeFileSync(out, JSON.stringify(r, null, 2)),
      });
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log("\n=== VERDICTS ===");
      for (const line of report.analysis.verdicts) console.log(line);
      console.log(`\nFull report written to ${out} — forward this file for review.`);
      break;
    }
    case "inspect": {
      // Diagnostic dump that is SAFE to forward: shows field names and value
      // lengths only — never cookie/password/2FA values. The bare `id` is shown
      // because it's a non-secret profile handle and confirms parsing worked.
      const file = rest[0];
      if (!file || file.startsWith("--")) throw new Error("usage: inspect <file>");
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
      const text = decodeText(bytes);
      const recs = splitRecords(text);
      const summary = parseExport(text);
      const hex = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const enc = text.length > 0 && bytes.length / text.length > 1.8 ? "utf-16(ish)" : "utf-8(ish)";
      console.log(`file: ${file}`);
      console.log(`bytes: ${bytes.length}  decodedChars: ${text.length}  firstBytes: ${hex}  encoding: ${enc}`);
      console.log(`records: ${recs.length}  parseableProfiles: ${summary.profiles.length}  skipped(no id): ${summary.skipped}`);
      if (recs[0]) {
        console.log(`record[0] id: ${JSON.stringify(recs[0].id ?? "(missing)")}`);
        const shape = Object.entries(recs[0]).map(([k, v]) => (k === "id" ? `id=${v}` : `${k}=<${v.length} chars>`));
        console.log(`record[0] fields: ${shape.join("  ")}`);
      }
      if (recs.length && !summary.profiles.length) {
        console.log(`(records found but none had an "id" field — likely a separator or field-name mismatch)`);
      } else if (!recs.length) {
        console.log(`(no records split out — check encoding (firstBytes) or the record separator)`);
      }
      break;
    }
    case "list": {
      const store = new ProfileStore(dbPath);
      for (const p of store.listProfiles()) {
        console.log(
          `${p.id}\t${p.name}\tseed=${p.fingerprintSeed}\t${p.screenWidth}x${p.screenHeight}\ttz=${p.timezone || "default"}\t` +
            `proxy=${p.proxy ? `${p.proxy.host}:${p.proxy.port}` : "none"}\tcookies=${p.cookies.length}\tseeded=${p.seeded}`,
        );
      }
      store.close();
      break;
    }
    default:
      console.log("commands: install-browser | start | import [file|dir] | inspect <file> | serve | diagnose | list");
      process.exit(cmd ? 1 : 0);
  }
}

// Only run the CLI when executed directly (`bun cli.ts …`), not when imported (e.g. by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

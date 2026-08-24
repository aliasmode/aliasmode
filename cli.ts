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
 * Common flags: --db <path>  --state-root <dir>  --data-root <dir>  --port <n>
 */

import { parseExport, decodeText, splitRecords } from "./parse.ts";
import { ProfileStore } from "./store.ts";
import { Launcher, readSnapshotChildBounded } from "./launcher.ts";
import {
  defaultPlaywrightRuntimeRoot,
  runPlaywrightWorker,
  verifyPlaywrightRuntime,
} from "./playwright-runtime.ts";
import { serveDashboard } from "./web.ts";
import { LifecycleAdmissionController, type LifecycleAdmissionOptions } from "./lifecycle-admission.ts";
import { HubClient } from "./hub-client.ts";
import { RemoteCoordinator } from "./remote.ts";
import {
  playwrightTransportAttribution,
  parseCapturedSessionBundle,
  readSession,
  readSessionInSubprocess,
  READ_SESSION_WORKER_ARG,
  runReadSessionWorker,
  writeSession,
  applySessionToEndpoint,
} from "./session.ts";
import { importBuffers, importInbox, watchInbox } from "./inbox.ts";
import { ensureStateDirectories, profileDataPaths, resolveStateRoot, statePaths, type StatePaths } from "./paths.ts";
import { migrateLegacyState, type LegacyMigrationResult, type MigrationOptions } from "./migration.ts";
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
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import net from "node:net";
import { defaultOperatorName } from "./operator.ts";
import { ensureDuckDuckGoDefault } from "./search-provider.ts";
import { installCloakBrowser } from "./browser-install.ts";
import { resolveEgressEndpoints } from "./egress.ts";
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

export const CLOAKPIT_IMPORT_COMMAND = "__import-cloakpit";
const IMPORT_RESTRICTION = "Windows DPAPI protects persisted browser secrets, so this import works only for the same Windows machine and account. Persisted persona fields are preserved, but runtime or browser differences can change the account-visible fingerprint.";

export async function runCloakpitImportCommand(
  args: string[],
  migrate: (source: string, destination: StatePaths, options?: MigrationOptions) => Promise<LegacyMigrationResult> = migrateLegacyState,
): Promise<{ ok: boolean; message: string }> {
  const source = flag(args, "source") ?? (existsSync(join("C:\\Cloakpit", "profiles.sqlite")) ? "C:\\Cloakpit" : undefined);
  if (!source) return { ok: false, message: `No Cloakpit source was selected. Pass an explicit source path. ${IMPORT_RESTRICTION}` };
  try {
    const result = await migrate(source, statePaths(resolveStateRoot(args)), {
      profileRoot: flag(args, "cloakpit-profile-root"),
    });
    if (result.status === "not_found") {
      return { ok: false, message: `No profiles.sqlite was found in ${resolve(source)}. ${IMPORT_RESTRICTION}` };
    }
    return {
      ok: true,
      message: `Imported ${result.profileCount} Cloakpit profile(s). ${IMPORT_RESTRICTION}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${detail}. ${IMPORT_RESTRICTION}` };
  }
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

const UNSAFE_CANARY_TIMEOUT_MS = 600_000;

function makeLauncher(
  store: ProfileStore,
  rest: string[],
  remoteMode = false,
  defaultDataRoot = "profiles",
): Launcher {
  const unsafeCanary = has(rest, "unsafe-disable-identity-gates");
  return new Launcher({
    store,
    dataRoot: defaultDataRoot,
    headless: has(rest, "headless"),
    // Explicit canary-only escape hatch for constrained test hosts where a
    // full browser identity probe cannot complete. Never enable in production.
    unsafeDisableIdentityGates: unsafeCanary,
    ...(unsafeCanary ? { cdpReadyTimeoutMs: UNSAFE_CANARY_TIMEOUT_MS } : {}),
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
    ...(unsafeCanary ? {} : { ensureSearchProvider: ensureDuckDuckGoDefault }),
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
    readSession: (endpoint, captureSeed) => readSessionInSubprocess(endpoint, { captureSeed }),
    applySession: (endpoint, bundle, urls) =>
      applySessionToEndpoint(endpoint, bundle, urls, { log: (m) => console.log(`[aliasmode] ${m}`) }),
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
  await runPlaywrightWorker("navigate", {
    endpoint,
    urls: ["about:blank"],
    connectTimeoutMs: 30_000,
  });
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

export type CloudRestoreFixtureMode = "healthy" | "offline" | "membership-revoked";

export function parseCloudRestoreFixtureOptions(args: string[]): {
  port: number;
  mode: CloudRestoreFixtureMode;
  initialRefresh: "seeded" | "rotated";
} {
  const port = Number(flag(args, "port"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Cloud restore fixture requires a valid loopback port");
  }
  const mode = flag(args, "mode");
  if (mode !== "healthy" && mode !== "offline" && mode !== "membership-revoked") {
    throw new Error("Cloud restore fixture mode must be healthy, offline, or membership-revoked");
  }
  const initialRefresh = flag(args, "initial-refresh") ?? "seeded";
  if (initialRefresh !== "seeded" && initialRefresh !== "rotated") {
    throw new Error("Cloud restore fixture initial refresh must be seeded or rotated");
  }
  return { port, mode, initialRefresh };
}

const CLOUD_RESTORE_FIXTURE_ACCESS_TOKEN = "aliasmode-fixture-access";
const CLOUD_RESTORE_FIXTURE_SEEDED_REFRESH_TOKEN = "aliasmode-acceptance-refresh-seeded";
const CLOUD_RESTORE_FIXTURE_REFRESH_TOKEN = "aliasmode-fixture-refresh-rotated";
const CLOUD_RESTORE_FIXTURE_DEVICE_CREDENTIAL = "aliasmode-acceptance-device";
const CLOUD_RESTORE_FIXTURE_LEGAL = {
  terms: "fixture-terms",
  privacy: "fixture-privacy",
  acceptableUse: "fixture-acceptable-use",
};

function cloudRestoreFixtureStatus() {
  return {
    ok: true as const,
    account: {
      id: "fixture-account",
      email: "user@fixture.invalid",
      emailVerified: true,
    },
    workspace: {
      id: "fixture-workspace",
      ownerAccountId: "fixture-owner",
      name: "Fixture workspace",
      role: "member" as const,
    },
    device: {
      id: "fixture-device",
      label: "Fixture Windows device",
      platform: "windows" as const,
      appVersion: ALIASMODE_VERSION,
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
      current: true,
    },
    legal: {
      current: CLOUD_RESTORE_FIXTURE_LEGAL,
      accepted: { ...CLOUD_RESTORE_FIXTURE_LEGAL, acceptedAt: 1 },
    },
  };
}

function fixtureJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function fixtureAuthorized(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${CLOUD_RESTORE_FIXTURE_ACCESS_TOKEN}`
    && request.headers.get("x-aliasmode-device") === CLOUD_RESTORE_FIXTURE_DEVICE_CREDENTIAL;
}

export function createCloudRestoreFixtureHandler(
  mode: CloudRestoreFixtureMode,
  initialRefresh: "seeded" | "rotated" = "seeded",
): (request: Request) => Promise<Response> {
  let expectedRefreshToken = initialRefresh === "seeded"
    ? CLOUD_RESTORE_FIXTURE_SEEDED_REFRESH_TOKEN
    : CLOUD_RESTORE_FIXTURE_REFRESH_TOKEN;
  const waiting: Array<() => void> = [];
  const waitForRelease = () => new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
  const release = (count: number): boolean => {
    if (waiting.length < count) return false;
    for (let index = 0; index < count; index++) waiting.shift()!();
    return true;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return fixtureJson({ ok: true, mode });
    }
    if (request.method === "POST" && url.pathname === "/control/release") {
      const count = Number(url.searchParams.get("count") ?? "1");
      if (!Number.isInteger(count) || count < 1 || count > 2) {
        return fixtureJson({ ok: false, error: "fixture release count must be one or two" }, 400);
      }
      if (!release(count)) {
        return fixtureJson({ ok: false, error: "fixture has no waiting refresh request" }, 409);
      }
      return fixtureJson({ ok: true, released: count });
    }
    if (
      request.method === "POST"
      && url.pathname === "/auth/v1/token"
      && url.searchParams.get("grant_type") === "refresh_token"
    ) {
      const body = await request.json().catch(() => null) as { refresh_token?: unknown } | null;
      if (body?.refresh_token !== expectedRefreshToken) {
        return fixtureJson({ message: "fixture refresh token is invalid" }, 401);
      }
      expectedRefreshToken = CLOUD_RESTORE_FIXTURE_REFRESH_TOKEN;
      // Hold the response until installed automation has observed the restoring UI.
      await waitForRelease();
      if (mode === "offline") return Response.error();
      return fixtureJson({
        access_token: CLOUD_RESTORE_FIXTURE_ACCESS_TOKEN,
        refresh_token: CLOUD_RESTORE_FIXTURE_REFRESH_TOKEN,
        expires_in: 3_600,
        user: {
          id: "fixture-account",
          email: "user@fixture.invalid",
          email_confirmed_at: "fixture",
        },
      });
    }
    if (!url.pathname.startsWith("/v1/") || !fixtureAuthorized(request)) {
      return fixtureJson({
        ok: false,
        error: { code: "authentication_required", message: "fixture authentication is required" },
      }, 401);
    }
    if (mode === "offline") return Response.error();
    if (mode === "membership-revoked") {
      return fixtureJson({
        ok: false,
        error: { code: "membership_revoked", message: "fixture membership was revoked" },
      }, 403);
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return fixtureJson(cloudRestoreFixtureStatus());
    }
    if (request.method === "GET" && url.pathname === "/v1/profiles") {
      return fixtureJson({ ok: true, profiles: [] });
    }
    if (request.method === "GET" && url.pathname === "/v1/workspace/folders") {
      return fixtureJson({ ok: true, folders: [] });
    }
    if (request.method === "GET" && url.pathname === "/v1/workspace/members") {
      return fixtureJson({
        ok: true,
        members: [{
          accountId: "fixture-account",
          email: "user@fixture.invalid",
          role: "member",
          joinedAt: 1,
          grants: [],
        }],
      });
    }
    return fixtureJson({
      ok: false,
      error: { code: "internal_error", message: "unknown fixture route" },
    }, 404);
  };
}

async function runCloudRestoreFixture(args: string[]): Promise<void> {
  const { port, mode, initialRefresh } = parseCloudRestoreFixtureOptions(args);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: createCloudRestoreFixtureHandler(mode, initialRefresh),
  });
  if (server.port !== port) {
    server.stop(true);
    throw new Error("Cloud restore fixture did not bind the requested loopback port");
  }
  console.log(`Cloud restore fixture ready on loopback port ${port} in ${mode} mode`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop(true);
}

export interface WindowsNativeWindowCandidate {
  profileId: string;
  hwnd: number;
  minimized: boolean;
  visible: boolean;
}

export interface WindowsNativeWindowSnapshot {
  foregroundHwnd: number;
  windows: Record<string, Omit<WindowsNativeWindowCandidate, "profileId">>;
}

export function mapWindowsNativeWindowCandidates(
  profileIds: readonly string[],
  candidates: readonly WindowsNativeWindowCandidate[],
): WindowsNativeWindowSnapshot["windows"] {
  const windows: WindowsNativeWindowSnapshot["windows"] = {};
  const handles = new Set<number>();
  for (const profileId of profileIds) {
    const matches = candidates.filter((candidate) => candidate.profileId === profileId);
    if (matches.length !== 1) return {};
    const { hwnd, minimized, visible } = matches[0]!;
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || handles.has(hwnd)) return {};
    handles.add(hwnd);
    windows[profileId] = { hwnd, minimized, visible };
  }
  return windows;
}

export interface WindowsProfileCardObservation {
  createdPageTargetIds: string[];
  nativeWindowStayedMinimized: boolean;
}

export interface WindowsPageLifecycleObservation extends WindowsProfileCardObservation {
  destroyedPageTargetIds: string[];
}

export type WindowsWindowAcceptanceStage =
  | "page_targets_ready"
  | "windows_distinct"
  | "window_minimized"
  | "profile_card_observed"
  | "background_page_observed"
  | "session_capture_observed"
  | "first_window_raised"
  | "second_window_raised";

export interface WindowsWindowAcceptanceRuntime {
  profileIds: readonly [string, string];
  open(profileId: string): Promise<void>;
  close(profileId: string): Promise<void>;
  nativeWindows(): Promise<WindowsNativeWindowSnapshot>;
  minimize(profileId: string): Promise<void>;
  pageTargetIds(profileId: string): Promise<string[]>;
  runProfileCardObserved(profileId: string, hwnd: number): Promise<WindowsProfileCardObservation>;
  runBackgroundPageObserved(profileId: string, hwnd: number): Promise<WindowsPageLifecycleObservation>;
  runSessionCaptureObserved(profileId: string, hwnd: number): Promise<WindowsProfileCardObservation>;
  bringToFront(profileId: string): Promise<void>;
  reportStage?(stage: WindowsWindowAcceptanceStage): void;
}

async function waitForNativeWindowState(
  read: () => Promise<WindowsNativeWindowSnapshot>,
  accepted: (snapshot: WindowsNativeWindowSnapshot) => boolean,
  failure: string,
  timeoutMs = 20_000,
): Promise<WindowsNativeWindowSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot: WindowsNativeWindowSnapshot | undefined;
  while (Date.now() < deadline) {
    snapshot = await read();
    if (accepted(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(failure);
}

export async function exerciseWindowsWindowAcceptance(
  runtime: WindowsWindowAcceptanceRuntime,
): Promise<void> {
  const [firstId, secondId] = runtime.profileIds;
  const opened: string[] = [];
  let failure: unknown;
  let cleanupFailure: unknown;
  try {
    await runtime.open(firstId);
    opened.push(firstId);
    await runtime.open(secondId);
    opened.push(secondId);

    const [firstTargets, secondTargets] = await Promise.all([
      runtime.pageTargetIds(firstId),
      runtime.pageTargetIds(secondId),
    ]);
    if (!firstTargets.length || !secondTargets.length) {
      throw new Error("managed CloakBrowser did not expose initial page targets");
    }
    runtime.reportStage?.("page_targets_ready");

    const initial = await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => {
        const first = snapshot.windows[firstId];
        const second = snapshot.windows[secondId];
        return !!first && !!second
          && first.visible && second.visible
          && first.hwnd > 0 && second.hwnd > 0 && first.hwnd !== second.hwnd;
      },
      "managed CloakBrowser windows did not expose distinct native HWNDs",
    );
    runtime.reportStage?.("windows_distinct");
    const firstHwnd = initial.windows[firstId]!.hwnd;
    const secondHwnd = initial.windows[secondId]!.hwnd;

    await runtime.minimize(firstId);
    await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => snapshot.windows[firstId]?.hwnd === firstHwnd
        && snapshot.windows[firstId]?.visible === true
        && snapshot.windows[firstId]?.minimized === true
        && snapshot.windows[secondId]?.hwnd === secondHwnd
        && snapshot.windows[secondId]?.visible === true,
      "native CloakBrowser window did not remain distinct and minimized",
    );
    runtime.reportStage?.("window_minimized");
    const targetsBefore = (await runtime.pageTargetIds(firstId)).slice().sort();
    const observation = await runtime.runProfileCardObserved(firstId, firstHwnd);
    const targetsAfter = (await runtime.pageTargetIds(firstId)).slice().sort();
    if (JSON.stringify(targetsAfter) !== JSON.stringify(targetsBefore)) {
      throw new Error("profile-card operation changed the page targets for a minimized window");
    }
    await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => snapshot.windows[firstId]?.hwnd === firstHwnd
        && snapshot.windows[firstId]?.visible === true
        && snapshot.windows[firstId]?.minimized === true
        && snapshot.windows[secondId]?.hwnd === secondHwnd
        && snapshot.windows[secondId]?.visible === true,
      "profile-card operation restored or replaced the minimized native window",
    );
    if (observation.createdPageTargetIds.length > 0) {
      throw new Error("profile-card operation created a page target while the window was minimized");
    }
    if (!observation.nativeWindowStayedMinimized) {
      throw new Error("profile-card operation transiently restored the minimized native window");
    }
    runtime.reportStage?.("profile_card_observed");

    const backgroundPageObservation = await runtime.runBackgroundPageObserved(firstId, firstHwnd);
    const targetsAfterBackgroundPage = (await runtime.pageTargetIds(firstId)).slice().sort();
    if (JSON.stringify(targetsAfterBackgroundPage) !== JSON.stringify(targetsAfter)) {
      throw new Error("background page operation left a page target for a minimized window");
    }
    await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => snapshot.windows[firstId]?.hwnd === firstHwnd
        && snapshot.windows[firstId]?.visible === true
        && snapshot.windows[firstId]?.minimized === true
        && snapshot.windows[secondId]?.hwnd === secondHwnd
        && snapshot.windows[secondId]?.visible === true,
      "background page operation restored or replaced the minimized native window",
    );
    if (backgroundPageObservation.createdPageTargetIds.length !== 1) {
      throw new Error("background page operation did not observe exactly one created page target");
    }
    if (
      backgroundPageObservation.destroyedPageTargetIds.length !== 1
      || backgroundPageObservation.destroyedPageTargetIds[0]
        !== backgroundPageObservation.createdPageTargetIds[0]
    ) {
      throw new Error("background page operation did not observe its page target being destroyed");
    }
    if (!backgroundPageObservation.nativeWindowStayedMinimized) {
      throw new Error("background page operation transiently restored the minimized native window");
    }
    runtime.reportStage?.("background_page_observed");

    const captureObservation = await runtime.runSessionCaptureObserved(firstId, firstHwnd);
    const targetsAfterCapture = (await runtime.pageTargetIds(firstId)).slice().sort();
    if (JSON.stringify(targetsAfterCapture) !== JSON.stringify(targetsAfterBackgroundPage)) {
      throw new Error("session capture changed the page targets for a minimized window");
    }
    await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => snapshot.windows[firstId]?.hwnd === firstHwnd
        && snapshot.windows[firstId]?.visible === true
        && snapshot.windows[firstId]?.minimized === true
        && snapshot.windows[secondId]?.hwnd === secondHwnd
        && snapshot.windows[secondId]?.visible === true,
      "session capture restored or replaced the minimized native window",
    );
    if (captureObservation.createdPageTargetIds.length > 0) {
      throw new Error("session capture created a page target while the window was minimized");
    }
    if (!captureObservation.nativeWindowStayedMinimized) {
      throw new Error("session capture transiently restored the minimized native window");
    }
    runtime.reportStage?.("session_capture_observed");

    await runtime.bringToFront(firstId);
    await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => snapshot.foregroundHwnd === firstHwnd
        && snapshot.windows[firstId]?.hwnd === firstHwnd
        && snapshot.windows[firstId]?.visible === true
        && snapshot.windows[firstId]?.minimized === false
        && snapshot.windows[secondId]?.hwnd === secondHwnd
        && snapshot.windows[secondId]?.visible === true
        && snapshot.foregroundHwnd !== secondHwnd,
      "Bring to front did not select only the first managed window",
    );
    runtime.reportStage?.("first_window_raised");

    await runtime.bringToFront(secondId);
    await waitForNativeWindowState(
      runtime.nativeWindows,
      (snapshot) => snapshot.foregroundHwnd === secondHwnd
        && snapshot.windows[firstId]?.hwnd === firstHwnd
        && snapshot.windows[firstId]?.visible === true
        && snapshot.windows[secondId]?.hwnd === secondHwnd
        && snapshot.windows[secondId]?.visible === true
        && snapshot.windows[secondId]?.minimized === false
        && snapshot.foregroundHwnd !== firstHwnd,
      "Bring to front did not select only the second managed window",
    );
    runtime.reportStage?.("second_window_raised");
  } catch (error) {
    failure = error;
  } finally {
    for (const profileId of opened.reverse()) {
      try {
        await runtime.close(profileId);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

export interface CloudLauncherSmokeRuntime {
  coordinator: Pick<CloudBrowserCoordinator, "open" | "close" | "releaseAll">;
  launcher: Pick<Launcher, "active" | "stop">;
  store: Pick<ProfileStore, "getLaunch">;
}

export async function exerciseCloudLauncherSmoke(
  runtime: CloudLauncherSmokeRuntime,
  profileId = "aliasmode-cloud-smoke",
  launchArgs: string[] = [],
): Promise<void> {
  for (let cycle = 0; cycle < 3; cycle++) {
    const opened = await runtime.coordinator.open(profileId, launchArgs);
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
  startupUrl?: string;
  assertComplete?(): void;
  close?(): void;
};

const PROXY_MISMATCH_URL = "http://cloud-open.invalid/ok";

/**
 * Local authenticated upstream used only by the compiled acceptance command.
 * It rejects every HTTPS tunnel, so the old Node TLS precheck fails, while the
 * real Chromium HTTP request succeeds through AliasMode's credential relay.
 */
async function startProxyMismatchFixture(): Promise<CloudLauncherSmokeProxy> {
  const expectedAuth = `Basic ${Buffer.from("aliasmode-smoke:aliasmode-smoke").toString("base64")}`;
  let targetRequests = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const end = input.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = input.subarray(0, end).toString("latin1");
      const lines = head.split("\r\n");
      const requestLine = lines[0] ?? "";
      const auth = lines.find((line) => /^proxy-authorization:/i.test(line))
        ?.replace(/^proxy-authorization:\s*/i, "");
      if (auth !== expectedAuth) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
      } else if (/^CONNECT\s/i.test(requestLine)) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } else if (requestLine.startsWith(`GET ${PROXY_MISMATCH_URL} `)) {
        targetRequests++;
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        );
      } else {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      }
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("proxy mismatch fixture did not bind a loopback port");
  }
  return {
    profileProxy: {
      type: "http",
      host: "127.0.0.1",
      port: String(address.port),
      user: "aliasmode-smoke",
      pass: "aliasmode-smoke",
    },
    startupUrl: PROXY_MISMATCH_URL,
    assertComplete() {
      if (targetRequests < 3) throw new Error("browser proxy mismatch smoke did not reach its target on every cycle");
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

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
  if (!host || !port || !user || !pass) {
    throw new Error("Cloud launcher smoke proxy environment is incomplete");
  }
  return {
    profileProxy: { type, host, port, user, pass },
    startupUrl: resolveEgressEndpoints()[0],
  };
}

const WINDOWS_ACCEPTANCE_PROFILE_IDS = [
  "aliasmode-window-smoke-one",
  "aliasmode-window-smoke-two",
] as const;

function windowsAcceptanceWindowMarker(profileId: string): string {
  return `aliasmode-window-acceptance:${profileId}`;
}

function smokeProfile(
  id: string,
  name: string,
  fingerprintSeed: number,
  proxy: Profile["proxy"] = null,
): Profile {
  return {
    id,
    accId: "",
    name,
    group: "",
    platform: "",
    username: "",
    password: "",
    email: "",
    emailPassword: "",
    twofa: "",
    proxy,
    extensions: [],
    tags: [],
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
    timezone: "UTC",
    screenWidth: 1280,
    screenHeight: 720,
    fingerprintSeed,
    cookies: [],
    seeded: false,
  };
}

async function runPowerShellAcceptance(script: string): Promise<string> {
  const child = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdout: "pipe", stderr: "ignore" },
  );
  const result = await readSnapshotChildBounded(
    child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
    10_000,
  );
  if (!result) throw new Error("native Windows acceptance helper timed out");
  if (result.exitCode !== 0) throw new Error("native Windows acceptance helper failed");
  return result.raw;
}

const WINDOWS_NATIVE_TYPE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AliasModeWindowAcceptanceNative {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hWnd, int objectId, int childId, uint threadId, uint eventTime);
  [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] private struct NativeMessage {
    public IntPtr hWnd;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public NativePoint point;
    public uint privateValue;
  }
  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] private static extern int GetMessage(out NativeMessage message, IntPtr hWnd, uint filterMin, uint filterMax);
  [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
  private static IntPtr monitoredWindow;
  private static WinEventProc monitorCallback;
  public static void MonitorMinimized(long windowValue) {
    monitoredWindow = new IntPtr(windowValue);
    monitorCallback = delegate(IntPtr _, uint eventType, IntPtr hWnd, int _objectId, int _childId, uint _threadId, uint _eventTime) {
      if (eventType == 0x0017 && hWnd == monitoredWindow) {
        Console.WriteLine("restored");
        Console.Out.Flush();
        PostQuitMessage(0);
      }
    };
    IntPtr hook = SetWinEventHook(0x0017, 0x0017, IntPtr.Zero, monitorCallback, 0, 0, 0);
    if (hook == IntPtr.Zero) throw new InvalidOperationException("native minimized-state event hook failed");
    try {
      if (!IsIconic(monitoredWindow)) {
        Console.WriteLine("restored");
        Console.Out.Flush();
        return;
      }
      Console.WriteLine("ready");
      Console.Out.Flush();
      NativeMessage message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {}
    } finally {
      UnhookWinEvent(hook);
    }
  }
  public static long[] TopLevelWindows() {
    var windows = new List<long>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr _) {
      windows.Add(hWnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static string WindowTitle(long windowValue) {
    var hWnd = new IntPtr(windowValue);
    int length = GetWindowTextLength(hWnd);
    if (length <= 0) return "";
    var title = new StringBuilder(length + 1);
    return GetWindowText(hWnd, title, title.Capacity) > 0 ? title.ToString() : "";
  }
}`;

async function readWindowsNativeWindows(
  profiles: Array<{ profileId: string; marker: string }>,
): Promise<WindowsNativeWindowSnapshot> {
  const encoded = Buffer.from(JSON.stringify(profiles), "utf8").toString("base64");
  const script = `
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_TYPE}
'@
$entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$topLevelWindows = @(
  [AliasModeWindowAcceptanceNative]::TopLevelWindows() | ForEach-Object {
    $handle = [long]$_
    [pscustomobject]@{
      hwnd = $handle
      title = [AliasModeWindowAcceptanceNative]::WindowTitle($handle)
      minimized = [AliasModeWindowAcceptanceNative]::IsIconic([IntPtr]$handle)
      visible = [AliasModeWindowAcceptanceNative]::IsWindowVisible([IntPtr]$handle)
    }
  }
)
$rows = @(
  foreach ($entry in $entries) {
    foreach ($window in $topLevelWindows) {
      if ($window.title.IndexOf([string]$entry.marker, [StringComparison]::Ordinal) -ge 0) {
        [pscustomobject]@{
          profileId = [string]$entry.profileId
          hwnd = [long]$window.hwnd
          minimized = [bool]$window.minimized
          visible = [bool]$window.visible
        }
      }
    }
  }
)
[pscustomobject]@{
  foregroundHwnd = [AliasModeWindowAcceptanceNative]::GetForegroundWindow().ToInt64()
  windows = $rows
} | ConvertTo-Json -Compress -Depth 4
`;
  const raw = await runPowerShellAcceptance(script);
  const parsed = JSON.parse(raw) as {
    foregroundHwnd?: unknown;
    windows?: Array<{
      profileId?: unknown;
      hwnd?: unknown;
      minimized?: unknown;
      visible?: unknown;
    }>;
  };
  const candidates: WindowsNativeWindowCandidate[] = [];
  for (const row of Array.isArray(parsed.windows) ? parsed.windows : []) {
    if (
      typeof row.profileId === "string"
      && Number.isSafeInteger(row.hwnd)
      && typeof row.minimized === "boolean"
      && typeof row.visible === "boolean"
    ) {
      candidates.push({
        profileId: row.profileId,
        hwnd: Number(row.hwnd),
        minimized: row.minimized,
        visible: row.visible,
      });
    }
  }
  return {
    foregroundHwnd: Number.isSafeInteger(parsed.foregroundHwnd) ? Number(parsed.foregroundHwnd) : 0,
    windows: mapWindowsNativeWindowCandidates(
      profiles.map(({ profileId }) => profileId),
      candidates,
    ),
  };
}

async function minimizeWindowsHwnd(hwnd: number): Promise<void> {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("native CloakBrowser HWND is unavailable");
  const script = `
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_TYPE}
'@
[void][AliasModeWindowAcceptanceNative]::ShowWindowAsync([IntPtr]${hwnd}, 6)
`;
  await runPowerShellAcceptance(script);
}

async function observeNativeMinimized<T>(
  hwnd: number,
  operation: () => Promise<T>,
): Promise<{ value: T; stayedMinimized: boolean }> {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("native CloakBrowser HWND is unavailable");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_TYPE}
'@
[AliasModeWindowAcceptanceNative]::MonitorMinimized(${hwnd})
`;
  const child = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdout: "pipe", stderr: "ignore" },
  );
  let ready = false;
  let stayedMinimized = true;
  let stopRequested = false;
  let watcherFailure: Error | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const monitor = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line === "ready" && !ready) {
            ready = true;
            resolveReady();
          } else if (line === "restored") {
            stayedMinimized = false;
            if (!ready) rejectReady(new Error("native minimized-state observation could not be armed"));
          }
        }
      }
    } catch {
      watcherFailure = new Error("native minimized-state observation failed");
      if (!ready) rejectReady(watcherFailure);
    } finally {
      reader.releaseLock();
      if (!stopRequested && stayedMinimized) {
        watcherFailure = new Error("native minimized-state observer exited early");
        if (!ready) rejectReady(watcherFailure);
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let value!: T;
  try {
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native minimized-state observer did not become ready")), 10_000);
      }),
    ]);
    value = await operation();
  } finally {
    if (timer) clearTimeout(timer);
    stopRequested = true;
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
    await monitor;
  }
  if (watcherFailure) throw watcherFailure;
  return { value, stayedMinimized };
}

async function cdpPageTargetIds(port: number): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("managed CloakBrowser target list is unavailable");
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("managed CloakBrowser target list is invalid");
  const pages = targets.filter((target) => target?.type === "page");
  const ids = pages
    .map((target) => target?.id)
    .filter((id): id is string => typeof id === "string" && !!id)
    .sort();
  if (ids.length !== pages.length) {
    throw new Error("managed CloakBrowser page target identity is invalid");
  }
  return ids;
}

async function runWindowsWindowAcceptance(paths: StatePaths, rest: string[]): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Windows window acceptance requires Windows");
  }
  const store = new ProfileStore(paths.cloudDatabase);
  const launcher = makeLauncher(store, rest, true, paths.cloudProfiles);
  const [firstId, secondId] = WINDOWS_ACCEPTANCE_PROFILE_IDS;
  store.upsertProfiles([
    smokeProfile(firstId, "Window smoke one", 101),
    smokeProfile(secondId, "Window smoke two", 202),
  ]);
  const launch = (profileId: string) => {
    const value = store.getLaunch(profileId);
    if (!value) throw new Error(`managed CloakBrowser launch is missing for ${profileId}`);
    return value;
  };
  const nativeWindows = () => readWindowsNativeWindows(
    WINDOWS_ACCEPTANCE_PROFILE_IDS.map((profileId) => ({
      profileId,
      marker: windowsAcceptanceWindowMarker(profileId),
    })),
  );

  try {
    await launcher.reconcileOrphans();
    await exerciseWindowsWindowAcceptance({
      profileIds: WINDOWS_ACCEPTANCE_PROFILE_IDS,
      async open(profileId) {
        const opened = await launcher.start(profileId, [], { autoNavigate: false });
        const marker = windowsAcceptanceWindowMarker(profileId);
        const document = `<!doctype html><title>${marker}</title>`;
        await launcher.navigate(opened.ws, [
          `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
        ]);
      },
      async close(profileId) {
        if (!await launcher.stop(profileId)) {
          throw new Error(`managed CloakBrowser cleanup was not confirmed for ${profileId}`);
        }
      },
      nativeWindows,
      async minimize(profileId) {
        const snapshot = await nativeWindows();
        await minimizeWindowsHwnd(snapshot.windows[profileId]?.hwnd ?? 0);
      },
      async pageTargetIds(profileId) {
        return cdpPageTargetIds(launch(profileId).debugPort);
      },
      async runProfileCardObserved(profileId, hwnd) {
        const observed = await observeNativeMinimized(hwnd, () => runPlaywrightWorker<{
          createdPageTargetIds?: unknown;
        }>("profile-card", {
          endpoint: launch(profileId).ws,
          url: "http://127.0.0.1/aliasmode-window-acceptance",
          connectTimeoutMs: 30_000,
        }));
        const created = observed.value?.createdPageTargetIds;
        if (!Array.isArray(created) || created.some((targetId) => typeof targetId !== "string" || !targetId)) {
          throw new Error("profile-card target observation returned an invalid result");
        }
        return {
          createdPageTargetIds: created,
          nativeWindowStayedMinimized: observed.stayedMinimized,
        };
      },
      async runBackgroundPageObserved(profileId, hwnd) {
        const observed = await observeNativeMinimized(hwnd, () => runPlaywrightWorker<{
          createdPageTargetIds?: unknown;
          destroyedPageTargetIds?: unknown;
        }>("profile-card", {
          endpoint: launch(profileId).ws,
          url: "about:blank",
          temporary: true,
          connectTimeoutMs: 30_000,
        }));
        const created = observed.value?.createdPageTargetIds;
        const destroyed = observed.value?.destroyedPageTargetIds;
        if (
          !Array.isArray(created)
          || created.some((targetId) => typeof targetId !== "string" || !targetId)
          || !Array.isArray(destroyed)
          || destroyed.some((targetId) => typeof targetId !== "string" || !targetId)
        ) {
          throw new Error("background page target observation returned an invalid result");
        }
        return {
          createdPageTargetIds: created,
          destroyedPageTargetIds: destroyed,
          nativeWindowStayedMinimized: observed.stayedMinimized,
        };
      },
      async runSessionCaptureObserved(profileId, hwnd) {
        const endpoint = launch(profileId).ws;
        const before = await cdpPageTargetIds(launch(profileId).debugPort);
        const captureOrigin = "https://aliasmode-window-acceptance.invalid";
        const observed = await observeNativeMinimized(hwnd, () => runPlaywrightWorker<string>(
          "session-capture",
          {
            endpoint,
            captureSeed: { origins: [captureOrigin] },
            connectTimeoutMs: 30_000,
          },
        ));
        const captured = parseCapturedSessionBundle(observed.value);
        if (!captured.origins.some((origin) => origin.origin === captureOrigin)) {
          throw new Error("session capture omitted the closed acceptance origin");
        }
        const priorTargets = new Set(before);
        const after = await cdpPageTargetIds(launch(profileId).debugPort);
        return {
          createdPageTargetIds: after.filter((targetId) => !priorTargets.has(targetId)),
          nativeWindowStayedMinimized: observed.stayedMinimized,
        };
      },
      async bringToFront(profileId) {
        await launcher.bringToFront(profileId);
      },
      reportStage(stage) {
        console.log(`[aliasmode] installed window acceptance stage ${stage}`);
      },
    });
  } finally {
    for (const profileId of [...WINDOWS_ACCEPTANCE_PROFILE_IDS].reverse()) {
      await launcher.stop(profileId).catch(() => false);
    }
    store.close();
  }
}

async function runCloudLauncherSmoke(paths: StatePaths, rest: string[]): Promise<void> {
  if (has(rest, "windows-window-acceptance")) {
    await runWindowsWindowAcceptance(paths, rest);
    return;
  }
  const profileId = "aliasmode-cloud-smoke";
  const canaryWorkerTimeoutMs = has(rest, "unsafe-disable-identity-gates")
    ? UNSAFE_CANARY_TIMEOUT_MS
    : undefined;
  const store = new ProfileStore(paths.cloudDatabase);
  const queue = new PendingSyncQueue(paths.pendingSync, new Uint8Array(32).fill(1));
  const smokeProxy = has(rest, "proxy-mismatch")
    ? await startProxyMismatchFixture()
    : cloudLauncherSmokeProxy(rest);
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
  );
  const profile = smokeProfile(
    profileId,
    "Cloud launcher smoke",
    1,
    smokeProxy?.profileProxy ?? null,
  );
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
    readSession: (endpoint, captureSeed) => readSessionInSubprocess(endpoint, {
      captureSeed,
      ...(canaryWorkerTimeoutMs ? { timeoutMs: canaryWorkerTimeoutMs } : {}),
    }),
    applySession: (endpoint, bundle, urls) =>
      applySessionToEndpoint(endpoint, bundle, urls, {
        log: (m) => console.log(`[aliasmode] ${m}`),
        ...(canaryWorkerTimeoutMs ? { writeTimeoutMs: canaryWorkerTimeoutMs } : {}),
      }),
    heartbeatMs: 0,
  });

  try {
    await exerciseCloudLauncherSmoke(
      { coordinator, launcher, store },
      profileId,
      smokeProxy?.startupUrl ? [smokeProxy.startupUrl] : [],
    );
    smokeProxy?.assertComplete?.();
  } finally {
    await coordinator.releaseAll(true).catch(() => false);
    await launcher.stop(profileId).catch(() => false);
    smokeProxy?.close?.();
    queue.close();
    store.close();
  }
}

const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;

/** Mirror console output to <root>/logs/aliasmode-<date>.log (rotates at 2 MB). Best-effort. */
function installFileLogging(root: string): void {
  try {
    const dir = join(root, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `aliasmode-${new Date().toISOString().slice(0, 10)}.log`);
    appendFileSync(file, `${new Date().toISOString()} sidecar start v${ALIASMODE_VERSION} pid=${process.pid}\n`);
    const write = (stream: NodeJS.WriteStream, args: unknown[]) => {
      try {
        const line = new Date().toISOString() + " " + args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n";
        if (statSync(file).size > MAX_LOG_FILE_BYTES) renameSync(file, file.replace(/\.log$/, ".1.log"));
        appendFileSync(file, line);
      } catch {
        try { appendFileSync(file, new Date().toISOString() + " " + args.join(" ") + "\n"); } catch {}
      }
      stream.write(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
    };
    console.log = (...args: unknown[]) => write(process.stdout, args);
    console.error = (...args: unknown[]) => write(process.stderr, args);
  } catch {
    // Logging must never break startup.
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === CLOAKPIT_IMPORT_COMMAND) {
    const result = await runCloakpitImportCommand(argv.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (argv[0] === "__cloud-restore-fixture") {
    await runCloudRestoreFixture(argv.slice(1));
    return;
  }

  // Playwright-over-CDP on Bun emits occasional stray websocket rejections
  // ("ws.WebSocket 'upgrade' event is not implemented in bun"). Left unhandled,
  // Bun exits the process — which would crash the long-running manager or cut a
  // diagnose run short. Log and continue instead.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    // ONLY the known Bun+Playwright ws-upgrade noise is non-fatal. Anything
    // else (a DB failure, an unhandled launcher path) is a real bug — surface it
    // loudly and exit rather than masking it as "(non-fatal)" and continuing in
    // a possibly-corrupt state. The desktop enters a static degraded state.
    if (msg.includes("not implemented in bun") || msg.includes("WebSocket 'upgrade'")) {
      console.error("[aliasmode] (non-fatal) Bun ws-upgrade noise");
      return;
    }
    console.error("[aliasmode] FATAL unhandled rejection");
    process.exit(1);
  });

  if (typeof ALIASMODE_COMPILED !== "undefined" && ALIASMODE_COMPILED === true) {
    const runtime = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME?.trim() || defaultPlaywrightRuntimeRoot();
    process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = runtime;
    await verifyPlaywrightRuntime(runtime);
  }
  if (await dispatchReadSessionWorker(argv)) return;

  const [cmd, ...rest] = argv;
  const paths = statePaths(resolveStateRoot(rest));
  const desktop = has(rest, "desktop-stdio");
  // The desktop sidecar's stdout/stderr are discarded by the Tauri shell, which
  // made device-only failures undebuggable. Mirror every log line to a rotating
  // file under <state-root>/logs/ so a failed open can be diagnosed for real.
  installFileLogging(paths.root);
  if (desktop && cmd !== "start") throw new Error("--desktop-stdio is supported only by the start command");
  const desktopHealth = desktop
    ? desktopHealthMetadata(process.env, flag(rest, "desktop-root"))
    : null;
  const desktopCredentials = desktopHealth
    ? new DesktopCredentialBridge(desktopHealth.instance)
    : null;
  ensureStateDirectories(paths);
  if (cmd === "__cloud-launcher-smoke") {
    await runCloudLauncherSmoke(paths, rest);
    console.log(has(rest, "windows-window-acceptance")
      ? "installed CloakBrowser native minimize, background page, session capture, target, HWND, and foreground acceptance passed"
      : "compiled sidecar opened, restored, captured, and closed a fresh and repeated cached Cloud profile");
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
          readSession: (endpoint, captureSeed) => readSessionInSubprocess(endpoint, { captureSeed }),
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
  main().catch(() => {
    console.error("[aliasmode] FATAL command failure");
    process.exit(1);
  });
}

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
import { Launcher } from "./launcher.ts";
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
} from "./session.ts";
import { importBuffers, importInbox, watchInbox } from "./inbox.ts";
import { ensureStateDirectories, resolveStateRoot, statePaths } from "./paths.ts";
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
import { PendingSyncRuntime } from "./pending-sync.ts";
import { SupabaseAuthClient } from "./supabase-auth.ts";
import { runDiagnostics } from "./diagnose.ts";
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { defaultOperatorName } from "./operator.ts";
import { ensureDuckDuckGoDefault } from "./search-provider.ts";
import { installCloakBrowser } from "./browser-install.ts";
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

function makeLauncher(store: ProfileStore, rest: string[], remoteMode = false, defaultDataRoot = "profiles"): Launcher {
  return new Launcher({
    store,
    dataRoot: flag(rest, "data-root") ?? defaultDataRoot,
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
    writeSession,
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
  const dbPath = flag(rest, "db") ?? paths.database;
  const cloudConnection = cloudAuth && cloudConfig
    ? new CloudConnectionRuntime({
        baseUrl: cloudConfig.apiUrl,
        accessToken: () => cloudAuth.accessTokenOrRefresh(),
        installation: {
          installationId: defaultOperatorName(dbPath),
          label: hostname(),
          platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
          appVersion: process.env.ALIASMODE_APP_VERSION ?? "0.1.0-beta.1",
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
      const bundle = JSON.parse(await readSessionInSubprocess(endpoint));
      if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.cookies)) {
        throw new Error("compiled sidecar capture returned an invalid session bundle");
      }
      console.log("compiled sidecar captured a session over Playwright CDP");
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
        const owner = defaultOperatorName(dbPath);
        console.log(`local instance "${owner}" (hub lock attribution: this box's operator id)`);
        const launcher = makeLauncher(store, rest, true, paths.profiles);
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
      const launcher = makeLauncher(store, rest, savedMode.mode === "cloud", paths.profiles);
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
      const launcher = makeLauncher(store, rest, savedMode.mode === "cloud", paths.profiles);
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

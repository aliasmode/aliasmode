import { expect, test } from "bun:test";
import {
  cloudRuntimeConfiguration,
  dispatchReadSessionWorker,
  drainRemoteShutdown,
  exerciseCloudLauncherSmoke,
  lifecycleAdmissionOptionsFromEnv,
  OFFICIAL_CLOUD_ANON_KEY,
  OFFICIAL_CLOUD_URL,
  RemoteShutdownTimeoutError,
  runCompiledSidecarSmoke,
  selectedCloudUrl,
} from "./cli.ts";

const cloudMode = {
  version: 1 as const,
  mode: "cloud" as const,
  localAnalytics: false,
};

const localMode = {
  version: 1 as const,
  mode: "local" as const,
  localAnalytics: false,
};

test("compiled sidecar smoke restores before navigation and capture", async () => {
  const events: string[] = [];
  await runCompiledSidecarSmoke("http://127.0.0.1:9222", {
    async writeSession(endpoint, bundle) {
      events.push(`write:${endpoint}`);
      expect(JSON.parse(bundle)).toEqual({
        cookies: [{
          name: "aliasmode_smoke",
          value: "live",
          domain: ".x.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        }],
        origins: [{
          origin: "https://web.telegram.org",
          localStorage: [{ name: "aliasmode_smoke", value: "live" }],
        }],
      });
    },
    async assertAlive(endpoint) {
      events.push(`alive:${endpoint}`);
    },
    async webSocketEndpoint(endpoint) {
      events.push(`resolve:${endpoint}`);
      return "ws://127.0.0.1:9222/devtools/browser/current";
    },
    async navigate(endpoint) {
      events.push(`navigate:${endpoint}`);
    },
    async readSession(endpoint) {
      events.push(`read:${endpoint}`);
      return JSON.stringify({ cookies: [{ name: "aliasmode_smoke", value: "live" }] });
    },
  });
  expect(events).toEqual([
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "resolve:http://127.0.0.1:9222",
    "write:ws://127.0.0.1:9222/devtools/browser/current",
    "alive:http://127.0.0.1:9222",
    "navigate:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "read:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
  ]);
});

test("Cloud launcher smoke requires fresh and repeated cached opens to stay alive and close cleanly", async () => {
  const events: string[] = [];
  let running = false;
  let launch: object | null = null;
  let opens = 0;
  const coordinator = {
    async open(profileId: string, launchArgs: string[]) {
      opens++;
      events.push(`open:${opens}:${profileId}:${launchArgs.join(",")}`);
      running = true;
      launch = { profileId };
      return { ok: true, ws: `ws://smoke/${opens}`, port: 9200 + opens };
    },
    async close(profileId: string) {
      events.push(`close:${opens}:${profileId}`);
      running = false;
      launch = null;
      return true;
    },
    async releaseAll() { return true; },
  };
  const launcher = {
    async active(profileId: string) {
      events.push(`active:${opens}:${profileId}:${running}`);
      return running;
    },
    async stop() { return true; },
  };
  const store = { getLaunch: () => launch };

  await exerciseCloudLauncherSmoke(
    { coordinator, launcher, store } as any,
    "profile-smoke",
    ["http://cloud-open.invalid/ok"],
  );

  expect(events).toEqual([
    "open:1:profile-smoke:http://cloud-open.invalid/ok",
    "active:1:profile-smoke:true",
    "close:1:profile-smoke",
    "active:1:profile-smoke:false",
    "open:2:profile-smoke:http://cloud-open.invalid/ok",
    "active:2:profile-smoke:true",
    "close:2:profile-smoke",
    "active:2:profile-smoke:false",
    "open:3:profile-smoke:http://cloud-open.invalid/ok",
    "active:3:profile-smoke:true",
    "close:3:profile-smoke",
    "active:3:profile-smoke:false",
  ]);
});

test("CLI dispatches the session worker before normal command parsing", async () => {
  const events: string[] = [];
  expect(await dispatchReadSessionWorker(["list"], {
    async readSession() { throw new Error("must not run"); },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(false);
  expect(events).toEqual([]);

  expect(await dispatchReadSessionWorker(["--read-session-worker", "ws://capture"], {
    async readSession(ws) {
      expect(ws).toBe("ws://capture");
      return "captured bundle";
    },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(true);
  expect(events).toEqual([
    JSON.stringify({ ok: true, bundle: "captured bundle" }),
    "exit:0",
  ]);
});

test("official Cloud configuration works without environment variables", () => {
  expect(cloudRuntimeConfiguration(cloudMode, {})).toEqual({
    apiUrl: OFFICIAL_CLOUD_URL,
    authUrl: OFFICIAL_CLOUD_URL,
    anonKey: OFFICIAL_CLOUD_ANON_KEY,
  });
});

test("Cloud configuration preserves explicit staging overrides", () => {
  expect(cloudRuntimeConfiguration(cloudMode, {
    ALIASMODE_CLOUD_URL: "http://127.0.0.1:3000/",
    ALIASMODE_SUPABASE_URL: "http://localhost:9999/",
    ALIASMODE_SUPABASE_ANON_KEY: "staging-public-key",
  })).toEqual({
    apiUrl: "http://127.0.0.1:3000",
    authUrl: "http://localhost:9999",
    anonKey: "staging-public-key",
  });
});

test("persisted Cloud URL configures both API and Auth", () => {
  const savedMode = { ...cloudMode, cloudUrl: "https://saved.aliasmode.test" };
  expect(cloudRuntimeConfiguration(savedMode, {})).toEqual({
    apiUrl: "https://saved.aliasmode.test",
    authUrl: "https://saved.aliasmode.test",
    anonKey: OFFICIAL_CLOUD_ANON_KEY,
  });
});

test("nonblank environment Cloud URL overrides the persisted selection", () => {
  const savedMode = { ...cloudMode, cloudUrl: "https://saved.aliasmode.test" };
  const env = { ALIASMODE_CLOUD_URL: "https://override.aliasmode.test/" };
  expect(selectedCloudUrl(savedMode, env)).toBe("https://override.aliasmode.test/");
  expect(cloudRuntimeConfiguration(savedMode, env)).toMatchObject({
    apiUrl: "https://override.aliasmode.test",
    authUrl: "https://override.aliasmode.test",
  });
});

test("blank Cloud overrides fall back to official configuration", () => {
  expect(cloudRuntimeConfiguration(cloudMode, {
    ALIASMODE_CLOUD_URL: "  ",
    ALIASMODE_SUPABASE_URL: "\t",
    ALIASMODE_SUPABASE_ANON_KEY: " ",
  })).toEqual({
    apiUrl: OFFICIAL_CLOUD_URL,
    authUrl: OFFICIAL_CLOUD_URL,
    anonKey: OFFICIAL_CLOUD_ANON_KEY,
  });
});

test("Local mode does not initialize or validate Cloud configuration", () => {
  const invalidEnv = {
    ALIASMODE_CLOUD_URL: "not a URL",
    ALIASMODE_SUPABASE_URL: "not a URL",
    ALIASMODE_SUPABASE_ANON_KEY: "",
  };
  expect(selectedCloudUrl(localMode, invalidEnv)).toBe("not a URL");
  expect(cloudRuntimeConfiguration(localMode, invalidEnv)).toBeNull();
});

test("Cloud mode rejects invalid explicit configuration", () => {
  expect(() => cloudRuntimeConfiguration(cloudMode, {
    ALIASMODE_CLOUD_URL: "http://cloud.example.com",
  })).toThrow("AliasMode Cloud URL must use HTTPS");
});

test("lifecycle admission env config is optional and parses positive integers", () => {
  expect(lifecycleAdmissionOptionsFromEnv({})).toEqual({});
  expect(lifecycleAdmissionOptionsFromEnv({
    ALIASMODE_LIFECYCLE_CAP: "6",
    ALIASMODE_LIFECYCLE_WAIT_MS: "180000",
  })).toEqual({ limit: 6, queueWaitMs: 180_000 });
});

test("invalid lifecycle admission env config fails startup validation", () => {
  for (const [name, value] of [
    ["ALIASMODE_LIFECYCLE_CAP", "0"],
    ["ALIASMODE_LIFECYCLE_CAP", "4.5"],
    ["ALIASMODE_LIFECYCLE_CAP", "NaN"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", "Infinity"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", ""],
  ] as const) {
    expect(() => lifecycleAdmissionOptionsFromEnv({ [name]: value })).toThrow(`${name} must be a positive integer`);
  }
});

test("remote shutdown retries unconfirmed cleanup until it is safe to exit", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const logs: string[] = [];

  await drainRemoteShutdown(
    async () => ++attempts >= 3,
    {
      retryMs: 7,
      attemptLogMs: 100,
      sleep: async (ms) => { waits.push(ms); },
      log: (message) => logs.push(message),
    },
  );

  expect(attempts).toBe(3);
  expect(waits).toEqual([7, 7]);
  expect(logs.filter((message) => message.includes("remains unconfirmed")).length).toBe(2);
  expect(logs.at(-1)).toContain("confirmed on attempt 3");
});

test("remote shutdown logs a hung cleanup in bounded windows without overlapping it", async () => {
  let attempts = 0;
  let finish!: (confirmed: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { finish = resolve; });
  const logs: string[] = [];

  const draining = drainRemoteShutdown(
    () => {
      attempts++;
      return pending;
    },
    {
      attemptLogMs: 2,
      retryMs: 1,
      sleep: async () => {},
      log: (message) => logs.push(message),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 12));
  expect(attempts).toBe(1);
  expect(logs.some((message) => message.includes("continuing to wait without overlapping"))).toBe(true);

  finish(true);
  await draining;
  expect(attempts).toBe(1);
});

test("remote shutdown has a total deadline even when cleanup never settles", async () => {
  let attempts = 0;
  const never = new Promise<boolean>(() => {});

  const draining = drainRemoteShutdown(
    () => {
      attempts++;
      return never;
    },
    {
      maxDrainMs: 12,
      attemptLogMs: 3,
      retryMs: 1,
      log: () => {},
    },
  );

  await expect(draining).rejects.toBeInstanceOf(RemoteShutdownTimeoutError);
  expect(attempts).toBe(1);
});

test("remote shutdown deadline retains failed cleanup instead of retrying forever", async () => {
  let attempts = 0;
  let now = 0;

  await expect(drainRemoteShutdown(
    async () => {
      attempts++;
      return false;
    },
    {
      maxDrainMs: 10,
      retryMs: 7,
      attemptLogMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      log: () => {},
    },
  )).rejects.toThrow("launch records and any unconfirmed hub locks were intentionally retained");

  expect(attempts).toBe(2);
});

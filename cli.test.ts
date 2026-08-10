import { expect, test } from "bun:test";
import {
  dispatchReadSessionWorker,
  drainRemoteShutdown,
  lifecycleAdmissionOptionsFromEnv,
  RemoteShutdownTimeoutError,
} from "./cli.ts";

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

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, type ScheduleRunner } from "./scheduler.ts";
import { ScriptError, type ScriptRun } from "./scripts.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const HOUR = 3_600_000;

function harness(options: { busy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-scheduler-"));
  roots.push(root);
  const clock = { now: new Date(2026, 0, 1, 8, 0, 0).getTime() };
  const state = { scope: "local", busy: !!options.busy, hang: false, shutdowns: 0, open: true, failProfile: "" as string, started: [] as any[], view: null as ScriptRun | null };
  let release = () => {};
  const hung = new Promise<void>((resolve) => { release = resolve; });
  const runner: ScheduleRunner = {
    start(request) {
      if (state.busy) throw new ScriptError("A script is already running", 409);
      state.started.push(request);
      state.view = {
        id: `run-${state.started.length}`, scriptId: request.scriptId, scriptName: "Script", status: "finished",
        profiles: request.profileIds.map((id) => id === state.failProfile
          ? { id, name: id, status: "failed" as const, error: "Profile is open on another device" }
          : { id, name: id, status: "succeeded" as const }),
      };
      return state.view;
    },
    settled: () => state.hang ? hung : Promise.resolve(),
    status: () => state.view,
    shutdown: async () => { state.shutdowns++; release(); },
  };
  const scheduler = new Scheduler({ root, runner, scope: () => state.scope, isOpen: async () => state.open, now: () => clock.now });
  const job = { scriptId: "s1", profileIds: ["a", "b"], inputs: { k: 1 }, everyHours: 2 };
  return { root, clock, state, scheduler, job };
}

test("a due job runs once and records history", async () => {
  const h = harness();
  const saved = h.scheduler.save(h.job);
  expect(saved.nextRun).toBe(h.clock.now + 2 * HOUR);
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(0);
  h.clock.now += 2 * HOUR;
  await h.scheduler.tick();
  expect(h.state.started).toEqual([{ scriptId: "s1", profileIds: ["a", "b"], inputs: { k: 1 }, useCredentials: false }]);
  const { jobs, history } = h.scheduler.list();
  expect(jobs[0]!.nextRun).toBe(h.clock.now + 2 * HOUR);
  expect(jobs[0]!.lastRun).toEqual({ at: h.clock.now, status: "succeeded" });
  expect(history).toEqual([expect.objectContaining({ jobId: saved.id, status: "succeeded", runId: "run-1" })]);
  const file = join(h.root, "schedules", "local.json");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a busy runner retries on the next tick without moving the slot", async () => {
  const h = harness({ busy: true });
  const saved = h.scheduler.save(h.job);
  h.clock.now += 2 * HOUR;
  await h.scheduler.tick();
  expect(h.scheduler.list().jobs[0]!.nextRun).toBe(saved.nextRun);
  expect(h.scheduler.list().history).toHaveLength(0);
  h.state.busy = false;
  h.clock.now += 30_000;
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(1);
});

test("a missed run collapses to one and does not build a backlog", async () => {
  const h = harness();
  h.scheduler.save(h.job);
  h.clock.now += 20 * HOUR;
  await h.scheduler.tick();
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(1);
  expect(h.scheduler.list().jobs[0]!.nextRun).toBe(h.clock.now + 2 * HOUR);
});

test("a daily job picks the next local time and failed profiles are recorded", async () => {
  const h = harness();
  const saved = h.scheduler.save({ ...h.job, everyHours: undefined, dailyAt: "09:30" });
  expect(saved.nextRun).toBe(new Date(2026, 0, 1, 9, 30).getTime());
  h.state.failProfile = "b";
  h.clock.now = new Date(2026, 0, 1, 9, 31).getTime();
  await h.scheduler.tick();
  const { jobs, history } = h.scheduler.list();
  expect(jobs[0]!.nextRun).toBe(new Date(2026, 0, 2, 9, 30).getTime());
  expect(jobs[0]!.lastRun!.status).toBe("failed");
  expect(history[0]!.profiles).toContainEqual({ id: "b", name: "b", status: "failed", error: "Profile is open on another device" });
  expect(() => h.scheduler.save({ ...h.job, dailyAt: "25:00", everyHours: undefined })).toThrow();
  expect(() => h.scheduler.save({ ...h.job, dailyAt: "09:00" })).toThrow();
});

test("schedules are kept per scope and skipped while no account is available", async () => {
  const h = harness();
  h.scheduler.save(h.job);
  h.clock.now += 3 * HOUR;
  h.state.scope = "account-x";
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(0);
  expect(h.scheduler.list().jobs).toEqual([]);
  h.state.scope = "local";
  expect(h.scheduler.list().jobs).toHaveLength(1);
  h.state.scope = "";
  Object.defineProperty(h.state, "scope", { get() { throw new ScriptError("Sign in to AliasMode Cloud first", 401); }, configurable: true });
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(0);
});

test("a run on open starts after the open, once per profile, and retries while busy", async () => {
  const h = harness({ busy: true });
  h.scheduler.setOnOpen("p1", "s9");
  h.scheduler.enqueueOpen("p1");
  h.scheduler.enqueueOpen("p1");
  h.scheduler.enqueueOpen("p2");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.state.started).toHaveLength(0);
  h.state.busy = false;
  await h.scheduler.tick();
  expect(h.state.started).toEqual([{ scriptId: "s9", profileIds: ["p1"], inputs: {}, useCredentials: false }]);
  expect(h.scheduler.list().history[0]!.jobId).toBe("open:p1");
  h.scheduler.setOnOpen("p1", null);
  expect(h.scheduler.list().onOpen).toEqual({});
});

test("history keeps the last 50 entries and shutdown stops new runs", async () => {
  const h = harness();
  h.scheduler.save({ ...h.job, everyHours: 1 });
  for (let i = 0; i < 55; i++) { h.clock.now += HOUR; await h.scheduler.tick(); }
  expect(h.scheduler.list().history).toHaveLength(50);
  await h.scheduler.shutdown();
  h.clock.now += HOUR;
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(55);
  expect(existsSync(join(h.root, "schedules", "local.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(h.root, "schedules", "local.json"), "utf8")).history).toHaveLength(50);
});

test("shutdown aborts a running job before waiting for it", async () => {
  const h = harness();
  h.state.hang = true;
  h.scheduler.save(h.job);
  h.clock.now += 2 * HOUR;
  const ticking = h.scheduler.tick();
  await Promise.resolve();
  await h.scheduler.shutdown();
  await ticking;
  expect(h.state.shutdowns).toBe(1);
});

test("a queued run on open is skipped when the profile was closed meanwhile", async () => {
  const h = harness({ busy: true });
  h.scheduler.setOnOpen("p1", "s9");
  h.scheduler.enqueueOpen("p1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.state.busy = false;
  h.state.open = false;
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(0);
  expect(h.scheduler.list().history[0]).toMatchObject({ jobId: "open:p1", status: "skipped", error: "skipped: profile closed" });
  await h.scheduler.tick();
  expect(h.state.started).toHaveLength(0);
});

test("a job can run hidden and a run on open never does", async () => {
  const h = harness();
  h.scheduler.save({ ...h.job, headless: true });
  h.clock.now += 2 * HOUR;
  await h.scheduler.tick();
  expect(h.state.started[0]).toMatchObject({ headless: true });
  h.scheduler.setOnOpen("p1", "s9");
  h.scheduler.enqueueOpen("p1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.state.started[1]).not.toHaveProperty("headless");
});

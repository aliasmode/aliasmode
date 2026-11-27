import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptError, type ScriptRun } from "./scripts.ts";

export interface ScheduleJob {
  id: string;
  name?: string;
  scriptId: string;
  profileIds: string[];
  inputs: Record<string, unknown>;
  useCredentials: boolean;
  /** Open the browsers hidden. */
  headless?: boolean;
  /** Exactly one of these sets the cadence. */
  everyHours?: number;
  /** "HH:MM" in the computer's local time. */
  dailyAt?: string;
  enabled: boolean;
  nextRun: number;
  lastRun?: { at: number; status: HistoryStatus };
}

export type HistoryStatus = "succeeded" | "failed" | "cancelled" | "skipped";

export interface ScheduleHistoryEntry {
  /** A job id, or `open:<profileId>` for a run-on-open run. */
  jobId: string;
  at: number;
  status: HistoryStatus;
  profiles: { id: string; name: string; status: string; error?: string; warning?: string }[];
  runId: string;
  error?: string;
  /** The script the run ran and whether it had saved logins; absent in older entries and when no run started. */
  scriptId?: string;
  useCredentials?: boolean;
}

export interface ScheduleState {
  jobs: ScheduleJob[];
  history: ScheduleHistoryEntry[];
  onOpen: Record<string, string>;
}

/** The part of ScriptSupervisor the scheduler drives. */
export interface ScheduleRunner {
  start(request: { scriptId: string; profileIds: string[]; inputs: Record<string, unknown>; useCredentials: boolean; headless?: boolean }): ScriptRun;
  settled(): Promise<void>;
  status(): ScriptRun | null;
  /** Abort any run and refuse new ones. */
  shutdown(): Promise<void>;
}

export interface SchedulerOptions {
  root: string;
  runner: ScheduleRunner;
  /** The library scope; throws while no account is available. */
  scope: () => string;
  /** Whether the profile's browser is still open; a run on open is dropped when it is not. */
  isOpen?: (profileId: string) => Promise<boolean>;
  now?: () => number;
  tickMs?: number;
  log?: (message: string) => void;
}

interface OpenItem { scope: string; profileId: string; scriptId: string; at: number }

const HISTORY_LIMIT = 50;
const DAILY_AT = /^([01]\d|2[0-3]):[0-5]\d$/;

function nextAfter(job: Pick<ScheduleJob, "everyHours" | "dailyAt">, now: number): number {
  if (job.everyHours !== undefined) return now + job.everyHours * 3_600_000;
  const [hours, minutes] = job.dailyAt!.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours!, minutes!, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function jobInput(value: any): Pick<ScheduleJob, "name" | "scriptId" | "profileIds" | "inputs" | "useCredentials" | "headless" | "everyHours" | "dailyAt" | "enabled"> {
  const hours = value?.everyHours;
  const daily = value?.dailyAt;
  if (!value || typeof value.scriptId !== "string" || !value.scriptId
    || !Array.isArray(value.profileIds) || !value.profileIds.length || !value.profileIds.every((id: unknown) => typeof id === "string" && id)
    || !value.inputs || typeof value.inputs !== "object" || Array.isArray(value.inputs)) {
    throw new ScriptError("Choose a script, profiles, and a JSON object for inputs");
  }
  if ((hours === undefined) === (daily === undefined)
    || (hours !== undefined && !(typeof hours === "number" && Number.isFinite(hours) && hours > 0))
    || (daily !== undefined && !(typeof daily === "string" && DAILY_AT.test(daily)))) {
    throw new ScriptError("Set either a positive number of hours or a daily time as HH:MM");
  }
  return {
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    scriptId: value.scriptId, profileIds: [...new Set<string>(value.profileIds)], inputs: value.inputs,
    useCredentials: value.useCredentials === true,
    ...(value.headless === true ? { headless: true } : {}),
    ...(hours !== undefined ? { everyHours: hours } : { dailyAt: daily }),
    enabled: value.enabled !== false,
  };
}

function summarize(view: ScriptRun | null): { status: HistoryStatus; profiles: ScheduleHistoryEntry["profiles"] } {
  const profiles = (view?.profiles ?? []).map(({ id, name, status, error, warning }) => ({ id, name, status, ...(error ? { error } : {}), ...(warning ? { warning } : {}) }));
  const status = !view || profiles.some((item) => item.status === "failed") ? "failed"
    : profiles.some((item) => item.status === "cancelled") ? "cancelled" : "succeeded";
  return { status, profiles };
}

/**
 * Runs saved scripts on a timer and when a profile opens. Runs one at a time through the
 * ScriptSupervisor, so a manual run delays a due job. Jobs only run while the app is open.
 */
export class Scheduler {
  private readonly directory: string;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private inflight?: Promise<void>;
  private opens: OpenItem[] = [];
  constructor(private readonly options: SchedulerOptions) {
    this.directory = join(options.root, "schedules");
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  start(): void {
    this.timer ??= setInterval(() => { void this.tick(); }, this.options.tickMs ?? 30_000);
    this.timer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    // Abort the run first; waiting for it to end on its own could outlast the quit deadline.
    await this.options.runner.shutdown();
    await this.inflight;
  }

  private read(scope: string): ScheduleState {
    const path = join(this.directory, `${scope}.json`);
    const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    return { jobs: state.jobs ?? [], history: state.history ?? [], onOpen: state.onOpen ?? {} };
  }

  private write(scope: string, state: ScheduleState): void {
    if (this.options.scope() !== scope) throw new ScriptError("The signed-in account changed", 409);
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${scope}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  }

  list(): ScheduleState {
    return this.read(this.options.scope());
  }

  save(value: unknown, id?: string): ScheduleJob {
    const scope = this.options.scope();
    const state = this.read(scope);
    const input = jobInput(value);
    const existing = id ? state.jobs.find((job) => job.id === id) : undefined;
    if (id && !existing) throw new ScriptError("Schedule not found", 404);
    const reschedule = !existing || existing.everyHours !== input.everyHours || existing.dailyAt !== input.dailyAt || (!existing.enabled && input.enabled);
    const job: ScheduleJob = {
      ...(existing ? { lastRun: existing.lastRun } : {}),
      ...input, id: existing?.id ?? randomUUID(),
      nextRun: reschedule ? nextAfter(input, this.now()) : existing!.nextRun,
    };
    this.write(scope, { ...state, jobs: [...state.jobs.filter((item) => item.id !== job.id), job] });
    return job;
  }

  remove(id: string): void {
    const scope = this.options.scope();
    const state = this.read(scope);
    if (!state.jobs.some((job) => job.id === id)) throw new ScriptError("Schedule not found", 404);
    this.write(scope, { ...state, jobs: state.jobs.filter((job) => job.id !== id) });
  }

  setOnOpen(profileId: string, scriptId: string | null): void {
    if (typeof scriptId === "string" && !scriptId) throw new ScriptError("Choose a script or None");
    const scope = this.options.scope();
    const state = this.read(scope);
    const { [profileId]: _removed, ...rest } = state.onOpen;
    this.write(scope, { ...state, onOpen: scriptId ? { ...rest, [profileId]: scriptId } : rest });
  }

  /** Queue the profile's run-on-open script after a UI open. Never waits for the script. */
  enqueueOpen(profileId: string): void {
    if (this.closed) return;
    try {
      const scope = this.options.scope();
      const scriptId = this.read(scope).onOpen[profileId];
      if (!scriptId) return;
      this.opens = this.opens.filter((item) => item.profileId !== profileId);
      this.opens.push({ scope, profileId, scriptId, at: this.now() });
      void this.tick();
    } catch (error) {
      this.options.log?.(`run on open skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Start the next due item if the runner is free. */
  async tick(): Promise<void> {
    if (this.closed || this.inflight) return;
    let scope: string;
    try { scope = this.options.scope(); } catch { return; }
    this.opens = this.opens.filter((item) => item.scope === scope);
    let state: ScheduleState;
    try { state = this.read(scope); } catch (error) {
      this.options.log?.(`schedules unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const now = this.now();
    const due = ([
      ...this.opens.map((item) => ({ at: item.at, open: item })),
      ...state.jobs.filter((job) => job.enabled && job.nextRun <= now).map((job) => ({ at: job.nextRun, job })),
    ] as { at: number; job?: ScheduleJob; open?: OpenItem }[]).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    const id = due.job?.id ?? `open:${due.open!.profileId}`;
    if (due.open && this.options.isOpen && !await this.options.isOpen(due.open.profileId).catch(() => false)) {
      this.opens = this.opens.filter((item) => item !== due.open);
      this.record(scope, undefined, { jobId: id, at: now, status: "skipped", profiles: [], runId: "", error: "skipped: profile closed" });
      return;
    }
    const request = due.job
      ? { scriptId: due.job.scriptId, profileIds: due.job.profileIds, inputs: due.job.inputs, useCredentials: due.job.useCredentials, ...(due.job.headless ? { headless: true } : {}) }
      : { scriptId: due.open!.scriptId, profileIds: [due.open!.profileId], inputs: {}, useCredentials: false };
    let view: ScriptRun;
    try {
      view = this.options.runner.start(request);
    } catch (error) {
      // A busy or paused runner retries on the next tick; anything else is a failed slot.
      if (error instanceof ScriptError && error.status === 409) return;
      this.opens = this.opens.filter((item) => item !== due.open);
      if (due.job) this.update(scope, due.job.id, (job) => ({ ...job, nextRun: nextAfter(job, now) }));
      this.record(scope, due.job, { jobId: id, at: now, status: "failed", profiles: [], runId: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.opens = this.opens.filter((item) => item !== due.open);
    // A missed run runs once; the next slot counts from now, so no backlog builds up.
    if (due.job) this.update(scope, due.job.id, (job) => ({ ...job, nextRun: nextAfter(job, now) }));
    this.inflight = this.options.runner.settled().then(() => {
      const { status, profiles } = summarize(this.options.runner.status());
      this.record(scope, due.job, { jobId: id, at: this.now(), status, profiles, runId: view.id, scriptId: request.scriptId, useCredentials: request.useCredentials });
    }).finally(() => { this.inflight = undefined; });
    await this.inflight;
  }

  private update(scope: string, id: string, change: (job: ScheduleJob) => ScheduleJob): void {
    try {
      const state = this.read(scope);
      this.write(scope, { ...state, jobs: state.jobs.map((job) => job.id === id ? change(job) : job) });
    } catch (error) {
      this.options.log?.(`schedule update skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private record(scope: string, job: ScheduleJob | undefined, entry: ScheduleHistoryEntry): void {
    try {
      const state = this.read(scope);
      this.write(scope, {
        ...state,
        jobs: state.jobs.map((item) => item.id === job?.id ? { ...item, lastRun: { at: entry.at, status: entry.status } } : item),
        history: [entry, ...state.history].slice(0, HISTORY_LIMIT),
      });
    } catch (error) {
      // The account changed or the disk refused; the run itself already ended.
      this.options.log?.(`schedule history skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

import { expect, test } from "bun:test";
import {
  LifecycleAdmissionController,
  LifecycleAdmissionError,
  classifyLifecycleRequest,
  dispatchWithLifecycleAdmission,
} from "./lifecycle-admission.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("invalid admission configuration is rejected instead of disabling dispatch", () => {
  expect(() => new LifecycleAdmissionController({ limit: Number.NaN })).toThrow("positive integer");
  expect(() => new LifecycleAdmissionController({ limit: 1.5 })).toThrow("positive integer");
  expect(() => new LifecycleAdmissionController({ queueWaitMs: Number.POSITIVE_INFINITY })).toThrow("positive integer");
  expect(() => new LifecycleAdmissionController({ queueWaitMs: 0 })).toThrow("positive integer");
});

test("64 starts reserve one slot without exceeding the total cap", async () => {
  const admission = new LifecycleAdmissionController({ limit: 4, queueWaitMs: 1_000 });
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 64 }, (_, index) =>
    admission.run({ kind: "start", profileIds: [`p${index}`] }, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await tick();
      active--;
    })
  ));
  expect(maximum).toBe(3);
  expect(admission.stats()).toEqual({
    limit: 4,
    inFlight: 0,
    queued: 0,
    byKind: {
      stop: { inFlight: 0, queued: 0 },
      cleanup: { inFlight: 0, queued: 0 },
      start: { inFlight: 0, queued: 0 },
    },
  });
});

test("the reserved lane admits stop and cleanup while another start waits", async () => {
  const admission = new LifecycleAdmissionController({ limit: 4, queueWaitMs: 1_000 });
  const startGates = [deferred(), deferred(), deferred()];
  const starts = startGates.map((gate, index) =>
    admission.run({ kind: "start", profileIds: [`running-${index}`] }, () => gate.promise)
  );
  await tick();

  const fourthGate = deferred();
  let fourthStarted = false;
  const fourth = admission.run({ kind: "start", profileIds: ["waiting"] }, () => {
    fourthStarted = true;
    return fourthGate.promise;
  });
  await tick();
  expect(fourthStarted).toBe(false);

  const stopGate = deferred();
  let stopStarted = false;
  const stop = admission.run({ kind: "stop", profileIds: ["stopping"] }, () => {
    stopStarted = true;
    return stopGate.promise;
  });
  await tick();
  expect(stopStarted).toBe(true);
  expect(admission.stats()).toMatchObject({ inFlight: 4, queued: 1 });

  const cleanupGate = deferred();
  let cleanupStarted = false;
  const cleanup = admission.run({ kind: "cleanup", profileIds: ["cleaning"] }, () => {
    cleanupStarted = true;
    return cleanupGate.promise;
  });
  stopGate.resolve();
  await stop;
  await tick();
  expect(cleanupStarted).toBe(true);
  expect(fourthStarted).toBe(false);
  expect(admission.stats()).toMatchObject({ inFlight: 4, queued: 1 });

  cleanupGate.resolve();
  await cleanup;
  await tick();
  expect(fourthStarted).toBe(false);

  startGates[0]!.resolve();
  await starts[0];
  await tick();
  expect(fourthStarted).toBe(true);

  fourthGate.resolve();
  startGates[1]!.resolve();
  startGates[2]!.resolve();
  await Promise.all([...starts, fourth]);
});

test("a limit of one still admits a start", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let started = false;
  await admission.run({ kind: "start", profileIds: ["only"] }, () => { started = true; });
  expect(started).toBe(true);
});

test("queued work is priority ordered and FIFO within each priority", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  const blocker = deferred();
  const order: string[] = [];
  const first = admission.run({ kind: "start", profileIds: ["blocker"] }, () => blocker.promise);
  const jobs = [
    admission.run({ kind: "start", profileIds: ["s1"] }, () => { order.push("s1"); }),
    admission.run({ kind: "stop", profileIds: ["t1"] }, () => { order.push("t1"); }),
    admission.run({ kind: "cleanup", profileIds: ["c1"] }, () => { order.push("c1"); }),
    admission.run({ kind: "stop", profileIds: ["t2"] }, () => { order.push("t2"); }),
    admission.run({ kind: "start", profileIds: ["s2"] }, () => { order.push("s2"); }),
  ];

  blocker.resolve();
  await first;
  await Promise.all(jobs);
  expect(order).toEqual(["t1", "t2", "c1", "s1", "s2"]);
});

test("same-profile FIFO is preserved while unrelated higher-priority work overtakes", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  const blocker = deferred();
  const order: string[] = [];
  const first = admission.run({ kind: "cleanup", profileIds: ["blocker"] }, () => blocker.promise);
  const start = admission.run({ kind: "start", profileIds: ["same"] }, () => { order.push("start-same"); });
  const stopSame = admission.run({ kind: "stop", profileIds: ["same"] }, () => { order.push("stop-same"); });
  const stopOther = admission.run({ kind: "stop", profileIds: ["other"] }, () => { order.push("stop-other"); });

  blocker.resolve();
  await first;
  await Promise.all([start, stopSame, stopOther]);
  expect(order).toEqual(["stop-other", "start-same", "stop-same"]);
});

test("an aborted queued request is removed without invoking its handler", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  const blocker = deferred();
  const first = admission.run({ kind: "start", profileIds: ["running"] }, () => blocker.promise);
  const abort = new AbortController();
  let invoked = false;
  const queued = admission.run({ kind: "start", profileIds: ["queued"], signal: abort.signal }, () => {
    invoked = true;
  });

  expect(admission.lifecycleState("queued")).toBe("starting");
  abort.abort();
  await expect(queued).rejects.toBeInstanceOf(LifecycleAdmissionError);
  expect(invoked).toBe(false);
  expect(admission.lifecycleState("queued")).toBeNull();
  blocker.resolve();
  await first;
  expect(admission.stats().inFlight).toBe(0);
});

test("caller abort after admission does not release the permit early", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  const abort = new AbortController();
  const finish = deferred();
  const admitted = admission.run({ kind: "stop", profileIds: ["one"], signal: abort.signal }, () => finish.promise);
  abort.abort();
  let secondInvoked = false;
  const second = admission.run({ kind: "stop", profileIds: ["two"] }, () => { secondInvoked = true; });

  await tick();
  expect(secondInvoked).toBe(false);
  expect(admission.stats()).toMatchObject({ inFlight: 1, queued: 1 });
  finish.resolve();
  await Promise.all([admitted, second]);
  expect(secondInvoked).toBe(true);
});

test("queue wait is bounded and timed-out work is not dispatched", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1, queueWaitMs: 5 });
  const blocker = deferred();
  const first = admission.run({ kind: "start", profileIds: ["running"] }, () => blocker.promise);
  let invoked = false;
  const queued = admission.run({ kind: "cleanup", profileIds: ["queued"] }, () => { invoked = true; });

  await expect(queued).rejects.toMatchObject({ reason: "timeout" });
  expect(invoked).toBe(false);
  blocker.resolve();
  await first;
});

test("a thrown handler releases its permit without leaks", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1 });
  const failed = admission.run({ kind: "stop", profileIds: ["bad"] }, () => {
    throw new Error("boom");
  });
  let nextRan = false;
  const next = admission.run({ kind: "start", profileIds: ["good"] }, () => { nextRan = true; });

  await expect(failed).rejects.toThrow("boom");
  await next;
  expect(nextRan).toBe(true);
  expect(admission.stats()).toMatchObject({ inFlight: 0, queued: 0 });
});

test("route classification covers AdsPower and dashboard lifecycle paths only", async () => {
  expect(await classifyLifecycleRequest(new Request("http://x/api/v1/browser/start?user_id=p1"))).toMatchObject({ kind: "start", profileIds: ["p1"] });
  expect(await classifyLifecycleRequest(new Request("http://x/api/v1/browser/stop?user_id=p1"))).toMatchObject({ kind: "stop" });
  expect(await classifyLifecycleRequest(new Request("http://x/ui/api/profiles/p1/open", { method: "POST" }))).toMatchObject({ kind: "start" });
  expect(await classifyLifecycleRequest(new Request("http://x/ui/api/profiles/p1/close", { method: "POST" }))).toMatchObject({ kind: "stop" });
  expect(await classifyLifecycleRequest(new Request("http://x/ui/api/profiles/p1/clear-cache", { method: "POST" }))).toMatchObject({ kind: "cleanup" });
  expect(await classifyLifecycleRequest(new Request("http://x/api/v2/browser-profile/delete-cache", {
    method: "POST",
    body: JSON.stringify({ profile_id: ["p1", "p2"] }),
  }))).toMatchObject({ kind: "cleanup", profileIds: ["p1", "p2"] });
  expect(await classifyLifecycleRequest(new Request("http://x/api/v1/browser/active?user_id=p1"))).toBeNull();
  expect(await classifyLifecycleRequest(new Request("http://x/api/v1/status"))).toBeNull();
});

test("admission rejection preserves AdsPower HTTP 200 and dashboard retry envelopes", async () => {
  const admission = new LifecycleAdmissionController({ limit: 1, queueWaitMs: 5 });
  const blocker = deferred();
  const first = admission.run({ kind: "start", profileIds: ["running"] }, () => blocker.promise);
  const dispatch = async () => Response.json({ unexpected: true });

  const ads = await dispatchWithLifecycleAdmission(
    new Request("http://x/api/v1/browser/start?user_id=queued"),
    admission,
    dispatch,
  );
  expect(ads.status).toBe(200);
  expect(await ads.json()).toMatchObject({ code: -1, data: {} });

  const ui = await dispatchWithLifecycleAdmission(
    new Request("http://x/ui/api/profiles/queued/open", { method: "POST" }),
    admission,
    dispatch,
  );
  expect(ui.status).toBe(503);
  expect(await ui.json()).toMatchObject({ ok: false });

  blocker.resolve();
  await first;
});

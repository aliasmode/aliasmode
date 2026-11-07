import { expect, test } from "bun:test";
import type { StoreEvent } from "../contracts/cloud-v1.ts";
import { STORE_EVENTS_BATCH, STORE_EVENTS_FLUSH_MS, StoreEvents, startStoreEvents, storeEvents } from "./store-events.ts";

/** A tracker with a hand-moved clock and timer, and a Cloud that answers `status`. */
function tracker(status = 200) {
  const sent: StoreEvent[][] = [];
  let clock = 1_000_000;
  let timer: { run: () => void; ms: number } | null = null;
  const events = new StoreEvents(
    async (batch) => { sent.push(batch); return status; },
    () => clock,
    (run, ms) => { timer = { run, ms }; return () => { timer = null; }; },
  );
  events.setEnabled(true);
  return {
    events, sent,
    tick: (ms: number) => { clock += ms; },
    timer: () => timer,
    fire: () => { const due = timer; timer = null; due?.run(); },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("store events batch in memory and go out after 30 seconds", async () => {
  const { events, sent, tick, timer, fire } = tracker();
  events.track("entry_click", "sidebar-cart");
  tick(500);
  events.track("store_view", "sidebar-cart");
  expect(sent).toEqual([]);
  expect(timer()?.ms).toBe(STORE_EVENTS_FLUSH_MS);
  fire();
  await settle();
  expect(sent).toEqual([[
    { type: "entry_click", src: "sidebar-cart", at: 1_000_000 },
    { type: "store_view", src: "sidebar-cart", at: 1_000_500 },
  ]]);
  // Each event is only these three fields.
  expect(Object.keys(sent[0]![0]!).sort()).toEqual(["at", "src", "type"]);
  expect(timer()).toBeNull();
});

test("20 queued events go out at once; rapid repeats of one type and src count once", async () => {
  const { events, sent, tick, timer } = tracker();
  events.track("pay_click", "profile-dialog");
  tick(1999);
  events.track("pay_click", "profile-dialog");
  events.track("store_view", "profile-dialog");
  events.track("pay_click", "proxies-tab");
  tick(1);
  events.track("pay_click", "profile-dialog");
  for (let index = 0; index < STORE_EVENTS_BATCH - 5; index++) { tick(2000); events.track("store_view", "direct"); }
  expect(sent).toEqual([]);
  tick(2000);
  events.track("store_view", "direct");
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveLength(STORE_EVENTS_BATCH);
  expect(sent[0]!.slice(0, 4).map(({ type, src }) => `${type}:${src}`))
    .toEqual(["pay_click:profile-dialog", "store_view:profile-dialog", "pay_click:proxies-tab", "pay_click:profile-dialog"]);
  expect(timer()).toBeNull();
});

test("a Cloud without the events route (404) gets one request and no retries", async () => {
  const { events, sent, tick, fire } = tracker(404);
  events.track("entry_click", "sidebar-cart");
  await events.flush();
  tick(5000);
  events.track("entry_click", "sidebar-cart");
  fire();
  await events.flush();
  expect(sent).toHaveLength(1);
});

test("a failed batch is dropped, not resent; later events still go out", async () => {
  for (const status of [503, 0, 500]) {
    const { events, sent, tick } = tracker(status);
    events.track("entry_click", "proxies-tab");
    await events.flush();
    tick(5000);
    events.track("pay_click", "proxies-tab");
    await events.flush();
    expect(sent.map((batch) => batch.map((event) => event.type))).toEqual([["entry_click"], ["pay_click"]]);
  }
  const throwing = new StoreEvents(async () => { throw new Error("offline"); }, () => 1, () => () => {});
  throwing.setEnabled(true);
  throwing.track("entry_click", "proxies-tab");
  await throwing.flush();
});

test("hiding or closing the window sends the queue; stopping sends the rest and turns tracking off", async () => {
  const { events, sent, tick } = tracker();
  const target = new EventTarget();
  let hidden = false;
  const stop = startStoreEvents(events, target, () => hidden);
  events.track("entry_click", "sidebar-cart");
  target.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(sent).toEqual([]);
  hidden = true;
  target.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(sent).toHaveLength(1);
  tick(5000);
  events.track("store_view", "sidebar-cart");
  target.dispatchEvent(new Event("pagehide"));
  await settle();
  expect(sent).toHaveLength(2);
  tick(5000);
  events.track("pay_click", "sidebar-cart");
  stop();
  await settle();
  expect(sent.map((batch) => batch[0]!.type)).toEqual(["entry_click", "store_view", "pay_click"]);
  tick(5000);
  events.track("pay_click", "sidebar-cart");
  target.dispatchEvent(new Event("pagehide"));
  await events.flush();
  expect(sent).toHaveLength(3);
});

test("Local mode sends nothing: the shared tracker stays off until the Cloud store turns it on", async () => {
  const requests: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => { requests.push(args); return new Response("{}"); }) as typeof fetch;
  try {
    storeEvents.track("entry_click", "sidebar-cart");
    await storeEvents.flush();
    const { events, sent } = tracker();
    events.setEnabled(false);
    events.track("entry_click", "sidebar-cart");
    await events.flush();
    expect(sent).toEqual([]);
    expect(requests).toEqual([]);
  } finally { globalThis.fetch = realFetch; }
});

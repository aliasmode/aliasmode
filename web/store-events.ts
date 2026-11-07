import { useEffect } from "react";
import type { StoreEvent, StoreEventType } from "../contracts/cloud-v1.ts";

export const STORE_EVENTS_FLUSH_MS = 30_000;
export const STORE_EVENTS_BATCH = 20;
export const STORE_EVENTS_DEDUPE_MS = 2_000;

/** Sends one batch and gives the HTTP status, or 0 when the request could not be made. */
export type SendStoreEvents = (events: StoreEvent[]) => Promise<number>;
/** Starts a timer and gives a function that stops it. */
export type StartTimer = (run: () => void, ms: number) => () => void;

/** Goes to Cloud through the app's signed-in Cloud route; `keepalive` lets a send outlive a closing window. */
async function sendToCloud(events: StoreEvent[]): Promise<number> {
  try {
    const response = await fetch("/ui/api/cloud-store", {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ action: "store-events", events }),
    });
    return response.status;
  } catch { return 0; }
}

const startTimer: StartTimer = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); };

/**
 * Store placement events (Cloud mode only), batched in memory. A batch goes out
 * after 30 seconds, at 20 events, or when the window hides. Each event is only
 * a type, a placement slug and a time. A failed batch is dropped, never retried.
 */
export class StoreEvents {
  private queue: StoreEvent[] = [];
  private readonly last = new Map<string, number>();
  private stopTimer: (() => void) | null = null;
  private enabled = false;
  /** This Cloud has no events route (404): nothing more is sent until tracking is turned off and on. */
  private missing = false;

  constructor(
    private readonly send: SendStoreEvents = sendToCloud,
    private readonly now: () => number = Date.now,
    private readonly timer: StartTimer = startTimer,
  ) {}

  /** Off drops what is queued; the next session (another workspace or Cloud) starts fresh. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) { this.queue = []; this.last.clear(); this.missing = false; this.clearTimer(); }
  }

  track(type: StoreEventType, src: string): void {
    if (!this.enabled || this.missing) return;
    const at = this.now();
    const key = `${type}|${src}`;
    const previous = this.last.get(key);
    // A double click or a quick re-render counts once.
    if (previous !== undefined && at - previous < STORE_EVENTS_DEDUPE_MS) return;
    this.last.set(key, at);
    this.queue.push({ type, src, at });
    if (this.queue.length >= STORE_EVENTS_BATCH) void this.flush();
    else this.stopTimer ??= this.timer(() => void this.flush(), STORE_EVENTS_FLUSH_MS);
  }

  /** Sends what is queued. Never throws and never blocks the page. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (!this.queue.length || this.missing) return;
    const events = this.queue;
    this.queue = [];
    const status = await this.send(events).catch(() => 0);
    if (status === 404) this.missing = true;
  }

  private clearTimer(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }
}

export const storeEvents = new StoreEvents();

export function trackStoreEvent(type: StoreEventType, src: string): void {
  storeEvents.track(type, src);
}

/**
 * Turns tracking on and sends the queue when the window is hidden or closed.
 * `visibilitychange` reaches the window from the document. The returned stop sends what is left.
 */
export function startStoreEvents(events: StoreEvents, target: EventTarget, isHidden: () => boolean): () => void {
  events.setEnabled(true);
  const flush = () => void events.flush();
  const hidden = () => { if (isHidden()) flush(); };
  target.addEventListener("pagehide", flush);
  target.addEventListener("visibilitychange", hidden);
  return () => {
    target.removeEventListener("pagehide", flush);
    target.removeEventListener("visibilitychange", hidden);
    flush();
    events.setEnabled(false);
  };
}

/** Tracks only while `enabled` (the Cloud store is available). */
export function useStoreEvents(enabled: boolean): void {
  useEffect(() => enabled ? startStoreEvents(storeEvents, window, () => document.visibilityState === "hidden") : undefined, [enabled]);
}

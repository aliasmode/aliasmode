/**
 * Keeps each Chromium 155 window no larger than the screen its profile claims.
 *
 * A page reads screen.* from the profile, but outerWidth, innerHeight and
 * screenX from the real window. A window maximized on a display bigger than
 * that screen is bigger than the screen the page sees, and a page finds that in
 * one comparison (innerHeight > screen.height). This reads each window's bounds
 * over the browser's CDP socket. A maximized window stays maximized when the
 * display's available area, which it covers, fits the profile's available
 * screen. On a larger display, a maximize gives the window the profile's
 * available screen at the display's corner, as a maximize on that smaller
 * screen would, and maximizing it again brings back the window from before.
 * A normal window dragged larger is shrunk to fit. The position is the user's:
 * windows can still sit anywhere, on any monitor. Fullscreen and minimized
 * windows are left alone. It never attaches to a page.
 */

import type { FingerprintSample } from "./diagnose.ts";
import type { Profile } from "./types.ts";

export interface ScreenArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowBounds extends Partial<ScreenArea> {
  windowState?: string;
}

/**
 * The profile's available screen as its pages read it. Without a capture from this launch, the
 * last stored capture still names the area above the taskbar; the whole screen is the last resort.
 */
export function claimedScreenArea(profile: Profile, sample: FingerprintSample | null): ScreenArea {
  const screen = sample?.screen;
  if (screen?.availWidth && screen.availHeight) {
    return { left: screen.availLeft ?? 0, top: screen.availTop ?? 0, width: screen.availWidth, height: screen.availHeight };
  }
  const [width, height] = (profile.fpObserved?.availableScreen ?? "").split("*").map(Number);
  if (width && height && width <= profile.screenWidth && height <= profile.screenHeight) {
    return { left: 0, top: 0, width, height };
  }
  return { left: 0, top: 0, width: profile.screenWidth, height: profile.screenHeight };
}

/**
 * On Windows, CDP reports a maximized window with its hidden resize border, which hangs
 * off the monitor: (-8,-8,1936,1048) for a page that reads (0,0,1920,1032). The border is
 * the same on every side and at most 16 px at 150%. Other systems have none.
 */
function maximizedBorder({ left = 0, top = 0 }: WindowBounds): number {
  const insets = [-left, -top].filter((inset) => inset > 0 && inset <= 16);
  return insets.length ? Math.min(...insets) : 0;
}

/**
 * The largest window size Chromium draws at `scale` that a page reads as no more than `size`.
 * It rounds a window out to whole device pixels and back: 566 at 125% is 708 px, read as 567.
 */
function sizeAtScale(size: number, scale: number): number {
  let fitted = size;
  while (fitted > 1 && Math.ceil(Math.ceil(fitted * scale - 1e-6) / scale - 1e-6) > size) fitted--;
  return fitted;
}

/**
 * The bounds that make a window fit `area`'s size, or null when it already does or must be left
 * alone. At a fractional scale CDP rounds a maximized window's bounds outward: one that a page
 * reads as 1536x826 at 125% comes back as (-6,-6,1550,839), 2 px too large.
 */
export function fitWindow(bounds: WindowBounds, area: ScreenArea, scale = 1): ScreenArea | null {
  const { windowState } = bounds;
  if (windowState === "minimized" || windowState === "fullscreen") return null;
  if (bounds.left === undefined || bounds.top === undefined || bounds.width === undefined || bounds.height === undefined) return null;
  const maximized = windowState === "maximized";
  const border = maximized ? maximizedBorder(bounds) : 0;
  const left = bounds.left + border;
  const top = bounds.top + border;
  const width = bounds.width - 2 * border;
  const height = bounds.height - 2 * border;
  const slack = maximized && !Number.isInteger(scale) ? 2 : 0;
  if (width <= area.width + slack && height <= area.height + slack) return null;
  return { left, top, width: Math.min(width, sizeAtScale(area.width, scale)), height: Math.min(height, sizeAtScale(area.height, scale)) };
}

export interface WindowFitOptions {
  intervalMs?: number;
  /** The scale the browser draws at (--force-device-scale-factor). */
  scale?: number;
  log?: (msg: string) => void;
  onClose?: () => void;
  WebSocket?: typeof WebSocket;
}

/** Reads a dragged window's bounds must hold still before it is fixed: a second at the default interval. */
const SETTLE_READS = 4;

interface WindowTrack {
  seen: string;
  /** Reads since the bounds last changed. */
  stable: number;
  /** The last read was answered with a fix; a window still too large after it is left for the user. */
  fixed: boolean;
  giveUp?: string;
  /** The window a maximize gave on a larger display, and the window before that maximize. */
  maximized?: { window: ScreenArea; before: ScreenArea };
}

function near(a: WindowBounds, b: ScreenArea): boolean {
  return (["left", "top", "width", "height"] as const).every((key) => Math.abs((a[key] ?? NaN) - b[key]) <= 2);
}

/**
 * Watch every window of the browser at `ws` until its socket closes or stop() is called.
 * New windows are found within five reads. A maximize is answered on the read that finds
 * it. A window being dragged larger is fixed once its bounds stop changing, so the fix never
 * fights the mouse. A fix the window manager refuses is not repeated until the window changes
 * again, so there is no resize loop.
 */
export function watchWindowFit(ws: string, area: ScreenArea, opts: WindowFitOptions = {}): { stop(): void } {
  // Each tick is a CDP round trip on AliasMode's main thread, once per browser.
  const intervalMs = opts.intervalMs ?? 2_000;
  const Socket = opts.WebSocket ?? WebSocket;
  const socket = new Socket(ws);
  const pending = new Map<number, (result: any) => void>();
  const windows = new Map<number, WindowTrack>();
  let nextId = 1;
  let reads = 0;
  let windowIds: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    try { socket.close(); } catch {}
    opts.onClose?.();
  };

  /**
   * A maximized window larger than the profile's screen: restore it, then give it the profile's
   * available screen. When it was restored to the window an earlier maximize gave, this maximize
   * asks for the window from before that one instead, as restoring a maximized window would.
   */
  const fitMaximized = async (windowId: number, track: WindowTrack, fit: ScreenArea) => {
    // Chromium ignores bounds sent with the restore of a maximized window, so restore first.
    await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    const restored: WindowBounds | undefined = (await send("Browser.getWindowBounds", { windowId }))?.bounds;
    const back = track.maximized && restored && near(restored, track.maximized.window) ? track.maximized.before : undefined;
    const { left, top, width, height } = restored ?? {};
    const before = left === undefined || top === undefined || width === undefined || height === undefined ? undefined : { left, top, width, height };
    track.maximized = back || !before ? undefined : { window: fit, before };
    return await send("Browser.setWindowBounds", { windowId, bounds: back ?? fit });
  };

  const tick = async () => {
    // Look for new windows on every fifth read; in between, read only the windows already known.
    if (reads++ % 5 === 0) {
      const pages = ((await send("Target.getTargets"))?.targetInfos ?? []).filter((target: any) => target.type === "page");
      const ids = new Set<number>();
      for (const page of pages) {
        const found = await send("Browser.getWindowForTarget", { targetId: page.targetId });
        if (typeof found?.windowId === "number") ids.add(found.windowId);
      }
      windowIds = [...ids];
      for (const id of windows.keys()) if (!ids.has(id)) windows.delete(id);
    }
    for (const windowId of windowIds) {
      const bounds: WindowBounds | undefined = (await send("Browser.getWindowBounds", { windowId }))?.bounds;
      if (closed) return;
      if (!bounds) continue;
      const seen = JSON.stringify(bounds);
      const track = windows.get(windowId) ?? { seen: "", stable: 0, fixed: false };
      windows.set(windowId, track);
      const fit = fitWindow(bounds, area, opts.scale);
      track.stable = seen === track.seen ? track.stable + 1 : 0;
      track.seen = seen;
      if (!fit) { track.fixed = false; continue; }
      if (track.fixed) { track.fixed = false; track.giveUp = seen; continue; }
      if (seen === track.giveUp) continue;
      if (bounds.windowState === "normal" && track.stable < SETTLE_READS) continue;
      track.fixed = true;
      const done = bounds.windowState === "maximized"
        ? await fitMaximized(windowId, track, fit)
        : await send("Browser.setWindowBounds", { windowId, bounds: fit });
      // Check the fix at once: by the next read the user may already have maximized again, and
      // that maximize must not look like a fix the window manager refused.
      const after: WindowBounds | undefined = (await send("Browser.getWindowBounds", { windowId }))?.bounds;
      if (after && !fitWindow(after, area, opts.scale)) {
        track.fixed = false;
        track.seen = JSON.stringify(after);
        track.stable = 0;
      }
      if (done) opts.log?.(`window ${seen} resized to fit the profile's ${area.width}x${area.height} available screen`);
    }
  };
  const loop = () => {
    if (closed) return;
    tick().catch(() => {}).finally(() => {
      if (!closed) timer = setTimeout(loop, intervalMs);
    });
  };

  socket.onopen = loop;
  socket.onmessage = (event) => {
    let msg: any;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    const resolve = msg?.id === undefined ? undefined : pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg.error ? undefined : msg.result);
  };
  socket.onclose = stop;
  socket.onerror = stop;
  return { stop };
}

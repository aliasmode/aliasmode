/**
 * Minimal CDP probe used by the spike: connect over CDP, read back the live
 * navigator.userAgent, and disconnect. Kept separate so the spike's flow is
 * testable without pulling Playwright into unit tests.
 */

import { runPlaywrightWorker } from "./playwright-runtime.ts";

export interface CdpPageOptions {
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Create and later close an isolated temporary page instead of reusing tab 0. */
  temporaryPage?: boolean;
  /** Fail a successful probe unless temporary-page cleanup and CDP detach both finish. */
  requireConfirmedCleanup?: boolean;
  /** Injectable connector for deterministic cleanup tests. */
  connect?: (ws: string, options: { timeout: number }) => Promise<any>;
}

export interface CdpPageLease {
  /** Close and confirm the exact temporary target before other CDP work continues. */
  closeTemporaryPage(): Promise<void>;
}

/**
 * Shared connect/context/page/detach shell for small CDP probes. A temporary
 * page is useful for checks that must not navigate an operator's existing tab.
 */
export async function withCdpPage<T>(
  ws: string,
  run: (page: any, browser: any, lease: CdpPageLease) => Promise<T>,
  opts: CdpPageOptions = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000;
  let browser: any;
  if (!opts.connect) throw new Error("withCdpPage requires an injected connector");
  browser = await opts.connect(ws, { timeout });
  let temporaryPage: any | undefined;
  let temporaryTargetId: string | undefined;
  let temporaryPageClosed = false;
  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("persistent CDP context unavailable");
    const page = opts.temporaryPage
      ? (temporaryPage = await context.newPage())
      : context.pages()[0] ?? (temporaryPage = await context.newPage());
    if (opts.temporaryPage && opts.requireConfirmedCleanup) {
      temporaryTargetId = await identifyPageTarget(context, page, opts.cleanupTimeoutMs ?? 5_000);
    }
    const closeTemporaryPage = async () => {
      if (!temporaryPage || temporaryPageClosed) return;
      const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 5_000;
      const closed = temporaryTargetId
        ? await closeTargetWithin(browser, temporaryTargetId, cleanupTimeoutMs)
        : await closeWithin(() => temporaryPage.close(), cleanupTimeoutMs);
      if (!closed) throw new Error("temporary CDP target cleanup was not confirmed");
      temporaryPageClosed = true;
    };
    result = await run(page, browser, { closeTemporaryPage });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 5_000;
  const pageClosed = temporaryPageClosed || !temporaryPage
    ? true
    : temporaryTargetId
      ? await closeTargetWithin(browser, temporaryTargetId, cleanupTimeoutMs)
      : await closeWithin(() => temporaryPage.close(), cleanupTimeoutMs);
  // connectOverCDP clients detach here; the managed browser remains alive.
  const browserClosed = await closeWithin(() => browser.close(), cleanupTimeoutMs);

  if (operationFailed) throw operationError;
  if (opts.requireConfirmedCleanup && (!pageClosed || !browserClosed)) {
    throw new Error("CDP probe cleanup was not confirmed");
  }
  return result;
}

async function identifyPageTarget(context: any, page: any, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const session: any = await withinDeadline(
    () => context.newCDPSession(page),
    remaining(deadline),
  );
  let targetId: string | undefined;
  let operationError: unknown;
  try {
    const response: any = await withinDeadline(
      () => session.send("Target.getTargetInfo"),
      remaining(deadline),
    );
    if (typeof response?.targetInfo?.targetId !== "string") {
      throw new Error("temporary CDP target identity was unavailable");
    }
    targetId = response.targetInfo.targetId;
  } catch (error) {
    operationError = error;
  }
  const detached = await closeWithin(() => session.detach(), remaining(deadline));
  if (operationError) throw operationError;
  if (!detached) throw new Error("temporary CDP target session did not detach");
  return targetId!;
}

async function closeTargetWithin(browser: any, targetId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let session: any;
  let destroyedListener: ((event: { targetId?: string }) => void) | undefined;
  let targetClosed = false;
  let destroyed = false;
  try {
    session = await withinDeadline(
      () => browser.newBrowserCDPSession(),
      remaining(deadline),
    );
    let markDestroyed!: () => void;
    const targetDestroyed = new Promise<void>((resolve) => { markDestroyed = resolve; });
    destroyedListener = (event) => {
      if (event?.targetId === targetId) {
        destroyed = true;
        markDestroyed();
      }
    };
    session.on("Target.targetDestroyed", destroyedListener);
    await withinDeadline(
      () => session.send("Target.setDiscoverTargets", { discover: true }),
      remaining(deadline),
    );
    if (!await targetExists(session, targetId, deadline)) {
      targetClosed = true;
    } else {
      await withinDeadline(
        () => session.send("Target.closeTarget", { targetId }),
        remaining(deadline),
      );
      if (!destroyed && await targetExists(session, targetId, deadline)) {
        await withinDeadline(() => targetDestroyed, remaining(deadline));
      }
      targetClosed = !await targetExists(session, targetId, deadline);
    }
  } catch {
    targetClosed = destroyed;
  }
  if (session && destroyedListener) {
    session.off("Target.targetDestroyed", destroyedListener);
  }
  const detached = !session
    || await closeWithin(() => session.detach(), remaining(deadline));
  return targetClosed && detached;
}

async function targetExists(session: any, targetId: string, deadline: number): Promise<boolean> {
  const response: any = await withinDeadline(
    () => session.send("Target.getTargets"),
    remaining(deadline),
  );
  return Array.isArray(response?.targetInfos)
    && response.targetInfos.some((target: { targetId?: string }) => target.targetId === targetId);
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function withinDeadline<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("CDP cleanup timed out")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeWithin(close: (() => unknown) | undefined, timeoutMs: number): Promise<boolean> {
  if (!close) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(close).then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Connect through the isolated Node worker and return the page's navigator.userAgent. */
export async function connectOverCDP(ws: string): Promise<string> {
  return runPlaywrightWorker<string>("page", {
    endpoint: ws,
    kind: "user-agent",
    connectTimeoutMs: 30_000,
  });
}

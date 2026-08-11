/**
 * Minimal CDP probe used by the spike: connect over CDP, read back the live
 * navigator.userAgent, and disconnect. Kept separate so the spike's flow is
 * testable without pulling Playwright into unit tests.
 */

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

/**
 * Shared connect/context/page/detach shell for small CDP probes. A temporary
 * page is useful for checks that must not navigate an operator's existing tab.
 */
export async function withCdpPage<T>(
  ws: string,
  run: (page: any) => Promise<T>,
  opts: CdpPageOptions = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000;
  let browser: any;
  if (opts.connect) {
    browser = await opts.connect(ws, { timeout });
  } else {
    const { chromium } = await import("playwright-core");
    browser = await chromium.connectOverCDP(ws, { timeout });
  }
  let temporaryPage: any | undefined;
  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = opts.temporaryPage
      ? (temporaryPage = await context.newPage())
      : context.pages()[0] ?? (temporaryPage = await context.newPage());
    result = await run(page);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 5_000;
  const pageClosed = await closeWithin(temporaryPage ? () => temporaryPage.close() : undefined, cleanupTimeoutMs);
  // connectOverCDP clients detach here; the managed browser remains alive.
  const browserClosed = await closeWithin(() => browser.close(), cleanupTimeoutMs);

  if (operationFailed) throw operationError;
  if (opts.requireConfirmedCleanup && (!pageClosed || !browserClosed)) {
    throw new Error("CDP probe cleanup was not confirmed");
  }
  return result;
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

/** Connect over CDP and return the page's navigator.userAgent. */
export async function connectOverCDP(ws: string): Promise<string> {
  return withCdpPage(ws, (page) => page.evaluate(() => navigator.userAgent));
}

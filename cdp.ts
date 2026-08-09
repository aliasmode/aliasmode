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
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = opts.temporaryPage
      ? (temporaryPage = await context.newPage())
      : context.pages()[0] ?? (temporaryPage = await context.newPage());
    return await run(page);
  } finally {
    const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 5_000;
    await closeWithin(temporaryPage ? () => temporaryPage.close() : undefined, cleanupTimeoutMs);
    // connectOverCDP clients detach here; the managed browser remains alive.
    await closeWithin(() => browser.close(), cleanupTimeoutMs);
  }
}

async function closeWithin(close: (() => unknown) | undefined, timeoutMs: number): Promise<void> {
  if (!close) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs));
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

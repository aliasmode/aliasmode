/**
 * Minimal CDP probe used by the spike: connect over CDP, read back the live
 * navigator.userAgent, and disconnect. Kept separate so the spike's flow is
 * testable without pulling Playwright into unit tests.
 */

import { runPlaywrightWorker } from "./playwright-runtime.ts";
import { canonicalUserPageUrl } from "./session.ts";

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

interface CdpConnection {
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  on(method: string, sessionId: string | undefined, listener: (params: any) => void): () => void;
  once(method: string, sessionId: string | undefined): Promise<any>;
  close(): void;
}

/** A raw CDP connection from this process: no Node worker, and it attaches to no tab by itself. */
async function openCdp(endpoint: string, timeout: number): Promise<CdpConnection> {
  const url = /^https?:/.test(endpoint)
    ? (await (await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(timeout) })).json() as any).webSocketDebuggerUrl
    : endpoint;
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timed out")), timeout);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("CDP connection failed")); };
  });
  let lastId = 0;
  const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: any) => void>();
  socket.onmessage = ({ data }) => {
    let message: any;
    try { message = JSON.parse(String(data)); } catch { return; }
    const call = calls.get(message.id);
    if (!call) return void listeners.forEach((listener) => listener(message));
    calls.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message || "CDP call failed"));
    else call.resolve(message.result ?? {});
  };
  socket.onclose = () => { for (const call of calls.values()) call.reject(new Error("CDP connection closed")); calls.clear(); };
  const within = <T>(promise: Promise<T>, what: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), timeout); })])
      .finally(() => clearTimeout(timer));
  };
  const connection: CdpConnection = {
    send(method, params = {}, sessionId) {
      const id = ++lastId;
      const reply = new Promise<any>((resolve, reject) => calls.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return within(reply, method);
    },
    on(method, sessionId, listener) {
      const filtered = (message: any) => { if (message.method === method && message.sessionId === sessionId) listener(message.params); };
      listeners.add(filtered);
      return () => listeners.delete(filtered);
    },
    once(method, sessionId) {
      let off: (() => void) | undefined;
      return within(new Promise((resolve) => { off = connection.on(method, sessionId, resolve); }), method).finally(() => off?.());
    },
    close() { socket.close(); },
  };
  return connection;
}

const FINGERPRINT_URL = "https://fingerprint.aliasmode.invalid/?__aliasmode_fingerprint__=1";

/**
 * The launch-time fingerprint capture of a Chromium browser, in its own background tab. Playwright's
 * connectOverCDP would attach to every tab (Runtime.enable, Page.enable), and a tab that loads
 * meanwhile, such as one the browser restores at startup, then plays unmuted media and runs audio
 * without a click, as under automation. This connection attaches to the capture tab only.
 */
export async function chromiumFingerprint<T>(endpoint: string, script: string, timeout: number): Promise<T> {
  const cdp = await openCdp(endpoint, timeout);
  let targetId: string | undefined;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true }));
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method: string, params?: object) => cdp.send(method, params, sessionId);
    let intercepted = false;
    cdp.on("Fetch.requestPaused", sessionId, ({ requestId, request }) => {
      if (request.url !== FINGERPRINT_URL) return void page("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
      intercepted = true;
      const body = Buffer.from("<!doctype html><title>Fingerprint</title>").toString("base64");
      void page("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body }).catch(() => {});
    });
    await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await page("Page.enable");
    const loaded = cdp.once("Page.domContentEventFired", sessionId);
    loaded.catch(() => {});
    if ((await page("Page.navigate", { url: FINGERPRINT_URL })).errorText) throw new Error("fingerprint navigation failed");
    await loaded;
    if (!intercepted) throw new Error("fingerprint document was not fulfilled locally");
    const { result, exceptionDetails } = await page("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error("fingerprint probe failed");
    return result?.value;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}

const UNGOOGLED_FIRST_RUN_URL = "chrome://ungoogled-first-run/";
const INTERNAL_NEW_TAB_URLS = new Set(["chrome://newtab/", "chrome://new-tab-page/", "chrome://new-tab-page-third-party/"]);

/**
 * Open user pages in a Chromium browser over raw CDP, without a Playwright worker: the same rules
 * as the worker's navigate without replacePages. The first page loads in the empty tab (or the
 * first-run tab) when the browser shows no user page yet; others open in new tabs. All load at
 * once, and each waits for DOMContentLoaded. Only the tabs it loads are attached.
 */
export async function openChromiumPages(endpoint: string, urls: string[], timeout = 30_000): Promise<void> {
  const targets = urls.map(canonicalUserPageUrl).filter((url): url is string => !!url);
  const cdp = await openCdp(endpoint, timeout);
  try {
    const { browserContextIds = [] } = await cdp.send("Target.getBrowserContexts");
    const isolated = new Set<string>(browserContextIds);
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const pages = (targetInfos as Array<{ targetId: string; type: string; url: string; browserContextId?: string }>)
      .filter((target) => target.type === "page" && !isolated.has(target.browserContextId ?? ""));
    const existingUserPage = pages.some((page) => canonicalUserPageUrl(page.url) !== null);
    const blank = existingUserPage ? undefined
      : pages.find((page) => page.url === "about:blank")
        ?? pages.find((page) => INTERNAL_NEW_TAB_URLS.has(page.url))
        ?? pages.find((page) => page.url === UNGOOGLED_FIRST_RUN_URL);
    let firstError: unknown;

    const load = async (targetId: string, url: string, waitMs: number) => {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = (method: string, params?: object) => cdp.send(method, params, sessionId);
      const loaded = new Set<string>();
      let markLoaded: (() => void) | undefined;
      let loaderId: string | undefined;
      const off = cdp.on("Page.lifecycleEvent", sessionId, (event) => {
        if (event?.name !== "DOMContentLoaded") return;
        loaded.add(event.loaderId);
        if (event.loaderId === loaderId) markLoaded?.();
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await page("Page.enable");
        await page("Page.setLifecycleEventsEnabled", { enabled: true });
        const navigation = await page("Page.navigate", { url });
        if (navigation.errorText) throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
        loaderId = navigation.loaderId;
        if (!loaderId || loaded.has(loaderId)) return;
        await new Promise<void>((resolve, reject) => {
          markLoaded = resolve;
          timer = setTimeout(() => reject(new Error(`navigation to ${url} timed out`)), waitMs);
        });
      } finally {
        clearTimeout(timer);
        off();
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    };

    for (const page of pages) {
      if (page.url !== UNGOOGLED_FIRST_RUN_URL) continue;
      if (page === blank) {
        if (targets.length > 0) continue;
        try { await load(page.targetId, "about:blank", 5_000); } catch (error) { firstError ??= error; }
        continue;
      }
      try { await cdp.send("Target.closeTarget", { targetId: page.targetId }); } catch (error) { firstError ??= error; }
    }

    const tabs: Array<string | undefined> = [];
    for (let index = 0; index < targets.length; index++) {
      try {
        tabs[index] = index === 0 && blank ? blank.targetId : (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
      } catch (error) {
        firstError ??= error;
      }
    }
    // The tabs exist in their order; they load at the same time, so an open waits for its slowest
    // page through the proxy, not for the sum of all pages.
    const errors = await Promise.all(tabs.map((targetId, index) => targetId
      ? load(targetId, targets[index]!, timeout).then(() => undefined, (error) => error)
      : undefined));
    for (const error of errors) if (error) firstError ??= error;
    if (firstError) throw firstError;
  } finally {
    cdp.close();
  }
}

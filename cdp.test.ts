import { expect, test } from "bun:test";
import { openChromiumPages, withCdpPage } from "./cdp.ts";

function stalledBrowser() {
  const never = new Promise<void>(() => {});
  let pageCloseCalls = 0;
  let browserCloseCalls = 0;
  const page = {
    close() {
      pageCloseCalls++;
      return never;
    },
  };
  const targetSession = {
    async send(method: string) {
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "temporary-target" } };
      }
      throw new Error("unexpected target command");
    },
    async detach() {},
  };
  const browserSession = {
    on() {},
    off() {},
    async send(method: string) {
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "temporary-target" }] };
      }
      if (method === "Target.closeTarget") return never;
      throw new Error("unexpected browser command");
    },
    async detach() {},
  };
  const context = {
    pages: () => [],
    newPage: async () => page,
    newCDPSession: async () => targetSession,
  };
  const browser = {
    contexts() {
      return [context];
    },
    newBrowserCDPSession: async () => browserSession,
    close() {
      browserCloseCalls++;
      return never;
    },
  };
  return {
    browser,
    closeCalls: () => ({ page: pageCloseCalls, browser: browserCloseCalls }),
  };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("CDP probe remained stuck")), 250)),
  ]);
}

test("mandatory CDP probe closes the exact temporary target without page.close", async () => {
  const events: string[] = [];
  const page = { close() { events.push("page-close"); } };
  const targetSession = {
    async send() { return { targetInfo: { targetId: "temporary-target" } }; },
    async detach() { events.push("target-session-detach"); },
  };
  let targetPresent = true;
  const browserSession = {
    on() {},
    off() {},
    async send(method: string) {
      events.push(method);
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.getTargets") {
        return { targetInfos: targetPresent ? [{ targetId: "temporary-target" }] : [] };
      }
      if (method === "Target.closeTarget") {
        targetPresent = false;
        return { success: true };
      }
      throw new Error("unexpected command");
    },
    async detach() { events.push("browser-session-detach"); },
  };
  const browser = {
    contexts: () => [{
      pages: () => [],
      newPage: async () => page,
      newCDPSession: async () => targetSession,
    }],
    newBrowserCDPSession: async () => browserSession,
    async close() { events.push("browser-close"); },
  };

  const result = await withCdpPage(
    "ws://test",
    async (_page, _browser, lease) => {
      events.push("run");
      await lease.closeTemporaryPage();
      events.push("after-close");
      return "verified";
    },
    {
      temporaryPage: true,
      cleanupTimeoutMs: 25,
      requireConfirmedCleanup: true,
      connect: async () => browser,
    },
  );

  expect(result).toBe("verified");
  expect(events).toEqual([
    "target-session-detach",
    "run",
    "Target.setDiscoverTargets",
    "Target.getTargets",
    "Target.closeTarget",
    "Target.getTargets",
    "Target.getTargets",
    "browser-session-detach",
    "after-close",
    "browser-close",
  ]);
});

test("matching target destruction wins over a failing confirmation query", async () => {
  const events: string[] = [];
  let destroyedListener: ((event: { targetId: string }) => void) | undefined;
  let targetQueries = 0;
  const page = { async close() { events.push("page-close"); } };
  const targetSession = {
    async send() { return { targetInfo: { targetId: "temporary-target" } }; },
    async detach() {},
  };
  const browserSession = {
    on(_event: string, listener: (event: { targetId: string }) => void) {
      destroyedListener = listener;
    },
    off() {},
    async send(method: string) {
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.getTargets") {
        targetQueries++;
        if (targetQueries === 1) {
          return { targetInfos: [{ targetId: "temporary-target" }] };
        }
        destroyedListener?.({ targetId: "temporary-target" });
        throw new Error("query connection closed");
      }
      if (method === "Target.closeTarget") return { success: true };
      throw new Error("unexpected command");
    },
    async detach() { events.push("raw-detach"); },
  };
  const browser = {
    contexts: () => [{
      pages: () => [],
      newPage: async () => page,
      newCDPSession: async () => targetSession,
    }],
    newBrowserCDPSession: async () => browserSession,
    async close() { events.push("browser-close"); },
  };

  const result = await withCdpPage(
    "ws://test",
    async (_page, _browser, lease) => {
      await lease.closeTemporaryPage();
      events.push("handoff");
      return "verified";
    },
    {
      temporaryPage: true,
      cleanupTimeoutMs: 25,
      requireConfirmedCleanup: true,
      connect: async () => browser,
    },
  );

  expect(result).toBe("verified");
  expect(events).toEqual(["raw-detach", "handoff", "browser-close"]);
  expect(events).not.toContain("page-close");
});

test("mandatory CDP probe blocks handoff when exact target cleanup is unconfirmed", async () => {
  const events: string[] = [];
  const page = { async close() { events.push("page-close"); } };
  const targetSession = {
    async send() { return { targetInfo: { targetId: "temporary-target" } }; },
    async detach() {},
  };
  const browserSession = {
    on() {},
    off() {},
    async send(method: string) {
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "temporary-target" }] };
      }
      if (method === "Target.closeTarget") return { success: true };
      throw new Error("unexpected command");
    },
    async detach() { events.push("raw-detach"); },
  };
  const browser = {
    contexts: () => [{
      pages: () => [],
      newPage: async () => page,
      newCDPSession: async () => targetSession,
    }],
    newBrowserCDPSession: async () => browserSession,
    async close() { events.push("browser-close"); },
  };

  await expect(withCdpPage(
    "ws://test",
    async (_page, _browser, lease) => {
      events.push("run");
      await lease.closeTemporaryPage();
      events.push("handoff");
    },
    {
      temporaryPage: true,
      cleanupTimeoutMs: 5,
      requireConfirmedCleanup: true,
      connect: async () => browser,
    },
  )).rejects.toThrow("temporary CDP target cleanup was not confirmed");

  expect(events).not.toContain("handoff");
  expect(events).not.toContain("page-close");
  expect(events).toContain("raw-detach");
  expect(events).toContain("browser-close");
});

test("CDP probe returns when temporary page and browser detach stall", async () => {
  const fake = stalledBrowser();
  const result = await within(withCdpPage(
    "ws://test",
    async () => "verified",
    {
      temporaryPage: true,
      cleanupTimeoutMs: 5,
      connect: async () => fake.browser,
    },
  ));

  expect(result).toBe("verified");
  expect(fake.closeCalls()).toEqual({ page: 1, browser: 1 });
});

test("CDP probe preserves its original error when detach stalls", async () => {
  const fake = stalledBrowser();
  const original = new Error("proxy verification failed");
  const probe = withCdpPage(
    "ws://test",
    async () => { throw original; },
    {
      temporaryPage: true,
      cleanupTimeoutMs: 5,
      connect: async () => fake.browser,
    },
  );

  await expect(within(probe)).rejects.toBe(original);
  expect(fake.closeCalls()).toEqual({ page: 1, browser: 1 });
});

test("mandatory CDP probe rejects an unconfirmed detach", async () => {
  const fake = stalledBrowser();
  const probe = withCdpPage(
    "ws://test",
    async () => "verified",
    {
      temporaryPage: true,
      cleanupTimeoutMs: 5,
      requireConfirmedCleanup: true,
      connect: async () => fake.browser,
    },
  );

  await expect(within(probe)).rejects.toThrow("CDP probe cleanup was not confirmed");
  expect(fake.closeCalls()).toEqual({ page: 0, browser: 1 });
});

test("mandatory CDP probe preserves its operation error over cleanup failure", async () => {
  const fake = stalledBrowser();
  const original = new Error("proxy verification failed");
  const probe = withCdpPage(
    "ws://test",
    async () => { throw original; },
    {
      temporaryPage: true,
      cleanupTimeoutMs: 5,
      requireConfirmedCleanup: true,
      connect: async () => fake.browser,
    },
  );

  await expect(within(probe)).rejects.toBe(original);
  expect(fake.closeCalls()).toEqual({ page: 0, browser: 1 });
});

/** A browser over plain CDP with the given page targets; it records every command. */
function fakeChromium(pages: Array<{ targetId: string; url: string; browserContextId?: string }>, failUrl?: string) {
  const calls: string[] = [];
  let created = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("", { status: 400 }),
    websocket: {
      message(ws, raw) {
        const { id, method, params, sessionId } = JSON.parse(String(raw));
        const reply = (result: object = {}) => void ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
        calls.push(`${method}${params?.targetId ? ` ${params.targetId}` : ""}${params?.url ? ` ${params.url}` : ""}`);
        if (method === "Target.getBrowserContexts") return reply({ browserContextIds: ["isolated"] });
        if (method === "Target.getTargets") return reply({ targetInfos: [...pages.map((page) => ({ type: "page", ...page })), { targetId: "sw", type: "service_worker", url: "https://a.example/sw.js" }] });
        if (method === "Target.createTarget") return reply({ targetId: `new${++created}` });
        if (method === "Target.attachToTarget") return reply({ sessionId: `s-${params.targetId}` });
        if (method === "Page.navigate") {
          if (params.url === failUrl) return reply({ frameId: "f", errorText: "net::ERR_PROXY_CONNECTION_FAILED" });
          const loaderId = `l-${params.url}`;
          // DOMContentLoaded of the old document first, then of the new one after the reply.
          ws.send(JSON.stringify({ method: "Page.lifecycleEvent", params: { name: "DOMContentLoaded", loaderId: "old", frameId: "f" }, sessionId }));
          reply({ frameId: "f", loaderId });
          return void setTimeout(() => ws.send(JSON.stringify({ method: "Page.lifecycleEvent", params: { name: "DOMContentLoaded", loaderId, frameId: "f" }, sessionId })), 20);
        }
        return reply();
      },
    },
  });
  return { calls, endpoint: `ws://127.0.0.1:${server.port}/devtools/browser/x`, stop: () => server.stop(true) };
}

test("raw CDP opens the first page in the empty tab and the others in new tabs", async () => {
  const browser = fakeChromium([
    { targetId: "ext", url: "chrome-extension://abc/options.html" },
    { targetId: "blank", url: "about:blank" },
    { targetId: "other-context", url: "about:blank", browserContextId: "isolated" },
  ]);
  try {
    await openChromiumPages(browser.endpoint, ["https://a.example/", "chrome://settings/", "https://b.example/"]);
    const navigated = browser.calls.filter((call) => call.startsWith("Page.navigate") || call.startsWith("Target.attachToTarget") || call.startsWith("Target.createTarget"));
    expect(navigated.sort()).toEqual([
      "Page.navigate https://a.example/",
      "Page.navigate https://b.example/",
      "Target.attachToTarget blank",
      "Target.attachToTarget new1",
      "Target.createTarget about:blank",
    ]);
  } finally {
    browser.stop();
  }
});

test("raw CDP keeps open user pages and closes a stray first-run tab", async () => {
  const browser = fakeChromium([
    { targetId: "user", url: "https://x.com/home" },
    { targetId: "blank", url: "about:blank" },
    { targetId: "first-run", url: "chrome://ungoogled-first-run/" },
  ]);
  try {
    await openChromiumPages(browser.endpoint, ["https://a.example/"]);
    expect(browser.calls).toContain("Target.closeTarget first-run");
    expect(browser.calls).toContain("Target.attachToTarget new1");
    expect(browser.calls.some((call) => call.endsWith(" blank") || call.includes(" user"))).toBe(false);
  } finally {
    browser.stop();
  }
});

test("raw CDP loads every page and then reports the first failed one", async () => {
  const browser = fakeChromium([{ targetId: "blank", url: "chrome://newtab/" }], "https://a.example/");
  try {
    await expect(openChromiumPages(browser.endpoint, ["https://a.example/", "https://b.example/"])).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    expect(browser.calls).toContain("Page.navigate https://b.example/");
  } finally {
    browser.stop();
  }
});

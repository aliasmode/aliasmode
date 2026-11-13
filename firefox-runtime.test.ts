import { expect, test } from "bun:test";
import { createServer, type RequestListener } from "node:http";
import {
  callFirefoxOwner,
  firefoxEndpoint,
  firefoxOwnerReady,
  forgetFirefoxOwner,
  reserveFirefoxOwner,
  type FirefoxOwner,
} from "./firefox-runtime.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";
import { camouEnvironment, firefoxLaunchOptions, observedFirefoxCaptureUrl, trackFirefoxPages } from "./firefox-worker.mjs";
import { EventEmitter } from "node:events";

async function ownerServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const owner: FirefoxOwner = {
    endpoint: `http://127.0.0.1:${address.port}/`,
    token: "private-owner-token",
    generation: "generation-1",
    pid: 12,
    browserPid: 34,
  };
  return { server, owner };
}

test("a crashed Firefox tab never reads as a closed last window", () => {
  // As Playwright does: a crashed page emits "crash", then leaves the context's page list.
  const context = Object.assign(new EventEmitter(), { list: [] as EventEmitter[], pages() { return this.list; } });
  const first = new EventEmitter();
  context.list.push(first);
  const hasPages = trackFirefoxPages(context);
  expect(hasPages()).toBe(true);
  const second = new EventEmitter();
  context.list.push(second);
  context.emit("page", second);
  // The user closes a tab: one page is left.
  context.list = [first];
  expect(hasPages()).toBe(true);
  // The last tab's content process crashes: the tab still shows in its window.
  first.emit("crash");
  context.list = [];
  expect(hasPages()).toBe(true);

  const closed = Object.assign(new EventEmitter(), { list: [new EventEmitter()], pages() { return this.list; } });
  const closedHasPages = trackFirefoxPages(closed);
  closed.list = [];
  expect(closedHasPages()).toBe(false);
});

test("Firefox owner passes native proxy preferences", () => {
  const proxy = { server: "http://proxy.example:8080" };
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", proxy })).toMatchObject({
    executablePath: "firefox.exe",
    viewport: null,
    proxy,
    firefoxUserPrefs: {
      "media.peerconnection.ice.proxy_only": true,
      "media.peerconnection.ice.default_address_only": true,
      "media.peerconnection.ice.no_host": true,
      // Response bodies and WebSocket frames for Playwright stay off until a script or MCP client attaches.
      "juggler.networkDetail": false,
    },
  });
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", proxy })).not.toHaveProperty("firefoxUserPrefs.browser.startup.page");
  // Pages follow the computer's colour scheme and accessibility settings, never Playwright's light defaults.
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe" })).toMatchObject({
    colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null,
  });
  // A stored graphics identity keeps WebGL on, so the same card shows on every computer.
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", config: { "webGl:vendor": "Google Inc. (Intel)" } }).firefoxUserPrefs)
    .toMatchObject({ "webgl.force-enabled": true });
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", config: {} }).firefoxUserPrefs).not.toHaveProperty("webgl.force-enabled");
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe" }).firefoxUserPrefs).toEqual({
    "media.peerconnection.ice.default_address_only": true,
    "juggler.networkDetail": false,
  });
});

test("Firefox owner sends the config and ASCII-only startup preferences in chunks and drops stale ones", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("CAMOU_")));
  const chunks = (name: string) => Object.keys(process.env).filter((key) => key.startsWith(`${name}_`)).sort((a, b) => Number(a.split("_")[2]) - Number(b.split("_")[2]))
    .map((key) => process.env[key]!).join("");
  try {
    process.env.CAMOU_PREFS_3 = "stale";
    const config = { voices: Array.from({ length: 120 }, (_, i) => ({ name: `Amélie ${i}`, lang: "fr-CA" })) };
    camouEnvironment(config, { "intl.locale.requested": "fr-CA", label: "Zoë" });
    expect(chunks("CAMOU_CONFIG")).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(chunks("CAMOU_CONFIG"))).toEqual(config);
    expect(process.env.CAMOU_CONFIG_2).toBeString();
    const prefs = chunks("CAMOU_PREFS");
    expect(prefs).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(prefs)).toEqual({ "intl.locale.requested": "fr-CA", label: "Zoë" });
    expect(process.env.CAMOU_PREFS_3).toBeUndefined();
    camouEnvironment({}, undefined);
    expect(Object.keys(process.env).filter((key) => key.startsWith("CAMOU_PREFS"))).toEqual([]);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("CAMOU_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("Firefox owner excludes its temporary fingerprint page from capture history", () => {
  expect(observedFirefoxCaptureUrl("https://fingerprint.aliasmode.invalid/?__aliasmode_fingerprint__=1")).toBeUndefined();
  expect(observedFirefoxCaptureUrl("http://aliasmode-fixture.test:8080/first")?.origin).toBe("http://aliasmode-fixture.test:8080");
  expect(observedFirefoxCaptureUrl("about:blank")).toBeUndefined();
});

test("Firefox owner preserves pre-readiness worker error codes", () => {
  const error = (() => {
    try {
      firefoxOwnerReady({ version: 1, ok: false, error: { code: "runtime_unavailable" } });
    } catch (failure) {
      return failure;
    }
  })();
  expect(error).toMatchObject({ name: "FirefoxOwnerError", code: "runtime_unavailable", message: "Firefox owner failed before ready" });
});

test("Firefox owner endpoints are opaque and route worker operations privately", async () => {
  let authorization = "";
  let request: any;
  const { server, owner } = await ownerServer(async (incoming, response) => {
    authorization = incoming.headers.authorization ?? "";
    request = JSON.parse(await new Response(incoming as any).text());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: 1, ok: true, result: { injected: true } }));
  });
  try {
    const endpoint = firefoxEndpoint(owner);
    expect(endpoint).toBe(`firefox://127.0.0.1:${new URL(owner.endpoint).port}/generation-1`);
    expect(endpoint).not.toContain(owner.token);
    await expect(runPlaywrightWorker<{ injected: boolean }>("ensure-cookies", {
      endpoint,
      cookies: [],
    })).resolves.toEqual({ injected: true });
    expect(authorization).toBe(`Bearer ${owner.token}`);
    expect(request).toEqual({
      version: 1,
      operation: "ensure-cookies",
      payload: { endpoint, cookies: [], ownerGeneration: owner.generation },
    });
  } finally {
    forgetFirefoxOwner(owner);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Firefox owner forwards RPC details to worker callers", async () => {
  const { server, owner } = await ownerServer((_incoming, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: 1,
      ok: false,
      error: { code: "operation_failed", message: "capture failed", details: { operation: "origin_storage", outcome: "failure" } },
    }));
  });
  try {
    const endpoint = firefoxEndpoint(owner);
    const error = await runPlaywrightWorker("session-capture", { endpoint, captureSeed: { origins: [] } })
      .then(() => null, (failure) => failure);
    expect(error).toMatchObject({
      code: "operation_failed",
      details: { operation: "origin_storage", outcome: "failure" },
    });
  } finally {
    forgetFirefoxOwner(owner);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Firefox owner honors caller-provided RPC timeouts", async () => {
  const { server, owner } = await ownerServer(() => {});
  try {
    const endpoint = firefoxEndpoint(owner);
    const error = await runPlaywrightWorker("session-capture", {
      endpoint,
      captureSeed: { origins: [] },
    }, { timeoutMs: 1 }).then(() => null, (failure) => failure);
    expect(error).toMatchObject({ code: "timeout" });
    await expect(callFirefoxOwner(owner, "status", {}, { timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
  } finally {
    forgetFirefoxOwner(owner);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Firefox owner reservations keep tokens out of their endpoint", async () => {
  const reservation = await reserveFirefoxOwner();
  expect(reservation.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(reservation.endpoint).not.toContain(reservation.token);
  expect(reservation.generation).not.toContain(reservation.token);
});

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
import { firefoxLaunchOptions } from "./firefox-worker.mjs";

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
    },
  });
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", proxy })).not.toHaveProperty("firefoxUserPrefs.browser.startup.page");
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe" })).not.toHaveProperty("firefoxUserPrefs");
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

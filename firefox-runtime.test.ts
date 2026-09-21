import { expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  firefoxEndpoint,
  forgetFirefoxOwner,
  reserveFirefoxOwner,
  type FirefoxOwner,
} from "./firefox-runtime.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";

test("Firefox owner endpoints are opaque and route worker operations privately", async () => {
  let authorization = "";
  let request: any;
  const server = createServer(async (incoming, response) => {
    authorization = incoming.headers.authorization ?? "";
    request = JSON.parse(await new Response(incoming as any).text());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: 1, ok: true, result: { injected: true } }));
  });
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
  try {
    const endpoint = firefoxEndpoint(owner);
    expect(endpoint).toBe(`firefox://127.0.0.1:${address.port}/generation-1`);
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

test("Firefox owner reservations keep tokens out of their endpoint", async () => {
  const reservation = await reserveFirefoxOwner();
  expect(reservation.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(reservation.endpoint).not.toContain(reservation.token);
  expect(reservation.generation).not.toContain(reservation.token);
});

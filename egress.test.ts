import { expect, test } from "bun:test";
import { parseEgressResponse, resolveEgressEndpoints, verifyBrowserProxy } from "./egress.ts";

test("parseEgressResponse accepts JSON and plain IPv4/IPv6 responses", () => {
  expect(parseEgressResponse('{"ip":"203.0.113.4","country":"US"}')).toEqual({ ip: "203.0.113.4", country: "US" });
  expect(parseEgressResponse('{"query":"2001:db8::1"}')).toEqual({ ip: "2001:db8::1" });
  expect(parseEgressResponse("198.51.100.9\n")).toEqual({ ip: "198.51.100.9" });
});

test("parseEgressResponse rejects malformed responses", () => {
  expect(parseEgressResponse("")).toBeNull();
  expect(parseEgressResponse("not an ip")).toBeNull();
  expect(parseEgressResponse('{"ip":"localhost"}')).toBeNull();
});

test("egress endpoints support an operator override and reject invalid schemes", () => {
  expect(resolveEgressEndpoints("https://one.example/ip, http://127.0.0.1:8080/ip")).toEqual([
    "https://one.example/ip",
    "http://127.0.0.1:8080/ip",
  ]);
  expect(() => resolveEgressEndpoints("")).toThrow("at least one URL");
  expect(() => resolveEgressEndpoints("file:///tmp/ip")).toThrow("must use http or https");
});

test("browser proxy verification refuses plaintext endpoints before CDP", async () => {
  await expect(verifyBrowserProxy(
    "ws://127.0.0.1:1/devtools/browser/never-contact",
    { endpoints: ["http://example.test/ip"] },
  )).rejects.toThrow("must use HTTPS");
});

test("browser proxy verification applies session work before its only CDP detach", async () => {
  const events: string[] = [];
  const page = {
    async goto() {
      events.push("proof");
      return { ok: () => true };
    },
    locator() {
      return { innerText: async () => "203.0.113.9" };
    },
    async close() { events.push("page-close"); },
  };
  const browser = {
    contexts: () => [{ pages: () => [], newPage: async () => page }],
    async close() { events.push("browser-close"); },
  };

  const result = await verifyBrowserProxy(
    "ws://test",
    {
      endpoints: ["https://example.test/ip"],
      connect: async () => {
        events.push("connect");
        return browser;
      },
    },
    async (attachedBrowser, egress) => {
      expect(attachedBrowser).toBe(browser);
      expect(egress.ip).toBe("203.0.113.9");
      events.push("session-apply");
    },
  );

  expect(result.ip).toBe("203.0.113.9");
  expect(events).toEqual(["connect", "proof", "session-apply", "page-close", "browser-close"]);
});

test("browser proxy verification preserves session work errors after proof", async () => {
  const original = new Error("session apply failed");
  const page = {
    async goto() { return { ok: () => true }; },
    locator() { return { innerText: async () => "203.0.113.9" }; },
    async close() {},
  };
  const browser = {
    contexts: () => [{ pages: () => [], newPage: async () => page }],
    async close() {},
  };

  await expect(verifyBrowserProxy(
    "ws://test",
    { endpoints: ["https://example.test/ip"], connect: async () => browser },
    async () => { throw original; },
  )).rejects.toBe(original);
});

test("browser proxy verification never applies session work before proof", async () => {
  let actionCalled = false;
  const page = {
    async goto() { return { ok: () => false }; },
    locator() { return { innerText: async () => "" }; },
    async close() {},
  };
  const browser = {
    contexts: () => [{ pages: () => [], newPage: async () => page }],
    async close() {},
  };

  await expect(verifyBrowserProxy(
    "ws://test",
    { endpoints: ["https://example.test/ip"], connect: async () => browser },
    async () => { actionCalled = true; },
  )).rejects.toThrow("Proxy verification failed before account traffic");
  expect(actionCalled).toBe(false);
});

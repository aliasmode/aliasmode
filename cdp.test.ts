import { expect, test } from "bun:test";
import { withCdpPage } from "./cdp.ts";

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
  const browser = {
    contexts() {
      return [{ pages: () => [], newPage: async () => page }];
    },
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
  expect(fake.closeCalls()).toEqual({ page: 1, browser: 1 });
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
  expect(fake.closeCalls()).toEqual({ page: 1, browser: 1 });
});

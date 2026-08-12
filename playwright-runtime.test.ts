import { expect, test } from "bun:test";
import { playwrightFromModule } from "./playwright-runtime.ts";

const chromium = { async connectOverCDP() {} };

test("accepts named Playwright exports", () => {
  expect(playwrightFromModule({ chromium }).chromium).toBe(chromium);
});

test("accepts a CommonJS Playwright default export", () => {
  expect(playwrightFromModule({ default: { chromium } }).chromium).toBe(chromium);
});

test("rejects an invalid Playwright runtime", () => {
  expect(() => playwrightFromModule({ default: {} })).toThrow("Playwright runtime is invalid");
});

import { expect, test } from "bun:test";
import {
  configureDuckDuckGo,
  existingSearchProvider,
} from "./search-provider.ts";

test("keeps a functional operator-selected search provider", () => {
  expect(existingSearchProvider([
    { name: "No Search", url: "http://%s" },
    { default: true, name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  ])).toEqual({ status: "kept-existing", engine: "Brave Search" });
});

test("repairs a missing or No Search default", () => {
  expect(existingSearchProvider([])).toBeNull();
  expect(existingSearchProvider([
    { default: true, name: "No Search", url: "http://%s" },
  ])).toBeNull();
});

test("recognizes an existing DuckDuckGo default", () => {
  expect(existingSearchProvider([
    { default: true, name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  ])).toEqual({ status: "already-default", engine: "DuckDuckGo" });
});

test("does not run the mutation when the current provider works", async () => {
  let evaluations = 0;
  let closed = false;
  const page = {
    goto: async (url: string) => expect(url).toBe("chrome://settings/searchEngines"),
    evaluate: async () => {
      evaluations++;
      return [{ default: true, name: "Bing", url: "https://bing.com/search?q=%s" }];
    },
    close: async () => { closed = true; },
  };
  const context = { newPage: async () => page };

  const result = await configureDuckDuckGo(context as any);

  expect(result).toEqual({ status: "kept-existing", engine: "Bing" });
  expect(evaluations).toBe(1);
  expect(closed).toBe(true);
});

test("configures No Search through a second settings evaluation", async () => {
  let evaluations = 0;
  let closed = false;
  const page = {
    goto: async () => {},
    evaluate: async () => {
      evaluations++;
      if (evaluations === 1) return [{ default: true, name: "No Search", url: "http://%s" }];
      return { ok: true, status: "configured", engine: "DuckDuckGo" };
    },
    close: async () => { closed = true; },
  };
  const context = { newPage: async () => page };

  const result = await configureDuckDuckGo(context as any);

  expect(result).toEqual({ status: "configured", engine: "DuckDuckGo" });
  expect(evaluations).toBe(2);
  expect(closed).toBe(true);
});

test("closes the settings page when Chromium rejects the repair", async () => {
  let evaluations = 0;
  let closed = false;
  const page = {
    goto: async () => {},
    evaluate: async () => {
      evaluations++;
      if (evaluations === 1) return [{ default: true, name: "No Search", url: "http://%s" }];
      return { ok: false, error: "rejected" };
    },
    close: async () => { closed = true; },
  };
  const context = { newPage: async () => page };

  await expect(configureDuckDuckGo(context as any)).rejects.toThrow("rejected");
  expect(closed).toBe(true);
});

import { expect, test } from "bun:test";
import { existingSearchProvider } from "./search-provider.ts";

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

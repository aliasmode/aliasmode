import { expect, test } from "bun:test";
import { existingSearchProvider } from "./search-provider.ts";

test("replaces a functional non-DuckDuckGo search provider", () => {
  expect(existingSearchProvider([
    { name: "No Search", url: "http://%s" },
    { default: true, name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  ])).toBeNull();
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

test("requires an official HTTPS DuckDuckGo query URL", () => {
  for (const url of [
    "https://search.example/?q=%s",
    "http://duckduckgo.com/?q=%s",
    "https://duckduckgo.com.evil.example/?q=%s",
  ]) {
    expect(existingSearchProvider([
      { default: true, name: "DuckDuckGo", url },
    ])).toBeNull();
  }
});

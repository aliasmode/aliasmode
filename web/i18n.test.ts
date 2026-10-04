import { test, expect } from "bun:test";
import { availableLanguages, languageNativeName, translate } from "./i18n.tsx";
import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";

const tables = {
  "en-US": enUS as Record<string, string>,
  "zh-CN": zhCN as Record<string, string>,
};

// Keys are the English source strings, so en-US only carries the keys whose
// value differs from the key. Every translated key must still exist in the UI
// source, or the translation is dead.
test("every zh-CN key is an English string used in the web source", async () => {
  const sources = await Promise.all(
    ["app.tsx", "proxies.tsx", "scripts.tsx", "trash.tsx", "proxy-offer.tsx"]
      .map((file) => Bun.file(new URL(`./${file}`, import.meta.url)).text()),
  );
  const source = sources.join("\n");
  const stale = Object.keys(tables["zh-CN"]).filter((key) => !key.startsWith("language.") && !source.includes(key));
  expect(stale).toEqual([]);
});

test("t() returns the translation for the active language", () => {
  expect(translate(tables, "zh-CN", "Appearance")).toBe(tables["zh-CN"]!["Appearance"]!);
  expect(translate(tables, "en-US", "Appearance")).toBe("Appearance");
});

test("t() falls back to English for missing keys", () => {
  const partial = {
    "en-US": { hello: "Hello" },
    "xx-YY": {} as Record<string, string>,
  };
  // Missing in xx-YY → English catalog value.
  expect(translate(partial, "xx-YY", "hello")).toBe("Hello");
  // Missing everywhere → the key itself.
  expect(translate(partial, "xx-YY", "unknown.key")).toBe("unknown.key");
  // Unknown language → English catalog.
  expect(translate(partial, "zz-ZZ", "hello")).toBe("Hello");
});

test("t() interpolates {name} and {{name}} placeholders", () => {
  const partial = { "en-US": { greeting: "Hello {name}", formal: "Hi {{name}}" } };
  expect(translate(partial, "en-US", "greeting", { name: "Ada" })).toBe("Hello Ada");
  expect(translate(partial, "en-US", "formal", { name: "Ada" })).toBe("Hi Ada");
  expect(translate(partial, "en-US", "greeting")).toBe("Hello {name}");
});

test("availableLanguages lists bundled locales with native names", () => {
  expect(availableLanguages()).toContain("en-US");
  expect(availableLanguages()).toContain("zh-CN");
  expect(languageNativeName("en-US")).toBe("English");
  expect(languageNativeName("zh-CN")).toBe("简体中文");
  expect(languageNativeName("xx-YY")).toBe("xx-YY");
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore, legacyHubUrl, parseAppConfig } from "./app-config.ts";

describe("AliasMode app config", () => {
  test("fresh installs remain unconfigured with Local analytics disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-config-"));
    expect(new AppConfigStore(join(root, "config.json")).read()).toEqual({
      version: 1,
      mode: "unconfigured",
      localAnalytics: false,
    });
  });

  test("Cloud mode requires HTTPS except for loopback development", () => {
    expect(() => parseAppConfig({ version: 1, mode: "cloud", cloudUrl: "http://example.com", localAnalytics: false }))
      .toThrow("Cloud URL must use HTTPS");
    expect(parseAppConfig({ version: 1, mode: "cloud", cloudUrl: "http://127.0.0.1:54321", localAnalytics: false }).cloudUrl)
      .toBe("http://127.0.0.1:54321");
  });

  test("writes normalized config atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-config-"));
    const path = join(root, "config.json");
    const store = new AppConfigStore(path);
    expect(store.setMode("cloud", "https://cloud.aliasmode.test/")).toEqual({
      version: 1,
      mode: "cloud",
      cloudUrl: "https://cloud.aliasmode.test",
      localAnalytics: false,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(store.read());
  });

  test("switching to Local removes the Cloud endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-config-"));
    const store = new AppConfigStore(join(root, "config.json"));
    store.setMode("cloud", "https://cloud.aliasmode.test");
    expect(store.setMode("local")).toEqual({ version: 1, mode: "local", localAnalytics: false });
  });

  test("legacy HUB_URL never handles an explicit Local or Cloud selection", () => {
    const env = { HUB_URL: "https://legacy-hub.example" };
    expect(legacyHubUrl({ version: 1, mode: "unconfigured", localAnalytics: false }, env))
      .toBe("https://legacy-hub.example");
    expect(legacyHubUrl({ version: 1, mode: "local", localAnalytics: false }, env)).toBeUndefined();
    expect(legacyHubUrl({
      version: 1,
      mode: "cloud",
      cloudUrl: "https://cloud.aliasmode.test",
      localAnalytics: false,
    }, env)).toBeUndefined();
  });
});

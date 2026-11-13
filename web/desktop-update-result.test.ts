import { expect, test } from "bun:test";
import {
  describeDesktopUpdateResult,
  NATIVE_UPDATE_ERRORS,
  parseDesktopUpdateResult,
} from "./desktop-update-result.ts";
import { translate } from "./i18n.tsx";
import enUS from "./locales/en-US.json";
import ruRU from "./locales/ru-RU.json";
import zhCN from "./locales/zh-CN.json";

test("parses only safe durable desktop update results", () => {
  expect(parseDesktopUpdateResult(null)).toBeNull();
  expect(parseDesktopUpdateResult({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
    expectedRoot: "C:\\private\\install",
  })).toEqual({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
  });
  expect(parseDesktopUpdateResult({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  })).toEqual({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  });
  expect(parseDesktopUpdateResult({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "browserCleanup",
  })).toEqual({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "browserCleanup",
  });
});

test("rejects malformed or unknown durable update results", () => {
  for (const value of [
    undefined,
    {},
    { state: "succeeded", version: "0.1.0-beta.48" },
    { state: "installedRelaunchUnconfirmed", version: "" },
    {
      state: "failedOrInterrupted",
      fromVersion: "0.1.0-beta.47",
      expectedVersion: "0.1.0-beta.48",
      reason: "privateDiagnostic",
    },
  ]) {
    expect(() => parseDesktopUpdateResult(value)).toThrow("AliasMode returned an invalid update result.");
  }
});


// Mock t function that does simple interpolation
const mockT = (key: string, values?: Record<string, string>): string => {
  let result = key;
  if (values) {
    for (const [k, v] of Object.entries(values)) {
      result = result.replace(`{${k}}`, v);
    }
  }
  return result;
};

test("describes confirmed, unconfirmed, and failed updates without private diagnostics", () => {
  expect(describeDesktopUpdateResult({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
  }, mockT)).toEqual({
    tone: "success",
    title: "AliasMode 0.1.0-beta.48 installed successfully.",
    detail: "Updated from 0.1.0-beta.47 and verified the installed app after restart.",
  });
  expect(describeDesktopUpdateResult({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  }, mockT).detail).toContain("launch it from Windows Start");
  expect(describeDesktopUpdateResult({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "installationUnconfirmed",
  }, mockT).detail).toContain("full offline installer without uninstalling");
});

const tables = {
  "en-US": enUS as Record<string, string>,
  "ru-RU": ruRU as Record<string, string>,
  "zh-CN": zhCN as Record<string, string>,
};

test("lists every error text the native updater can return", async () => {
  const rust = (await Bun.file(new URL("../src-tauri/src/releases.rs", import.meta.url)).text()).split("#[cfg(test)]")[0]!;
  const native = [...new Set([...rust.matchAll(/"((?:AliasMode|The update|An update)[^"{}]*\.)"/g)].map((match) => match[1]!))];
  expect(native.toSorted()).toEqual([...NATIVE_UPDATE_ERRORS].toSorted());
});

test("translates every native updater error in English, Russian and Chinese", () => {
  for (const message of NATIVE_UPDATE_ERRORS) {
    expect(translate(tables, "en-US", message)).toBe(message);
    for (const language of ["ru-RU", "zh-CN"]) {
      const translated = translate(tables, language, message);
      expect(translated).not.toBe(message);
      expect(translated.length).toBeGreaterThan(0);
    }
  }
});

test("names the download step, not the check, when a download fails", () => {
  const downloadErrors = NATIVE_UPDATE_ERRORS.filter((message) => /update download|downloaded update/.test(message));
  expect(downloadErrors).toHaveLength(3);
  for (const message of downloadErrors) {
    expect(message).not.toContain("could not check");
    expect(message).toContain("Your browsers are still open.");
  }
  expect(translate(tables, "ru-RU", "The update download was interrupted. Your browsers are still open. Try again."))
    .toBe("Загрузка обновления прервана. Браузеры остаются открытыми. Повторите попытку.");
  expect(translate(tables, "zh-CN", "The update download stopped because no data arrived for 1 minute. Your browsers are still open. Check your connection and try again."))
    .toBe("更新下载已停止，因为 1 分钟内没有收到数据。浏览器仍保持打开。请检查网络连接后重试。");
});

test("translates the download progress size and reconnect texts", () => {
  expect(translate(tables, "en-US", "{downloaded} of {total} MB", { downloaded: "110", total: "263" })).toBe("110 of 263 MB");
  expect(translate(tables, "ru-RU", "{downloaded} of {total} MB", { downloaded: "110", total: "263" })).toBe("110 из 263 МБ");
  expect(translate(tables, "zh-CN", "{downloaded} of {total} MB", { downloaded: "110", total: "263" })).toBe("110 / 263 MB");
  expect(translate(tables, "ru-RU", "Connection lost. Reconnecting…")).toBe("Соединение прервано. Повторное подключение…");
  expect(translate(tables, "zh-CN", "Connection lost. Reconnecting…")).toBe("连接中断。正在重新连接…");
});

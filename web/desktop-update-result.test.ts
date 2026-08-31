import { expect, test } from "bun:test";
import {
  describeDesktopUpdateResult,
  parseDesktopUpdateResult,
} from "./desktop-update-result.ts";

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

test("describes confirmed, unconfirmed, and failed updates without private diagnostics", () => {
  expect(describeDesktopUpdateResult({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
  })).toEqual({
    tone: "success",
    title: "AliasMode 0.1.0-beta.48 installed successfully.",
    detail: "Updated from 0.1.0-beta.47 and verified the installed app after restart.",
  });
  expect(describeDesktopUpdateResult({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  }).detail).toContain("launch it from Windows Start");
  expect(describeDesktopUpdateResult({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "installationUnconfirmed",
  }).detail).toContain("full offline installer without uninstalling");
});

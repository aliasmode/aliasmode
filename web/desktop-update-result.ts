export type DesktopUpdateFailureReason =
  | "browserCleanup"
  | "installerLaunch"
  | "installationUnconfirmed"
  | "startupMismatch";

export type DesktopUpdateResult =
  | { state: "succeeded"; fromVersion: string; version: string }
  | { state: "installedRelaunchUnconfirmed"; version: string }
  | {
      state: "failedOrInterrupted";
      fromVersion: string;
      expectedVersion: string;
      reason: DesktopUpdateFailureReason;
    };

export interface DesktopUpdateResultSummary {
  tone: "success" | "warning" | "error";
  title: string;
  detail: string;
}

const FAILURE_REASONS = new Set<DesktopUpdateFailureReason>([
  "browserCleanup",
  "installerLaunch",
  "installationUnconfirmed",
  "startupMismatch",
]);

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function parseDesktopUpdateResult(value: unknown): DesktopUpdateResult | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new Error("AliasMode returned an invalid update result.");
  }
  const result = value as Record<string, unknown>;
  if (
    result.state === "succeeded" &&
    isVersion(result.fromVersion) &&
    isVersion(result.version)
  ) {
    return {
      state: "succeeded",
      fromVersion: result.fromVersion,
      version: result.version,
    };
  }
  if (result.state === "installedRelaunchUnconfirmed" && isVersion(result.version)) {
    return { state: "installedRelaunchUnconfirmed", version: result.version };
  }
  if (
    result.state === "failedOrInterrupted" &&
    isVersion(result.fromVersion) &&
    isVersion(result.expectedVersion) &&
    typeof result.reason === "string" &&
    FAILURE_REASONS.has(result.reason as DesktopUpdateFailureReason)
  ) {
    return {
      state: "failedOrInterrupted",
      fromVersion: result.fromVersion,
      expectedVersion: result.expectedVersion,
      reason: result.reason as DesktopUpdateFailureReason,
    };
  }
  throw new Error("AliasMode returned an invalid update result.");
}

// The recovery hints name what each system offers: the Start menu and offline installer, or Applications and the install command.
// Each hint is a full sentence per platform so translations never mix languages.
const MAC = typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);

export function describeDesktopUpdateResult(result: DesktopUpdateResult, t: (key: string, values?: Record<string, string>) => string): DesktopUpdateResultSummary {
  if (result.state === "succeeded") {
    return {
      tone: "success",
      title: t("AliasMode {version} installed successfully.", { version: result.version }),
      detail: t("Updated from {fromVersion} and verified the installed app after restart.", { fromVersion: result.fromVersion }),
    };
  }
  if (result.state === "installedRelaunchUnconfirmed") {
    return {
      tone: "warning",
      title: t("AliasMode {version} is installed.", { version: result.version }),
      detail: MAC
        ? t("The automatic restart was not confirmed. Close AliasMode, then open it from the Applications folder.")
        : t("The automatic restart was not confirmed. Close AliasMode, then launch it from Windows Start."),
    };
  }

  const detail = result.reason === "browserCleanup"
    ? t("AliasMode {fromVersion} remains installed because browser services could not close safely.", { fromVersion: result.fromVersion })
    : result.reason === "installerLaunch"
      ? t("AliasMode {expectedVersion} could not start. AliasMode {fromVersion} remains installed.", { expectedVersion: result.expectedVersion, fromVersion: result.fromVersion })
      : result.reason === "startupMismatch"
        ? MAC
          ? t("AliasMode could not verify {expectedVersion} at the expected install location. Close AliasMode, then open it from the Applications folder.", { expectedVersion: result.expectedVersion })
          : t("AliasMode could not verify {expectedVersion} at the expected install location. Close AliasMode, then launch it from Windows Start.", { expectedVersion: result.expectedVersion })
        : MAC
          ? t("AliasMode could not confirm {expectedVersion}. If the installed version did not change, run the install command again.", { expectedVersion: result.expectedVersion })
          : t("AliasMode could not confirm {expectedVersion}. If the installed version did not change, run the full offline installer without uninstalling.", { expectedVersion: result.expectedVersion });
  return {
    tone: "error",
    title: t("The last update did not finish."),
    detail,
  };
}

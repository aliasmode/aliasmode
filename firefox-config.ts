import { fromBrowserforge, generateFingerprint } from "camoufox-js/dist/fingerprints.js";
import type { FirefoxProfileConfig, JsonValue, ProfileEngine } from "./types.ts";

export const FIREFOX_RUNTIME_VERSION = "152.0.4-beta.30";
const FIREFOX_UA_MAJOR_VERSION = "152";

/** Generate a Windows Camoufox identity once, for durable profile storage. */
export function createFirefoxProfileConfig(screenWidth: number, screenHeight: number): FirefoxProfileConfig {
  const fingerprint = generateFingerprint([screenWidth, screenHeight], {
    browsers: ["firefox"],
    operatingSystems: ["windows"],
  });
  return normalizeFirefoxProfileConfig({
    version: 1,
    runtimeVersion: FIREFOX_RUNTIME_VERSION,
    config: fromBrowserforge(fingerprint, FIREFOX_UA_MAJOR_VERSION),
  });
}

/** Normalize and validate the persisted Camoufox identity at every boundary. */
export function normalizeFirefoxProfileConfig(value: unknown): FirefoxProfileConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "runtimeVersion", "config"])) {
    throw new Error("invalid Firefox profile config");
  }
  if (value.version !== 1) throw new Error("unsupported Firefox profile config version");
  if (typeof value.runtimeVersion !== "string" || !value.runtimeVersion.trim()) {
    throw new Error("Firefox profile config runtimeVersion must be a non-empty string");
  }
  if (!isRecord(value.config)) throw new Error("Firefox profile config must include a config object");
  return {
    version: 1,
    runtimeVersion: value.runtimeVersion.trim(),
    config: normalizeJsonRecord(value.config),
  };
}

/** Treat a missing legacy engine as Chromium and reject malformed combinations. */
export function normalizeProfileEngine(value: unknown, firefox: unknown): {
  engine: ProfileEngine;
  firefox?: FirefoxProfileConfig;
} {
  const engine = value === undefined ? "chromium" : value;
  if (engine !== "chromium" && engine !== "firefox") throw new Error("unsupported profile engine");
  if (engine === "firefox") {
    if (firefox === undefined) throw new Error("Firefox profiles require a Firefox config");
    return { engine, firefox: normalizeFirefoxProfileConfig(firefox) };
  }
  if (firefox !== undefined) throw new Error("Chromium profiles cannot include a Firefox config");
  return { engine };
}

function normalizeJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]));
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Firefox profile config must contain JSON values");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) return normalizeJsonRecord(value);
  throw new Error("Firefox profile config must contain JSON values");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

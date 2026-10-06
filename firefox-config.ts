// @ts-expect-error Bun embeds this package data in compiled sidecars.
import fingerprintNetworkDefinitionPath from "./node_modules/fingerprint-generator/data_files/fingerprint-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import inputNetworkDefinitionPath from "./node_modules/header-generator/data_files/input-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import headerNetworkDefinitionPath from "./node_modules/header-generator/data_files/header-network-definition.zip" with { type: "file" };
import type { FirefoxProfileConfig, JsonValue, Profile, ProfileEngine } from "./types.ts";
import fonts from "camoufox-js/dist/mappings/fonts.config.js";
import { platformFromUA } from "./fingerprint.ts";
import { localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";

const generatorAssetInputs = [
  ["fingerprint-network-definition.zip", fingerprintNetworkDefinitionPath],
  ["input-network-definition.zip", inputNetworkDefinitionPath],
  ["header-network-definition.zip", headerNetworkDefinitionPath],
] as const;
const generatorAssets = Object.fromEntries(await Promise.all(generatorAssetInputs.map(async ([name, source]) => {
  return [name, Buffer.from(await Bun.file(source).arrayBuffer())] as const;
})));
(globalThis as typeof globalThis & { __aliasmodeGeneratorAssets?: Record<string, Buffer> }).__aliasmodeGeneratorAssets = generatorAssets;
const { fromBrowserforge, generateFingerprint } = await import("camoufox-js/dist/fingerprints.js");

export const FIREFOX_RUNTIME_VERSION = "152.0.4-beta.30";
const FIREFOX_UA_MAJOR_VERSION = "152";

/** Generate an OS-matched identity once, for durable profile storage. */
export function createFirefoxProfileConfig(
  screenWidth: number,
  screenHeight: number,
  platformOs: "windows" | "macos" | "linux" = "windows",
): FirefoxProfileConfig {
  const fingerprint = generateFingerprint([screenWidth, screenHeight], {
    browsers: ["firefox"],
    operatingSystems: [platformOs],
  });
  const config = fromBrowserforge(fingerprint, FIREFOX_UA_MAJOR_VERSION);
  if (typeof config.timezone !== "string" || !config.timezone.trim()) {
    config.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return normalizeFirefoxProfileConfig({
    version: 1,
    runtimeVersion: FIREFOX_RUNTIME_VERSION,
    config,
  });
}

function configuredFirefoxLocale(config: Record<string, JsonValue>): string | undefined {
  const language = config["locale:language"];
  const region = config["locale:region"];
  const explicit = config["locale:all"] || config["navigator.language"];
  const value = typeof explicit === "string" ? explicit.split(",")[0]?.trim()
    : typeof language === "string" ? [language, config["locale:script"], region].filter(Boolean).join("-")
    : undefined;
  return normalizeProfileLocale(value);
}

/** Complete missing identity only at creation or closed-profile persistence boundaries. */
export function completeProfileFingerprint(profile: Profile): Profile {
  const saved = profile.firefox?.config;
  const locale = normalizeProfileLocale(profile.locale)
    ?? (saved ? configuredFirefoxLocale(saved) : undefined)
    ?? localeForTimezone(profile.timezone);
  if (profile.engine !== "firefox" || !profile.firefox) return { ...profile, locale };

  const config = { ...profile.firefox.config };
  const tag = new Intl.Locale(locale);
  const previousLocale = configuredFirefoxLocale(config);
  config["locale:language"] = tag.language;
  if (tag.region) config["locale:region"] = tag.region;
  else delete config["locale:region"];
  if (tag.script) config["locale:script"] = tag.script;
  else delete config["locale:script"];
  config["navigator.language"] = locale;
  if (!config["locale:all"] || previousLocale !== locale) {
    config["locale:all"] = [...new Set([locale, tag.language])].join(", ");
  }
  if (config["navigator.languages"] !== undefined && previousLocale !== locale) {
    config["navigator.languages"] = [...new Set([locale, tag.language])];
  }
  if (config.fonts === undefined) {
    const ua = typeof config["navigator.userAgent"] === "string" ? config["navigator.userAgent"] : "";
    const platform = profile.platformOs || platformFromUA(profile.ua) || platformFromUA(ua)
      || (config["navigator.platform"] === "MacIntel" ? "macos"
        : String(config["navigator.platform"] ?? "").startsWith("Linux") ? "linux" : "windows");
    config.fonts = [...fonts[platform === "macos" ? "mac" : platform === "linux" ? "lin" : "win"]];
  }
  return { ...profile, locale, firefox: { ...profile.firefox, config } };
}

export function syncFirefoxTimezone(profile: Profile): void {
  if (profile.engine !== "firefox") return;
  if (!profile.firefox) throw new Error("Firefox profile is missing its saved configuration");
  const { timezone: _timezone, ...config } = profile.firefox.config;
  profile.firefox = {
    ...profile.firefox,
    config: { ...config, ...(profile.timezone ? { timezone: profile.timezone } : {}) },
  };
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

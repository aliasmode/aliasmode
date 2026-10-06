import { expect, test } from "bun:test";
import { localeForCountry, localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";
import { completeProfileFingerprint } from "./firefox-config.ts";
import { buildNewProfile } from "./create.ts";
import { deriveFingerprintFlags } from "./fingerprint.ts";
import fonts from "camoufox-js/dist/mappings/fonts.config.js";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { parseExport, parseUpdateFile, rowsToUpdates, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { importBuffers } from "./inbox.ts";
import { parseImportFile } from "./import-formats.ts";
import { encodePortableProfile, decodePortableProfile } from "./portable-profile.ts";
import { writeXlsx } from "./xlsx.ts";

test("locale defaults distinguish countries within the same timezone continent", () => {
  for (const [country, timezone, locale] of [
    ["US", "America/New_York", "en-US"],
    ["MX", "America/Mexico_City", "es-MX"],
    ["BR", "America/Sao_Paulo", "pt-BR"],
    ["FR", "Europe/Paris", "fr-FR"],
    ["CN", "Asia/Shanghai", "zh-CN"],
  ]) {
    expect(localeForCountry(country!)).toBe(locale!);
    expect(localeForTimezone(timezone!)).toBe(locale!);
  }
  expect(localeForTimezone("US/Eastern")).toBe("en-US");
  expect(localeForTimezone("Asia/Calcutta")).toBe(localeForTimezone("Asia/Kolkata"));
  expect(localeForTimezone("Europe/Kiev")).toBe(localeForTimezone("Europe/Kyiv"));
  expect(localeForTimezone("UTC")).toBe("en-US");
  expect(localeForTimezone("")).toBe("en-US");
  expect(localeForCountry("ZZ")).toBeNull();
});

test("locale input is canonical BCP-47, not browser arguments", () => {
  expect(normalizeProfileLocale(" fr-fr ")).toBe("fr-FR");
  expect(normalizeProfileLocale(undefined)).toBeUndefined();
  expect(normalizeProfileLocale("")).toBeUndefined();
  for (const value of [12, "en-US --proxy-server=other", "not_a_locale"]) {
    expect(() => normalizeProfileLocale(value)).toThrow("invalid locale");
  }
});

test("Chromium locale is saved rather than taken from measured language or the next host", () => {
  const profile = buildNewProfile({}, () => false);
  delete profile.locale;
  profile.timezone = "America/New_York";
  profile.fpObserved = { language: "zh-CN" };
  const completed = completeProfileFingerprint(profile);
  expect(completed.locale).toBe("en-US");
  expect(profile.locale).toBeUndefined();
  expect(deriveFingerprintFlags(completed)).toContain("--fingerprint-locale=en-US");
  expect(completeProfileFingerprint({ ...completed, timezone: "Asia/Shanghai" }).locale).toBe("en-US");
  expect(completeProfileFingerprint(completed)).toEqual(completed);
});

test.each(["en", "fr-CA", "zh-Hans-CN"])("Firefox retains explicit BCP-47 locale %s", (locale) => {
  const profile = completeProfileFingerprint({ ...buildNewProfile({ engine: "firefox" }, () => false), locale });
  expect(profile.locale).toBe(locale);
  expect(profile.firefox!.config["navigator.language"]).toBe(locale);
  expect(profile.firefox!.config["locale:all"]).toBe([...new Set([locale, new Intl.Locale(locale).language])].join(", "));
  expect(completeProfileFingerprint(profile)).toEqual(profile);
});

test.each([['windows', 'win'], ['macos', 'mac'], ['linux', 'lin']] as const)(
  "Firefox saves the %s font list without reseeding its fingerprint",
  (platformOs, key) => {
    const profile = buildNewProfile({ engine: "firefox", platformOs }, () => false);
    expect(profile.firefox!.config.fonts).toEqual(fonts[key]);
    expect(profile.firefox!.config["locale:language"]).toBe(new Intl.Locale(profile.locale!).language);
    expect(profile.firefox!.config["locale:region"]).toBe(new Intl.Locale(profile.locale!).region);
    expect(profile.firefox!.config).not.toHaveProperty("canvas:seed");
    expect(completeProfileFingerprint(profile)).toEqual(profile);
  },
);

test.each(["chromium", "firefox"] as const)("%s locale survives exports, Cloud transfer, and sparse re-import", async (engine) => {
  const profile = completeProfileFingerprint({ ...buildNewProfile({ engine }, () => false), locale: "fr-CA" });
  expect(parseExport(serializeAdsTxt([profile])).profiles[0]!.locale).toBe("fr-CA");
  const { headers, rows } = serializeXlsxRows([profile]);
  expect((await parseImportFile("profiles.xlsx", await writeXlsx(headers, rows))).profiles[0]!.locale).toBe("fr-CA");
  const transferred = decodePortableProfile(encodePortableProfile(profile)).profile;
  expect(transferred.locale).toBe("fr-CA");
  expect(transferred.firefox).toEqual(profile.firefox);
  const store = new ProfileStore(":memory:");
  try {
    store.upsertProfile(profile);
    await importBuffers(store, [{ name: "rename.txt", bytes: new TextEncoder().encode(`id=${profile.id}\nname=New name\n`) }], () => {});
    expect(store.getProfile(profile.id)!.locale).toBe("fr-CA");
    await importBuffers(store, [{ name: "locale.txt", bytes: new TextEncoder().encode(`id=${profile.id}\nlocale=es-MX\n`) }], () => {});
    expect(store.getProfile(profile.id)!.locale).toBe("es-MX");
    expect(store.getProfile(profile.id)!.fpExpected).toBeUndefined();
  } finally { store.close(); }
});

test("explicit locales survive file update parsing without adding them to sparse updates", () => {
  expect(parseUpdateFile("id=p1\nlocale=fr-CA\n").updates[0]!.set).toEqual({ locale: "fr-CA" });
  expect(rowsToUpdates([{ id: "p1", locale: "es-MX" }]).updates[0]!.set).toEqual({ locale: "es-MX" });
  expect(rowsToUpdates([{ id: "p1", name: "Renamed" }]).updates[0]!.set).not.toHaveProperty("locale");
});

test("closed-profile migration is persistent and leaves live Firefox identities unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-locale-"));
  const path = join(dir, "profiles.sqlite");
  let store = new ProfileStore(path);
  const closed = buildNewProfile({}, () => false);
  const active = buildNewProfile({ engine: "firefox", platformOs: "windows" }, () => false);
  const legacy = { version: 1 as const, runtimeVersion: active.firefox!.runtimeVersion, config: { "navigator.platform": "Win32", timezone: "America/New_York" } };
  try {
    store.upsertProfile(closed);
    store.upsertProfile(active);
    store.saveSessionBundle(active.id, '{"cookies":[],"tabs":["https://example.com"]}');
    store.recordLaunch({ profileId: active.id, pid: 123, debugPort: 9222, ws: "ws://localhost:9222", startedAt: 1, personaDigest: "legacy" });
    store.close();
    const db = new Database(path);
    db.query("UPDATE profiles SET locale = '', timezone = 'America/New_York'").run();
    db.query("UPDATE profiles SET firefox_config_json = ? WHERE id = ?").run(JSON.stringify(legacy), active.id);
    db.close();
    store = new ProfileStore(path);
    expect(store.getProfile(closed.id)!.locale).toBe("en-US");
    expect(store.getProfile(active.id)!.locale).toBeUndefined();
    expect(store.getProfile(active.id)!.firefox).toEqual(legacy);
    expect(store.getLaunch(active.id)!.personaDigest).toBe("legacy");
    store.clearLaunch(active.id);
    const completed = store.getProfile(active.id)!;
    expect(completed.locale).toBe("en-US");
    expect(completed.firefox!.config.fonts).toEqual(fonts.win);
    expect(completed.fingerprintSeed).toBe(active.fingerprintSeed);
    expect(store.getSessionBundle(active.id)).toContain("https://example.com");
    store.close();
    store = new ProfileStore(path);
    expect(store.getProfile(active.id)).toEqual(completed);
    const { locale: _locale, ...partial } = completed;
    store.upsertProfile({ ...partial, name: "Renamed", timezone: "Asia/Shanghai" });
    expect(store.getProfile(active.id)!.locale).toBe("en-US");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy Firefox export can be re-imported after locale and font migration", async () => {
  const profile = buildNewProfile({ engine: "firefox", platformOs: "windows" }, () => false);
  delete profile.locale;
  for (const key of ["fonts", "locale:all", "locale:language", "locale:region", "navigator.language"]) delete profile.firefox!.config[key];
  const bytes = new TextEncoder().encode(serializeAdsTxt([profile]));
  const store = new ProfileStore(":memory:");
  try {
    store.upsertProfile(profile);
    const migrated = store.getProfile(profile.id)!;
    await importBuffers(store, [{ name: "legacy.txt", bytes }], () => {});
    expect(store.getProfile(profile.id)!.firefox).toEqual(migrated.firefox);
    expect(store.getProfile(profile.id)!.locale).toBe(migrated.locale);
  } finally { store.close(); }
});

test("legacy Firefox keeps explicit locales and fonts and infers its saved OS", () => {
  const profile = buildNewProfile({ engine: "firefox", platformOs: "macos" }, () => false);
  delete profile.platformOs;
  delete profile.locale;
  delete profile.firefox!.config.fonts;
  delete profile.firefox!.config["locale:all"];
  delete profile.firefox!.config["navigator.language"];
  profile.firefox!.config["locale:language"] = "fr";
  profile.firefox!.config["locale:region"] = "CA";
  const completed = completeProfileFingerprint(profile);
  expect(completed.locale).toBe("fr-CA");
  expect(completed.firefox!.config.fonts).toEqual(fonts.mac);
  completed.firefox!.config.fonts = ["Custom Font"];
  expect(completeProfileFingerprint(completed).firefox!.config.fonts).toEqual(["Custom Font"]);
});

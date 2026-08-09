import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState } from "./migration.ts";
import { statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

function profile(id = "legacy1"): Profile {
  return {
    id,
    accId: "",
    name: "Legacy",
    group: "Imported",
    platform: "x.com",
    username: "user",
    password: "pass",
    email: "mail@example.com",
    emailPassword: "mail-pass",
    twofa: "seed",
    proxy: null,
    extensions: ["ext1"],
    tags: ["legacy"],
    ua: "ua",
    timezone: "UTC",
    screenWidth: 1920,
    screenHeight: 1080,
    fingerprintSeed: 42,
    cookies: [],
    seeded: false,
  };
}

function roots() {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-migration-"));
  const source = join(parent, "cloakpit");
  const destination = statePaths(join(parent, "AliasMode"));
  mkdirSync(source);
  return { source, destination };
}

test("legacy migration is a no-op without a source database", () => {
  const { source, destination } = roots();
  expect(migrateLegacyState(source, destination)).toEqual({ status: "not_found", profileCount: 0 });
  expect(existsSync(destination.root)).toBe(false);
});

test("legacy migration stages database, profile data, extensions, and operator identity", () => {
  const { source, destination } = roots();
  const sourceStore = new ProfileStore(join(source, "profiles.sqlite"));
  sourceStore.upsertProfile(profile());
  const legacyExtension = join(source, "extensions", "ext1");
  mkdirSync(legacyExtension, { recursive: true });
  writeFileSync(join(legacyExtension, "manifest.json"), "{}\n");
  sourceStore.addExtension({ id: "ext1", name: "Extension", loadDir: legacyExtension });
  sourceStore.close();

  const profileDir = join(source, "profiles", "legacy1", "Default");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "Cookies"), "cookie-db");
  writeFileSync(join(source, ".operator-id"), "legacy-device\n");

  expect(migrateLegacyState(source, destination)).toEqual({ status: "migrated", profileCount: 1 });
  expect(readFileSync(join(destination.profiles, "legacy1", "Default", "Cookies"), "utf8")).toBe("cookie-db");
  expect(readFileSync(join(destination.extensions, "ext1", "manifest.json"), "utf8")).toBe("{}\n");
  expect(readFileSync(destination.operatorId, "utf8")).toBe("legacy-device\n");
  expect(existsSync(destination.migration)).toBe(true);

  const migrated = new ProfileStore(destination.database);
  expect(migrated.getProfile("legacy1")?.password).toBe("pass");
  expect(migrated.getExtension("ext1")?.loadDir).toBe(join(destination.extensions, "ext1"));
  migrated.close();
  expect(migrateLegacyState(source, destination)).toEqual({ status: "already_migrated", profileCount: 1 });
});

test("legacy migration refuses active launch records and leaves destination absent", () => {
  const { source, destination } = roots();
  const sourceStore = new ProfileStore(join(source, "profiles.sqlite"));
  sourceStore.upsertProfile(profile());
  sourceStore.recordLaunch({
    profileId: "legacy1",
    pid: 123,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/test",
    startedAt: 1,
  });
  sourceStore.close();

  expect(() => migrateLegacyState(source, destination)).toThrow("Close Cloakpit");
  expect(existsSync(destination.root)).toBe(false);
});

test("legacy migration refuses to overwrite existing AliasMode state", () => {
  const { source, destination } = roots();
  const sourceStore = new ProfileStore(join(source, "profiles.sqlite"));
  sourceStore.close();
  mkdirSync(destination.root);
  writeFileSync(destination.config, "{}\n");

  expect(() => migrateLegacyState(source, destination)).toThrow("state already exists");
  expect(existsSync(destination.migration)).toBe(false);
});

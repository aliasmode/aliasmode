import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { profileDataPaths, resolveStateRoot, statePaths } from "./paths.ts";

describe("state paths", () => {
  test("explicit state root wins over environment and cwd", () => {
    expect(resolveStateRoot(["--state-root", "./explicit"], { ALIASMODE_STATE_ROOT: "./env" }, "/tmp/base"))
      .toBe(resolve("/tmp/base", "explicit"));
  });

  test("environment root is used by packaged sidecars", () => {
    expect(resolveStateRoot([], { ALIASMODE_STATE_ROOT: "./env" }, "/tmp/base"))
      .toBe(resolve("/tmp/base", "env"));
  });

  test("CLI defaults to its current working directory", () => {
    expect(resolveStateRoot([], {}, "/tmp/base")).toBe(resolve("/tmp/base"));
  });

  test("Local and Cloud profile data use separate stores", () => {
    const paths = statePaths("/tmp/aliasmode-state");
    const local = profileDataPaths(paths, false);
    const cloud = profileDataPaths(paths, true);
    expect(local).toEqual({ database: paths.database, profiles: paths.profiles });
    expect(cloud).toEqual({ database: paths.cloudDatabase, profiles: paths.cloudProfiles });
    expect(cloud.database).not.toBe(local.database);
    expect(cloud.profiles).not.toBe(local.profiles);

    const explicitLocal = profileDataPaths(paths, false, "/tmp/custom.sqlite", "/tmp/custom-profiles");
    const explicitCloud = profileDataPaths(paths, true, "/tmp/custom.sqlite", "/tmp/custom-profiles");
    expect(explicitLocal).toEqual({ database: "/tmp/custom.sqlite", profiles: "/tmp/custom-profiles" });
    expect(explicitCloud).toEqual({
      database: "/tmp/custom.sqlite.cloud-cache",
      profiles: "/tmp/custom-profiles/cloud-cache",
    });
  });

  test("CLI uses the isolated runtime database even with --db", () => {
    const cli = readFileSync(resolve(import.meta.dir, "cli.ts"), "utf8");
    expect(cli).toContain("const dbPath = activeProfilePaths.database;");
    expect(cli).not.toContain("const dbPath = configuredDbPath ?? activeProfilePaths.database;");
  });

  test("every mutable path is confined below the state root", () => {
    const root = resolve("/tmp/aliasmode-state");
    const paths = statePaths(root);
    expect(paths.root).toBe(root);
    for (const [name, path] of Object.entries(paths)) {
      if (name === "root") continue;
      expect(path.startsWith(`${root}/`)).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveStateRoot, statePaths } from "./paths.ts";

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

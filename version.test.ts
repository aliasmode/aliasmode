import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALIASMODE_VERSION } from "./version.ts";

const root = import.meta.dir;

test("release version stays aligned across the desktop bundle", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as { version: string };
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];

  expect(ALIASMODE_VERSION).toBe("0.1.0-beta.7");
  expect(packageJson.version).toBe(ALIASMODE_VERSION);
  expect(tauriConfig.version).toBe(ALIASMODE_VERSION);
  expect(cargoVersion).toBe(ALIASMODE_VERSION);
});

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALIASMODE_VERSION } from "./version.ts";

const root = import.meta.dir;

test("release version and updater trust stay aligned across the desktop bundle", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
    scripts: { "desktop:build:nsis": string };
  };
  const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as {
    version: string;
    bundle: { createUpdaterArtifacts: boolean | string; windows: { webviewInstallMode: { type: string }; nsis: { installMode: string } } };
    plugins: { updater: { pubkey: string; windows: { installMode: string } } };
  };
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const updaterSource = readFileSync(join(root, "vendor", "tauri-plugin-updater", "src", "updater.rs"), "utf8");
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
  const lockedVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "aliasmode-desktop"\r?\nversion = "([^"]+)"/)?.[1];

  expect(ALIASMODE_VERSION).toBe("0.1.0-beta.46");
  expect(packageJson.version).toBe(ALIASMODE_VERSION);
  expect(packageJson.scripts["desktop:build:nsis"]).toBe("bun run desktop:prepare && tauri build --bundles nsis --no-sign");
  expect(tauriConfig.version).toBe(ALIASMODE_VERSION);
  expect(cargoVersion).toBe(ALIASMODE_VERSION);
  expect(lockedVersion).toBe(ALIASMODE_VERSION);
  expect(tauriConfig.bundle.windows.webviewInstallMode.type).toBe("offlineInstaller");
  expect(tauriConfig.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(tauriConfig.bundle.createUpdaterArtifacts).toBe("v1Compatible");
  expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
  expect(tauriConfig.plugins.updater.pubkey.length).toBeGreaterThan(100);
  expect(cargoToml).toContain('tauri-plugin-updater = { version = "=2.10.1"');
  expect(cargoToml).toContain('tauri-plugin-updater = { path = "../vendor/tauri-plugin-updater" }');
  expect(updaterSource).toContain("if result as isize <= 32");
  expect(updaterSource).toContain("Error::Io(std::io::Error::last_os_error())");
  expect(existsSync(join(root, "src-tauri", "tauri.unsigned.conf.json"))).toBe(false);
});

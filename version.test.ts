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
  const updaterConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.updater.conf.json"), "utf8")) as {
    bundle: { createUpdaterArtifacts: boolean; windows: { webviewInstallMode: { type: string } } };
  };
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const releasesSource = readFileSync(join(root, "src-tauri", "src", "releases.rs"), "utf8");
  const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "release-candidate.yml"), "utf8")
    .replaceAll("\r\n", "\n");
  const ciWorkflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const cliSource = readFileSync(join(root, "cli.ts"), "utf8");
  const updaterAcceptance = readFileSync(join(root, "scripts", "windows-in-app-update-acceptance.ps1"), "utf8");
  const updaterSource = readFileSync(join(root, "vendor", "tauri-plugin-updater", "src", "updater.rs"), "utf8");
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
  const lockedVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "aliasmode-desktop"\r?\nversion = "([^"]+)"/)?.[1];

  expect(ALIASMODE_VERSION).toBe("0.1.0-beta.47");
  expect(packageJson.version).toBe(ALIASMODE_VERSION);
  expect(packageJson.scripts["desktop:build:nsis"]).toBe("bun run desktop:prepare && tauri build --bundles nsis --no-sign");
  expect(tauriConfig.version).toBe(ALIASMODE_VERSION);
  expect(cargoVersion).toBe(ALIASMODE_VERSION);
  expect(lockedVersion).toBe(ALIASMODE_VERSION);
  expect(tauriConfig.bundle.windows.webviewInstallMode.type).toBe("offlineInstaller");
  expect(tauriConfig.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
  expect(updaterConfig.bundle.createUpdaterArtifacts).toBe(true);
  expect(updaterConfig.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
  expect(releasesSource).toContain('const UPDATE_MANIFEST: &str = "latest-v2.json";');
  expect(releasesSource).toContain(".on_before_exit(move || {");
  expect(releasesSource).toContain("let _ = sidecar.kill_owned();");
  expect(releasesSource).toContain("app_handle.cleanup_before_exit();");
  expect(releaseWorkflow).toContain('$latestPath = Join-Path $artifact "latest-v2.json"');
  expect(releaseWorkflow).toContain("--config src-tauri/tauri.updater.conf.json");
  expect(releaseWorkflow).toContain("& $baselineBun scripts/prepare-windows-bundle.ts");
  expect(releaseWorkflow).toContain("23f2df1f40d963e5b6104e1a565df992aab8968da5004f460617073843b8b8be");
  expect(releaseWorkflow).not.toContain("bun run desktop:prepare");
  expect(releaseWorkflow).not.toContain("nsis-updater");
  expect(releaseWorkflow).toContain(
    "- name: Test candidate through the exact updater protocol\n        timeout-minutes: 35",
  );
  expect(ciWorkflow).toContain("Build full offline installer");
  expect(ciWorkflow).toContain("--config src-tauri/tauri.updater.conf.json");
  expect(ciWorkflow).not.toContain("nsis-updater");
  expect(updaterAcceptance).toContain("New-LocalUser");
  expect(updaterAcceptance).toContain('EntryPoint = "CreateProcessWithLogonW"');
  expect(updaterAcceptance).toContain("LoadUserProfile");
  expect(updaterAcceptance).toContain('"Registry::HKEY_USERS\\$acceptanceUserSid');
  expect(updaterAcceptance).toContain("AliasModeAcceptanceDesktopAccess");
  expect(updaterAcceptance).toContain("GetProcessLogonSid");
  expect(updaterAcceptance).toContain("TokenLogonSidClass = 28");
  expect(updaterAcceptance).not.toContain("identity.Groups");
  expect(updaterAcceptance).toContain(
    "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT",
  );
  expect(updaterAcceptance).toContain(
    'ALIASMODE_ACCEPTANCE_DISABLE_GPU_SANDBOX = "1"',
  );
  expect(updaterAcceptance).toContain(
    "ALIASMODE_ACCEPTANCE_BROWSER_LOG = $browserLogPath",
  );
  expect(updaterAcceptance).toContain("Read-SafeBrowserLogDiagnostics");
  expect(updaterAcceptance).toContain(
    "$observations.browserLogSignatures = @($browserLogDiagnostics.signatures)",
  );
  expect(updaterAcceptance).toContain('GITHUB_ACTIONS = "true"');
  expect(updaterAcceptance).toContain(
    "$openTask = $openClient.SendAsync($openRequest)",
  );
  expect(updaterAcceptance).not.toContain(
    '$opened = Invoke-RestMethod "$($oldRecord.Origin)/ui/api/profiles/$encodedProfileId/open"',
  );
  expect(updaterAcceptance).toContain(
    "$observations.browserRootSeenDuringOpen = $true",
  );
  expect(updaterAcceptance).toContain(
    "$observations.gpuProcessSeenDuringOpen = $true",
  );
  expect(updaterAcceptance).toContain(
    "$observations.gpuSandboxExceptionSeenDuringOpen = $true",
  );
  expect(updaterAcceptance).toContain(
    "$observations.gpuSandboxExceptionUsed = $true",
  );
  expect(cliSource).toContain("windowsUpdaterAcceptanceBrowserArgs");
  expect(cliSource).toContain("ALIASMODE_ACCEPTANCE_BROWSER_LOG");
  expect(cliSource).toContain('"--enable-logging"');
  expect(cliSource).toContain("`--log-file=${logPath}`");
  expect(updaterAcceptance).toContain("$acceptanceDebugPort");
  expect(updaterAcceptance).toContain('ALIASMODE_SESSION_LAUNCH = "0"');
  expect(updaterAcceptance).toContain("[void]$process.Handle");
  expect(updaterAcceptance).not.toContain("TokenLinkedToken");
  expect(updaterAcceptance).not.toContain("DuplicateTokenEx");
  expect(updaterAcceptance).not.toContain("CreateProcessAsUser");
  expect(updaterAcceptance).not.toContain("SaferComputeTokenFromLevel");
  expect(releaseWorkflow).not.toContain('Join-Path $artifact "latest.json"');
  expect(releaseWorkflow).toContain("$updaterHeader[0] -ne 0x4d");
  expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
  expect(tauriConfig.plugins.updater.pubkey.length).toBeGreaterThan(100);
  expect(cargoToml).toContain('tauri-plugin-updater = { version = "=2.10.1"');
  expect(cargoToml).toContain('tauri-plugin-updater = { path = "../vendor/tauri-plugin-updater" }');
  expect(updaterSource).toContain("if result as isize <= 32");
  expect(updaterSource).toContain("Error::Io(std::io::Error::last_os_error())");
  expect(existsSync(join(root, "src-tauri", "tauri.unsigned.conf.json"))).toBe(false);
});

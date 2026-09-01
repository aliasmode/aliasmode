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
    bundle: {
      createUpdaterArtifacts: boolean | string;
      windows: {
        webviewInstallMode: { type: string };
        nsis: { compression: string; installMode: string };
      };
    };
    plugins: { updater: { pubkey: string; windows: { installMode: string } } };
  };
  const updaterConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.updater.conf.json"), "utf8")) as {
    bundle: { createUpdaterArtifacts: boolean; windows: { webviewInstallMode: { type: string } } };
  };
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const browserInstallSource = readFileSync(join(root, "browser-install.ts"), "utf8");
  const releasesSource = readFileSync(join(root, "src-tauri", "src", "releases.rs"), "utf8");
  const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "release-candidate.yml"), "utf8")
    .replaceAll("\r\n", "\n");
  const ciWorkflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const compatibilityWorkflow = readFileSync(
    join(root, ".github", "workflows", "client-compatibility.yml"),
    "utf8",
  );
  const installedAcceptance = readFileSync(join(root, "scripts", "windows-installed-acceptance.ps1"), "utf8");
  const previousUpgradeAcceptance = readFileSync(
    join(root, "scripts", "windows-previous-upgrade-acceptance.ps1"),
    "utf8",
  );
  const updaterAcceptance = readFileSync(join(root, "scripts", "windows-in-app-update-acceptance.ps1"), "utf8")
    .replaceAll("\r\n", "\n");
  const updaterUiProbe = readFileSync(join(root, "scripts", "windows-updater-ui-probe.mjs"), "utf8");
  const updaterSource = readFileSync(join(root, "vendor", "tauri-plugin-updater", "src", "updater.rs"), "utf8");
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
  const lockedVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "aliasmode-desktop"\r?\nversion = "([^"]+)"/)?.[1];
  const windowsGateNeeds = ciWorkflow.match(
    /\n  windows:\n    name: Windows NSIS installer\n    needs:\n((?:      - [a-z_]+\n)+)/,
  )?.[1]?.trim().split("\n").map((line) => line.trim().slice(2));
  const syntheticUnsignedStep = releaseWorkflow.slice(
    releaseWorkflow.indexOf("- name: Build unsigned synthetic successor"),
    releaseWorkflow.indexOf("- name: Sign and verify synthetic successor"),
  );
  const exactUpdaterJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  exact_updater_acceptance:"),
    releaseWorkflow.indexOf("\n  publish_release:"),
  );

  expect(ALIASMODE_VERSION).toBe("0.1.0-beta.47");
  expect(packageJson.version).toBe(ALIASMODE_VERSION);
  expect(packageJson.scripts["desktop:build:nsis"]).toBe("bun run desktop:prepare && tauri build --bundles nsis --no-sign");
  expect(tauriConfig.version).toBe(ALIASMODE_VERSION);
  expect(cargoVersion).toBe(ALIASMODE_VERSION);
  expect(lockedVersion).toBe(ALIASMODE_VERSION);
  expect(tauriConfig.bundle.windows.webviewInstallMode.type).toBe("offlineInstaller");
  expect(tauriConfig.bundle.windows.nsis.compression).toBe("zlib");
  expect(tauriConfig.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
  expect(updaterConfig.bundle.createUpdaterArtifacts).toBe(true);
  expect(updaterConfig.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
  expect(browserInstallSource).toContain('CLOAKBROWSER_VERSION = "146.0.7680.177.5"');
  expect(browserInstallSource).toContain('env.CLOAKBROWSER_AUTO_UPDATE = "false"');
  expect(ciWorkflow).toContain("cloakbrowser-version=146.0.7680.177.5");
  expect(ciWorkflow).toContain(
    "cloakbrowser-archive-sha256=b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe",
  );
  expect(ciWorkflow).toContain(
    "cloakbrowser-executable-sha256=03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80",
  );
  expect(releasesSource).toContain('const UPDATE_MANIFEST: &str = "latest-v2.json";');
  expect(releasesSource).toContain(".on_before_exit(move || {");
  expect(releasesSource).toContain("let _ = sidecar.kill_owned();");
  expect(releasesSource).toContain("app_handle.cleanup_before_exit();");
  expect(releaseWorkflow).toContain('$latestPath = Join-Path $artifact "latest-v2.json"');
  expect(releaseWorkflow).toContain("build-windows-installer.ps1 -Flavor slim");
  expect(releaseWorkflow).toContain("& $baselineBun scripts/prepare-windows-bundle.ts");
  expect(releaseWorkflow).toContain("23f2df1f40d963e5b6104e1a565df992aab8968da5004f460617073843b8b8be");
  expect(releaseWorkflow).toContain("sign_current:\n    name: Sign current release assets\n    needs: provenance");
  expect(releaseWorkflow).toContain("synthetic_successor:\n    name: Build protected synthetic successor\n    needs: provenance");
  expect(releaseWorkflow).toContain("previous_upgrade_acceptance:\n    name: Previous-version upgrade acceptance\n    needs: [provenance, sign_current]");
  expect(releaseWorkflow).toContain("exact_updater_acceptance:\n    name: Exact in-app updater acceptance\n    needs: [provenance, sign_current, synthetic_successor]");
  expect(releaseWorkflow).toContain(
    "publish_release:\n    name: Publish verified prerelease\n    needs: [provenance, sign_current, previous_upgrade_acceptance, exact_updater_acceptance]",
  );
  expect(releaseWorkflow.match(/contents: write/g)).toHaveLength(1);
  expect(releaseWorkflow).toContain("name: aliasmode-signed-current");
  expect(releaseWorkflow).toContain("name: aliasmode-synthetic-successor");
  expect(syntheticUnsignedStep).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  expect(exactUpdaterJob).toContain("bun install --frozen-lockfile");
  expect(releaseWorkflow.match(/Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY\b/g)).toHaveLength(2);
  expect(releaseWorkflow).toContain("aliasmode-windows-in-app-update-diagnostics-${{ github.run_attempt }}");
  expect(releaseWorkflow).toContain("aliasmode-windows-previous-upgrade-diagnostics-${{ github.run_attempt }}");
  expect(releaseWorkflow).toContain('if [[ "$asset_state" == starter ]]');
  expect(releaseWorkflow).toContain('if [[ "$already_published" == true ]]');
  expect(releaseWorkflow).toContain("release producer must contain exactly six regular assets");
  expect(releaseWorkflow).toContain("draft release does not contain the exact six assets");
  expect(releaseWorkflow).toContain(
    "- name: Test candidate through the exact updater protocol\n        timeout-minutes: 35",
  );
  expect(releaseWorkflow).not.toContain("bun run desktop:prepare");
  expect(releaseWorkflow).not.toContain("nsis-updater");
  expect(ciWorkflow).toContain("Build full offline installer");
  expect(ciWorkflow).toContain("--config src-tauri/tauri.updater.conf.json");
  expect(ciWorkflow).toContain("name: Ubuntu tests and checks");
  expect(ciWorkflow).toContain("name: Windows NSIS installer");
  expect(windowsGateNeeds).toEqual([
    "windows_cache",
    "windows_prepare",
    "windows_full",
    "windows_slim",
    "windows_source",
    "windows_candidate",
    "windows_accept_runtime",
    "windows_accept_browser",
    "windows_accept_cloud",
  ]);
  expect(ciWorkflow).toContain("name: aliasmode-windows-candidate");
  expect(ciWorkflow).toContain('"--role", "candidate"');
  expect(ciWorkflow).toContain("windows_cache_save:");
  expect(ciWorkflow).toContain("name: Save accepted Windows candidate cache");
  expect(ciWorkflow).toContain("scripts\\windows-installed-acceptance.ps1");
  expect(ciWorkflow).toContain("- windows_accept_runtime");
  expect(ciWorkflow).toContain("- windows_accept_browser");
  expect(ciWorkflow).toContain("- windows_accept_cloud");
  expect(ciWorkflow).not.toContain("aliasmode-windows-unsigned");
  expect(ciWorkflow).not.toContain("macos-latest");
  expect(ciWorkflow).not.toContain("nsis-updater");
  expect(compatibilityWorkflow).toContain("name: aliasmode-windows-candidate");
  expect(compatibilityWorkflow).toContain('role -cne "candidate"');
  expect(compatibilityWorkflow).toContain('event -cne "push"');
  expect(compatibilityWorkflow).toContain("scripts/windows-artifact-manifest.ts verify");
  expect(compatibilityWorkflow).not.toContain("aliasmode-windows-unsigned");
  expect(installedAcceptance).toContain(`[ValidateSet("runtime", "browser", "cloud")]`);
  for (const shard of ["runtime", "browser", "cloud"]) {
    expect(ciWorkflow).toContain(`-Shard ${shard}`);
  }
  expect(previousUpgradeAcceptance).toContain('Set-AcceptanceStage "applying-passive-update"');
  expect(previousUpgradeAcceptance).toContain('@("/P", "/R", "/UPDATE", "/ARGS")');
  expect(updaterAcceptance).toContain("function Start-RunnerUserProcess");
  expect(updaterAcceptance).toContain("Start-Process @start");
  expect(updaterAcceptance).toContain("$start.Environment = $Environment");
  expect(updaterAcceptance).toContain(
    "Start-RunnerUserProcess $appPath -Environment $sourceEnvironment",
  );
  expect(updaterAcceptance).toContain("Registry::HKEY_CURRENT_USER");
  expect(updaterAcceptance).toContain(
    '$opened = Invoke-RestMethod "$($oldRecord.Origin)/ui/api/profiles/$encodedProfileId/open"',
  );
  expect(updaterAcceptance.indexOf('SetEnvironmentVariable($name, $acceptanceEnvironment[$name], "Process")')).toBeLessThan(
    updaterAcceptance.indexOf("$observations.publicDesktopReady = $true"),
  );
  expect(updaterAcceptance.indexOf('SetEnvironmentVariable($name, $candidateEnvironment[$name], "User")')).toBeGreaterThan(
    updaterAcceptance.indexOf("$observations.publicDesktopReady = $true"),
  );
  expect(updaterAcceptance).toContain(
    '$userEnvironmentNames = @(\n  "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG",\n  "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT"\n)',
  );
  expect(updaterAcceptance).toContain('ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT = "0"');
  expect(updaterAcceptance).toContain("Get-WebViewDebugPort $WebViewRoot $ExpectedDebugPort");
  expect(updaterAcceptance).toContain("$candidateDebugPortProbe.Server.ExclusiveAddressUse = $true");
  expect(updaterAcceptance).toContain('[void]$browserProcess.Handle');
  expect(updaterAcceptance).toContain("$deadline = [TimeSpan]::FromMinutes(5)");
  expect(updaterAcceptance).toContain("sourceDebugArgumentSeen");
  expect(updaterAcceptance).toContain("$savedUserEnvironment[$name]");
  expect(updaterAcceptance).toContain(
    'SetEnvironmentVariable($name, $savedUserEnvironment[$name], "User")',
  );
  expect(updaterUiProbe).toContain("document.visibilityState");
  expect(updaterUiProbe).toContain('visibility.state !== "visible"');
  expect(updaterAcceptance).not.toContain("CreateProcessAsUser");
  expect(updaterAcceptance).not.toContain("CreateProcessWithLogonW");
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

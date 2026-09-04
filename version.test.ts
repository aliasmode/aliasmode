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
        nsis: { compression: string; installMode: string; installerIcon: string };
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
  const ciSuccessorJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  windows_synthetic_successor:"),
    ciWorkflow.indexOf("\n  windows_prepare:"),
  );
  const ciSuccessorVersionFiles = ciSuccessorJob.slice(
    ciSuccessorJob.indexOf("            $versionFiles = @("),
    ciSuccessorJob.indexOf("            foreach ($path in $versionFiles)"),
  );
  const provenanceJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  provenance:"),
    releaseWorkflow.indexOf("\n  sign_current:"),
  );
  const signCurrentJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  sign_current:"),
    releaseWorkflow.indexOf("\n  sign_successor:"),
  );
  const signSuccessorJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  sign_successor:"),
    releaseWorkflow.indexOf("\n  previous_upgrade_acceptance:"),
  );
  const signSuccessorInputStep = signSuccessorJob.slice(
    signSuccessorJob.indexOf("      - name: Verify unsigned synthetic successor source"),
    signSuccessorJob.indexOf("      - name: Sign and verify synthetic successor"),
  );
  const previousUpgradeJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  previous_upgrade_acceptance:"),
    releaseWorkflow.indexOf("\n  exact_updater_acceptance:"),
  );
  const exactUpdaterJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  exact_updater_acceptance:"),
    releaseWorkflow.indexOf("\n  publish_release:"),
  );
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  publish_release:"));
  const publishAssetList = publishJob.slice(
    publishJob.indexOf("          required=("),
    publishJob.indexOf("          mapfile -t expected_names"),
  );
  const windowsCacheSaveJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  windows_cache_save:"),
    ciWorkflow.indexOf("\n  windows:"),
  );
  const windowsPrepareJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  windows_prepare:"),
    ciWorkflow.indexOf("\n  windows_full:"),
  );
  const windowsFullJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  windows_full:"),
    ciWorkflow.indexOf("\n  windows_slim:"),
  );
  const windowsSourceJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  windows_source:"),
    ciWorkflow.indexOf("\n  windows_candidate:"),
  );
  const windowsRuntimeJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  windows_accept_runtime:"),
    ciWorkflow.indexOf("\n  windows_accept_browser:"),
  );
  const runtimeProtocolShard = installedAcceptance.slice(
    installedAcceptance.indexOf('    "runtime-protocol" {'),
    installedAcceptance.indexOf('    "runtime-ownership" {'),
  );
  const runtimeOwnershipShard = installedAcceptance.slice(
    installedAcceptance.indexOf('    "runtime-ownership" {'),
    installedAcceptance.indexOf('    "runtime-desktop" {'),
  );
  const runtimeDesktopShard = installedAcceptance.slice(
    installedAcceptance.indexOf('    "runtime-desktop" {'),
    installedAcceptance.indexOf('    "browser" {'),
  );
  const cacheStep = (job: string) => {
    const start = job.indexOf("      - name: Cache pinned CloakBrowser");
    return job.slice(start, job.indexOf("\n      - ", start + 1));
  };
  const baselineStep = (job: string, nextStep: string) => job.slice(
    job.indexOf("      - name: Prepare bundle with verified official baseline Bun"),
    job.indexOf(nextStep),
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
  expect(tauriConfig.bundle.windows.nsis.installerIcon).toBe("icons/icon.ico");
  expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
  expect(updaterConfig.bundle.createUpdaterArtifacts).toBe(true);
  expect(updaterConfig.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
  expect(browserInstallSource).toContain('CLOAKBROWSER_VERSION = "146.0.7680.177.5"');
  expect(browserInstallSource).toContain('env.CLOAKBROWSER_AUTO_UPDATE = "false"');
  expect(ciWorkflow).toContain("name: Cache pinned CloakBrowser");
  expect(ciWorkflow).toContain("path: src-tauri/target/cloakbrowser-cache");
  expect(releaseWorkflow).not.toContain("name: Cache pinned CloakBrowser");
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
  expect(signCurrentJob).toContain('$latestPath = Join-Path $artifact "latest-v2.json"');
  expect(releaseWorkflow).not.toContain("build-windows-installer.ps1");
  expect(releaseWorkflow).not.toContain("prepare-windows-bundle.ts");
  expect(releaseWorkflow).not.toContain("Build unsigned synthetic successor");
  expect(releaseWorkflow).not.toContain("src-tauri -> target");
  expect(ciSuccessorJob).toContain("needs: windows_cache");
  expect(ciSuccessorJob).not.toContain("cache_hit");
  expect(ciSuccessorJob).toContain("timeout-minutes: 35");
  expect(ciSuccessorJob).toContain("shared-key: windows_full");
  expect(ciSuccessorJob).toContain("workspaces: src-tauri -> target");
  expect(ciSuccessorJob).toContain("cache-on-failure: true");
  expect(ciSuccessorJob.indexOf("uses: Swatinem/rust-cache@v2")).toBeLessThan(
    ciSuccessorJob.indexOf("name: Cache pinned CloakBrowser"),
  );
  expect(cacheStep(ciSuccessorJob)).toBe(cacheStep(windowsFullJob));
  expect(ciSuccessorVersionFiles).toBe([
    "            $versionFiles = @(",
    '              ".\\package.json",',
    '              ".\\version.ts",',
    '              ".\\src-tauri\\tauri.conf.json",',
    '              ".\\src-tauri\\Cargo.toml",',
    '              ".\\src-tauri\\Cargo.lock"',
    "            )",
    "",
  ].join("\n"));
  expect(ciSuccessorJob).toContain('"$($env:WINDOWS_VERSION).acceptance.1"');
  expect(ciSuccessorJob).toContain('$($sourceSemantic.Patch + 1)-acceptance.1');
  expect(ciSuccessorJob).toContain(
    '23f2df1f40d963e5b6104e1a565df992aab8968da5004f460617073843b8b8be',
  );
  expect(ciSuccessorJob).toContain('$baselineVersion -cne "1.2.21"');
  expect(ciSuccessorJob).toContain("& $baselineBun scripts/prepare-windows-bundle.ts");
  expect(ciSuccessorJob).toContain("build-windows-installer.ps1 -Flavor slim");
  expect(ciSuccessorJob).toContain('"--role", "unsigned-synthetic-successor"');
  expect(ciSuccessorJob).toContain('"--source", $env:WINDOWS_SOURCE');
  expect(ciSuccessorJob).toContain('"--version", $successorVersion');
  expect(ciSuccessorJob).toContain('"--product-key", $env:WINDOWS_PRODUCT_KEY');
  expect(ciSuccessorJob).toContain('$requiredNames = @($name, "artifact-manifest.json")');
  expect(ciSuccessorJob).toContain("$entries.Count -ne 2");
  expect(ciSuccessorJob).toContain("$stream.ReadByte() -ne 0x4d");
  expect(ciSuccessorJob).toContain('Status -cne "NotSigned"');
  expect(ciSuccessorJob).toContain("& git checkout -- .");
  expect(ciSuccessorJob).toContain("git rev-parse HEAD");
  expect(ciSuccessorJob).toContain("git status --porcelain --untracked-files=all");
  expect(ciSuccessorJob).toContain("name: aliasmode-windows-unsigned-synthetic-successor");
  expect(ciSuccessorJob).toContain("retention-days: 7");
  expect(ciSuccessorJob).toContain("compression-level: 0");
  expect(ciSuccessorJob).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  expect(ciSuccessorJob).not.toContain("secrets.");
  expect(ciSuccessorJob).not.toContain("tauri signer sign");

  expect(provenanceJob).toContain("successor_version: ${{ steps.successor.outputs.version }}");
  expect(provenanceJob).toContain("name: aliasmode-windows-unsigned-synthetic-successor");
  expect(provenanceJob).toContain("run-id: ${{ inputs.run_id }}");
  expect(provenanceJob).toContain('"$($env:WINDOWS_VERSION).acceptance.1"');
  expect(provenanceJob).toContain('$($sourceSemantic.Patch + 1)-acceptance.1');
  expect(provenanceJob).toContain('$name = "AliasMode_${successorVersion}_x64-setup.exe"');
  expect(provenanceJob).toContain('$requiredNames = @($name, "artifact-manifest.json")');
  expect(provenanceJob).toContain("$entries.Count -ne 2");
  expect(provenanceJob).toContain('$manifest.role -cne "unsigned-synthetic-successor"');
  expect(provenanceJob).toContain("$manifest.source -cne $env:WINDOWS_SOURCE");
  expect(provenanceJob).toContain("$manifest.version -cne $successorVersion");
  expect(provenanceJob).toContain("$manifest.productKey -cne $env:WINDOWS_PRODUCT_KEY");
  expect(provenanceJob).toContain("$fileIdentity[0].sha256 -cne $actualHash");
  expect(provenanceJob).toContain("$fileIdentity[0].bytes -ne $actualSize");
  expect(provenanceJob).toContain("windows-artifact-manifest.ts verify");
  expect(provenanceJob).toContain("$stream.ReadByte() -ne 0x4d");
  expect(provenanceJob).toContain('Status -cne "NotSigned"');
  expect(provenanceJob).toContain('"version=$successorVersion" | Add-Content $env:GITHUB_OUTPUT');

  expect(releaseWorkflow).toContain("sign_current:\n    name: Sign current release assets\n    needs: provenance");
  expect(releaseWorkflow).toContain("sign_successor:\n    name: Sign synthetic successor\n    needs: provenance");
  expect(signSuccessorJob).toContain("environment: windows-release");
  expect(signSuccessorJob).toContain("name: aliasmode-windows-unsigned-synthetic-successor");
  expect(signSuccessorJob).toContain("run-id: ${{ inputs.run_id }}");
  expect(signSuccessorInputStep).toContain("--role unsigned-synthetic-successor");
  expect(signSuccessorInputStep).toContain("$entries.Count -ne 2");
  expect(signSuccessorInputStep).toContain("$fileIdentity[0].sha256 -cne $actualHash");
  expect(signSuccessorInputStep).toContain("windows-artifact-manifest.ts verify");
  expect(signSuccessorInputStep).toContain("$stream.ReadByte() -ne 0x4d");
  expect(signSuccessorInputStep).toContain('Status -cne "NotSigned"');
  expect(signSuccessorInputStep).toContain("Copy-Item $installer $signedInstaller");
  expect(signSuccessorInputStep).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  expect(signSuccessorJob).not.toContain("Cache pinned CloakBrowser");
  expect(signSuccessorJob).not.toContain("prepare-windows-bundle.ts");
  expect(signSuccessorJob).not.toContain("build-windows-installer.ps1");
  expect(signSuccessorJob).not.toContain("src-tauri -> target");
  expect(signSuccessorJob).not.toContain("$versionFiles");
  expect(releaseWorkflow).toContain(
    "previous_upgrade_acceptance:\n    name: Previous-version upgrade acceptance\n    needs: provenance",
  );
  expect(previousUpgradeJob).toContain("name: aliasmode-release-provenance");
  expect(previousUpgradeJob).toContain('"--role", "candidate"');
  expect(previousUpgradeJob).toContain('-FullInstallerPath ".\\candidate\\AliasMode_');
  expect(previousUpgradeJob).not.toContain("sign_current");
  expect(previousUpgradeJob).not.toContain("aliasmode-signed-current");
  expect(releaseWorkflow).toContain(
    "exact_updater_acceptance:\n    name: Exact in-app updater acceptance\n    needs: [provenance, sign_successor]",
  );
  expect(exactUpdaterJob).toContain("bun install --frozen-lockfile");
  expect(exactUpdaterJob).toContain("name: aliasmode-release-provenance");
  expect(exactUpdaterJob).toContain("name: aliasmode-synthetic-successor");
  expect(exactUpdaterJob).toContain('-SourceInstallerPath ".\\candidate\\AliasMode_');
  expect(exactUpdaterJob).not.toContain("dtolnay/rust-toolchain");
  expect(exactUpdaterJob).not.toContain("Swatinem/rust-cache");
  expect(exactUpdaterJob).not.toContain("cargo run");
  expect(exactUpdaterJob).not.toContain("aliasmode-signed-current");
  expect(releaseWorkflow).toContain(
    "publish_release:\n    name: Publish verified prerelease\n    needs: [provenance, sign_current, previous_upgrade_acceptance, exact_updater_acceptance]",
  );
  expect(releaseWorkflow.match(/contents: write/g)).toHaveLength(1);
  expect(publishJob).toContain("contents: write");
  expect(publishAssetList).toBe([
    "          required=(",
    '            "$full_name"',
    '            "$slim_name"',
    '            "$slim_name.sig"',
    '            "latest-v2.json"',
    '            "aliasmode-agent-bootstrap.json"',
    '            "SHA256SUMS.txt"',
    "          )",
    "",
  ].join("\n"));
  expect(releaseWorkflow).toContain("name: aliasmode-signed-current");
  expect(releaseWorkflow).toContain("name: aliasmode-synthetic-successor");
  expect(releaseWorkflow.match(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/g)).toHaveLength(2);
  expect(releaseWorkflow.match(/Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY\b/g)).toHaveLength(2);
  expect(releaseWorkflow.match(/bunx tauri signer sign/g)).toHaveLength(2);
  expect(ciWorkflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  for (const signer of [signCurrentJob, signSuccessorJob]) {
    expect(signer.match(/cargo run --quiet --locked --manifest-path "\.\\scripts\\updater-signature-check\\Cargo\.toml"/g)).toHaveLength(2);
    expect(signer).toContain("if ($LASTEXITCODE -ne 0)");
    expect(signer).toContain("$bytes[$middle] = $bytes[$middle] -bxor 1");
    expect(signer).toContain("if ($LASTEXITCODE -eq 0)");
  }
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
  expect(ciWorkflow).toContain("node-version: 22.23.2");
  expect(windowsFullJob).toContain("\n    needs: windows_cache\n");
  expect(windowsFullJob).not.toContain("windows_prepare");
  expect(cacheStep(windowsFullJob)).toBe(cacheStep(windowsPrepareJob));
  expect(windowsFullJob.indexOf("uses: Swatinem/rust-cache@v2")).toBeLessThan(
    windowsFullJob.indexOf("name: Cache pinned CloakBrowser"),
  );
  expect(cacheStep(windowsFullJob)).toContain(
    "key: cloakbrowser-windows-x64-v1-146.0.7680.177.5-b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe-03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80",
  );
  const fullBaselineStep = baselineStep(
    windowsFullJob,
    "      - name: Build full offline installer",
  );
  expect(fullBaselineStep).toBe(
    baselineStep(windowsPrepareJob, "      - name: Archive prepared bundle inputs"),
  );
  expect(fullBaselineStep).toContain(
    '$pinnedSha = "23f2df1f40d963e5b6104e1a565df992aab8968da5004f460617073843b8b8be"',
  );
  expect(fullBaselineStep).toContain('$baselineVersion -ne "1.2.21"');
  expect(fullBaselineStep).toContain("& $baselineBun scripts/prepare-windows-bundle.ts");
  expect(windowsFullJob).not.toContain("actions/download-artifact");
  expect(windowsFullJob).not.toContain("aliasmode-windows-prepared");
  expect(windowsFullJob).not.toContain("prepared-input manifest");
  expect(windowsFullJob).not.toContain("tar.exe -xf");
  expect(windowsPrepareJob).not.toContain("if: needs.windows_cache.outputs.cache_hit == 'false'");
  expect(windowsSourceJob).toContain(
    "name: Windows source tests and checks\n    needs: [windows_cache, windows_prepare]\n    runs-on: windows-latest",
  );
  expect(windowsSourceJob).not.toContain("if: needs.windows_cache.outputs.cache_hit == 'false'");
  expect(windowsSourceJob).toContain("name: aliasmode-windows-prepared");
  expect(windowsSourceJob).toContain("Smoke-test compiled sidecar CDP runtime");
  expect(windowsRuntimeJob).toContain("name: Windows installed ${{ matrix.shard }} acceptance");
  expect(windowsRuntimeJob).toContain("fail-fast: false");
  expect(windowsRuntimeJob).toContain(
    "shard: [runtime-protocol, runtime-ownership, runtime-desktop]",
  );
  expect(windowsRuntimeJob).toContain("-Shard ${{ matrix.shard }}");
  expect(windowsRuntimeJob).toContain('DiagnosticsPath ".\\diagnostics\\${{ matrix.shard }}.json"');
  expect(windowsRuntimeJob).toContain(
    "name: aliasmode-windows-${{ matrix.shard }}-diagnostics-${{ github.run_attempt }}",
  );
  expect(windowsGateNeeds).toEqual([
    "windows_cache",
    "windows_synthetic_successor",
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
  expect(windowsCacheSaveJob).not.toContain("windows_synthetic_successor");
  expect(ciWorkflow).toContain("SUCCESSOR_RESULT: ${{ needs.windows_synthetic_successor.result }}");
  expect(ciWorkflow).toContain('require_result windows_synthetic_successor "$SUCCESSOR_RESULT" success');
  expect(ciWorkflow.match(/require_result windows_prepare "\$PREPARE_RESULT" success/g)).toHaveLength(1);
  expect(ciWorkflow).not.toContain('require_result windows_prepare "$PREPARE_RESULT" skipped');
  expect(ciWorkflow).toContain("scripts\\windows-installed-acceptance.ps1");
  expect(ciWorkflow).toContain("- windows_accept_runtime");
  expect(ciWorkflow).toContain("- windows_accept_browser");
  expect(ciWorkflow).toContain("- windows_accept_cloud");
  expect(ciWorkflow).toContain("name: aliasmode-windows-unsigned-synthetic-successor");
  expect(ciWorkflow).not.toContain("macos-latest");
  expect(ciWorkflow).not.toContain("nsis-updater");
  expect(compatibilityWorkflow).toContain("name: aliasmode-windows-candidate");
  expect(compatibilityWorkflow).toContain('role -cne "candidate"');
  expect(compatibilityWorkflow).toContain('event -cne "push"');
  expect(compatibilityWorkflow).toContain("scripts/windows-artifact-manifest.ts verify");
  expect(compatibilityWorkflow).not.toContain("aliasmode-windows-unsigned");
  expect(ciWorkflow).not.toContain("-cjoin");
  expect(releaseWorkflow).not.toContain("-cjoin");
  expect(compatibilityWorkflow).not.toContain("-cjoin");
  expect(installedAcceptance).toContain(
    `[ValidateSet("runtime-protocol", "runtime-ownership", "runtime-desktop", "browser", "cloud")]`,
  );
  for (const shard of ["runtime-protocol", "runtime-ownership", "runtime-desktop"]) {
    expect(installedAcceptance).toContain(`    "${shard}" {`);
  }
  for (const shard of ["browser", "cloud"]) {
    expect(ciWorkflow).toContain(`-Shard ${shard}`);
  }
  for (const contract of [
    "runtime-protocol-resource-independence",
    "installed sidecar embeds its source checkout path",
    "installed Node runtime version is incorrect",
    "installed generic MCP setup returned incorrect paths",
    "installed MCP host did not expose $name",
    "installed MCP tool $($tool.name) has no $hint annotation",
    "Read-ValidRuntimeDescriptor $descriptorPath $bundleVersion",
    "MCP host did not launch AliasMode in background mode",
    "background AliasMode exposed its main window",
    "installed MCP tool schemas changed after browser selection",
    "installed MCP tool schemas changed after browser close",
    "installed helper could not reopen the pre-existing browser",
    "installed helper could not close the preserved browser",
    "Remove-PersistentProfile $helper $preexistingProfileId",
  ]) {
    expect(runtimeProtocolShard).toContain(contract);
  }
  for (const contract of [
    "runtime-ownership-preexisting",
    "New-OpenPersistentProfile $helper",
    "Select-McpBrowser $mcp $preexistingProfileId",
    'name = "aliasmode_profile_create"',
    'name = "aliasmode_browser_open"',
    "Disconnect-McpHost $mcp",
    "background desktop did not survive MCP disconnect",
    "runtime descriptor did not survive MCP disconnect",
    "MCP-owned browser survived its connection",
    "pre-existing browser did not survive MCP disconnect",
    "Remove-PersistentProfile $helper $ownedProfileId",
  ]) {
    expect(runtimeOwnershipShard).toContain(contract);
  }
  expect(runtimeOwnershipShard).not.toContain("browser close --profile $preexistingProfileId");
  expect(runtimeOwnershipShard).not.toContain("Remove-PersistentProfile $helper $preexistingProfileId");
  for (const contract of [
    "runtime-desktop-json-cli",
    "installed JSON CLI could not create a temporary profile",
    "installed JSON CLI could not open a headless browser",
    "installed JSON CLI did not report its browser as running",
    "installed JSON CLI did not close and delete its temporary profile",
    "runtime-desktop-descriptor",
    "runtime-desktop-single-instance-window",
    "runtime-desktop-eof-termination",
    "packaged sidecar survived parent stdin EOF",
    "runtime-desktop-degraded-termination",
    "runtime descriptor survived unexpected sidecar termination",
    "runtime-desktop-playwright-worker",
    "installed Playwright worker returned an unexpected protocol response",
  ]) {
    expect(runtimeDesktopShard).toContain(contract);
  }
  for (const contract of [
    "installed MCP host returned an invalid initialize response",
    "background runtime descriptor is invalid",
    "installed helper could not delete a lifecycle profile",
    "WaitForExit(60000)",
  ]) {
    expect(installedAcceptance).toContain(contract);
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

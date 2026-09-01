#Requires -Version 7.0

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$CandidateVersion,

  [Parameter(Mandatory)]
  [string]$FullInstallerPath,

  [Parameter(Mandatory)]
  [string]$ChecksumsPath,

  [Parameter(Mandatory)]
  [string]$Repository,

  [Parameter(Mandatory)]
  [string]$GitHubToken,

  [Parameter(Mandatory)]
  [string]$DiagnosticsPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-InputFile([string]$Path, [string]$Description) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description is missing"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Set-AcceptanceStage([string]$NextStage) {
  $script:stage = $NextStage
  Write-Host "AliasMode previous-version upgrade acceptance stage: $NextStage"
}

function Test-ProcessExited([Diagnostics.Process]$Process) {
  if (-not $Process) { return $true }
  try {
    $Process.Refresh()
    return $Process.HasExited
  } catch {
    return $true
  }
}

function Stop-ProcessTree([Diagnostics.Process]$Process) {
  if (-not $Process -or (Test-ProcessExited $Process)) { return }
  $Process.Kill($true)
  if (-not $Process.WaitForExit(15000)) {
    throw "upgrade acceptance process tree did not exit"
  }
}

function Test-PathWithin([string]$Path, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $fullPath.StartsWith("$fullRoot\", [StringComparison]::OrdinalIgnoreCase)
}

function Wait-AliasModeReady([string]$AppPath, [string]$ExpectedVersion) {
  $app = Get-Process -Name "AliasMode" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $AppPath } |
    Select-Object -First 1
  if (-not $app) { $app = Start-Process -PassThru $AppPath }
  for ($attempt = 0; $attempt -lt 180; $attempt++) {
    $app.Refresh()
    if ($app.HasExited) { throw "AliasMode exited before readiness" }
    $sidecar = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)" |
      Where-Object { $_.Name -like "aliasmode-sidecar*.exe" } |
      Select-Object -First 1
    if ($sidecar) {
      $ports = Get-NetTCPConnection -State Listen -OwningProcess $sidecar.ProcessId -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty LocalPort -Unique
      foreach ($port in $ports) {
        try {
          $origin = "http://127.0.0.1:$port"
          $health = Invoke-RestMethod "$origin/ui/api/health" -TimeoutSec 1
          if ($health.ok -eq $true -and $health.version -eq $ExpectedVersion) {
            return [pscustomobject]@{
              App = $app
              SidecarPid = [int]$sidecar.ProcessId
              Origin = $origin
              Health = $health
            }
          }
        } catch {}
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "AliasMode $ExpectedVersion did not become ready"
}

function Stop-AliasMode($Record) {
  if (-not $Record.App.CloseMainWindow()) { throw "AliasMode rejected its close request" }
  if (-not $Record.App.WaitForExit(180000)) { throw "AliasMode did not exit after cleanup" }
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Get-Process -Id $Record.SidecarPid -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "AliasMode sidecar survived shutdown"
}

function Stop-UpgradeProcesses([string]$InstallRoot, [string]$RunRoot, [string[]]$DataRoots) {
  foreach ($record in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $belongsToAcceptance = $record.ExecutablePath -and (Test-PathWithin ([string]$record.ExecutablePath) $InstallRoot)
    if (-not $belongsToAcceptance -and $record.CommandLine) {
      $belongsToAcceptance = $record.CommandLine.Contains($RunRoot, [StringComparison]::OrdinalIgnoreCase)
      if (-not $belongsToAcceptance) {
        foreach ($dataRoot in $DataRoots) {
          if (-not [string]::IsNullOrWhiteSpace($dataRoot) -and
              $record.CommandLine.Contains($dataRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $belongsToAcceptance = $true
            break
          }
        }
      }
    }
    if (-not $belongsToAcceptance) { continue }
    $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
    if ($process) { Stop-ProcessTree $process }
  }
}

function Remove-AcceptancePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try { [IO.Directory]::Delete($Path, $true) } catch {}
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "upgrade acceptance state survived cleanup: $(Split-Path $Path -Leaf)"
}

function Write-AcceptanceDiagnostics(
  [string]$Path,
  [string]$RecordedStage,
  [bool]$Success,
  [string]$Candidate,
  [string]$Previous,
  $Checks,
  [int]$CleanupFailureCount
) {
  $parent = Split-Path $Path -Parent
  if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
  $diagnostics = [ordered]@{
    version = 1
    stage = $RecordedStage
    success = $Success
    candidateVersion = $Candidate
    previousVersion = $Previous
    checks = $Checks
    cleanupFailureCount = $CleanupFailureCount
  }
  [IO.File]::WriteAllText(
    $Path,
    ($diagnostics | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false)
  )
}

$DiagnosticsPath = [IO.Path]::GetFullPath($DiagnosticsPath)
$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  [IO.Path]::GetTempPath()
} else {
  $env:RUNNER_TEMP
}
$runRoot = Join-Path $temporaryRoot "aliasmode-previous-upgrade-$([Guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $runRoot "aliasmode update acceptance"
$defaultDataRoot = Join-Path $env:APPDATA "com.aliasmode.desktop"
$registrationKeys = @(
  "Registry::HKEY_CURRENT_USER\Software\aliasmode\AliasMode",
  "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\AliasMode"
)
$stage = "validating-inputs"
$previousVersion = ""
$oldDataRoot = ""
$activeRecord = $null
$primaryFailure = $null
$acceptanceSucceeded = $false
$acceptanceStateOwned = $false
$cleanupFailures = [Collections.Generic.List[string]]::new()
$checks = [ordered]@{
  candidateInstallerVerified = $false
  previousReleaseSelected = $false
  previousInstallerVerified = $false
  previousVersionReady = $false
  sentinelProfileCreated = $false
  sentinelDataCreated = $false
  passiveUpdateCompleted = $false
  versionTransition = $false
  instanceTransition = $false
  appDataRootPreserved = $false
  sentinelDataPreserved = $false
  sentinelProfilePreserved = $false
}

try {
  if (-not $IsWindows) { throw "Windows previous-version upgrade acceptance requires Windows" }
  if ([string]::IsNullOrWhiteSpace($GitHubToken)) { throw "GitHub token is required" }
  if ([string]::IsNullOrWhiteSpace($Repository)) { throw "GitHub repository is required" }

  Set-AcceptanceStage "verifying-candidate-installer"
  $candidateSemantic = [Management.Automation.SemanticVersion]::Parse($CandidateVersion)
  if ($candidateSemantic.ToString() -ne $CandidateVersion) {
    throw "candidate version is not canonical"
  }
  $candidateInstaller = Resolve-InputFile $FullInstallerPath "candidate full installer"
  $candidateChecksums = Resolve-InputFile $ChecksumsPath "candidate checksum manifest"
  $candidateInstallerName = "AliasMode_${CandidateVersion}_x64-offline-setup.exe"
  if ((Split-Path $candidateInstaller -Leaf) -ne $candidateInstallerName) {
    throw "candidate full installer name does not match candidate version"
  }
  $candidateChecksumPattern = '^([a-fA-F0-9]{64})  ' + [regex]::Escape($candidateInstallerName) + '$'
  $candidateChecksumLines = @([IO.File]::ReadAllLines($candidateChecksums) | Where-Object { $_ -match $candidateChecksumPattern })
  if ($candidateChecksumLines.Count -ne 1) {
    throw "candidate full installer checksum is missing or ambiguous"
  }
  $candidateChecksumMatch = [regex]::Match($candidateChecksumLines[0], $candidateChecksumPattern)
  $expectedCandidateChecksum = $candidateChecksumMatch.Groups[1].Value.ToLowerInvariant()
  if ((Get-FileHash -LiteralPath $candidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedCandidateChecksum) {
    throw "candidate full installer checksum mismatch"
  }
  $checks.candidateInstallerVerified = $true

  Set-AcceptanceStage "selecting-previous-release"
  New-Item -ItemType Directory -Force $runRoot | Out-Null
  $headers = @{ Authorization = "Bearer $GitHubToken"; Accept = "application/vnd.github+json" }
  $releases = @(Invoke-RestMethod "https://api.github.com/repos/$Repository/releases?per_page=100" -Headers $headers | Write-Output)
  $previous = $releases |
    Where-Object { -not $_.draft -and $_.tag_name.StartsWith("v") } |
    ForEach-Object {
      try {
        $version = [Management.Automation.SemanticVersion]::Parse($_.tag_name.Substring(1))
        if ($version -lt $candidateSemantic) {
          [pscustomobject]@{ Release = $_; Version = $version }
        }
      } catch {}
    } |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if (-not $previous) { throw "no previous public release is available for upgrade acceptance" }
  $previousVersion = $previous.Version.ToString()
  $checks.previousReleaseSelected = $true

  Set-AcceptanceStage "verifying-previous-installer"
  $offlineInstallerName = "AliasMode_$($previous.Version)_x64-offline-setup.exe"
  $legacyInstallerName = "AliasMode_$($previous.Version)_x64-setup.exe"
  $oldInstallerAsset = @()
  foreach ($installerName in @($offlineInstallerName, $legacyInstallerName)) {
    $matches = @($previous.Release.assets | Where-Object { $_.name -eq $installerName })
    if ($matches.Count -gt 1) { throw "previous release installer asset is ambiguous: $installerName" }
    if ($matches.Count -eq 1) {
      $oldInstallerAsset = $matches
      break
    }
  }
  $oldChecksumAsset = @($previous.Release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" })
  if ($oldInstallerAsset.Count -ne 1 -or $oldChecksumAsset.Count -ne 1) {
    throw "previous release assets are incomplete"
  }
  $oldInstaller = Join-Path $runRoot $oldInstallerAsset[0].name
  $oldChecksums = Join-Path $runRoot "old-SHA256SUMS.txt"
  Invoke-WebRequest $oldInstallerAsset[0].browser_download_url -OutFile $oldInstaller
  Invoke-WebRequest $oldChecksumAsset[0].browser_download_url -OutFile $oldChecksums
  $checksumPattern = '^([a-fA-F0-9]{64})  ' + [regex]::Escape($oldInstallerAsset[0].name) + '$'
  $checksumLines = @([IO.File]::ReadAllLines($oldChecksums) | Where-Object { $_ -match $checksumPattern })
  if ($checksumLines.Count -ne 1) { throw "previous installer checksum is missing or ambiguous" }
  $checksumMatch = [regex]::Match($checksumLines[0], $checksumPattern)
  if (-not $checksumMatch.Success) { throw "previous installer checksum is malformed" }
  $expectedChecksum = $checksumMatch.Groups[1].Value.ToLowerInvariant()
  if ((Get-FileHash -LiteralPath $oldInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedChecksum) {
    throw "previous installer checksum mismatch"
  }
  $checks.previousInstallerVerified = $true

  Set-AcceptanceStage "installing-previous-version"
  if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $defaultDataRoot)) {
    throw "previous-version upgrade acceptance state was not clean"
  }
  if (@(Get-Process -Name "AliasMode" -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "runner has a pre-existing AliasMode process"
  }
  foreach ($key in $registrationKeys) {
    if (Test-Path -LiteralPath $key) {
      throw "runner has pre-existing AliasMode registration"
    }
  }
  $acceptanceStateOwned = $true
  $install = Start-Process -PassThru $oldInstaller -ArgumentList @("/S", "/D=$installRoot")
  if (-not $install.WaitForExit(300000)) {
    Stop-ProcessTree $install
    throw "previous installer timed out"
  }
  if ($install.ExitCode -ne 0) { throw "previous installer exited with code $($install.ExitCode)" }
  $appPath = Join-Path $installRoot "AliasMode.exe"
  $activeRecord = Wait-AliasModeReady $appPath $previousVersion
  $checks.previousVersionReady = $true
  $mode = Invoke-RestMethod "$($activeRecord.Origin)/ui/api/app-mode"
  if ($mode.mode -eq "unconfigured") {
    Invoke-RestMethod "$($activeRecord.Origin)/ui/api/app-mode" `
      -Method Post `
      -ContentType "application/json" `
      -Body '{"mode":"local"}' | Out-Null
    Stop-AliasMode $activeRecord
    $activeRecord = Wait-AliasModeReady $appPath $previousVersion
  }

  Set-AcceptanceStage "creating-preservation-sentinels"
  $profile = Invoke-RestMethod "$($activeRecord.Origin)/ui/api/profiles" `
    -Method Post `
    -ContentType "application/json" `
    -Body '{"name":"update-preservation-sentinel"}'
  if ($profile.ok -ne $true -or [string]::IsNullOrWhiteSpace([string]$profile.id)) {
    throw "could not create upgrade sentinel profile"
  }
  $checks.sentinelProfileCreated = $true
  $sentinel = Join-Path $activeRecord.Health.root "upgrade-sentinel.txt"
  "preserve-me" | Set-Content $sentinel
  $checks.sentinelDataCreated = $true
  $oldDataRoot = [string]$activeRecord.Health.root
  $oldInstance = [string]$activeRecord.Health.instance
  if ([string]::IsNullOrWhiteSpace($oldInstance)) {
    throw "previous version health response omitted its instance ID"
  }
  Stop-AliasMode $activeRecord
  $activeRecord = $null

  Set-AcceptanceStage "applying-passive-update"
  $updater = Start-Process -PassThru $candidateInstaller -ArgumentList @("/P", "/R", "/UPDATE", "/ARGS")
  if (-not $updater.WaitForExit(300000)) {
    Stop-ProcessTree $updater
    throw "candidate updater did not exit"
  }
  if ($updater.ExitCode -ne 0) { throw "candidate updater exited with code $($updater.ExitCode)" }
  $checks.passiveUpdateCompleted = $true

  Set-AcceptanceStage "verifying-preserved-state"
  $activeRecord = Wait-AliasModeReady $appPath $CandidateVersion
  $checks.versionTransition = $true
  if ($activeRecord.Health.root -ne $oldDataRoot) { throw "update changed the app-data root" }
  $checks.appDataRootPreserved = $true
  $updatedInstance = [string]$activeRecord.Health.instance
  if ([string]::IsNullOrWhiteSpace($updatedInstance) -or $updatedInstance -eq $oldInstance) {
    throw "updated app did not start a new instance"
  }
  $checks.instanceTransition = $true
  if ((Get-Content $sentinel -Raw).Trim() -ne "preserve-me") {
    throw "update changed app-data sentinel content"
  }
  $checks.sentinelDataPreserved = $true
  $roster = Invoke-RestMethod "$($activeRecord.Origin)/ui/api/profiles"
  if (-not ($roster.profiles | Where-Object { $_.id -eq $profile.id -and $_.name -eq "update-preservation-sentinel" })) {
    throw "update did not preserve the sentinel profile"
  }
  $checks.sentinelProfilePreserved = $true
  Stop-AliasMode $activeRecord
  $activeRecord = $null

  Set-AcceptanceStage "verified"
  $acceptanceSucceeded = $true
} catch {
  $primaryFailure = $_
} finally {
  $stageBeforeCleanup = $stage
  Set-AcceptanceStage "cleanup"

  if ($activeRecord -and -not (Test-ProcessExited $activeRecord.App)) {
    try { Stop-AliasMode $activeRecord } catch {
      try { Stop-ProcessTree $activeRecord.App } catch {}
      $cleanupFailures.Add("active AliasMode cleanup failed")
    }
  }
  $dataRoots = if ($acceptanceStateOwned) { @($oldDataRoot, $defaultDataRoot) } else { @() }
  try { Stop-UpgradeProcesses $installRoot $runRoot $dataRoots } catch {
    $cleanupFailures.Add("upgrade process cleanup failed")
  }

  $uninstaller = Join-Path $installRoot "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    try {
      $uninstall = Start-Process -PassThru $uninstaller -ArgumentList "/S"
      if (-not $uninstall.WaitForExit(120000)) {
        Stop-ProcessTree $uninstall
        throw "uninstaller timed out"
      }
      if ($uninstall.ExitCode -ne 0) { throw "uninstaller exited nonzero" }
    } catch {
      $cleanupFailures.Add("installed app cleanup failed")
    }
  }
  try { Stop-UpgradeProcesses $installRoot $runRoot $dataRoots } catch {
    $cleanupFailures.Add("final upgrade process cleanup failed")
  }
  if ($acceptanceStateOwned) {
    foreach ($key in $registrationKeys) {
      try {
        if (Test-Path -LiteralPath $key) {
          Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $key) { throw "installer registration survived cleanup" }
      } catch {
        $cleanupFailures.Add("installer registration cleanup failed")
      }
    }
  }
  $cleanupPaths = @($installRoot, $runRoot)
  if ($acceptanceStateOwned) { $cleanupPaths = @($oldDataRoot, $defaultDataRoot) + $cleanupPaths }
  foreach ($path in @($cleanupPaths | Select-Object -Unique)) {
    try { Remove-AcceptancePath $path } catch { $cleanupFailures.Add($_.Exception.Message) }
  }
  $stage = $stageBeforeCleanup
}

$overallSuccess = $acceptanceSucceeded -and -not $primaryFailure -and $cleanupFailures.Count -eq 0
try {
  Write-AcceptanceDiagnostics `
    $DiagnosticsPath `
    $stage `
    $overallSuccess `
    $CandidateVersion `
    $previousVersion `
    $checks `
    $cleanupFailures.Count
} catch {
  $cleanupFailures.Add("diagnostics write failed")
  $overallSuccess = $false
}

if ($primaryFailure) {
  if ($cleanupFailures.Count -gt 0) {
    throw "$($primaryFailure.Exception.Message); acceptance cleanup also failed in $($cleanupFailures.Count) area(s)"
  }
  throw $primaryFailure
}
if ($cleanupFailures.Count -gt 0) {
  throw "Windows previous-version upgrade acceptance cleanup failed in $($cleanupFailures.Count) area(s)"
}

Write-Host "Windows previous-version upgrade acceptance passed: $previousVersion -> $CandidateVersion"

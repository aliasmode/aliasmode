[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("full", "slim")]
  [string]$Flavor,

  [Parameter(Mandatory = $true, Position = 1)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$timer = [Diagnostics.Stopwatch]::StartNew()
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = [string]$config.version
if ([string]::IsNullOrWhiteSpace($version)) { throw "Tauri bundle version is missing" }

$flavorName = $Flavor.ToLowerInvariant()
$sourceName = "AliasMode_$($version)_x64-setup.exe"
$bundleDirectory = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
$sourcePath = Join-Path $bundleDirectory $sourceName
if (Test-Path -LiteralPath $sourcePath) { Remove-Item -LiteralPath $sourcePath -Force }

$tauriArguments = @("tauri", "build", "--bundles", "nsis", "--no-sign")
if ($flavorName -eq "slim") {
  $tauriArguments += @("--config", "src-tauri/tauri.updater.conf.json")
}

Push-Location $repoRoot
try {
  & bunx @tauriArguments
  if ($LASTEXITCODE -ne 0) { throw "Tauri $flavorName NSIS build exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$matches = @(
  Get-ChildItem -LiteralPath $bundleDirectory -File |
    Where-Object { $_.Name -ceq $sourceName }
)
if ($matches.Count -ne 1) { throw "Tauri build did not create exactly $sourceName" }
$source = $matches[0]
if (
  $null -eq $source -or $source.Length -lt 2 -or
  (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
) {
  throw "Tauri installer must be a nonempty regular file"
}
$stream = [IO.File]::OpenRead($source.FullName)
try {
  if ($stream.ReadByte() -ne 0x4d -or $stream.ReadByte() -ne 0x5a) {
    throw "Tauri installer must be a Windows PE file"
  }
} finally {
  $stream.Dispose()
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputRoot = (Resolve-Path $OutputDirectory).Path
$outputName = if ($flavorName -eq "full") {
  "AliasMode_$($version)_x64-offline-setup.exe"
} else {
  "AliasMode_$($version)_x64-setup.exe"
}
$outputPath = Join-Path $outputRoot $outputName
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($source.FullName, [IO.Path]::GetFullPath($outputPath))) {
  Copy-Item -LiteralPath $source.FullName -Destination $outputPath -Force
}

$output = Get-Item -LiteralPath $outputPath
$sha256 = (Get-FileHash -LiteralPath $output.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$timer.Stop()
[ordered]@{
  flavor = $flavorName
  version = $version
  path = $output.FullName
  sha256 = $sha256
  bytes = $output.Length
  elapsedMilliseconds = $timer.ElapsedMilliseconds
} | ConvertTo-Json -Compress

param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$ManifestUri = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$helper = Join-Path $env:LOCALAPPDATA "AliasMode\aliasmode-mcp.exe"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aliasmode-agent-" + [Guid]::NewGuid().ToString("N"))

function Fail-Json([string]$Code, [string]$Message) {
  [Console]::Out.WriteLine((@{ ok = $false; error = @{ code = $Code; message = $Message } } | ConvertTo-Json -Compress))
  exit 1
}

function Helper-MatchesVersion {
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { return $false }
  try {
    $output = & $helper version --json 2> $null
    if ($LASTEXITCODE -ne 0) { return $false }
    $record = ($output | Out-String) | ConvertFrom-Json
    return $record.ok -eq $true -and $record.result.version -eq $Version
  } catch {
    return $false
  }
}

try {
  if (-not (Helper-MatchesVersion)) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
      & $winget.Source install --id AliasMode.AliasMode --version $Version --exact --force --silent --disable-interactivity --accept-package-agreements --accept-source-agreements *> $null
    }
  }

  if (-not (Helper-MatchesVersion)) {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    if (-not $ManifestUri) {
      $ManifestUri = "https://github.com/Twitter-outreach/cloakpit/releases/download/v$Version/aliasmode-agent-bootstrap.json"
    }
    $manifestPath = Join-Path $tempRoot "manifest.json"
    Invoke-WebRequest -UseBasicParsing -Uri $ManifestUri -OutFile $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -ne $Version) {
      Fail-Json "manifest_mismatch" "AliasMode release metadata did not match the requested version."
    }
    if ($manifest.installer.url -notmatch '^https://github\.com/Twitter-outreach/cloakpit/releases/download/' -or
        $manifest.installer.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
      Fail-Json "manifest_invalid" "AliasMode release metadata is invalid."
    }

    $installer = Join-Path $tempRoot "AliasMode-setup.exe"
    Invoke-WebRequest -UseBasicParsing -Uri $manifest.installer.url -OutFile $installer
    $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $manifest.installer.sha256.ToLowerInvariant()) {
      Fail-Json "hash_mismatch" "The AliasMode installer SHA-256 did not match the release manifest."
    }

    $process = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru
    if (-not $process.WaitForExit(600000)) {
      Fail-Json "installer_interrupted" "AliasMode installation is waiting for Windows approval or antivirus review."
    }
    if ($process.ExitCode -ne 0) {
      Fail-Json "installer_failed" "AliasMode installation did not complete. Windows may require approval for this unsigned beta."
    }
  }

  if (-not (Helper-MatchesVersion)) {
    Fail-Json "helper_version_mismatch" "AliasMode did not install the requested agent helper version."
  }

  & $helper setup --client auto --yes --json
  exit $LASTEXITCODE
} catch {
  Fail-Json "bootstrap_failed" "AliasMode installation or agent setup failed."
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

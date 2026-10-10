param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:RUNNER_OS -ne 'Windows') { throw 'This comparison requires a disposable Windows runner' }
if (Test-Path -LiteralPath $Root) { throw 'The comparison root must be new' }
New-Item -ItemType Directory -Path $Root | Out-Null
$engines = Get-Content (Join-Path $PSScriptRoot 'browser-engine-artifacts.json') -Raw | ConvertFrom-Json
$engines | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Root 'engines.json') -Encoding utf8
$verified = @()
foreach ($engine in $engines) {
    $download = Join-Path $Root "downloads/$($engine.id)"
    $destination = Join-Path $Root "browsers/$($engine.id)"
    New-Item -ItemType Directory -Path $download, $destination | Out-Null
    $archive = Join-Path $download 'browser.zip'
    Write-Host "Download $($engine.engine) $($engine.releaseVersion)"
    Invoke-WebRequest -Uri $engine.url -OutFile $archive
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -cne $engine.archiveSha256) { throw "Archive hash mismatch: $($engine.id)" }
    & tar.exe -xf $archive -C $destination
    if ($LASTEXITCODE -ne 0) { throw "Archive extraction failed: $($engine.id)" }
    $executable = Join-Path $destination $engine.binaryRelativePath
    $executableHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($executableHash -cne $engine.exeSha256) { throw "Executable hash mismatch: $($engine.id)" }
    $verified += [ordered]@{ engine = $engine.id; archiveSha256 = $archiveHash; executableSha256 = $executableHash }
}

# Keep the automation package and authored scripts outside the extracted engines.
$automation = Join-Path $Root 'automation'
New-Item -ItemType Directory -Path $automation | Out-Null
& npm.cmd install --prefix $automation --ignore-scripts --no-audit --no-fund playwright-core@1.58.2
if ($LASTEXITCODE -ne 0) { throw 'Playwright Core installation failed' }

# Only synthetic loopback origins are needed. Block external traffic from every
# executable in the downloaded browser payloads, without blocking the CI agent.
Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True
$outsideLoopback = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$rules = @()
$index = 0
foreach ($binary in Get-ChildItem (Join-Path $Root 'browsers') -Recurse -File -Filter '*.exe') {
    $name = "BrowserAcceptance-$env:GITHUB_RUN_ID-$index"
    New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Block -Enabled True -Profile Any -Program $binary.FullName -RemoteAddress $outsideLoopback | Out-Null
    $rule = Get-NetFirewallRule -Name $name
    if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block') { throw "Firewall rule did not apply: $name" }
    $rules += [ordered]@{ name = $name; executable = $binary.FullName; remoteAddresses = $outsideLoopback }
    $index++
}
$profiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled)
if (@($profiles | Where-Object { -not $_.Enabled }).Count) { throw 'A firewall profile is disabled' }
$evidence = Join-Path $Root 'evidence'
New-Item -ItemType Directory -Path $evidence | Out-Null
[ordered]@{
    platform = [Environment]::OSVersion.VersionString
    architecture = $env:PROCESSOR_ARCHITECTURE
    source = $env:GITHUB_SHA
    runnerImage = $env:ImageOS
    runnerImageVersion = $env:ImageVersion
    verifiedArtifacts = $verified
    firewallProfiles = $profiles
    browserOutboundRules = $rules
    limitation = 'Program-specific egress rules, not an offline VM or physical-GPU qualification.'
} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'setup.json') -Encoding utf8
"BROWSER_ACCEPTANCE_ROOT=$Root" | Add-Content $env:GITHUB_ENV
Write-Host 'Windows browser payloads are hash-checked and ready for local tests.'

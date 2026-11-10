# Signs one Windows program with the company's Certum cloud certificate (SimplySign), through the
# pinned ssign tool. CERTUM_EMAIL and CERTUM_OTP come from the protected release environment.
param([Parameter(Mandatory = $true, Position = 0)][string]$Path)

$ErrorActionPreference = "Stop"
$version = "0.1.7"
$expectedSha256 = "4ee5389a74ddbeb67e18fe8c8b963734ca13de7b24beffbe430c3f427ecc5e40"
foreach ($name in @("CERTUM_EMAIL", "CERTUM_OTP")) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "$name is missing" }
}
$zip = Join-Path $env:RUNNER_TEMP "ssign-$version.zip"
$root = Join-Path $env:RUNNER_TEMP "ssign-$version"
Invoke-WebRequest "https://github.com/Le-Syl21/ssign/releases/download/v$version/ssign-windows-x86_64.zip" -OutFile $zip
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha256) {
  throw "ssign download SHA-256 mismatch"
}
Expand-Archive -LiteralPath $zip -DestinationPath $root -Force
$ssign = Join-Path $root "ssign.exe"
if (-not (Test-Path -LiteralPath $ssign -PathType Leaf)) { throw "the ssign archive has no ssign.exe" }

# The full and slim builds can sign in the same 30-second window with the same one-time code.
# If Certum refuses the reused code, the next window gives a new one.
for ($attempt = 1; $attempt -le 2; $attempt++) {
  & $ssign $Path
  if ($LASTEXITCODE -eq 0) { return }
  if ($attempt -eq 1) { Start-Sleep -Seconds 35 }
}
throw "ssign could not sign $Path"

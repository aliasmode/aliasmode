# Prepares Azure Artifact Signing for windows-authenticode-sign.ps1: the pinned signing client
# and its account settings. Run it after azure/login, with ARTIFACT_SIGNING_ENDPOINT and
# ARTIFACT_SIGNING_ACCOUNT set.
$ErrorActionPreference = "Stop"
$version = "1.0.128"
$expectedSha256 = "74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b"
foreach ($name in @("ARTIFACT_SIGNING_ENDPOINT", "ARTIFACT_SIGNING_ACCOUNT")) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "$name is missing" }
}
if ($env:ARTIFACT_SIGNING_ENDPOINT -notmatch '^https://[a-z0-9]+\.codesigning\.azure\.net/?$') {
  throw "ARTIFACT_SIGNING_ENDPOINT is not an Artifact Signing endpoint"
}

$root = Join-Path $env:RUNNER_TEMP "artifact-signing"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$package = Join-Path $root "client.nupkg"
Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$version/microsoft.artifactsigning.client.$version.nupkg" -OutFile $package
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha256) {
  throw "Artifact Signing client package SHA-256 mismatch"
}
Expand-Archive -LiteralPath $package -DestinationPath (Join-Path $root "client") -Force
$dlib = Join-Path $root "client\bin\x64\Azure.CodeSigning.Dlib.dll"
if (-not (Test-Path -LiteralPath $dlib -PathType Leaf)) { throw "the signing client has no x64 dlib" }

# Only the Azure CLI login from azure/login is used, so no other credential is tried first.
$metadata = Join-Path $root "metadata.json"
@{
  Endpoint = $env:ARTIFACT_SIGNING_ENDPOINT.TrimEnd("/")
  CodeSigningAccountName = $env:ARTIFACT_SIGNING_ACCOUNT
  CertificateProfileName = "aliasmode"
  ExcludeCredentials = @(
    "ManagedIdentityCredential", "WorkloadIdentityCredential", "SharedTokenCacheCredential",
    "VisualStudioCredential", "VisualStudioCodeCredential", "AzurePowerShellCredential",
    "AzureDeveloperCliCredential", "InteractiveBrowserCredential"
  )
} | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
"ACS_DLIB=$dlib" | Add-Content $env:GITHUB_ENV
"ACS_METADATA=$metadata" | Add-Content $env:GITHUB_ENV

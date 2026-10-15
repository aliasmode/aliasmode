# Signs one file with Azure Artifact Signing. Tauri runs it for each program it bundles.
# windows-artifact-signing-setup.ps1 sets ACS_DLIB and ACS_METADATA; the Azure CLI login provides the access.
param([Parameter(Mandatory = $true, Position = 0)][string]$Path)

$ErrorActionPreference = "Stop"
foreach ($name in @("ACS_DLIB", "ACS_METADATA")) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value) -or -not (Test-Path -LiteralPath $value -PathType Leaf)) {
    throw "$name does not point to a file"
  }
}
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } |
  Select-Object -Last 1
if ($null -eq $signtool) { throw "signtool.exe was not found" }
# No verbose output: it would print the certificate subject (the company name) in a public log.
& $signtool.FullName sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib $env:ACS_DLIB /dmdf $env:ACS_METADATA $Path
if ($LASTEXITCODE -ne 0) { throw "signtool exited with code $LASTEXITCODE for $Path" }

# Checks the Authenticode state of a Windows program. "on": a valid signature from the company's
# Certum certificate, with a timestamp. "off": no signature. The signer name is not printed.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][ValidateSet("on", "off")][string]$Signing
)

$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($Signing -ceq "off") {
  if ([string]$signature.Status -cne "NotSigned") { throw "expected no signature: $Path" }
  return
}
if ([string]$signature.Status -cne "Valid") { throw "expected a valid signature, found $($signature.Status): $Path" }
if ($null -eq $signature.TimeStamperCertificate) { throw "the signature has no timestamp: $Path" }
if ($signature.SignerCertificate.Issuer -notlike "*CN=Certum*") { throw "the signature is not from the Certum certificate: $Path" }

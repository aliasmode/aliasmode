#Requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$SourceVersion,

  [Parameter(Mandatory)]
  [string]$SourceInstallerPath,

  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$CandidateVersion,

  [Parameter(Mandatory)]
  [string]$CandidateInstallerPath,

  [Parameter(Mandatory)]
  [string]$CandidateSignaturePath,

  [Parameter(Mandatory)]
  [string]$CandidateManifestPath,

  [string]$SourceChecksumsPath,

  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$ExpectedSourceInstallerSha256,

  [string]$JavaScriptRuntimePath,

  [string]$DiagnosticsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AliasModeStandardUserProcess {
  private const uint SaferScopeUser = 2;
  private const uint SaferLevelNormalUser = 0x00020000;
  private const int TokenElevationClass = 20;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo {
    public int cb;
    public string reserved;
    public string desktop;
    public string title;
    public int x;
    public int y;
    public int xSize;
    public int ySize;
    public int xCountChars;
    public int yCountChars;
    public int fillAttribute;
    public int flags;
    public short showWindow;
    public short reserved2;
    public IntPtr reserved2Pointer;
    public IntPtr standardInput;
    public IntPtr standardOutput;
    public IntPtr standardError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr process;
    public IntPtr thread;
    public int processId;
    public int threadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct TokenElevation {
    public int isElevated;
  }

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SaferCreateLevel(
    uint scopeId,
    uint levelId,
    uint openFlags,
    out IntPtr level,
    IntPtr reserved
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SaferComputeTokenFromLevel(
    IntPtr level,
    IntPtr inputToken,
    out IntPtr outputToken,
    uint flags,
    IntPtr reserved
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SaferCloseLevel(IntPtr level);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetTokenInformation(
    IntPtr token,
    int informationClass,
    ref TokenElevation information,
    int informationLength,
    out int returnLength
  );

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessAsUser(
    IntPtr token,
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  public static int Start(string fileName, string arguments, string currentDirectory) {
    IntPtr level = IntPtr.Zero;
    IntPtr token = IntPtr.Zero;
    ProcessInformation process = new ProcessInformation();
    try {
      if (!SaferCreateLevel(SaferScopeUser, SaferLevelNormalUser, 1, out level, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user level creation failed");
      }
      if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user token creation failed");
      }
      TokenElevation elevation = new TokenElevation();
      int returned;
      if (!GetTokenInformation(
        token,
        TokenElevationClass,
        ref elevation,
        Marshal.SizeOf<TokenElevation>(),
        out returned
      ) || elevation.isElevated != 0) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user token verification failed");
      }

      StartupInfo startup = new StartupInfo();
      startup.cb = Marshal.SizeOf<StartupInfo>();
      string escapedFileName = "\"" + fileName.Replace("\"", "\"\"") + "\"";
      StringBuilder command = new StringBuilder(
        string.IsNullOrWhiteSpace(arguments) ? escapedFileName : escapedFileName + " " + arguments
      );
      if (!CreateProcessAsUser(
        token,
        fileName,
        command,
        IntPtr.Zero,
        IntPtr.Zero,
        false,
        0,
        IntPtr.Zero,
        currentDirectory,
        ref startup,
        out process
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user process launch failed");
      }
      return process.processId;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (level != IntPtr.Zero) SaferCloseLevel(level);
    }
  }
}
'@

function Start-StandardUserProcess([string]$FilePath, [string]$Arguments = "") {
  $processId = [AliasModeStandardUserProcess]::Start(
    $FilePath,
    $Arguments,
    [IO.Path]::GetDirectoryName($FilePath)
  )
  return [Diagnostics.Process]::GetProcessById($processId)
}

$publicVersion = $SourceVersion
$publicInstallerName = "AliasMode_${publicVersion}_x64-offline-setup.exe"
$candidateTag = "v$CandidateVersion"
$candidateInstallerName = "AliasMode_${CandidateVersion}_x64-setup.exe"
$candidateReleaseBase = "https://github.com/aliasmode/aliasmode/releases/download/$candidateTag"
$candidateManifestUrl = "$candidateReleaseBase/latest-v2.json"
$candidateInstallerUrl = "$candidateReleaseBase/$candidateInstallerName"
$repoRoot = Split-Path $PSScriptRoot -Parent
$fixtureScript = Join-Path $PSScriptRoot "windows-updater-https-fixture.mjs"
$probeScript = Join-Path $PSScriptRoot "windows-updater-ui-probe.mjs"

function Resolve-InputFile([string]$Path, [string]$Description) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description is missing"
  }
  return (Resolve-Path -LiteralPath $Path).Path
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

function Set-AcceptanceStage([string]$NextStage) {
  $script:stage = $NextStage
  Write-Host "AliasMode updater acceptance stage: $NextStage"
}

function Stop-ProcessTree([Diagnostics.Process]$Process) {
  if (-not $Process -or (Test-ProcessExited $Process)) { return }
  $Process.Kill($true)
  if (-not $Process.WaitForExit(15000)) {
    throw "acceptance process tree did not exit"
  }
}

function Get-ProcessPath([Diagnostics.Process]$Process) {
  try {
    return $Process.Path
  } catch {
    return $null
  }
}

function Test-PathWithin([string]$Path, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $fullPath.StartsWith("$fullRoot\", [StringComparison]::OrdinalIgnoreCase)
}

function Get-InstalledDesktopProcesses([string]$AppPath) {
  $result = [Collections.Generic.List[Diagnostics.Process]]::new()
  foreach ($process in @(Get-Process -Name "AliasMode" -ErrorAction SilentlyContinue)) {
    $path = Get-ProcessPath $process
    if ($path -and [IO.Path]::GetFullPath($path).Equals(
      [IO.Path]::GetFullPath($AppPath),
      [StringComparison]::OrdinalIgnoreCase
    )) {
      $result.Add($process)
    }
  }
  return @($result)
}

function Get-ChildSidecars([int]$DesktopProcessId) {
  $result = [Collections.Generic.List[Diagnostics.Process]]::new()
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $DesktopProcessId" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "aliasmode-sidecar*.exe" })
  foreach ($child in $children) {
    $process = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
    if ($process) { $result.Add($process) }
  }
  return @($result)
}

function Get-SidecarHealth([int]$SidecarProcessId) {
  $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $SidecarProcessId -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty LocalPort -Unique)
  foreach ($port in $ports) {
    try {
      $origin = "http://127.0.0.1:$port"
      $health = Invoke-RestMethod "$origin/ui/api/health" -TimeoutSec 1 -NoProxy
      if ($health.ok -eq $true -and
          -not [string]::IsNullOrWhiteSpace([string]$health.version) -and
          -not [string]::IsNullOrWhiteSpace([string]$health.root) -and
          -not [string]::IsNullOrWhiteSpace([string]$health.instance)) {
        return [pscustomobject]@{
          Origin = $origin
          Health = $health
        }
      }
    } catch {}
  }
  return $null
}

function Get-WebViewDebugPort([string]$WebViewRoot) {
  $activePortPath = Join-Path $WebViewRoot "EBWebView\DevToolsActivePort"
  if (-not (Test-Path -LiteralPath $activePortPath -PathType Leaf)) { return 0 }
  try {
    $line = [IO.File]::ReadLines($activePortPath) | Select-Object -First 1
    $port = 0
    if ([int]::TryParse($line, [ref]$port) -and $port -gt 0 -and $port -le 65535) {
      Invoke-RestMethod "http://127.0.0.1:$port/json/version" -TimeoutSec 1 -NoProxy | Out-Null
      return $port
    }
  } catch {}
  return 0
}

function Wait-DesktopReady(
  [Diagnostics.Process]$DesktopProcess,
  [string]$ExpectedVersion,
  [string]$ExpectedRoot,
  [string]$WebViewRoot
) {
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    if (Test-ProcessExited $DesktopProcess) {
      throw "installed public desktop exited before readiness"
    }
    $sidecars = @(Get-ChildSidecars $DesktopProcess.Id)
    foreach ($sidecar in $sidecars) {
      $healthRecord = Get-SidecarHealth $sidecar.Id
      if (-not $healthRecord) { continue }
      if ($healthRecord.Health.version -ne $ExpectedVersion) {
        throw "installed public desktop reported an unexpected version"
      }
      if (-not [IO.Path]::GetFullPath([string]$healthRecord.Health.root).Equals(
        [IO.Path]::GetFullPath($ExpectedRoot),
        [StringComparison]::OrdinalIgnoreCase
      )) {
        throw "installed public desktop used an unexpected app-data root"
      }
      $debugPort = Get-WebViewDebugPort $WebViewRoot
      $DesktopProcess.Refresh()
      if ($debugPort -gt 0 -and $DesktopProcess.MainWindowHandle -ne 0) {
        return [pscustomobject]@{
          App = $DesktopProcess
          Sidecar = $sidecar
          Origin = $healthRecord.Origin
          Health = $healthRecord.Health
          DebugPort = $debugPort
        }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "installed public desktop did not become ready"
}

function Get-InstalledBrowserProcesses([string]$InstallRoot) {
  $result = [Collections.Generic.List[Diagnostics.Process]]::new()
  foreach ($record in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($record.ExecutablePath -and
        (Test-PathWithin ([string]$record.ExecutablePath) (Join-Path $InstallRoot "cloakbrowser"))) {
      $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
      if ($process) { $result.Add($process) }
    }
  }
  return @($result)
}

function Get-CandidateUpdaterProcesses([string]$Version) {
  $result = [Collections.Generic.List[Diagnostics.Process]]::new()
  $expectedName = "AliasMode-$Version-installer.exe"
  $expectedParentPrefix = "AliasMode-$Version-updater-"
  $temporaryRoot = [IO.Path]::GetTempPath()
  foreach ($record in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if (-not $record.ExecutablePath -or -not $record.CommandLine -or
        -not (Test-PathWithin ([string]$record.ExecutablePath) $temporaryRoot) -or
        -not [IO.Path]::GetFileName([string]$record.ExecutablePath).Equals(
          $expectedName,
          [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [IO.Path]::GetFileName([IO.Path]::GetDirectoryName([string]$record.ExecutablePath)).StartsWith(
          $expectedParentPrefix,
          [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not $record.CommandLine.Contains("/UPDATE", [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
    if ($process) { $result.Add($process) }
  }
  return @($result)
}

function Read-FixtureState([string]$StatePath) {
  try {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    $state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
    if ($state.version -ne 1 -or $null -eq $state.counts) { return $null }
    return $state
  } catch {
    return $null
  }
}

function Get-SafeRouteCounts([string]$StatePath) {
  $state = Read-FixtureState $StatePath
  if (-not $state) {
    return [ordered]@{ releaseList = 0; manifest = 0; installer = 0; rejected = 0 }
  }
  return [ordered]@{
    releaseList = [int]$state.counts.releaseList
    manifest = [int]$state.counts.manifest
    installer = [int]$state.counts.installer
    rejected = [int]$state.counts.rejected
  }
}

function Start-JavaScriptFixture([string]$RuntimePath, [string]$ScriptPath, [string]$ConfigPath) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $RuntimePath
  $start.ArgumentList.Add($ScriptPath)
  $start.ArgumentList.Add($ConfigPath)
  $start.WorkingDirectory = $repoRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "HTTPS fixture process did not start" }
  return $process
}

function Invoke-DesktopUiProbe(
  [string]$RuntimePath,
  [string]$ScriptPath,
  [int]$DebugPort,
  [string]$DashboardOrigin,
  [string]$ExpectedCandidateVersion,
  [ValidateSet("click-update", "click-update-and-wait-error", "verify-update-result")]
  [string]$Action = "click-update",
  [string]$ExpectedSourceVersion = ""
) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $RuntimePath
  $start.ArgumentList.Add($ScriptPath)
  $start.WorkingDirectory = $repoRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "desktop UI probe did not start" }
  try {
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $probeInput = [ordered]@{
      endpoint = "http://127.0.0.1:$DebugPort"
      dashboardOrigin = $DashboardOrigin
      candidateVersion = $ExpectedCandidateVersion
      sourceVersion = $ExpectedSourceVersion
      action = $Action
    }
    $probeInput | ConvertTo-Json -Compress | ForEach-Object { $process.StandardInput.Write($_) }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(120000)) {
      Stop-ProcessTree $process
      throw "desktop UI probe timed out"
    }
    $output = $outputTask.GetAwaiter().GetResult()
    [void]$errorTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "desktop UI probe failed" }
    try { $result = $output | ConvertFrom-Json } catch { throw "desktop UI probe returned invalid output" }
    $expectedResult = switch ($Action) {
      "click-update" { "visible-update-now" }
      "click-update-and-wait-error" { "visible-update-rejected" }
      "verify-update-result" { "verified-durable-success" }
    }
    if ($result.ok -ne $true -or $result.action -ne $expectedResult) {
      throw "desktop UI probe returned an unexpected result"
    }
  } finally {
    if (-not (Test-ProcessExited $process)) { Stop-ProcessTree $process }
    $process.Dispose()
  }
}

function Wait-CandidateRelaunch(
  [string]$AppPath,
  [string]$ExpectedCandidateVersion,
  [string]$ExpectedRoot,
  $OldRecord,
  [Diagnostics.Process[]]$OldBrowserProcesses,
  [string]$WebViewRoot,
  [string]$FixtureStatePath,
  $Observations
) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $deadline = [TimeSpan]::FromMinutes(10)
  $nextReportSeconds = 0.0
  while ($timer.Elapsed -lt $deadline) {
    $oldDesktopExited = Test-ProcessExited $OldRecord.App
    $oldSidecarExited = Test-ProcessExited $OldRecord.Sidecar
    $oldBrowsersExited = @($OldBrowserProcesses | Where-Object { -not (Test-ProcessExited $_) }).Count -eq 0
    $Observations.oldDesktopExited = $oldDesktopExited
    $Observations.oldSidecarExited = $oldSidecarExited
    $Observations.oldBrowserExited = $oldBrowsersExited

    foreach ($desktop in @(Get-InstalledDesktopProcesses $AppPath)) {
      if ($desktop.Id -ne $OldRecord.App.Id) { $Observations.candidateDesktopSeen = $true }
      foreach ($sidecar in @(Get-ChildSidecars $desktop.Id)) {
        if ($sidecar.Id -ne $OldRecord.Sidecar.Id) { $Observations.candidateSidecarSeen = $true }
        $healthRecord = Get-SidecarHealth $sidecar.Id
        if (-not $healthRecord) { continue }
        $health = $healthRecord.Health
        if ($health.version -eq $publicVersion -and
            ($health.instance -ne $OldRecord.Health.instance -or $oldSidecarExited)) {
          throw "public $publicVersion health reappeared after update handoff"
        }
        if ($health.version -ne $ExpectedCandidateVersion) { continue }
        $Observations.candidateHealthSeen = $true
        if (-not $oldDesktopExited -or -not $oldSidecarExited -or -not $oldBrowsersExited) { continue }
        if ($desktop.Id -eq $OldRecord.App.Id -or $sidecar.Id -eq $OldRecord.Sidecar.Id) {
          throw "candidate relaunch reused an old process ID"
        }
        if ($health.instance -eq $OldRecord.Health.instance) {
          throw "candidate relaunch reused the public desktop instance"
        }
        if (-not [IO.Path]::GetFullPath([string]$health.root).Equals(
          [IO.Path]::GetFullPath($ExpectedRoot),
          [StringComparison]::OrdinalIgnoreCase
        )) {
          throw "candidate relaunch changed the app-data root"
        }
        $desktop.Refresh()
        if ($desktop.MainWindowHandle -eq 0) { continue }
        $debugPort = Get-WebViewDebugPort $WebViewRoot
        if ($debugPort -eq 0) { continue }
        $Observations.candidateWindowSeen = $true
        $candidateRoutes = Get-SafeRouteCounts $FixtureStatePath
        if ($candidateRoutes.releaseList -lt 4) { continue }
        $Observations.candidateFrontendSeen = $true
        return [pscustomobject]@{
          App = $desktop
          Sidecar = $sidecar
          Origin = $healthRecord.Origin
          Health = $health
          DebugPort = $debugPort
        }
      }
    }

    if ($oldSidecarExited) {
      $oldOriginHealth = $null
      try {
        $oldOriginHealth = Invoke-RestMethod "$($OldRecord.Origin)/ui/api/health" -TimeoutSec 1 -NoProxy
      } catch {}
      if ($oldOriginHealth -and $oldOriginHealth.version -eq $publicVersion) {
        throw "public $publicVersion health reappeared on its previous endpoint"
      }
    }
    if ($timer.Elapsed.TotalSeconds -ge $nextReportSeconds) {
      $counts = Get-SafeRouteCounts $FixtureStatePath
      Write-Host (
        "AliasMode updater relaunch state: " +
        "oldDesktopExited=$oldDesktopExited; " +
        "oldSidecarExited=$oldSidecarExited; " +
        "oldBrowserExited=$oldBrowsersExited; " +
        "candidateDesktopSeen=$($Observations.candidateDesktopSeen); " +
        "candidateSidecarSeen=$($Observations.candidateSidecarSeen); " +
        "candidateHealthSeen=$($Observations.candidateHealthSeen); " +
        "candidateWindowSeen=$($Observations.candidateWindowSeen); " +
        "candidateFrontendSeen=$($Observations.candidateFrontendSeen); " +
        "releaseRequests=$($counts.releaseList); " +
        "manifestRequests=$($counts.manifest); " +
        "installerRequests=$($counts.installer); " +
        "rejectedRequests=$($counts.rejected)"
      )
      $nextReportSeconds = $timer.Elapsed.TotalSeconds + 30
    }
    Start-Sleep -Milliseconds 250
  }
  throw "signed candidate did not relaunch after visible update handoff"
}

function Assert-NoPublicHealthReappears([string]$AppPath, $OldRecord, $CandidateRecord) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ((Test-ProcessExited $CandidateRecord.App) -or (Test-ProcessExited $CandidateRecord.Sidecar)) {
      throw "candidate desktop did not remain ready"
    }
    foreach ($desktop in @(Get-InstalledDesktopProcesses $AppPath)) {
      foreach ($sidecar in @(Get-ChildSidecars $desktop.Id)) {
        $healthRecord = Get-SidecarHealth $sidecar.Id
        if ($healthRecord -and $healthRecord.Health.version -eq $publicVersion) {
          throw "public $publicVersion health reappeared after candidate readiness"
        }
      }
    }
    $oldOriginHealth = $null
    try {
      $oldOriginHealth = Invoke-RestMethod "$($OldRecord.Origin)/ui/api/health" -TimeoutSec 1 -NoProxy
    } catch {}
    if ($oldOriginHealth -and $oldOriginHealth.version -eq $publicVersion) {
      throw "public $publicVersion health reappeared on its previous endpoint"
    }
    Start-Sleep -Milliseconds 250
  }
}

function New-AcceptanceCertificates([string]$CertificateRoot) {
  $caKey = [Security.Cryptography.RSA]::Create(3072)
  $serverKey = [Security.Cryptography.RSA]::Create(3072)
  $caCertificate = $null
  $serverCertificate = $null
  try {
    $caName = "CN=AliasMode Windows Update Acceptance $([Guid]::NewGuid().ToString('N'))"
    $caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      $caName,
      $caKey,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $caRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
    )
    $caUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
      [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    $caRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caUsage, $true)
    )
    $caRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
    )
    $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $notAfter = [DateTimeOffset]::UtcNow.AddDays(1)
    $caCertificate = $caRequest.CreateSelfSigned($notBefore, $notAfter)

    $serverRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=api.github.com",
      $serverKey,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $serverRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
    )
    $serverRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
        $true
      )
    )
    $enhancedUsage = [Security.Cryptography.OidCollection]::new()
    [void]$enhancedUsage.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $serverRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($enhancedUsage, $true)
    )
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("api.github.com")
    $san.AddDnsName("github.com")
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    $serverRequest.CertificateExtensions.Add($san.Build($false))

    $serial = [byte[]]::new(16)
    [Security.Cryptography.RandomNumberGenerator]::Fill($serial)
    $serial[0] = $serial[0] -band 0x7f
    if (($serial | Where-Object { $_ -ne 0 }).Count -eq 0) { $serial[15] = 1 }
    $serverPublic = $serverRequest.Create($caCertificate, $notBefore, $notAfter, $serial)
    try {
      $serverCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey(
        $serverPublic,
        $serverKey
      )
    } finally {
      $serverPublic.Dispose()
    }

    $caPath = Join-Path $CertificateRoot "acceptance-ca.cer"
    $certificatePath = Join-Path $CertificateRoot "acceptance-server.pem"
    $privateKeyPath = Join-Path $CertificateRoot "acceptance-server.key"
    [IO.File]::WriteAllBytes(
      $caPath,
      $caCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    )
    $certificatePem = "$($serverCertificate.ExportCertificatePem())`n$($caCertificate.ExportCertificatePem())`n"
    [IO.File]::WriteAllText($certificatePath, $certificatePem, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText(
      $privateKeyPath,
      $serverKey.ExportPkcs8PrivateKeyPem(),
      [Text.UTF8Encoding]::new($false)
    )
    $publicCa = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $caCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    )
    return [pscustomobject]@{
      Ca = $publicCa
      CaPath = $caPath
      CertificatePath = $certificatePath
      PrivateKeyPath = $privateKeyPath
    }
  } finally {
    if ($serverCertificate) { $serverCertificate.Dispose() }
    if ($caCertificate) { $caCertificate.Dispose() }
    $serverKey.Dispose()
    $caKey.Dispose()
  }
}

function Invoke-CertUtil([string[]]$Arguments, [string]$Description) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Join-Path $env:SystemRoot "System32\certutil.exe"
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw "$Description did not start" }
    if (-not $process.WaitForExit(30000)) {
      try { Stop-ProcessTree $process } catch {}
      throw "$Description timed out"
    }
    if ($process.ExitCode -ne 0) { throw "$Description exited with code $($process.ExitCode)" }
  } finally {
    $process.Dispose()
  }
}

function Get-LocalMachineRootCertificateCount($Certificate) {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new(
    [Security.Cryptography.X509Certificates.StoreName]::Root,
    [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  )
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    return @($store.Certificates.Find(
      [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $Certificate.Thumbprint,
      $false
    )).Count
  } finally {
    $store.Close()
    $store.Dispose()
  }
}

function Add-LocalMachineRootCertificate($Certificate, [string]$CertificatePath) {
  Invoke-CertUtil `
    -Arguments @("-f", "-addstore", "Root", $CertificatePath) `
    -Description "temporary CA installation"
  if ((Get-LocalMachineRootCertificateCount $Certificate) -ne 1) {
    throw "temporary CA trust was not installed exactly once"
  }
}

function Remove-LocalMachineRootCertificate($Certificate) {
  if ((Get-LocalMachineRootCertificateCount $Certificate) -eq 0) { return }
  Invoke-CertUtil `
    -Arguments @("-f", "-delstore", "Root", $Certificate.Thumbprint) `
    -Description "temporary CA removal"
  if ((Get-LocalMachineRootCertificateCount $Certificate) -ne 0) {
    throw "temporary CA trust survived cleanup"
  }
}

function Assert-NoGithubHostsMapping([byte[]]$HostsBytes) {
  $text = [Text.Encoding]::ASCII.GetString($HostsBytes)
  foreach ($line in [Text.RegularExpressions.Regex]::Split($text, "\r\n|\n|\r")) {
    $active = $line.Split('#', 2)[0]
    if ([Text.RegularExpressions.Regex]::IsMatch(
      $active,
      '(?i)(?:^|\s)(?:api\.github\.com|github\.com)(?:\s|$)'
    )) {
      throw "hosts already contains an active GitHub mapping"
    }
  }
}

function Set-GithubLoopbackHosts([string]$HostsPath, [byte[]]$OriginalBytes, [string]$Marker) {
  $separator = ""
  if ($OriginalBytes.Length -gt 0 -and
      $OriginalBytes[$OriginalBytes.Length - 1] -ne 10 -and
      $OriginalBytes[$OriginalBytes.Length - 1] -ne 13) {
    $separator = "`r`n"
  }
  $entry = [Text.Encoding]::ASCII.GetBytes(
    "${separator}127.0.0.1 api.github.com github.com # $Marker`r`n"
  )
  $temporaryBytes = [byte[]]::new($OriginalBytes.Length + $entry.Length)
  [Array]::Copy($OriginalBytes, 0, $temporaryBytes, 0, $OriginalBytes.Length)
  [Array]::Copy($entry, 0, $temporaryBytes, $OriginalBytes.Length, $entry.Length)
  [IO.File]::WriteAllBytes($HostsPath, $temporaryBytes)
}

function Flush-DnsCache {
  & (Join-Path $env:SystemRoot "System32\ipconfig.exe") /flushdns | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Windows DNS cache flush failed" }
}

function Assert-GithubResolvesToLoopback {
  foreach ($name in @("api.github.com", "github.com")) {
    $addresses = @([Net.Dns]::GetHostAddresses($name))
    if ($addresses.Count -eq 0 -or
        @($addresses | Where-Object { -not [Net.IPAddress]::IsLoopback($_) }).Count -ne 0) {
      throw "temporary GitHub hostname mapping did not resolve only to loopback"
    }
  }
}

function Write-SafeDiagnostics(
  [string]$Path,
  [string]$Stage,
  [bool]$Success,
  [string]$PublicVersion,
  [string]$CandidateVersion,
  $RouteCounts,
  $Observations,
  [int]$CleanupFailureCount
) {
  $parent = Split-Path $Path -Parent
  if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
  $diagnostics = [ordered]@{
    version = 1
    stage = $Stage
    success = $Success
    publicVersion = $PublicVersion
    candidateVersion = $CandidateVersion
    routeCounts = $RouteCounts
    observations = $Observations
    cleanupFailureCount = $CleanupFailureCount
  }
  [IO.File]::WriteAllText(
    $Path,
    ($diagnostics | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false)
  )
}

if (-not $IsWindows) { throw "Windows updater acceptance requires Windows" }
if ($env:GITHUB_ACTIONS -ne "true" -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw "Windows updater acceptance runs only on a disposable GitHub Actions runner"
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Windows updater acceptance requires an administrator runner"
}

$candidateSemanticVersion = [Management.Automation.SemanticVersion]::Parse($CandidateVersion)
$publicSemanticVersion = [Management.Automation.SemanticVersion]::Parse($publicVersion)
if ($candidateSemanticVersion -le $publicSemanticVersion -or
    $candidateSemanticVersion.ToString() -ne $CandidateVersion -or
    $publicSemanticVersion.ToString() -ne $publicVersion) {
  throw "candidate version must be canonical and newer than source $publicVersion"
}

$candidateInstallerPath = Resolve-InputFile $CandidateInstallerPath "signed candidate slim installer"
$candidateSignaturePath = Resolve-InputFile $CandidateSignaturePath "candidate detached signature"
$candidateManifestPath = Resolve-InputFile $CandidateManifestPath "candidate latest manifest"
if ((Split-Path $candidateInstallerPath -Leaf) -ne $candidateInstallerName) {
  throw "candidate slim installer name does not match candidate version"
}
if ((Split-Path $candidateSignaturePath -Leaf) -ne "$candidateInstallerName.sig") {
  throw "candidate detached signature name does not match candidate installer"
}
if ((Split-Path $candidateManifestPath -Leaf) -ne "latest-v2.json") {
  throw "candidate updater manifest must be named latest-v2.json"
}
$signature = [IO.File]::ReadAllText($candidateSignaturePath).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) { throw "candidate detached signature is empty" }
try { $manifest = [IO.File]::ReadAllText($candidateManifestPath) | ConvertFrom-Json } catch {
  throw "candidate updater manifest is malformed"
}
$manifestProperties = @($manifest.PSObject.Properties)
$platformProperties = @($manifest.platforms.PSObject.Properties)
$platform = $manifest.platforms."windows-x86_64"
$platformFields = @($platform.PSObject.Properties)
if ($manifestProperties.Count -ne 2 -or
    (@($manifestProperties.Name | Sort-Object) -join ',') -ne 'platforms,version' -or
    $manifest.version -ne $CandidateVersion -or
    $platformProperties.Count -ne 1 -or
    $platformProperties[0].Name -ne "windows-x86_64" -or
    $platformFields.Count -ne 2 -or
    (@($platformFields.Name | Sort-Object) -join ',') -ne 'signature,url' -or
    $platform.url -ne $candidateInstallerUrl -or
    $platform.signature -ne $signature) {
  throw "candidate updater manifest is not canonical or does not match its signed installer"
}

$runtime = $null
if ($JavaScriptRuntimePath) {
  $runtime = Resolve-InputFile $JavaScriptRuntimePath "JavaScript runtime"
} else {
  $runtimeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if (-not $runtimeCommand) {
    $runtimeCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
  }
  if (-not $runtimeCommand) { throw "Node or Bun is required for updater acceptance" }
  $runtime = $runtimeCommand.Source
}
foreach ($requiredPath in @($fixtureScript, $probeScript, (Join-Path $repoRoot "node_modules\playwright-core"))) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "updater acceptance runtime support is missing" }
}

$runId = [Guid]::NewGuid().ToString("N")
$runRoot = Join-Path $env:RUNNER_TEMP "aliasmode-in-app-update-$runId"
$installRoot = Join-Path $env:LOCALAPPDATA "AliasMode"
$webViewRoot = Join-Path $runRoot "webview"
$certificateRoot = Join-Path $runRoot "tls"
$fixtureConfigPath = Join-Path $runRoot "fixture-config.json"
$fixtureStatePath = Join-Path $runRoot "fixture-state.json"
if ([string]::IsNullOrWhiteSpace($DiagnosticsPath)) {
  $DiagnosticsPath = Join-Path $env:RUNNER_TEMP "aliasmode-windows-updater-acceptance.json"
} else {
  $DiagnosticsPath = [IO.Path]::GetFullPath($DiagnosticsPath)
}
$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$appDataRoot = Join-Path (
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
) "com.aliasmode.desktop"
$configPath = Join-Path $appDataRoot "config.json"
$sentinelPath = Join-Path $appDataRoot "in-app-update-sentinel.txt"
$appPath = Join-Path $installRoot "AliasMode.exe"
$manufacturerKey = "Registry::HKEY_CURRENT_USER\Software\aliasmode\AliasMode"
$uninstallKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\AliasMode"
$registrationBackup = $null
$registrationChanged = $false
$hostsOriginalBytes = $null
$hostsChanged = $false
$trustedCa = $null
$caTrusted = $false
$fixtureProcess = $null
$oldRecord = $null
$candidateRecord = $null
$oldBrowserProcesses = @()
$primaryFailure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$routeCounts = [ordered]@{ releaseList = 0; manifest = 0; installer = 0; rejected = 0 }
Set-AcceptanceStage "validating-inputs"
$acceptanceSucceeded = $false
$savedEnvironment = @{}
$environmentNames = @("ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG", "WEBVIEW2_USER_DATA_FOLDER")
$observations = [ordered]@{
  publicInstallerVerified = $false
  standardUserTokenUsed = $false
  publicDesktopReady = $false
  profileCreated = $false
  activeBrowserStarted = $false
  rootMismatchRejected = $false
  browserStayedActiveAfterRejection = $false
  installerDidNotStartAfterRejection = $false
  visibleUpdateClicked = $false
  oldDesktopExited = $false
  oldSidecarExited = $false
  oldBrowserExited = $false
  candidateDesktopSeen = $false
  candidateSidecarSeen = $false
  candidateHealthSeen = $false
  candidateWindowSeen = $false
  candidateFrontendSeen = $false
  candidateReady = $false
  candidateWindowReady = $false
  durableSuccessVisible = $false
  installPathPreserved = $false
  dataRootPreserved = $false
  configPreserved = $false
  sentinelPreserved = $false
  encryptedStatePreserved = $false
  profilePreserved = $false
  publicHealthDidNotReappear = $false
}

try {
  Set-AcceptanceStage "preparing-public-release"
  New-Item -ItemType Directory -Force $runRoot, $webViewRoot, $certificateRoot | Out-Null
  if (@(Get-Process -Name "AliasMode" -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "runner has a pre-existing AliasMode process"
  }
  foreach ($path in @($appDataRoot, $installRoot)) {
    if (Test-Path -LiteralPath $path) { throw "runner has pre-existing AliasMode state" }
  }
  foreach ($key in @(
    "Registry::HKEY_CURRENT_USER\Software\aliasmode\AliasMode",
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\AliasMode"
  )) {
    if (Test-Path -LiteralPath $key) { throw "runner has pre-existing AliasMode registration" }
  }

  $SourceInstallerPath = Resolve-InputFile $SourceInstallerPath "source $publicVersion installer"
  if ((Split-Path $SourceInstallerPath -Leaf) -ne $publicInstallerName) {
    throw "source installer name does not match source version"
  }
  $checksumFromManifest = $null
  if (-not [string]::IsNullOrWhiteSpace($SourceChecksumsPath)) {
    $SourceChecksumsPath = Resolve-InputFile $SourceChecksumsPath "source checksum manifest"
    $pattern = '^([a-fA-F0-9]{64})  ' + [Text.RegularExpressions.Regex]::Escape($publicInstallerName) + '$'
    $checksumLines = @([IO.File]::ReadAllLines($SourceChecksumsPath) | Where-Object { $_ -match $pattern })
    if ($checksumLines.Count -ne 1) { throw "source installer checksum entry is missing or ambiguous" }
    $match = [Text.RegularExpressions.Regex]::Match($checksumLines[0], $pattern)
    $checksumFromManifest = $match.Groups[1].Value.ToLowerInvariant()
  }
  $expectedPublicChecksum = if ($ExpectedSourceInstallerSha256) {
    $ExpectedSourceInstallerSha256.ToLowerInvariant()
  } else {
    $checksumFromManifest
  }
  if ([string]::IsNullOrWhiteSpace($expectedPublicChecksum)) {
    throw "source installer SHA-256 is required"
  }
  if ($checksumFromManifest -and $expectedPublicChecksum -ne $checksumFromManifest) {
    throw "provided source installer checksum disagrees with its checksum manifest"
  }
  $actualPublicChecksum = (Get-FileHash -LiteralPath $SourceInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualPublicChecksum -ne $expectedPublicChecksum) {
    throw "source installer SHA-256 mismatch"
  }
  $observations.publicInstallerVerified = $true

  Set-AcceptanceStage "installing-source-release"
  $install = Start-StandardUserProcess $SourceInstallerPath "/S"
  if (-not $install.WaitForExit(300000)) {
    Stop-ProcessTree $install
    throw "public $publicVersion installer timed out"
  }
  if ($install.ExitCode -ne 0) { throw "public $publicVersion installer exited nonzero" }
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    throw "public $publicVersion desktop executable is missing after install"
  }
  New-Item -ItemType Directory -Force $appDataRoot | Out-Null
  $config = [ordered]@{ version = 1; mode = "local"; localAnalytics = $false } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText(
    $sentinelPath,
    "aliasmode-windows-in-app-update-acceptance-v1",
    [Text.UTF8Encoding]::new($false)
  )

  Set-AcceptanceStage "intercepting-github"
  $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 443)
  try {
    $portProbe.Server.ExclusiveAddressUse = $true
    $portProbe.Start()
  } finally {
    $portProbe.Stop()
  }
  Set-AcceptanceStage "creating-https-certificates"
  $certificates = New-AcceptanceCertificates $certificateRoot
  $trustedCa = $certificates.Ca
  $caTrusted = $true
  Set-AcceptanceStage "trusting-https-certificate"
  Add-LocalMachineRootCertificate $trustedCa $certificates.CaPath

  Set-AcceptanceStage "starting-https-fixture"
  $fixtureConfig = [ordered]@{
    candidateVersion = $CandidateVersion
    manifestUrl = $candidateManifestUrl
    installerUrl = $candidateInstallerUrl
    manifestPath = $candidateManifestPath
    installerPath = $candidateInstallerPath
    certificatePath = $certificates.CertificatePath
    privateKeyPath = $certificates.PrivateKeyPath
    statePath = $fixtureStatePath
  }
  [IO.File]::WriteAllText(
    $fixtureConfigPath,
    ($fixtureConfig | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
  )
  $fixtureProcess = Start-JavaScriptFixture $runtime $fixtureScript $fixtureConfigPath
  $fixtureReady = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-ProcessExited $fixtureProcess) { throw "HTTPS fixture exited before readiness" }
    $fixtureState = Read-FixtureState $fixtureStatePath
    if ($fixtureState -and $fixtureState.ready -eq $true) {
      $fixtureReady = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $fixtureReady) { throw "HTTPS fixture did not become ready" }

  Set-AcceptanceStage "mapping-github-hosts"
  $hostsOriginalBytes = [IO.File]::ReadAllBytes($hostsPath)
  Assert-NoGithubHostsMapping $hostsOriginalBytes
  $hostsChanged = $true
  Set-GithubLoopbackHosts $hostsPath $hostsOriginalBytes "aliasmode-update-acceptance-$runId"
  Flush-DnsCache
  Assert-GithubResolvesToLoopback

  foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  [Environment]::SetEnvironmentVariable("ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG", "1", "Process")
  [Environment]::SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", $webViewRoot, "Process")

  Set-AcceptanceStage "starting-public-release"
  $publicDesktop = Start-StandardUserProcess $appPath
  $observations.standardUserTokenUsed = $true
  $oldRecord = Wait-DesktopReady $publicDesktop $publicVersion $appDataRoot $webViewRoot
  $observations.publicDesktopReady = $true

  Set-AcceptanceStage "creating-active-profile"
  $profile = Invoke-RestMethod "$($oldRecord.Origin)/ui/api/profiles" `
    -Method Post `
    -ContentType "application/json" `
    -Body '{"name":"in-app-update-preservation-sentinel"}' `
    -TimeoutSec 30 `
    -NoProxy
  if ($profile.ok -ne $true -or [string]::IsNullOrWhiteSpace([string]$profile.id)) {
    throw "public $publicVersion could not create the preservation profile"
  }
  $profileId = [string]$profile.id
  $profileName = "in-app-update-preservation-sentinel"
  $observations.profileCreated = $true
  $encodedProfileId = [Uri]::EscapeDataString($profileId)
  $opened = Invoke-RestMethod "$($oldRecord.Origin)/ui/api/profiles/$encodedProfileId/open" `
    -Method Post `
    -TimeoutSec 120 `
    -NoProxy
  if ($opened.ok -ne $true -or [int]$opened.port -le 0) {
    throw "public $publicVersion could not open the preservation browser"
  }
  $browserOwner = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$opened.port) -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  if ($browserOwner.Count -ne 1) { throw "preservation browser CDP owner was not unique" }
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $oldBrowserProcesses = @(Get-InstalledBrowserProcesses $installRoot)
    if ($oldBrowserProcesses.Count -gt 0 -and
        @($oldBrowserProcesses | Where-Object { $_.Id -eq $browserOwner[0] }).Count -eq 1) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if ($oldBrowserProcesses.Count -eq 0 -or
      @($oldBrowserProcesses | Where-Object { $_.Id -eq $browserOwner[0] }).Count -ne 1) {
    throw "installed preservation browser process tree was not found"
  }
  $oldRoster = Invoke-RestMethod "$($oldRecord.Origin)/ui/api/profiles" -TimeoutSec 30 -NoProxy
  $oldProfile = @($oldRoster.profiles | Where-Object { $_.id -eq $profileId -and $_.name -eq $profileName })
  if ($oldProfile.Count -ne 1 -or $oldProfile[0].running -ne $true) {
    throw "preservation profile was not active before update"
  }
  $observations.activeBrowserStarted = $true
  $configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  $sentinelHash = (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash
  $localStatePath = Join-Path (Join-Path (Join-Path $appDataRoot "profiles") $profileId) "Local State"
  if (-not (Test-Path -LiteralPath $localStatePath -PathType Leaf)) {
    throw "active profile encryption state is missing"
  }
  $localState = [IO.File]::ReadAllText($localStatePath) | ConvertFrom-Json
  $encryptedKey = [string]$localState.os_crypt.encrypted_key
  if ([string]::IsNullOrWhiteSpace($encryptedKey)) {
    throw "active profile encryption key is missing"
  }
  $encryptedKeyHash = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($encryptedKey))
  )

  Set-AcceptanceStage "rejecting-stale-registration"
  $registrationBackup = [ordered]@{
    ManufacturerRoot = (Get-Item -LiteralPath $manufacturerKey).GetValue("")
    InstallLocation = (Get-ItemProperty -LiteralPath $uninstallKey -Name "InstallLocation").InstallLocation
    UninstallString = (Get-ItemProperty -LiteralPath $uninstallKey -Name "UninstallString").UninstallString
  }
  $staleRoot = Join-Path $runRoot "stale-installation"
  New-Item -ItemType Directory -Force $staleRoot | Out-Null
  Copy-Item -LiteralPath $appPath -Destination (Join-Path $staleRoot "AliasMode.exe")
  Copy-Item -LiteralPath (Join-Path $installRoot "uninstall.exe") -Destination (Join-Path $staleRoot "uninstall.exe")
  Set-Item -LiteralPath $manufacturerKey -Value $staleRoot
  Set-ItemProperty -LiteralPath $uninstallKey -Name "InstallLocation" -Value $staleRoot
  Set-ItemProperty -LiteralPath $uninstallKey -Name "UninstallString" -Value (Join-Path $staleRoot "uninstall.exe")
  $registrationChanged = $true
  $routesBeforeRejection = Get-SafeRouteCounts $fixtureStatePath
  Invoke-DesktopUiProbe `
    $runtime `
    $probeScript `
    $oldRecord.DebugPort `
    $oldRecord.Origin `
    $CandidateVersion `
    "click-update-and-wait-error"
  $observations.rootMismatchRejected = $true
  $observations.browserStayedActiveAfterRejection = @(
    $oldBrowserProcesses | Where-Object { -not (Test-ProcessExited $_) }
  ).Count -eq $oldBrowserProcesses.Count
  if ((Test-ProcessExited $oldRecord.App) -or
      (Test-ProcessExited $oldRecord.Sidecar) -or
      -not $observations.browserStayedActiveAfterRejection) {
    throw "stale registration rejection changed the active process tree"
  }
  $observations.installerDidNotStartAfterRejection =
    @(Get-CandidateUpdaterProcesses $CandidateVersion).Count -eq 0 -and
    -not (Test-Path -LiteralPath (Join-Path $appDataRoot "update-attempt.json") -PathType Leaf)
  if (-not $observations.installerDidNotStartAfterRejection) {
    throw "stale registration rejection reached the installer handoff"
  }
  $routesAfterRejection = Get-SafeRouteCounts $fixtureStatePath
  if ($routesAfterRejection.installer -le $routesBeforeRejection.installer) {
    throw "stale registration check ran before detached-signature verification"
  }

  Set-Item -LiteralPath $manufacturerKey -Value $registrationBackup.ManufacturerRoot
  Set-ItemProperty -LiteralPath $uninstallKey -Name "InstallLocation" -Value $registrationBackup.InstallLocation
  Set-ItemProperty -LiteralPath $uninstallKey -Name "UninstallString" -Value $registrationBackup.UninstallString
  $registrationChanged = $false

  Set-AcceptanceStage "clicking-visible-update"
  Invoke-DesktopUiProbe `
    $runtime `
    $probeScript `
    $oldRecord.DebugPort `
    $oldRecord.Origin `
    $CandidateVersion
  $observations.visibleUpdateClicked = $true

  Set-AcceptanceStage "waiting-for-candidate-relaunch"
  $candidateRecord = Wait-CandidateRelaunch `
    $appPath `
    $CandidateVersion `
    $appDataRoot `
    $oldRecord `
    $oldBrowserProcesses `
    $webViewRoot `
    $fixtureStatePath `
    $observations
  $observations.oldDesktopExited = Test-ProcessExited $oldRecord.App
  $observations.oldSidecarExited = Test-ProcessExited $oldRecord.Sidecar
  $observations.oldBrowserExited = @($oldBrowserProcesses | Where-Object { -not (Test-ProcessExited $_) }).Count -eq 0
  if (-not $observations.oldDesktopExited -or
      -not $observations.oldSidecarExited -or
      -not $observations.oldBrowserExited) {
    throw "public $publicVersion process tree survived update handoff"
  }
  if (@(Get-InstalledBrowserProcesses $installRoot).Count -ne 0) {
    throw "installed browser process survived update handoff"
  }
  $observations.candidateReady = $true

  Set-AcceptanceStage "verifying-candidate-window"
  $candidateRecord.App.Refresh()
  if ($candidateRecord.App.MainWindowHandle -eq 0) {
    throw "signed candidate window did not become visible"
  }
  $observations.candidateWindowReady = $true

  Set-AcceptanceStage "verifying-durable-update-result"
  Invoke-DesktopUiProbe `
    $runtime `
    $probeScript `
    $candidateRecord.DebugPort `
    $candidateRecord.Origin `
    $CandidateVersion `
    "verify-update-result" `
    $publicVersion
  $observations.durableSuccessVisible = $true

  Set-AcceptanceStage "verifying-candidate-state"
  $candidateAppPath = Get-ProcessPath $candidateRecord.App
  $observations.installPathPreserved = $candidateAppPath -and
    [IO.Path]::GetFullPath($candidateAppPath).Equals(
      [IO.Path]::GetFullPath($appPath),
      [StringComparison]::OrdinalIgnoreCase
    )
  $observations.dataRootPreserved = [IO.Path]::GetFullPath([string]$candidateRecord.Health.root).Equals(
    [IO.Path]::GetFullPath([string]$oldRecord.Health.root),
    [StringComparison]::OrdinalIgnoreCase
  )
  $observations.configPreserved = (Test-Path -LiteralPath $configPath -PathType Leaf) -and
    (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -eq $configHash
  $observations.sentinelPreserved = (Test-Path -LiteralPath $sentinelPath -PathType Leaf) -and
    (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash -eq $sentinelHash
  $newEncryptedKey = ""
  if (Test-Path -LiteralPath $localStatePath -PathType Leaf) {
    try {
      $newLocalState = [IO.File]::ReadAllText($localStatePath) | ConvertFrom-Json
      $newEncryptedKey = [string]$newLocalState.os_crypt.encrypted_key
    } catch {}
  }
  $newEncryptedKeyHash = if ([string]::IsNullOrWhiteSpace($newEncryptedKey)) {
    ""
  } else {
    [Convert]::ToHexString(
      [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($newEncryptedKey))
    )
  }
  $observations.encryptedStatePreserved = $newEncryptedKeyHash -eq $encryptedKeyHash
  $newRoster = Invoke-RestMethod "$($candidateRecord.Origin)/ui/api/profiles" -TimeoutSec 30 -NoProxy
  $newProfile = @($newRoster.profiles | Where-Object { $_.id -eq $profileId -and $_.name -eq $profileName })
  $observations.profilePreserved = $newProfile.Count -eq 1 -and $newProfile[0].running -ne $true
  if (-not $observations.installPathPreserved -or
      -not $observations.dataRootPreserved -or
      -not $observations.configPreserved -or
      -not $observations.sentinelPreserved -or
      -not $observations.encryptedStatePreserved -or
      -not $observations.profilePreserved) {
    throw "signed candidate did not preserve installed state"
  }

  $routeCounts = Get-SafeRouteCounts $fixtureStatePath
  if ($routeCounts.releaseList -lt 4 -or
      $routeCounts.manifest -lt 3 -or
      $routeCounts.installer -lt 2 -or
      $routeCounts.rejected -ne 0) {
    throw "HTTPS fixture did not observe only the required production requests"
  }
  Assert-NoPublicHealthReappears $appPath $oldRecord $candidateRecord
  $observations.publicHealthDidNotReappear = $true
  Set-AcceptanceStage "verified"
  $acceptanceSucceeded = $true
} catch {
  $primaryFailure = $_
} finally {
  $stageBeforeCleanup = $stage
  Set-AcceptanceStage "cleanup"
  $routeCounts = Get-SafeRouteCounts $fixtureStatePath

  if ($registrationChanged -and $registrationBackup) {
    try {
      Set-Item -LiteralPath $manufacturerKey -Value $registrationBackup.ManufacturerRoot
      Set-ItemProperty -LiteralPath $uninstallKey -Name "InstallLocation" -Value $registrationBackup.InstallLocation
      Set-ItemProperty -LiteralPath $uninstallKey -Name "UninstallString" -Value $registrationBackup.UninstallString
      $registrationChanged = $false
    } catch {
      $cleanupFailures.Add("registration restoration failed")
    }
  }

  foreach ($record in @($candidateRecord, $oldRecord)) {
    if ($record -and $record.App) {
      try { Stop-ProcessTree $record.App } catch { $cleanupFailures.Add("desktop process cleanup failed") }
    }
  }
  foreach ($browserProcess in $oldBrowserProcesses) {
    try { Stop-ProcessTree $browserProcess } catch { $cleanupFailures.Add("browser process cleanup failed") }
  }
  try {
    foreach ($updaterProcess in @(Get-CandidateUpdaterProcesses $CandidateVersion)) {
      Stop-ProcessTree $updaterProcess
    }
  } catch {
    $cleanupFailures.Add("updater process cleanup failed")
  }
  if ($fixtureProcess) {
    try { Stop-ProcessTree $fixtureProcess } catch { $cleanupFailures.Add("fixture process cleanup failed") }
  }

  try {
    foreach ($processRecord in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
      $belongsToAcceptance = $processRecord.ExecutablePath -and
        (Test-PathWithin ([string]$processRecord.ExecutablePath) $installRoot)
      if (-not $belongsToAcceptance -and $processRecord.CommandLine) {
        $belongsToAcceptance = $processRecord.CommandLine.Contains($runRoot, [StringComparison]::OrdinalIgnoreCase)
      }
      if ($belongsToAcceptance) {
        $process = Get-Process -Id $processRecord.ProcessId -ErrorAction SilentlyContinue
        if ($process) { Stop-ProcessTree $process }
      }
    }
  } catch {
    $cleanupFailures.Add("isolated process sweep failed")
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

  try {
    foreach ($updaterRoot in @(Get-ChildItem ([IO.Path]::GetTempPath()) -Directory `
      -Filter "AliasMode-$CandidateVersion-updater-*" -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $updaterRoot.FullName -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $cleanupFailures.Add("updater temporary state cleanup failed")
  }

  if ($hostsChanged -and $null -ne $hostsOriginalBytes) {
    try { [IO.File]::WriteAllBytes($hostsPath, $hostsOriginalBytes) } catch {
      $cleanupFailures.Add("hosts byte restoration failed")
    }
  }
  if ($hostsChanged) {
    try { Flush-DnsCache } catch { $cleanupFailures.Add("restored DNS flush failed") }
  }
  if ($caTrusted -and $trustedCa) {
    try { Remove-LocalMachineRootCertificate $trustedCa } catch {
      $cleanupFailures.Add("temporary CA cleanup failed")
    }
  }
  if ($trustedCa) { $trustedCa.Dispose() }

  foreach ($name in $environmentNames) {
    if ($savedEnvironment.ContainsKey($name)) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
  }

  foreach ($key in @($manufacturerKey, $uninstallKey)) {
    try { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue } catch {
      $cleanupFailures.Add("installer registration cleanup failed")
    }
  }

  foreach ($path in @($appDataRoot, $installRoot, $runRoot)) {
    try {
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $path)) { break }
        Start-Sleep -Milliseconds 250
      }
      if (Test-Path -LiteralPath $path) { throw "isolated acceptance state survived cleanup" }
    } catch {
      $cleanupFailures.Add("isolated state cleanup failed")
    }
  }
  $stage = $stageBeforeCleanup
}

$overallSuccess = $acceptanceSucceeded -and -not $primaryFailure -and $cleanupFailures.Count -eq 0
try {
  Write-SafeDiagnostics `
    $DiagnosticsPath `
    $stage `
    $overallSuccess `
    $publicVersion `
    $CandidateVersion `
    $routeCounts `
    $observations `
    $cleanupFailures.Count
} catch {
  $cleanupFailures.Add("safe diagnostics write failed")
  $overallSuccess = $false
}

if ($primaryFailure) {
  if ($cleanupFailures.Count -gt 0) {
    throw "$($primaryFailure.Exception.Message); acceptance cleanup also failed in $($cleanupFailures.Count) area(s)"
  }
  throw $primaryFailure
}
if ($cleanupFailures.Count -gt 0) {
  throw "Windows updater acceptance cleanup failed in $($cleanupFailures.Count) area(s)"
}

Write-Host "Windows in-app updater acceptance passed: $publicVersion -> $CandidateVersion"
Write-Host "Safe route counts: release-list=$($routeCounts.releaseList) manifest=$($routeCounts.manifest) installer=$($routeCounts.installer) rejected=$($routeCounts.rejected)"

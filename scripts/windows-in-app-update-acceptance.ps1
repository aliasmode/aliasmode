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
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public sealed class AliasModeAcceptanceUserSession : IDisposable {
  private const int Logon32LogonInteractive = 2;
  private const int Logon32ProviderDefault = 0;
  private const int ProfileNoUi = 1;
  private const uint CreateUnicodeEnvironment = 0x00000400;
  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const uint TokenQuery = 0x0008;
  private const int TokenTypeClass = 8;
  private const int TokenElevationTypeClass = 18;
  private const int TokenElevationClass = 20;
  private const int TokenLogonSidClass = 28;
  private const int TokenPrimary = 1;
  private const int TokenElevationTypeDefault = 1;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ProfileInfo {
    public int size;
    public int flags;
    public string userName;
    public string profilePath;
    public string defaultPath;
    public string serverName;
    public string policyPath;
    public IntPtr profile;
  }

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
  private struct SidAndAttributes {
    public IntPtr sid;
    public uint attributes;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LogonUser(
    string userName,
    string domain,
    string password,
    int logonType,
    int logonProvider,
    out IntPtr token
  );

  [DllImport("advapi32.dll", EntryPoint = "CreateProcessWithLogonW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessWithLogon(
    string userName,
    string domain,
    string password,
    uint logonFlags,
    string applicationName,
    StringBuilder commandLine,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

  [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
  private static extern bool GetTokenInteger(
    IntPtr token,
    int informationClass,
    ref int information,
    int informationLength,
    out int returnLength
  );

  [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
  private static extern bool GetTokenBuffer(
    IntPtr token,
    int informationClass,
    IntPtr information,
    int informationLength,
    out int returnLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LoadUserProfile(IntPtr token, ref ProfileInfo profileInfo);

  [DllImport("userenv.dll", SetLastError = true)]
  private static extern bool UnloadUserProfile(IntPtr token, IntPtr profile);

  [DllImport("userenv.dll", SetLastError = true)]
  private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

  [DllImport("userenv.dll", SetLastError = true)]
  private static extern bool DestroyEnvironmentBlock(IntPtr environment);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetUserProfileDirectory(
    IntPtr token,
    StringBuilder profileDirectory,
    ref uint size
  );

  [DllImport("userenv.dll", EntryPoint = "DeleteProfileW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool DeleteProfile(string sid, string profilePath, string computerName);

  private IntPtr token;
  private IntPtr profile;
  private IntPtr environment;
  private readonly string userName;
  private string password;
  private readonly Dictionary<string, string> environmentValues;

  private AliasModeAcceptanceUserSession(
    IntPtr token,
    IntPtr profile,
    IntPtr environment,
    string userName,
    string password,
    string sid,
    string profileDirectory,
    Dictionary<string, string> environmentValues
  ) {
    this.token = token;
    this.profile = profile;
    this.environment = environment;
    this.userName = userName;
    this.password = password;
    UserSid = sid;
    ProfileDirectory = profileDirectory;
    this.environmentValues = environmentValues;
  }

  public string UserSid { get; private set; }
  public string ProfileDirectory { get; private set; }

  private static int ReadTokenInteger(IntPtr token, int informationClass, string failure) {
    int value = 0;
    int returned;
    if (!GetTokenInteger(token, informationClass, ref value, sizeof(int), out returned)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), failure);
    }
    return value;
  }

  private static Dictionary<string, string> ReadEnvironment(IntPtr block) {
    Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    int offset = 0;
    while (true) {
      string entry = Marshal.PtrToStringUni(IntPtr.Add(block, offset * sizeof(char)));
      if (string.IsNullOrEmpty(entry)) break;
      offset += entry.Length + 1;
      int separator = entry.IndexOf('=', 1);
      if (separator > 0) values[entry.Substring(0, separator)] = entry.Substring(separator + 1);
    }
    return values;
  }

  private static string GetProfileDirectory(IntPtr token) {
    uint size = 0;
    GetUserProfileDirectory(token, null, ref size);
    if (size == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user profile path query failed");
    }
    StringBuilder path = new StringBuilder((int)size);
    if (!GetUserProfileDirectory(token, path, ref size)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user profile path query failed");
    }
    return Path.GetFullPath(path.ToString());
  }

  public static AliasModeAcceptanceUserSession Open(
    string userName,
    string password,
    string expectedSid
  ) {
    IntPtr token = IntPtr.Zero;
    IntPtr environment = IntPtr.Zero;
    ProfileInfo profileInfo = new ProfileInfo();
    bool profileLoaded = false;
    try {
      if (!LogonUser(
        userName,
        Environment.MachineName,
        password,
        Logon32LogonInteractive,
        Logon32ProviderDefault,
        out token
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user logon failed");
      }

      string sid;
      using (WindowsIdentity identity = new WindowsIdentity(token)) {
        sid = identity.User.Value;
        WindowsPrincipal principal = new WindowsPrincipal(identity);
        if (principal.IsInRole(WindowsBuiltInRole.Administrator)) {
          throw new InvalidOperationException("acceptance account is an administrator");
        }
      }
      if (!sid.Equals(expectedSid, StringComparison.OrdinalIgnoreCase) ||
          ReadTokenInteger(token, TokenElevationClass, "standard-user elevation query failed") != 0 ||
          ReadTokenInteger(token, TokenElevationTypeClass, "standard-user elevation type query failed") != TokenElevationTypeDefault ||
          ReadTokenInteger(token, TokenTypeClass, "standard-user token type query failed") != TokenPrimary) {
        throw new InvalidOperationException("acceptance account token is not a standard-user primary token");
      }

      profileInfo.size = Marshal.SizeOf<ProfileInfo>();
      profileInfo.flags = ProfileNoUi;
      profileInfo.userName = userName;
      if (!LoadUserProfile(token, ref profileInfo) || profileInfo.profile == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user profile load failed");
      }
      profileLoaded = true;
      if (!CreateEnvironmentBlock(out environment, token, false) || environment == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user environment creation failed");
      }
      Dictionary<string, string> values = ReadEnvironment(environment);
      foreach (string required in new[] { "LOCALAPPDATA", "APPDATA", "TEMP" }) {
        if (!values.ContainsKey(required) || string.IsNullOrWhiteSpace(values[required])) {
          throw new InvalidOperationException("standard-user environment is incomplete");
        }
      }
      return new AliasModeAcceptanceUserSession(
        token,
        profileInfo.profile,
        environment,
        userName,
        password,
        sid,
        GetProfileDirectory(token),
        values
      );
    } catch {
      if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
      if (profileLoaded) UnloadUserProfile(token, profileInfo.profile);
      if (token != IntPtr.Zero) CloseHandle(token);
      throw;
    }
  }

  public string GetEnvironmentVariable(string name) {
    string value;
    if (!environmentValues.TryGetValue(name, out value)) {
      throw new InvalidOperationException("standard-user environment variable is missing");
    }
    return value;
  }

  private IntPtr BuildEnvironment(string[] overrides) {
    Dictionary<string, string> values = new Dictionary<string, string>(environmentValues, StringComparer.OrdinalIgnoreCase);
    if (overrides != null) {
      foreach (string entry in overrides) {
        int separator = entry == null ? -1 : entry.IndexOf('=');
        if (separator <= 0) throw new ArgumentException("invalid standard-user environment override");
        values[entry.Substring(0, separator)] = entry.Substring(separator + 1);
      }
    }
    List<string> entries = new List<string>();
    foreach (KeyValuePair<string, string> entry in values) {
      entries.Add(entry.Key + "=" + entry.Value);
    }
    entries.Sort(StringComparer.OrdinalIgnoreCase);
    byte[] bytes = Encoding.Unicode.GetBytes(string.Join("\0", entries) + "\0\0");
    IntPtr block = Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes, 0, block, bytes.Length);
    return block;
  }

  public int Start(
    string fileName,
    string arguments,
    string currentDirectory,
    string desktop,
    string[] environmentOverrides
  ) {
    if (token == IntPtr.Zero || profile == IntPtr.Zero || environment == IntPtr.Zero) {
      throw new ObjectDisposedException("AliasModeAcceptanceUserSession");
    }
    ProcessInformation process = new ProcessInformation();
    IntPtr processEnvironment = IntPtr.Zero;
    try {
      processEnvironment = BuildEnvironment(environmentOverrides);
      StartupInfo startup = new StartupInfo();
      startup.cb = Marshal.SizeOf<StartupInfo>();
      startup.desktop = desktop;
      string commandName = "\"" + fileName + "\"";
      StringBuilder command = new StringBuilder(
        string.IsNullOrWhiteSpace(arguments) ? commandName : commandName + " " + arguments
      );
      if (!CreateProcessWithLogon(
        userName,
        Environment.MachineName,
        password,
        0,
        fileName,
        command,
        CreateUnicodeEnvironment,
        processEnvironment,
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
      if (processEnvironment != IntPtr.Zero) Marshal.FreeHGlobal(processEnvironment);
    }
  }

  public static string GetProcessOwnerSid(int processId) {
    IntPtr process = IntPtr.Zero;
    IntPtr token = IntPtr.Zero;
    try {
      process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
      if (process == IntPtr.Zero || !OpenProcessToken(process, TokenQuery, out token)) return null;
      using (WindowsIdentity identity = new WindowsIdentity(token)) {
        return identity.User == null ? null : identity.User.Value;
      }
    } catch {
      return null;
    } finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }

  public static string GetProcessLogonSid(int processId) {
    IntPtr process = IntPtr.Zero;
    IntPtr token = IntPtr.Zero;
    IntPtr buffer = IntPtr.Zero;
    try {
      process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
      if (process == IntPtr.Zero || !OpenProcessToken(process, TokenQuery, out token)) return null;
      int size = 0;
      GetTokenBuffer(token, TokenLogonSidClass, IntPtr.Zero, 0, out size);
      if (size <= 0) return null;
      buffer = Marshal.AllocHGlobal(size);
      if (!GetTokenBuffer(token, TokenLogonSidClass, buffer, size, out size) ||
          Marshal.ReadInt32(buffer) != 1) {
        return null;
      }
      SidAndAttributes entry = Marshal.PtrToStructure<SidAndAttributes>(
        IntPtr.Add(buffer, IntPtr.Size)
      );
      if (entry.sid == IntPtr.Zero) return null;
      SecurityIdentifier sid = new SecurityIdentifier(entry.sid);
      return sid.IsWellKnown(WellKnownSidType.LogonIdsSid) ? sid.Value : null;
    } catch {
      return null;
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }

  public static void DeleteProfileDirectory(string sid, string profilePath) {
    if (!DeleteProfile(sid, profilePath, null)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "standard-user profile deletion failed");
    }
  }

  public void Dispose() {
    Win32Exception failure = null;
    if (environment != IntPtr.Zero) {
      if (!DestroyEnvironmentBlock(environment)) {
        failure = new Win32Exception(Marshal.GetLastWin32Error(), "standard-user environment cleanup failed");
      }
      environment = IntPtr.Zero;
    }
    if (profile != IntPtr.Zero) {
      if (!UnloadUserProfile(token, profile) && failure == null) {
        failure = new Win32Exception(Marshal.GetLastWin32Error(), "standard-user profile unload failed");
      }
      profile = IntPtr.Zero;
    }
    if (token != IntPtr.Zero) {
      CloseHandle(token);
      token = IntPtr.Zero;
    }
    password = null;
    if (failure != null) throw failure;
  }
}

public sealed class AliasModeAcceptanceDesktopAccess : IDisposable {
  private const int SeWindowObject = 7;
  private const uint DaclSecurityInformation = 0x00000004;
  private const uint WindowStationAllAccess = 0x000F037F;
  private const uint DesktopAllAccess = 0x000F01FF;
  private const int GrantAccess = 1;
  private const int TrusteeIsSid = 0;
  private const int TrusteeIsUser = 1;
  private const int UoiName = 2;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Trustee {
    public IntPtr multipleTrustee;
    public int multipleTrusteeOperation;
    public int trusteeForm;
    public int trusteeType;
    public IntPtr name;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ExplicitAccess {
    public uint accessPermissions;
    public int accessMode;
    public uint inheritance;
    public Trustee trustee;
  }

  private sealed class SecurityRecord {
    public IntPtr handle;
    public IntPtr originalDacl;
    public IntPtr securityDescriptor;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetProcessWindowStation();

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetThreadDesktop(uint threadId);

  [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetUserObjectInformation(
    IntPtr handle,
    int index,
    StringBuilder information,
    uint length,
    out uint needed
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(
    IntPtr handle,
    int objectType,
    uint securityInformation,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(
    IntPtr handle,
    int objectType,
    uint securityInformation,
    IntPtr owner,
    IntPtr group,
    IntPtr dacl,
    IntPtr sacl
  );

  [DllImport("advapi32.dll", EntryPoint = "SetEntriesInAclW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint SetEntriesInAcl(
    int count,
    ref ExplicitAccess entries,
    IntPtr oldAcl,
    out IntPtr newAcl
  );

  [DllImport("advapi32.dll", EntryPoint = "ConvertStringSidToSidW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr memory);

  private SecurityRecord windowStation;
  private SecurityRecord desktop;

  private AliasModeAcceptanceDesktopAccess(SecurityRecord windowStation, SecurityRecord desktop, string desktopPath) {
    this.windowStation = windowStation;
    this.desktop = desktop;
    DesktopPath = desktopPath;
  }

  public string DesktopPath { get; private set; }

  private static string GetObjectName(IntPtr handle) {
    uint needed;
    GetUserObjectInformation(handle, UoiName, null, 0, out needed);
    if (needed == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "interactive desktop name query failed");
    }
    StringBuilder name = new StringBuilder((int)(needed / sizeof(char)) + 1);
    if (!GetUserObjectInformation(handle, UoiName, name, needed, out needed)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "interactive desktop name query failed");
    }
    return name.ToString();
  }

  private static SecurityRecord Grant(IntPtr handle, string sidText, uint access) {
    IntPtr owner;
    IntPtr group;
    IntPtr originalDacl;
    IntPtr sacl;
    IntPtr descriptor;
    uint result = GetSecurityInfo(
      handle,
      SeWindowObject,
      DaclSecurityInformation,
      out owner,
      out group,
      out originalDacl,
      out sacl,
      out descriptor
    );
    if (result != 0) throw new Win32Exception((int)result, "interactive desktop ACL query failed");

    IntPtr sid = IntPtr.Zero;
    IntPtr newAcl = IntPtr.Zero;
    try {
      if (!ConvertStringSidToSid(sidText, out sid)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "acceptance account SID conversion failed");
      }
      ExplicitAccess entry = new ExplicitAccess();
      entry.accessPermissions = access;
      entry.accessMode = GrantAccess;
      entry.inheritance = 0;
      entry.trustee.multipleTrustee = IntPtr.Zero;
      entry.trustee.multipleTrusteeOperation = 0;
      entry.trustee.trusteeForm = TrusteeIsSid;
      entry.trustee.trusteeType = TrusteeIsUser;
      entry.trustee.name = sid;
      result = SetEntriesInAcl(1, ref entry, originalDacl, out newAcl);
      if (result != 0) throw new Win32Exception((int)result, "interactive desktop ACL creation failed");
      result = SetSecurityInfo(
        handle,
        SeWindowObject,
        DaclSecurityInformation,
        IntPtr.Zero,
        IntPtr.Zero,
        newAcl,
        IntPtr.Zero
      );
      if (result != 0) throw new Win32Exception((int)result, "interactive desktop ACL grant failed");
      return new SecurityRecord {
        handle = handle,
        originalDacl = originalDacl,
        securityDescriptor = descriptor
      };
    } catch {
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
      throw;
    } finally {
      if (newAcl != IntPtr.Zero) LocalFree(newAcl);
      if (sid != IntPtr.Zero) LocalFree(sid);
    }
  }

  private static void Restore(SecurityRecord record) {
    if (record == null) return;
    try {
      uint result = SetSecurityInfo(
        record.handle,
        SeWindowObject,
        DaclSecurityInformation,
        IntPtr.Zero,
        IntPtr.Zero,
        record.originalDacl,
        IntPtr.Zero
      );
      if (result != 0) throw new Win32Exception((int)result, "interactive desktop ACL restoration failed");
    } finally {
      if (record.securityDescriptor != IntPtr.Zero) LocalFree(record.securityDescriptor);
      record.securityDescriptor = IntPtr.Zero;
    }
  }

  public static AliasModeAcceptanceDesktopAccess Open(string sid) {
    IntPtr stationHandle = GetProcessWindowStation();
    IntPtr desktopHandle = GetThreadDesktop(GetCurrentThreadId());
    if (stationHandle == IntPtr.Zero || desktopHandle == IntPtr.Zero) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "interactive desktop lookup failed");
    }
    SecurityRecord station = null;
    SecurityRecord desktop = null;
    try {
      station = Grant(stationHandle, sid, WindowStationAllAccess);
      desktop = Grant(desktopHandle, sid, DesktopAllAccess);
      return new AliasModeAcceptanceDesktopAccess(
        station,
        desktop,
        GetObjectName(stationHandle) + "\\" + GetObjectName(desktopHandle)
      );
    } catch {
      try {
        if (desktop != null) Restore(desktop);
      } finally {
        if (station != null) Restore(station);
      }
      throw;
    }
  }

  public void Dispose() {
    Exception failure = null;
    try {
      Restore(desktop);
    } catch (Exception error) {
      failure = error;
    } finally {
      desktop = null;
    }
    try {
      Restore(windowStation);
    } catch (Exception error) {
      if (failure == null) failure = error;
    } finally {
      windowStation = null;
    }
    if (failure != null) throw failure;
  }
}
'@

function Start-StandardUserProcess(
  $UserSession,
  $DesktopAccess,
  [string]$FilePath,
  [string]$Arguments = "",
  [hashtable]$EnvironmentOverrides = @{}
) {
  [string[]]$overrides = @($EnvironmentOverrides.GetEnumerator() | ForEach-Object {
    "$($_.Key)=$($_.Value)"
  })
  $processId = $UserSession.Start(
    $FilePath,
    $Arguments,
    [IO.Path]::GetDirectoryName($FilePath),
    $DesktopAccess.DesktopPath,
    $overrides
  )
  $process = [Diagnostics.Process]::GetProcessById($processId)
  [void]$process.Handle
  $ownerSid = [AliasModeAcceptanceUserSession]::GetProcessOwnerSid($processId)
  if (-not $ownerSid -or -not $ownerSid.Equals($UserSession.UserSid, [StringComparison]::OrdinalIgnoreCase)) {
    try { $process.Kill($true) } catch {}
    throw "standard-user process owner verification failed"
  }
  return $process
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

function Assert-ProcessOwner([Diagnostics.Process]$Process, [string]$ExpectedSid) {
  $ownerSid = [AliasModeAcceptanceUserSession]::GetProcessOwnerSid($Process.Id)
  if (-not $ownerSid -or -not $ownerSid.Equals($ExpectedSid, [StringComparison]::OrdinalIgnoreCase)) {
    throw "acceptance process used an unexpected Windows account"
  }
}

function Get-ProcessesOwnedBySid([string]$Sid) {
  $result = [Collections.Generic.List[Diagnostics.Process]]::new()
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    $ownerSid = [AliasModeAcceptanceUserSession]::GetProcessOwnerSid($process.Id)
    if ($ownerSid -and $ownerSid.Equals($Sid, [StringComparison]::OrdinalIgnoreCase)) {
      $result.Add($process)
    }
  }
  return @($result)
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

function Get-WebViewDebugPort([string]$WebViewRoot, [int]$ExpectedPort = 0) {
  if ($ExpectedPort -gt 0) { return $ExpectedPort }
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
  [string]$WebViewRoot,
  [int]$ExpectedDebugPort,
  [string]$ExpectedUserSid
) {
  Assert-ProcessOwner $DesktopProcess $ExpectedUserSid
  $sidecarSeen = $false
  $healthSeen = $false
  $debugPortSeen = $false
  $windowSeen = $false
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $deadline = [TimeSpan]::FromMinutes(3)
  while ($timer.Elapsed -lt $deadline) {
    if (Test-ProcessExited $DesktopProcess) {
      throw "installed public desktop exited before readiness"
    }
    $DesktopProcess.Refresh()
    if ($DesktopProcess.MainWindowHandle -ne 0) { $windowSeen = $true }
    $debugPort = Get-WebViewDebugPort `
      $WebViewRoot `
      $ExpectedDebugPort
    if ($debugPort -gt 0) { $debugPortSeen = $true }
    $sidecars = @(Get-ChildSidecars $DesktopProcess.Id)
    if ($sidecars.Count -gt 0) { $sidecarSeen = $true }
    foreach ($sidecar in $sidecars) {
      Assert-ProcessOwner $sidecar $ExpectedUserSid
      $healthRecord = Get-SidecarHealth $sidecar.Id
      if (-not $healthRecord) { continue }
      $healthSeen = $true
      if ($healthRecord.Health.version -ne $ExpectedVersion) {
        throw "installed public desktop reported an unexpected version"
      }
      if (-not [IO.Path]::GetFullPath([string]$healthRecord.Health.root).Equals(
        [IO.Path]::GetFullPath($ExpectedRoot),
        [StringComparison]::OrdinalIgnoreCase
      )) {
        throw "installed public desktop used an unexpected app-data root"
      }
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
  throw (
    "installed public desktop did not become ready " +
    "(sidecarSeen=$sidecarSeen; healthSeen=$healthSeen; " +
    "debugPortSeen=$debugPortSeen; windowSeen=$windowSeen)"
  )
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

function Get-CandidateUpdaterProcesses([string]$Version, [string]$TemporaryRoot) {
  $result = [Collections.Generic.List[Diagnostics.Process]]::new()
  $expectedName = "AliasMode-$Version-installer.exe"
  $expectedParentPrefix = "AliasMode-$Version-updater-"
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
  $UserSession,
  $DesktopAccess,
  [string]$ProbeRoot,
  [string]$RuntimePath,
  [string]$ScriptPath,
  [int]$DebugPort,
  [string]$DashboardOrigin,
  [string]$ExpectedCandidateVersion,
  [ValidateSet("click-update", "click-update-and-wait-error", "verify-update-result")]
  [string]$Action = "click-update",
  [string]$ExpectedSourceVersion = ""
) {
  $probeId = [Guid]::NewGuid().ToString("N")
  $inputPath = Join-Path $ProbeRoot "ui-probe-$probeId-input.json"
  $outputPath = Join-Path $ProbeRoot "ui-probe-$probeId-output.json"
  $probeInput = [ordered]@{
    endpoint = "http://127.0.0.1:$DebugPort"
    dashboardOrigin = $DashboardOrigin
    candidateVersion = $ExpectedCandidateVersion
    sourceVersion = $ExpectedSourceVersion
    action = $Action
  }
  [IO.File]::WriteAllText(
    $inputPath,
    ($probeInput | ConvertTo-Json -Compress),
    [Text.UTF8Encoding]::new($false)
  )
  $arguments = "`"$ScriptPath`" `"$inputPath`" `"$outputPath`""
  $process = Start-StandardUserProcess `
    $UserSession `
    $DesktopAccess `
    $RuntimePath `
    $arguments
  try {
    if (-not $process.WaitForExit(120000)) {
      Stop-ProcessTree $process
      throw "desktop UI probe timed out"
    }
    if ($process.ExitCode -ne 0) { throw "desktop UI probe failed" }
    try {
      $result = [IO.File]::ReadAllText($outputPath) | ConvertFrom-Json
    } catch {
      throw "desktop UI probe returned invalid output"
    }
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
    Remove-Item -LiteralPath $inputPath, $outputPath -Force -ErrorAction SilentlyContinue
  }
}

function Wait-CandidateRelaunch(
  [string]$AppPath,
  [string]$ExpectedCandidateVersion,
  [string]$ExpectedRoot,
  $OldRecord,
  [Diagnostics.Process[]]$OldBrowserProcesses,
  [string]$WebViewRoot,
  [int]$ExpectedDebugPort,
  [string]$FixtureStatePath,
  [string]$ExpectedUserSid,
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
      Assert-ProcessOwner $desktop $ExpectedUserSid
      if ($desktop.Id -ne $OldRecord.App.Id) { $Observations.candidateDesktopSeen = $true }
      foreach ($sidecar in @(Get-ChildSidecars $desktop.Id)) {
        Assert-ProcessOwner $sidecar $ExpectedUserSid
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
        $debugPort = Get-WebViewDebugPort `
          $WebViewRoot `
          $ExpectedDebugPort
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
  $SourceInstallerExitCode,
  $CleanupFailures
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
    sourceInstallerExitCode = $SourceInstallerExitCode
    cleanupFailures = @($CleanupFailures)
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
$certificateRoot = Join-Path $runRoot "tls"
$fixtureConfigPath = Join-Path $runRoot "fixture-config.json"
$fixtureStatePath = Join-Path $runRoot "fixture-state.json"
if ([string]::IsNullOrWhiteSpace($DiagnosticsPath)) {
  $DiagnosticsPath = Join-Path $env:RUNNER_TEMP "aliasmode-windows-updater-acceptance.json"
} else {
  $DiagnosticsPath = [IO.Path]::GetFullPath($DiagnosticsPath)
}
$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$acceptanceUserName = "amupd$($runId.Substring(0, 12))"
$acceptancePassword = "Aa1!$runId"
$acceptanceUserCreated = $false
$acceptanceUserSession = $null
$desktopAccess = $null
$desktopLogonAccess = $null
$acceptanceUserSid = $null
$acceptanceProfilePath = $null
$userRunRoot = $null
$userTempRoot = $null
$acceptanceDebugPort = 0
$installRoot = $null
$webViewRoot = $null
$appDataRoot = $null
$configPath = $null
$sentinelPath = $null
$appPath = $null
$manufacturerKey = $null
$uninstallKey = $null
$stagedSourceInstallerPath = $null
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
$sourceInstallerExitCode = $null
$observations = [ordered]@{
  publicInstallerVerified = $false
  sourceInstallerAppPresent = $false
  sourceInstallerRegistrationPresent = $false
  standardUserTokenUsed = $false
  publicDesktopReady = $false
  profileCreated = $false
  activeBrowserStarted = $false
  gpuSandboxExceptionUsed = $false
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
  New-Item -ItemType Directory -Force $runRoot, $certificateRoot | Out-Null
  if (@(Get-Process -Name "AliasMode" -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "runner has a pre-existing AliasMode process"
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

  Set-AcceptanceStage "creating-standard-user"
  $securePassword = ConvertTo-SecureString $acceptancePassword -AsPlainText -Force
  try {
    $acceptanceUser = New-LocalUser `
      -Name $acceptanceUserName `
      -Password $securePassword `
      -AccountNeverExpires `
      -PasswordNeverExpires `
      -UserMayNotChangePassword `
      -Description "AliasMode disposable updater acceptance"
  } finally {
    $securePassword.Dispose()
  }
  $acceptanceUserCreated = $true
  $acceptanceUserSid = $acceptanceUser.SID.Value
  $usersGroup = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"))
  $usersMembers = @(Get-LocalGroupMember -Group $usersGroup -ErrorAction SilentlyContinue)
  if (@($usersMembers | Where-Object { $_.SID.Value -eq $acceptanceUserSid }).Count -eq 0) {
    Add-LocalGroupMember -Group $usersGroup -Member $acceptanceUserName
  }
  $administratorsGroup = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
  if (@(Get-LocalGroupMember -Group $administratorsGroup | Where-Object {
    $_.SID.Value -eq $acceptanceUserSid
  }).Count -ne 0) {
    throw "acceptance account unexpectedly belongs to Administrators"
  }

  $acceptanceUserSession = [AliasModeAcceptanceUserSession]::Open(
    $acceptanceUserName,
    $acceptancePassword,
    $acceptanceUserSid
  )
  $desktopAccess = [AliasModeAcceptanceDesktopAccess]::Open($acceptanceUserSid)
  $acceptanceProfilePath = $acceptanceUserSession.ProfileDirectory
  $userLocalAppData = [IO.Path]::GetFullPath(
    $acceptanceUserSession.GetEnvironmentVariable("LOCALAPPDATA")
  )
  $userAppData = [IO.Path]::GetFullPath(
    $acceptanceUserSession.GetEnvironmentVariable("APPDATA")
  )
  $userTempRoot = [IO.Path]::GetFullPath(
    $acceptanceUserSession.GetEnvironmentVariable("TEMP")
  )
  foreach ($path in @($userLocalAppData, $userAppData, $userTempRoot)) {
    if (-not (Test-PathWithin $path $acceptanceProfilePath)) {
      throw "standard-user environment escaped its disposable profile"
    }
  }

  $userRunRoot = Join-Path $userTempRoot "aliasmode-in-app-update-$runId"
  $installRoot = Join-Path $userLocalAppData "AliasMode"
  $webViewRoot = Join-Path $userRunRoot "webview"
  $appDataRoot = Join-Path $userAppData "com.aliasmode.desktop"
  $configPath = Join-Path $appDataRoot "config.json"
  $sentinelPath = Join-Path $appDataRoot "in-app-update-sentinel.txt"
  $appPath = Join-Path $installRoot "AliasMode.exe"
  $manufacturerKey = "Registry::HKEY_USERS\$acceptanceUserSid\Software\aliasmode\AliasMode"
  $uninstallKey = "Registry::HKEY_USERS\$acceptanceUserSid\Software\Microsoft\Windows\CurrentVersion\Uninstall\AliasMode"
  if (-not (Test-Path -LiteralPath "Registry::HKEY_USERS\$acceptanceUserSid")) {
    throw "standard-user registry hive is not loaded"
  }
  foreach ($path in @($appDataRoot, $installRoot)) {
    if (Test-Path -LiteralPath $path) { throw "standard user has pre-existing AliasMode state" }
  }
  foreach ($key in @($manufacturerKey, $uninstallKey)) {
    if (Test-Path -LiteralPath $key) { throw "standard user has pre-existing AliasMode registration" }
  }

  New-Item -ItemType Directory -Force $userRunRoot, $webViewRoot | Out-Null
  $stagedSourceInstallerPath = Join-Path $userRunRoot $publicInstallerName
  Copy-Item -LiteralPath $SourceInstallerPath -Destination $stagedSourceInstallerPath
  if ((Get-FileHash -LiteralPath $stagedSourceInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
      $actualPublicChecksum) {
    throw "staged source installer SHA-256 mismatch"
  }
  $observations.publicInstallerVerified = $true

  Set-AcceptanceStage "installing-source-release"
  $install = Start-StandardUserProcess `
    $acceptanceUserSession `
    $desktopAccess `
    $stagedSourceInstallerPath `
    "/S"
  if (-not $install.WaitForExit(300000)) {
    Stop-ProcessTree $install
    throw "public $publicVersion installer timed out"
  }
  $sourceInstallerExitCode = $install.ExitCode
  $observations.sourceInstallerAppPresent = Test-Path -LiteralPath $appPath -PathType Leaf
  $observations.sourceInstallerRegistrationPresent =
    (Test-Path -LiteralPath $manufacturerKey) -and (Test-Path -LiteralPath $uninstallKey)
  if ($sourceInstallerExitCode -ne 0) {
    throw "public $publicVersion installer exited with code $sourceInstallerExitCode"
  }
  if (-not $observations.sourceInstallerAppPresent) {
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

  $debugPortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $debugPortProbe.Server.ExclusiveAddressUse = $true
    $debugPortProbe.Start()
    $acceptanceDebugPort = ([Net.IPEndPoint]$debugPortProbe.LocalEndpoint).Port
  } finally {
    $debugPortProbe.Stop()
  }
  if ($acceptanceDebugPort -le 0) { throw "WebView debug port allocation failed" }

  Set-AcceptanceStage "starting-public-release"
  $publicDesktop = Start-StandardUserProcess `
    $acceptanceUserSession `
    $desktopAccess `
    $appPath `
    "" `
    @{
      ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG = "1"
      ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT = "$acceptanceDebugPort"
      ALIASMODE_ACCEPTANCE_DISABLE_GPU_SANDBOX = "1"
      ALIASMODE_SESSION_LAUNCH = "0"
      GITHUB_ACTIONS = "true"
      WEBVIEW2_USER_DATA_FOLDER = $webViewRoot
    }
  $desktopLogonSid = [AliasModeAcceptanceUserSession]::GetProcessLogonSid(
    $publicDesktop.Id
  )
  if ([string]::IsNullOrWhiteSpace($desktopLogonSid)) {
    throw "standard-user desktop logon SID is unavailable"
  }
  $desktopLogonAccess = [AliasModeAcceptanceDesktopAccess]::Open(
    $desktopLogonSid
  )
  $observations.standardUserTokenUsed = $true
  $oldRecord = Wait-DesktopReady `
    $publicDesktop `
    $publicVersion `
    $appDataRoot `
    $webViewRoot `
    $acceptanceDebugPort `
    $acceptanceUserSid
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
    -TimeoutSec 190 `
    -NoProxy
  if ($opened.ok -ne $true -or [int]$opened.port -le 0) {
    throw "public $publicVersion could not open the preservation browser"
  }
  $browserOwner = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$opened.port) -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  if ($browserOwner.Count -ne 1) { throw "preservation browser CDP owner was not unique" }
  $browserCommandLine = [string](Get-CimInstance Win32_Process `
    -Filter "ProcessId = $($browserOwner[0])" `
    -ErrorAction Stop).CommandLine
  if (-not $browserCommandLine.Contains(
    "--disable-gpu-sandbox",
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "preservation browser did not use the acceptance GPU sandbox exception"
  }
  $observations.gpuSandboxExceptionUsed = $true
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
  foreach ($browserProcess in $oldBrowserProcesses) {
    Assert-ProcessOwner $browserProcess $acceptanceUserSid
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
  $staleRoot = Join-Path $userRunRoot "stale-installation"
  New-Item -ItemType Directory -Force $staleRoot | Out-Null
  Copy-Item -LiteralPath $appPath -Destination (Join-Path $staleRoot "AliasMode.exe")
  Copy-Item -LiteralPath (Join-Path $installRoot "uninstall.exe") -Destination (Join-Path $staleRoot "uninstall.exe")
  Set-Item -LiteralPath $manufacturerKey -Value $staleRoot
  Set-ItemProperty -LiteralPath $uninstallKey -Name "InstallLocation" -Value $staleRoot
  Set-ItemProperty -LiteralPath $uninstallKey -Name "UninstallString" -Value (Join-Path $staleRoot "uninstall.exe")
  $registrationChanged = $true
  $routesBeforeRejection = Get-SafeRouteCounts $fixtureStatePath
  Invoke-DesktopUiProbe `
    $acceptanceUserSession `
    $desktopAccess `
    $userRunRoot `
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
    @(Get-CandidateUpdaterProcesses $CandidateVersion $userTempRoot).Count -eq 0 -and
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
    $acceptanceUserSession `
    $desktopAccess `
    $userRunRoot `
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
    $acceptanceDebugPort `
    $fixtureStatePath `
    $acceptanceUserSid `
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
    $acceptanceUserSession `
    $desktopAccess `
    $userRunRoot `
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
  if ($userTempRoot) {
    try {
      foreach ($updaterProcess in @(Get-CandidateUpdaterProcesses $CandidateVersion $userTempRoot)) {
        Stop-ProcessTree $updaterProcess
      }
    } catch {
      $cleanupFailures.Add("updater process cleanup failed")
    }
  }
  if ($fixtureProcess) {
    try { Stop-ProcessTree $fixtureProcess } catch { $cleanupFailures.Add("fixture process cleanup failed") }
  }

  if ($acceptanceUserSid) {
    try {
      foreach ($process in @(Get-ProcessesOwnedBySid $acceptanceUserSid)) {
        Stop-ProcessTree $process
      }
    } catch {
      $cleanupFailures.Add("standard-user process sweep failed")
    }
  }

  if ($installRoot) {
    $uninstaller = Join-Path $installRoot "uninstall.exe"
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      try {
        if (-not $acceptanceUserSession -or -not $desktopAccess) {
          throw "standard-user cleanup context is unavailable"
        }
        $uninstall = Start-StandardUserProcess `
          $acceptanceUserSession `
          $desktopAccess `
          $uninstaller `
          "/S"
        if (-not $uninstall.WaitForExit(120000)) {
          Stop-ProcessTree $uninstall
          throw "uninstaller timed out"
        }
        if ($uninstall.ExitCode -ne 0) { throw "uninstaller exited nonzero" }
      } catch {
        $cleanupFailures.Add("installed app cleanup failed")
      }
    }
  }

  if ($userTempRoot) {
    try {
      foreach ($updaterRoot in @(Get-ChildItem $userTempRoot -Directory `
        -Filter "AliasMode-$CandidateVersion-updater-*" -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $updaterRoot.FullName -Recurse -Force -ErrorAction Stop
      }
    } catch {
      $cleanupFailures.Add("updater temporary state cleanup failed")
    }
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

  foreach ($key in @($manufacturerKey, $uninstallKey)) {
    if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
    try { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue } catch {
      $cleanupFailures.Add("installer registration cleanup failed")
    }
  }

  foreach ($path in @($appDataRoot, $installRoot, $userRunRoot, $runRoot)) {
    if ([string]::IsNullOrWhiteSpace([string]$path)) { continue }
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

  if ($acceptanceUserCreated) {
    try { Disable-LocalUser -Name $acceptanceUserName } catch {
      $cleanupFailures.Add("standard-user disable failed")
    }
  }
  if ($acceptanceUserSid) {
    try {
      foreach ($process in @(Get-ProcessesOwnedBySid $acceptanceUserSid)) {
        Stop-ProcessTree $process
      }
      if (@(Get-ProcessesOwnedBySid $acceptanceUserSid).Count -ne 0) {
        throw "standard-user process survived cleanup"
      }
    } catch {
      $cleanupFailures.Add("final standard-user process cleanup failed")
    }
  }
  if ($desktopLogonAccess) {
    try { $desktopLogonAccess.Dispose() } catch {
      $cleanupFailures.Add("interactive logon desktop ACL restoration failed")
    }
    $desktopLogonAccess = $null
  }
  if ($desktopAccess) {
    try { $desktopAccess.Dispose() } catch {
      $cleanupFailures.Add("interactive desktop ACL restoration failed")
    }
    $desktopAccess = $null
  }
  if ($acceptanceUserSession) {
    try { $acceptanceUserSession.Dispose() } catch {
      $cleanupFailures.Add("standard-user profile unload failed")
    }
    $acceptanceUserSession = $null
  }

  if ($acceptanceUserSid -and $acceptanceProfilePath) {
    $profileLoaded = $false
    try {
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $profileRecord = @(Get-CimInstance Win32_UserProfile `
          -Filter "SID = '$acceptanceUserSid'" `
          -ErrorAction SilentlyContinue)
        $profileLoaded = $profileRecord.Count -gt 0 -and $profileRecord[0].Loaded
        if (-not $profileLoaded) { break }
        Start-Sleep -Milliseconds 250
      }
      if ($profileLoaded) { throw "standard-user profile remained loaded" }
      [AliasModeAcceptanceUserSession]::DeleteProfileDirectory(
        $acceptanceUserSid,
        $acceptanceProfilePath
      )
      if ((Test-Path -LiteralPath $acceptanceProfilePath) -or
          @(Get-CimInstance Win32_UserProfile `
            -Filter "SID = '$acceptanceUserSid'" `
            -ErrorAction SilentlyContinue).Count -ne 0) {
        throw "standard-user profile survived deletion"
      }
    } catch {
      $cleanupFailures.Add("standard-user profile deletion failed")
    }
  }
  if ($acceptanceUserCreated) {
    try {
      Remove-LocalUser -Name $acceptanceUserName
      if (Get-LocalUser -Name $acceptanceUserName -ErrorAction SilentlyContinue) {
        throw "standard user survived removal"
      }
      $acceptanceUserCreated = $false
    } catch {
      $cleanupFailures.Add("standard-user account removal failed")
    }
  }
  $acceptancePassword = $null
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
    $sourceInstallerExitCode `
    $cleanupFailures
} catch {
  $cleanupFailures.Add("safe diagnostics write failed")
  $overallSuccess = $false
}

if ($primaryFailure) {
  if ($cleanupFailures.Count -gt 0) {
    throw "$($primaryFailure.Exception.Message); acceptance cleanup failed: $($cleanupFailures -join ', ')"
  }
  throw $primaryFailure
}
if ($cleanupFailures.Count -gt 0) {
  throw "Windows updater acceptance cleanup failed: $($cleanupFailures -join ', ')"
}

Write-Host "Windows in-app updater acceptance passed: $publicVersion -> $CandidateVersion"
Write-Host "Safe route counts: release-list=$($routeCounts.releaseList) manifest=$($routeCounts.manifest) installer=$($routeCounts.installer) rejected=$($routeCounts.rejected)"

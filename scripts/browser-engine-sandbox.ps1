param(
    [Parameter(Mandatory = $true)][string]$ProcessIds,
    [Parameter(Mandatory = $true)][int]$BrowserProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BrowserTokenProbe {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int needed);
    [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    public static int[] Inspect(int pid) {
        IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero, buffer = IntPtr.Zero;
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int size;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
            if (size <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            buffer = Marshal.AllocHGlobal(size);
            if (!GetTokenInformation(token, 25, buffer, size, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            int integrity = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            Marshal.FreeHGlobal(buffer);
            buffer = Marshal.AllocHGlobal(4);
            if (!GetTokenInformation(token, 29, buffer, 4, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int appContainer = Marshal.ReadInt32(buffer), lessPrivileged = 0, lessPrivilegedError = 0;
            if (appContainer != 0) {
                if (GetTokenInformation(token, 46, buffer, 4, out size)) lessPrivileged = Marshal.ReadInt32(buffer);
                else { lessPrivileged = -1; lessPrivilegedError = Marshal.GetLastWin32Error(); }
            }
            bool inJob;
            if (!IsProcessInJob(process, IntPtr.Zero, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new int[] {integrity, appContainer, inJob ? 1 : 0, lessPrivileged, lessPrivilegedError};
        } finally {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
}
'@
$processes = @($ProcessIds -split ',' | ForEach-Object { [ordered]@{ pid = [int]$_; role = 'renderer' } })
$processes += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $BrowserProcessId" |
    Where-Object { $_.CommandLine -like '*--utility-sub-type=network.mojom.NetworkService*' } |
    ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; role = 'network-service' } })
$results = @(
    foreach ($process in $processes) {
        $processId = $process.pid
        try {
            $facts = [BrowserTokenProbe]::Inspect($processId)
            [ordered]@{ pid = $processId; role = $process.role; integrityRid = $facts[0]; appContainer = [bool]$facts[1]; inJob = [bool]$facts[2]; lessPrivilegedAppContainer = $(if ($facts[3] -lt 0) { $null } else { [bool]$facts[3] }); lessPrivilegedQueryError = $facts[4] }
        } catch {
            [ordered]@{ pid = $processId; role = $process.role; error = $_.Exception.Message }
        }
    }
)
ConvertTo-Json -InputObject $results -Compress

$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $request.executable
$start.WorkingDirectory = $request.root
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($argument in $request.flags) { $start.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$result = [ordered]@{ started = $false; nativeErrorCode = $null; message = $null }
try {
    $result.started = $process.Start()
    $result.pid = $process.Id
} catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    $result.message = $cause.Message
    if ($cause -is [ComponentModel.Win32Exception]) { $result.nativeErrorCode = $cause.NativeErrorCode }
} finally {
    if ($result.started -and -not $process.HasExited) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        $result.cleanupExitCode = $LASTEXITCODE
    }
    $process.Dispose()
}
$result | ConvertTo-Json -Compress

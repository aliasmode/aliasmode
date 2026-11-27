# OS-level input for the gates on Windows (user32 SendInput; no automation in the browser). Needs an interactive
# desktop session (a GitHub-hosted runner has one; an SSH session does not).
# Usage: win-input.ps1 <command> [args]   (same commands as linux.sh, minus display-start/stop)
#   activate | open <url> | type <text> | key <combo...> | click <x> <y> | geometry | copytext <out.txt> [xfrac yfrac] | shot <out.png>
# Key names follow xdotool: ctrl+l, Return, Tab, space, Escape.
param([Parameter(Position = 0)][string]$Command, [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class GatesInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(25); }
  public static void Key(ushort vk, bool up) { var i = new INPUT { type = 1 }; i.ki.vk = vk; i.ki.flags = up ? 2u : 0u; Send(i); }
  public static void Char(char c) {
    foreach (var up in new[] { false, true }) { var i = new INPUT { type = 1 }; i.ki.scan = c; i.ki.flags = 4u | (up ? 2u : 0u); Send(i); }
  }
  public static void Click() {
    foreach (var f in new[] { 2u, 4u }) { var i = new INPUT { type = 0 }; i.mi.flags = f; Send(i); }
  }
}
'@
$VK = @{ ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; Return = 0x0D; enter = 0x0D; Tab = 0x09; space = 0x20; Escape = 0x1B; BackSpace = 0x08; Up = 0x26; Down = 0x28; Left = 0x25; Right = 0x27 }
function Press([string]$combo) {
  $codes = foreach ($part in $combo -split '\+') {
    if ($VK.ContainsKey($part)) { [uint16]$VK[$part] } elseif ($part.Length -eq 1) { [uint16][char]$part.ToUpper() } else { throw "unknown key $part" }
  }
  foreach ($c in $codes) { [GatesInput]::Key($c, $false) }
  [array]::Reverse($codes); foreach ($c in $codes) { [GatesInput]::Key($c, $true) }
  Start-Sleep -Milliseconds 80
}
function TypeText([string]$text) { foreach ($ch in $text.ToCharArray()) { [GatesInput]::Char($ch); Start-Sleep -Milliseconds 40 } }
function ClickAt([int]$x, [int]$y) { [void][GatesInput]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 200; [GatesInput]::Click() }
function Geometry { $r = New-Object GatesInput+RECT; [void][GatesInput]::GetWindowRect([GatesInput]::GetForegroundWindow(), [ref]$r); $r }

switch ($Command) {
  'activate' {
    $w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'chrome|firefox|aliasmode' -and [GatesInput]::IsWindowVisible($_.MainWindowHandle) } |
      Sort-Object StartTime | Select-Object -Last 1
    if (-not $w) { 'none'; break }
    # An Alt tap lets this process move the foreground window (Windows refuses it to background processes otherwise).
    # Only when the browser is not in front yet: an Alt tap into Firefox opens its menu bar, and the URL typed next
    # then picks menu items (h, t = Help > Troubleshooting Information).
    if ([GatesInput]::GetForegroundWindow() -ne $w.MainWindowHandle) { [GatesInput]::Key(0x12, $false); [GatesInput]::Key(0x12, $true) }
    [void][GatesInput]::ShowWindow($w.MainWindowHandle, 5); [void][GatesInput]::SetForegroundWindow($w.MainWindowHandle)
    "$($w.MainWindowHandle)"
  }
  'open' { Press 'ctrl+l'; Start-Sleep -Milliseconds 500; TypeText $Rest[0]; Start-Sleep -Milliseconds 300; Press 'Return' }
  'type' { TypeText ($Rest -join ' ') }
  'key' { foreach ($k in $Rest) { Press $k } }
  'click' { ClickAt ([int]$Rest[0]) ([int]$Rest[1]) }
  'geometry' { $r = Geometry; "$($r.Left) $($r.Top) $($r.Right - $r.Left) $($r.Bottom - $r.Top)" }
  'copytext' {
    $out = $Rest[0]; $fx = if ($Rest.Count -gt 1) { [double]$Rest[1] } else { 0.004 }; $fy = if ($Rest.Count -gt 2) { [double]$Rest[2] } else { 0.7 }
    $r = Geometry
    [System.Windows.Forms.Clipboard]::Clear()
    ClickAt ([int]($r.Left + ($r.Right - $r.Left) * $fx + 2)) ([int]($r.Top + ($r.Bottom - $r.Top) * $fy)); Start-Sleep -Milliseconds 300
    Press 'ctrl+a'; Start-Sleep -Milliseconds 300; Press 'ctrl+c'; Start-Sleep -Milliseconds 700
    [System.IO.File]::WriteAllText($out, [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding $false))
    [GatesInput]::Click()
  }
  'shot' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save($Rest[0], [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  }
  default { Write-Error "unknown command $Command"; exit 2 }
}

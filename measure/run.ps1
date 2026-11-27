param([string]$Out)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$W = Join-Path $env:RUNNER_TEMP 'bk'; New-Item -ItemType Directory -Force $W | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Get-Verified($url, $file, $sha) {
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $h = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $sha) { throw "sha256 mismatch for $file : $h" }
}
Get-Verified 'https://dl.google.com/release2/chrome/ad5qleimopvibikppaxug4hqzqyq_159.0.8154.33/159.0.8154.33_chrome_installer_uncompressed.exe' "$W\chrome.exe" '278ce6c0656bb487aebaf062157bd9d80c41e32e01225991f8f2a1c8e5fdfce0'
Get-Verified 'https://archive.mozilla.org/pub/firefox/releases/159.0.1/win64/en-US/Firefox%20Setup%20159.0.1.exe' "$W\ff.exe" '729af643b8e0a3809d6153a57a448cb96a01e6fa5e2e7ff782152ede6202eadd'
& 7z x -y "-o$W\chx" "$W\chrome.exe" | Out-Null
& 7z x -y "-o$W\ffx" "$W\ff.exe" | Out-Null
$chrome = "$W\chx\Chrome-bin\chrome.exe"; $firefox = "$W\ffx\core\firefox.exe"
if (!(Test-Path $chrome) -or !(Test-Path $firefox)) { throw 'extract failed' }

Add-Type -Namespace BK -Name SPI -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref uint c, uint d);
[DllImport("user32.dll", EntryPoint="SystemParametersInfo")] public static extern bool SystemParametersInfoSet(uint a, uint b, IntPtr c, uint d);
'@
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class BKDisp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DD { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Str; public int Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Id; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Key; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string d, uint i, ref DD dd, uint f);
  public static string Primary() { var dd = new DD(); dd.cb = Marshal.SizeOf(dd); for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++) { if ((dd.Flags & 4) != 0) return dd.Name; dd.cb = Marshal.SizeOf(dd); } return null; }
}
'@
function Get-State {
  $o = [ordered]@{}
  foreach ($p in @(@('FONTSMOOTHING',0x004A),@('FONTSMOOTHINGTYPE',0x200A),@('FONTSMOOTHINGCONTRAST',0x200C),@('FONTSMOOTHINGORIENTATION',0x2012))) { [uint32]$v = 0; [void][BK.SPI]::SystemParametersInfo($p[1], 0, [ref]$v, 0); $o[$p[0]] = $v }
  foreach ($h in 'HKCU','HKLM') { $k = "${h}:\SOFTWARE\Microsoft\Avalon.Graphics"; $o["${h}_Avalon"] = if (Test-Path $k) { @{ root = (Get-ItemProperty $k | Select-Object * -ExcludeProperty PS*); subkeys = @(Get-ChildItem $k -Recurse | ForEach-Object { @{ key = $_.PSChildName; values = (Get-ItemProperty $_.PSPath | Select-Object * -ExcludeProperty PS*) } }) } } else { 'absent' } }
  $o['primaryDisplay'] = [BKDisp]::Primary()
  $o['os'] = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version)
  $o['gpu'] = @(Get-CimInstance Win32_VideoController | ForEach-Object Name)
  $o
}
$disp = ([BKDisp]::Primary() -replace '^\\\\\.\\', ''); if (!$disp) { $disp = 'DISPLAY1' }
$avalon = "HKCU:\SOFTWARE\Microsoft\Avalon.Graphics\$disp"
$initial = Get-State
$initial | ConvertTo-Json -Depth 6 | Set-Content "$Out\initial-state.json"
$hadAvalon = Test-Path $avalon
if ($hadAvalon) { Write-Host "Avalon key already present at start" }

$env:BK_SCRATCH = $W
function Measure-State($name) {
  (Get-State) | ConvertTo-Json -Depth 6 | Set-Content "$Out\state-$name.json"
  & python -I "$here\harness.py" chrome $chrome "$here\cfg-chrome-default.json" "$Out\chrome-$name.json" 2
  & python -I "$here\harness.py" firefox $firefox "$here\cfg-firefox-default.json" "$Out\firefox-$name.json" 2
}
function Set-Avalon($vals) {
  if (Test-Path $avalon) { Remove-Item $avalon -Recurse -Force }
  New-Item -Force $avalon | Out-Null
  foreach ($k in $vals.Keys) { New-ItemProperty -Path $avalon -Name $k -Value $vals[$k] -PropertyType DWord -Force | Out-Null }
}

Measure-State 'base'
& python -I "$here\harness.py" chrome $chrome "$here\cfg-chrome-emul.json" "$Out\chrome-emul.json" 2
& python -I "$here\harness.py" firefox $firefox "$here\cfg-firefox-emul.json" "$Out\firefox-emul.json" 2

$sets = [ordered]@{
  'av-g2200-ec50-l100-px1'  = @{ GammaLevel = 2200; EnhancedContrastLevel = 50;  ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 1; GrayscaleEnhancedContrastLevel = 100 }
  'av-g2200-ec0-l100-px1'   = @{ GammaLevel = 2200; EnhancedContrastLevel = 0;   ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 0; GrayscaleEnhancedContrastLevel = 100 }
  'av-g2200-ec100-l100-px1' = @{ GammaLevel = 2200; EnhancedContrastLevel = 100; ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 1; GrayscaleEnhancedContrastLevel = 100 }
  'av-g2200-ec400-l100-px1' = @{ GammaLevel = 2200; EnhancedContrastLevel = 400; ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 2; GrayscaleEnhancedContrastLevel = 100 }
  'av-g1800-ec50-l100-px1'  = @{ GammaLevel = 1800; EnhancedContrastLevel = 50;  ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 1; GrayscaleEnhancedContrastLevel = 100 }
  'av-g1800-ec0-l100-px1'   = @{ GammaLevel = 1800; EnhancedContrastLevel = 0;   ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 0; GrayscaleEnhancedContrastLevel = 100 }
  'av-g1800-ec100-l100-px1' = @{ GammaLevel = 1800; EnhancedContrastLevel = 100; ClearTypeLevel = 100; PixelStructure = 1; TextContrastLevel = 1; GrayscaleEnhancedContrastLevel = 100 }
  'av-g2200-ec50-l50-px2'   = @{ GammaLevel = 2200; EnhancedContrastLevel = 50;  ClearTypeLevel = 50;  PixelStructure = 2; TextContrastLevel = 1; GrayscaleEnhancedContrastLevel = 100 }
  'av-g2200-ec50-l0-px1'    = @{ GammaLevel = 2200; EnhancedContrastLevel = 50;  ClearTypeLevel = 0;   PixelStructure = 1; TextContrastLevel = 1; GrayscaleEnhancedContrastLevel = 100 }
  'av-empty'                = @{}
  'av-only-gamma2200'       = @{ GammaLevel = 2200 }
}
foreach ($n in $sets.Keys) { Set-Avalon $sets[$n]; Measure-State $n }
if (Test-Path $avalon) { Remove-Item $avalon -Recurse -Force }

# SPI_SETFONTSMOOTHINGTYPE 0x200B (1 = standard, 2 = ClearType); SPI_SETFONTSMOOTHING 0x004B; SPI_SETFONTSMOOTHINGCONTRAST 0x200D. Flags 3 = update ini + broadcast.
[void][BK.SPI]::SystemParametersInfoSet(0x200B, 0, [IntPtr]1, 3); Measure-State 'standard-grayscale'
[void][BK.SPI]::SystemParametersInfoSet(0x200B, 0, [IntPtr]2, 3)
[void][BK.SPI]::SystemParametersInfoSet(0x004B, 0, [IntPtr]0, 3); Measure-State 'smoothing-off'
[void][BK.SPI]::SystemParametersInfoSet(0x004B, 1, [IntPtr]0, 3)
[void][BK.SPI]::SystemParametersInfoSet(0x2013, 0, [IntPtr]0, 3); Measure-State 'cleartype-bgr'
[void][BK.SPI]::SystemParametersInfoSet(0x2013, 0, [IntPtr]1, 3)
[void][BK.SPI]::SystemParametersInfoSet(0x200D, 0, [IntPtr]2200, 3); Measure-State 'gdi-contrast2200'
[void][BK.SPI]::SystemParametersInfoSet(0x200D, 0, [IntPtr]1200, 3)
Measure-State 'base-again'

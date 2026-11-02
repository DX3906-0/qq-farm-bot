# One-shot capture: dump ALL visible windows on the desktop (rect + cls + title)
# and save a full-screen PNG, so we can locate the QQ "pick an account" dialog
# that is CURRENTLY open. This does NOT wait for a new window -- it snapshots NOW.
#
# Usage (run from your own shell -- Works on a normal shell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-now.ps1
param([string]$OutFile = "")
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
if ($OutFile -eq "") { $OutFile = Join-Path $dir '_probe-now.txt' }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SnapW {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB c, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RR t);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct RR { public int L,T,R,B; }
}
'@

$pids = @{}
Get-Process | Where-Object { $_.ProcessName -match 'QQ|Tencent' } | ForEach-Object { $pids[[int]$_.Id] = $_.ProcessName }

$all = New-Object System.Collections.Generic.List[object]
$fg = [SnapW]::GetForegroundWindow()
$cb = {
  param($h,$l)
  [uint32]$p=0
  [SnapW]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null
  $t=New-Object System.Text.StringBuilder 512
  $c=New-Object System.Text.StringBuilder 256
  [SnapW]::GetWindowText($h,$t,512) | Out-Null
  [SnapW]::GetClassName($h,$c,256) | Out-Null
  $vis = [SnapW]::IsWindowVisible($h)
  $r=New-Object SnapW+RR
  [SnapW]::GetWindowRect($h,[ref]$r) | Out-Null
  $w=$r.R-$r.L; $ht=$r.B-$r.T
  $isQq = $pids.ContainsKey([int]$p)
  # record QQ windows always; also record any visible non-zero-size window
  if ($isQq -or ($vis -and $w -gt 0 -and $ht -gt 0)) {
    $script:Rows += [pscustomobject]@{
      Pid=[int]$p; Qq=$isQq; Vis=$vis; L=$r.L; T=$r.T; W=$w; H=$ht
      Fg=([int64]$h -eq [int64]$fg); Cls=$c.ToString(); Title=$t.ToString()
    }
  }
  return $true
}
$script:Rows = New-Object System.Collections.Generic.List[object]
[SnapW]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("== snapshot " + (Get-Date -Format 'HH:mm:ss') + " ==")
$lines.Add("desktop: $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width)x$([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)")
$lines.Add("-- all meaningful windows (count $($Rows.Count)) --")
foreach($w in $Rows){
  $tags = @()
  if($w.Fg){$tags += 'FG'}
  if($w.Qq){$tags += 'QQ'}
  if(-not $w.Vis){$tags += 'hiden'}
  $tag = ($tags -join ',')
  $cx=[int]($w.L+$w.W/2); $cy=[int]($w.T+[int]($w.H*0.6))
  $lines.Add(("[{0,-10}] pid={1,-6} rect=({2,4},{3,4} {4,4}x{5,4}) cls='{6}' title='{7}' center=({8},{9})" -f $tag,$w.Pid,$w.L,$w.T,$w.W,$w.H,$w.Cls,$w.Title,$cx,$cy))
}
# also list QQ processes with count
$lines.Add("-- QQ processes (count $($pids.Count)) --")
foreach($k in ($pids.Keys | Sort-Object)){ $lines.Add("  pid=$k $($pids[$k])") }
$lines | Out-File -FilePath $OutFile -Encoding utf8
Write-Output "written -> $OutFile"

# full-screen screenshot for manual inspection
$sc = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($sc.Width, $sc.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($sc.Location, [System.Drawing.Point]::Empty, $sc.Size)
$png = Join-Path $dir '_probe-screen.png'
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "screenshot -> $png"
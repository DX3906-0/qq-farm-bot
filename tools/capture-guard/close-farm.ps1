# Close the QQ Farm mini-program window after a successful code capture.
#
# SAFETY RULES (do not weaken -- killing the wrong window would log QQ out):
#   1. Only windows belonging to a QQ/Tencent process are considered.
#   2. The window title must match the farm keyword ("农场").
#   3. We only send WM_CLOSE (graceful close). We NEVER kill a process, so the
#      QQ client itself can never be taken down by a bad match.
#   4. With -DryRun nothing is closed; all candidate windows are just logged.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File close-farm.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File close-farm.ps1 -DryRun
param([string]$OutFile = "", [switch]$DryRun)
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
if ($OutFile -eq "") { $OutFile = Join-Path $dir '_close-farm.txt' }
$Log = New-Object System.Collections.Generic.List[string]

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FarmW {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB c, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RR t);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
  public struct RR { public int L,T,R,B; }
}
'@

$script:QQPids = @{}
Get-Process | Where-Object { $_.ProcessName -match 'QQ|Tencent' } |
  ForEach-Object { $script:QQPids[[int]$_.Id] = $_.ProcessName }
$Log.Add(("qq_processes={0}" -f $script:QQPids.Count))

function Get-Windows {
  $script:Rows = New-Object System.Collections.Generic.List[object]
  $cb = {
    param($h, $l)
    [uint32]$p = 0
    [FarmW]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    $t = New-Object System.Text.StringBuilder 512
    $c = New-Object System.Text.StringBuilder 256
    [FarmW]::GetWindowText($h, $t, 512) | Out-Null
    [FarmW]::GetClassName($h, $c, 256) | Out-Null
    $vis = [FarmW]::IsWindowVisible($h)
    $r = New-Object FarmW+RR
    [FarmW]::GetWindowRect($h, [ref]$r) | Out-Null
    $title = $t.ToString()
    $cls = $c.ToString()
    if ($vis -and $title -ne '') {
      $script:Rows += [pscustomobject]@{
        H     = [int64]$h
        Pid   = [int]$p
        Qq    = $script:QQPids.ContainsKey([int]$p)
        Cls   = $cls
        Title = $title
        W     = ($r.R - $r.L)
        Hgt   = ($r.B - $r.T)
      }
    }
    return $true
  }
  [FarmW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:Rows
}

# ---- 1. snapshot every visible titled window (for diagnostics) ----
$before = Get-Windows
$Log.Add(("visible_titled_windows={0}" -f $before.Count))
foreach ($w in $before) {
  $Log.Add(("  win pid={0} qq={1} cls='{2}' title='{3}' {4}x{5}" -f $w.Pid, $w.Qq, $w.Cls, $w.Title, $w.W, $w.Hgt))
}

# ---- 2. pick farm windows: QQ process AND title matches the farm keyword ----
# Keep this narrow on purpose. A wrong match must never hit the QQ main window.
# The keyword is built from char codes because a raw CJK literal in a BOM-less
# ps1 gets decoded as ANSI/GBK garbage by Windows PowerShell 5.1 and never
# matches (this bug made farm_matches=0 forever).
$farmKw = [string][char]0x519C + [char]0x573A  # "NONG CHANG" in CJK
$targets = @($before | Where-Object { $_.Qq -and $_.Title.Contains($farmKw) })
$Log.Add(("farm_matches={0}" -f $targets.Count))

if ($targets.Count -eq 0) {
  $Log.Add('no_farm_window_found (nothing was closed)')
  $Log | Out-File -FilePath $OutFile -Encoding utf8
  exit 2
}

if ($DryRun) {
  foreach ($w in $targets) { $Log.Add(("DRYRUN would close: pid={0} title='{1}'" -f $w.Pid, $w.Title)) }
  $Log | Out-File -FilePath $OutFile -Encoding utf8
  exit 0
}

# ---- 3. graceful close via WM_CLOSE only ----
$WM_CLOSE = 0x0010
foreach ($w in $targets) {
  $h = [IntPtr]$w.H
  $Log.Add(("closing pid={0} title='{1}'" -f $w.Pid, $w.Title))
  [FarmW]::SendMessage($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}

# ---- 4. verify they are gone ----
Start-Sleep -Milliseconds 1500
$after = Get-Windows
$still = @($after | Where-Object { $_.Qq -and $_.Title.Contains($farmKw) })
$Log.Add(("after_close remaining={0}" -f $still.Count))
foreach ($w in $still) { $Log.Add(("  still_open pid={0} title='{1}'" -f $w.Pid, $w.Title)) }

$Log | Out-File -FilePath $OutFile -Encoding utf8
if ($still.Count -eq 0) { exit 0 } else { exit 1 }

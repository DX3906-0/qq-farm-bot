# Minimal probe: watch for a NEW visible QQ window to appear (the account
# picker) and print its process id and rectangle. Intentionally tiny to
# isolate logic from UIA. Success here => we can then add UIA dump.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-watch.ps1 120 [-OutPath C:\path\out.txt]
param([int]$Seconds = 120, [string]$OutFile = "")
$ErrorActionPreference = 'SilentlyContinue'
if ($OutFile -eq "") { $OutFile = Join-Path $PSScriptRoot '_probe-picker.txt' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QW {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB c, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RR t);
  public struct RR { public int L,T,R,B; }
}
'@

function Get-Visible {
  $set = @{}
  Get-Process | Where-Object { $_.ProcessName -match '^QQ' } | ForEach-Object { $set[[int]$_.Id] = $true }
  $script:Set = $set
  $script:Vis = @()
  $cb = {
    param($h,$l)
    [uint32]$p=0
    [QW]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null
    if (-not $script:Set.ContainsKey([int]$p)) { return $true }
    $t=New-Object System.Text.StringBuilder 512
    $c=New-Object System.Text.StringBuilder 256
    [QW]::GetWindowText($h,$t,512)   | Out-Null
    [QW]::GetClassName($h,$c,256)   | Out-Null
    if (-not [QW]::IsWindowVisible($h)){ return $true }
    $r=New-Object QW+RR
    [QW]::GetWindowRect($h,[ref]$r) | Out-Null
    $w=$r.R-$r.L;$ht=$r.B-$r.T
    if($w -le 0 -or $ht -le 0){ return $true }
    $cn=$c.ToString()
    if($cn -match 'NotifyIcon|Message|MSCTF|PowerMessage|IME|GDI'){ return $true }
    $script:Vis += [pscustomobject]@{Pid=$p;L=$r.L;T=$r.T;W=$w;H=$ht;Cls=$cn;Title=$t.ToString()}
    return $true
  }
  [QW]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null
  return $script:Vis
}

$before = @{}
# baseline
$first = Get-Visible
foreach($w in $first){ $before["$($w.Cls)|$($w.L),$($w.T)"] = $true }
Write-Host ("baseline visible QQ windows: {0}" -f $first.Count)

$deadline = (Get-Date).AddSeconds($Seconds)
$result = @()
while((Get-Date) -lt $deadline){
  $now = Get-Visible
  foreach($w in $now){
    $k = "$($w.Cls)|$($w.L),$($w.T)"
    if(-not $before.ContainsKey($k)){
      $cx = [int]($w.L + ($w.W / 2))
      $cy = [int]($w.T + ($w.H * 0.6))
      $result += "PICKER_DETECTED"
      $result += ("new_visible_window pid={0} rect=({1},{2} {3}x{4}) cls='{5}' title='{6}'" -f $w.Pid,$w.L,$w.T,$w.W,$w.H,$w.Cls,$w.Title)
      $result += "estimated_click_center=($cx,$cy)"
      foreach($all in $now){
        $result += ("  all_visible pid={0} rect=({1},{2} {3}x{4}) cls='{5}'" -f $all.Pid,$all.L,$all.T,$all.W,$all.H,$all.Cls)
      }
      $result | Out-File -FilePath $OutFile -Encoding utf8
      Write-Host ""
      Write-Host ("NEW visible QQ window: pid={0} rect=({1},{2} {3}x{4}) cls='{5}' title='{6}'" -f $w.Pid,$w.L,$w.T,$w.W,$w.H,$w.Cls,$w.Title)
      Write-Host "PICKER_DETECTED -> $OutFile"
      exit 0
    }
  }
  Start-Sleep -Milliseconds 500
}
"timeout after ${Seconds}s: no new visible QQ window appeared" | Out-File -FilePath $OutFile -Encoding utf8
Write-Output "no new QQ window -> $OutFile"
exit 1
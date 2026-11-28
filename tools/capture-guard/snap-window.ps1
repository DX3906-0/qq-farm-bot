param(
    [int]$Hwnd = 0,
    [string]$OutFile = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapApi {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@ -ErrorAction SilentlyContinue

# Set Per-Monitor DPI awareness so GetWindowRect returns physical pixels
try { [SnapApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}
try { [SnapApi]::SetProcessDPIAware() | Out-Null } catch {}
try { [SnapApi]::SetProcessDpiAwareness(2) | Out-Null } catch {}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($OutFile)) { $OutFile = Join-Path $here "_snap-farm.png" }

# Find farm window if hwnd not given
if ($Hwnd -eq 0) {
    $procs = Get-Process -Name QQ,QQNT -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.MainWindowTitle -like "*农场*") {
            $Hwnd = $p.MainWindowHandle.ToInt32()
            break
        }
    }
}
if ($Hwnd -eq 0) {
    "NO_FARM_WINDOW" | Out-File (Join-Path $here "_snap-result.txt") -Encoding utf8
    exit 2
}

$r = New-Object SnapApi+RECT
[SnapApi]::GetWindowRect([IntPtr]$Hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$vis = [SnapApi]::IsWindowVisible([IntPtr]$Hwnd)
$fg = [SnapApi]::GetForegroundWindow().ToInt32()
$isFg = ($fg -eq $Hwnd)

$lines = @()
$lines += "hwnd=$Hwnd rect=($($r.Left),$($r.Top) ${w}x${h}) visible=$vis isForeground=$isFg"

if ($r.Right -le $r.Left -or $r.Bottom -le $r.Top) {
    $lines += "ZERO_SIZE"
    $lines | Out-File (Join-Path $here "_snap-result.txt") -Encoding utf8
    exit 3
}

# Method 1: PrintWindow (works even if occluded / off-screen)
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [SnapApi]::PrintWindow([IntPtr]$Hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
if (-not $ok) {
    $g.Clear([System.Drawing.Color]::Magenta)
    $lines += "PrintWindow_failed_using_screen_copy"
}
$g.Dispose()

$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$size = (Get-Item $OutFile).Length
$lines += "png=$OutFile bytes=$size"

# Also screen-copy version if on-screen
if ($r.Left -gt -100 -and $r.Top -gt -100) {
    $bmp2 = New-Object System.Drawing.Bitmap($w, $h)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp2.Size)
    $g2.Dispose()
    $out2 = $OutFile -replace '\.png$', '-screen.png'
    $bmp2.Save($out2, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp2.Dispose()
    $lines += "screen_png=$out2 bytes=$((Get-Item $out2).Length)"
}

$lines | Out-File (Join-Path $here "_snap-result.txt") -Encoding utf8

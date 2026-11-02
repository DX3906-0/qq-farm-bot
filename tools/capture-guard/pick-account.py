#!/usr/bin/env python3
"""
Auto-pick row in QQ NT "select account" dialog — DPI-aware, background clicks.

ROOT CAUSE of all previous failures (fixed here):
  The user's display scale is 125%. A non-DPI-aware Python process gets
  VIRTUALIZED coordinates from GetWindowRect (logical 320x320 at (608,272)),
  while the real physical window is 400x400 at (760,340). All legacy click
  coordinates computed against the logical 320x320 size never reached the
  physical OK button at y ~343-378. Fix: SetProcessDpiAwareness(2) at startup,
  then all coordinates are true physical pixels and background PostMessage
  clicks work reliably (verified 2026-09-05: DISMISSED=True).

Layout of the 400x400 dialog (from probe-picker.png screenshot):
  row 1 (default selected): radio at (47, 74),  row area y 55-100
  row 2:                    radio at (47, 127), row area y 110-145
  OK  button: center (219, 360)
  Cancel button: center (325, 360)

Coordinates below are FRACTIONS of the physical client size, so they also
hold at other DPI scales (e.g. 100% -> 320x320 physical).

No physical mouse is moved; no foreground is stolen. If the background
clicks somehow fail, a last-resort foreground keyboard fallback runs and
then restores the user's previous foreground window.

Usage:
  python pick-account.py [--row 2] [--qq-id 123456789] [--timeout 120] [--outfile _pick-result.txt]

--qq-id: 目标 QQ 号（来自面板账号 gid）。提供时会截图选号框并用 Windows OCR
         读取每行文本，找到显示该 QQ 号的行直接点它 —— 不依赖行顺序假设
         （历史事故：行顺序变化导致罗辑的 Code 写到了比尔希恩斯头上）。
         OCR 不可用或未匹配到时，退回 --row 行号模式。
"""
import argparse
import ctypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes

# === DPI awareness FIRST: real physical pixels everywhere after this ===
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi

# --- Win32 API signatures ---
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL

user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD

user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = wintypes.BOOL

user32.GetForegroundWindow.restype = wintypes.HWND
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL

user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

psapi.GetModuleBaseNameW.argtypes = [wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
psapi.GetModuleBaseNameW.restype = wintypes.DWORD

user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL

# SendInput (foreground keyboard last-resort only)
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]  # ULONG_PTR; not in wintypes on py3.13

class INPUT_I(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD),
                ("ii", INPUT_I)]

user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT

WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
MK_LBUTTON = 0x0001

VK_RETURN = 0x0D
VK_DOWN = 0x28

# --- Constants ---
QQ_PROCS = {'QQ', 'QQNT', 'QQApp', 'QQProtect', 'TencentQQ',
            'TencentDocs', 'WeChat', 'WeChatAppEx', 'WeChatUtility'}
TITLE_BLACKLIST = ['远程抓包工具', r'\.exe$', '此电脑', '文件资源管理器',
                   'Visual Studio', 'Code', 'Chrome', 'Edge', '文档',
                   'Downloads', 'Desktop', 'cmd', 'PowerShell', '终端',
                   'Terminal', '任务管理器']

# Click positions as FRACTIONS of the physical client rect (verified on the
# 400x400 dialog at 125% scale; fractions hold at other scales too).
# OK button (219,360)/400 is VERIFIED working (background PostMessage click).
# Row-2 single click at (100,127) did NOT switch selection (2026-09-05 user
# feedback: dialog closed but logged in the default row-1 account), so row 2
# now uses a multi-point sweep across the whole row area before clicking OK.
ROW2_SWEEP_FRACS = [
    (0.12, 0.32),   # radio dot
    (0.30, 0.32),   # nickname/text area
    (0.45, 0.32),   # text right part
    (0.12, 0.29),   # radio upper
    (0.12, 0.35),   # radio lower
    (0.30, 0.29),   # text upper
    (0.30, 0.35),   # text lower
    (0.60, 0.32),   # far text
]
OK_FRAC = (0.55, 0.90)            # OK button center (219,360)/400 — VERIFIED
OK_ALT_FRACS = [(0.45, 0.90), (0.60, 0.88), (0.50, 0.86), (0.55, 0.85)]

# --- Helpers ---
def get_window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ''
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value

_proc_cache = {}

def get_process_name(pid):
    if pid in _proc_cache:
        return _proc_cache[pid]
    name = None
    try:
        h = kernel32.OpenProcess(0x0400 | 0x0010, False, pid)
        if h:
            try:
                buf = ctypes.create_unicode_buffer(512)
                psapi.GetModuleBaseNameW(h, None, buf, 512)
                raw = buf.value
                if raw.lower().endswith('.exe'):
                    raw = raw[:-4]
                name = raw
            finally:
                kernel32.CloseHandle(h)
    except Exception:
        pass
    _proc_cache[pid] = name
    return name

def enum_qq_windows():
    fg = user32.GetForegroundWindow()
    cands = []

    @EnumWindowsProc
    def callback(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        pid = pid.value
        proc = get_process_name(pid)
        if proc not in QQ_PROCS:
            return True
        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls_buf, 256)
        if cls_buf.value != 'Chrome_WidgetWin_1':
            return True
        rc = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rc))
        w = rc.right - rc.left
        h = rc.bottom - rc.top
        # Physical 400x400 at 125% scale; 320x320 at 100%.
        if w < 280 or w > 500 or h < 280 or h > 500:
            return True
        title = get_window_title(hwnd)
        bad = False
        for b in TITLE_BLACKLIST:
            if b.startswith('\\'):
                if re.search(b, title):
                    bad = True
                    break
            elif title == b:
                bad = True
                break
        if bad:
            return True
        cands.append({
            'hwnd': hwnd, 'left': rc.left, 'top': rc.top,
            'width': w, 'height': h, 'pid': pid, 'proc': proc,
            'title': title, 'fg': hwnd == fg
        })
        return True

    user32.EnumWindows(callback, 0)
    return cands

def picker_still_exists(hwnd):
    for w in enum_qq_windows():
        if w['hwnd'] == hwnd:
            return True
    return False

def post_click(hwnd, x, y, log=None, tag=''):
    lp = ((int(y) & 0xFFFF) << 16) | (int(x) & 0xFFFF)
    user32.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lp)
    time.sleep(0.04)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.06)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)
    time.sleep(0.08)
    if log is not None:
        log.append(f'click{tag}({int(x)},{int(y)})')

def wait_for_dismissal(hwnd, attempts, delay):
    for _ in range(attempts):
        if not picker_still_exists(hwnd):
            return True
        time.sleep(delay)
    return False


# ---------------------------------------------------------------------------
# OCR: screenshot the picker with PrintWindow, then run Windows built-in OCR
# (zh-CN, offline) via PowerShell to get every text line with its pixel Y.
# All temp files live under %TEMP% (pure-ASCII paths) to dodge encoding bugs.
# ---------------------------------------------------------------------------
OCR_PS1 = r"""
param([int]$TargetHwnd, [string]$OutFile)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FarmSnap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
  # Must be DPI aware BEFORE GetWindowRect, otherwise coords are virtualized
  # (e.g. 1536x864 instead of 1920x1080 at 125% scale) and OCR Y mismatches.
  [FarmSnap]::SetProcessDpiAwareness(2) | Out-Null

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
  [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null

  $rect = New-Object FarmSnap+RECT
  [FarmSnap]::GetWindowRect([IntPtr]$TargetHwnd, [ref]$rect) | Out-Null
  $wd = $rect.Right - $rect.Left
  $ht = $rect.Bottom - $rect.Top
  if ($wd -le 0 -or $ht -le 0) { Set-Content -Path $OutFile -Value 'SNAP_FAIL'; exit 4 }

  $bmp = New-Object System.Drawing.Bitmap($wd, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [FarmSnap]::PrintWindow([IntPtr]$TargetHwnd, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc)
  $g.Dispose()

  # Upscale 3x before OCR: small QQ-number glyphs get badly misread at 1x
  # (e.g. 1000000001 -> 2S10290839). Output coords are divided back by 3 below.
  $zoom = 3
  $big = New-Object System.Drawing.Bitmap(($wd * $zoom), ($ht * $zoom))
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, ($wd * $zoom), ($ht * $zoom))
  $g2.Dispose()
  $bmp.Dispose()
  $bmp = $big

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $ms.Position = 0

  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    $zh = New-Object Windows.Globalization.Language('zh-CN')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zh)
  }
  if (-not $engine) { Set-Content -Path $OutFile -Value 'OCR_ENGINE_UNAVAILABLE'; exit 2 }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  # OCR coords are in DIPs; PNG saved by GDI+ carries ~96dpi so scale is 1:1,
  # but normalize anyway in case the decoder reports a different dpi.
  # Then divide by the 3x OCR upscale so output coords are client pixels.
  $scale = 1.0
  if ($bitmap.DpiX -gt 1) { $scale = $bitmap.DpiX / 96.0 }
  $scale = $scale / 3.0

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("IMG`t$wd`t$ht")
  foreach ($line in $result.Lines) {
    $minY = [double]::MaxValue; $maxB = 0.0
    foreach ($w in $line.Words) {
      $y0 = $w.BoundingRect.Y * $scale
      $y1 = ($w.BoundingRect.Y + $w.BoundingRect.Height) * $scale
      if ($y0 -lt $minY) { $minY = $y0 }
      if ($y1 -gt $maxB) { $maxB = $y1 }
    }
    $lines.Add("LINE`t$([math]::Round($minY,1))`t$([math]::Round($maxB,1))`t$($line.Text)")
  }
  Set-Content -Path $OutFile -Value $lines -Encoding UTF8
  exit 0
} catch {
  Set-Content -Path $OutFile -Value ("PS_ERROR`t" + $_.Exception.Message)
  exit 3
}
"""


def nick_keywords(nick):
    """Extract short match keys from a panel nickname for OCR line matching.

    "面壁者比尔·希恩斯" -> ["希恩斯", "比尔", "希恩", "比"]  (full parts first,
    then 2-char / 1-char heads — CJK OCR often drops the last glyph).
    """
    if not nick:
        return []
    s = re.sub(r'面壁者|执剑人|守护者', '', nick)
    parts = [p for p in re.split(r'[·•・.\uFF0E\u3002\s]+', s) if p]
    keys = []
    for p in parts:
        if len(p) >= 2 and p not in keys:
            keys.append(p)
        if len(p) >= 3 and p[:2] not in keys:
            keys.append(p[:2])
    return keys


def ocr_find_row_y(hwnd, qq_id, log, nick=''):
    """OCR the picker dialog; return the Y-center (client px) of the line
    that contains qq_id, or None if OCR fails / no match."""
    tmpdir = tempfile.mkdtemp(prefix='farmocr_')
    ps1 = os.path.join(tmpdir, 'farm_ocr.ps1')
    out = os.path.join(tmpdir, 'lines.txt')
    with open(ps1, 'w', encoding='ascii') as f:
        f.write(OCR_PS1)
    try:
        cmd = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
               '-File', ps1, '-TargetHwnd', str(hwnd), '-OutFile', out]
        subprocess.run(cmd, capture_output=True, timeout=30,
                       creationflags=0x08000000)  # CREATE_NO_WINDOW
        if not os.path.exists(out):
            log.append('ocr: no output file (timeout or ps crash)')
            return None
        with open(out, encoding='utf-8-sig') as f:
            txt = f.read()
        log.append('ocr_begin')
        img_h = 0
        target_ys = []
        # Match probes, best-first:
        #   1. nickname keywords  — CJK OCR is far more reliable than the
        #      10-digit QQ number rendered in tiny glyphs, AND the panel gid is
        #      a game id that differs from the QQ number shown in the dialog
        #      (e.g. gid=1000000003 vs dialog 1000000002) so gid often CANNOT
        #      match anything on screen;
        #   2. gid exact / homoglyph-normalized — still useful when it works.
        probes = [p for p in nick_keywords(nick) if p]
        probes += [qq_id] if qq_id else []
        if len(qq_id or '') >= 9:
            probes += [qq_id[:-1], qq_id[:-2]]
        # Shape-homoglyph normalization for digit strings OCR'd from small
        # glyphs: S->5 O->0 B->8 l/I->1 Z->2 G->6 T->7 q/g->9 ...
        HOMO = str.maketrans({
            'O': '0', 'o': '0', 'Q': '0', 'D': '0',
            'l': '1', 'I': '1', 'i': '1', '|': '1',
            'Z': '2', 'z': '2',
            'S': '5', 's': '5',
            'G': '6', 'T': '7', 'B': '8', 'g': '9', 'q': '9',
        })
        for ln in txt.splitlines():
            log.append('ocr| ' + ln)
            parts = ln.split('\t')
            if parts[0] == 'IMG' and len(parts) >= 3:
                img_h = int(float(parts[2]))
            elif parts[0] == 'LINE' and len(parts) >= 4:
                y0, y1 = float(parts[1]), float(parts[2])
                text = re.sub(r'\s+', '', parts[3])
                norm = text.translate(HOMO)
                if text not in ('', 'LOADING'):
                    for p in probes:
                        if p and (p in text or p in norm):
                            target_ys.append((y0 + y1) / 2.0)
                            log.append(f'ocr_hit probe={p!r} line={text!r}')
                            break
        log.append('ocr_end')
        if target_ys:
            yc = target_ys[0]
            if img_h > 0 and not (0 < yc < img_h):
                log.append(f'ocr_y_out_of_range={yc}')
                return None
            return yc
        return None
    except Exception as e:
        log.append(f'ocr_exception: {e}')
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

def try_dismiss_background(hwnd, rect, row, log, row_y_px=None):
    w, h = rect['width'], rect['height']

    def pt(frac):
        return (w * frac[0], h * frac[1])

    # OCR mode: we know the exact pixel Y of the target row — sweep the whole
    # row area (multi-point; repeated clicks on the same row are harmless),
    # ONLY THEN click OK once. Never click OK before the selection switched.
    if row_y_px is not None:
        pts = []
        for fx in (0.12, 0.30, 0.45, 0.60):
            for dy in (-12, 0, 12):
                pts.append((w * fx, row_y_px + dy))
        for (x, y) in pts:
            post_click(hwnd, x, y, log, tag='_ocr')
            time.sleep(0.18)
        time.sleep(0.4)
        for frac in [OK_FRAC] + OK_ALT_FRACS:
            x, y = pt(frac)
            post_click(hwnd, x, y, log, tag='_ok')
            if wait_for_dismissal(hwnd, 4, 0.15):
                return True
        return False

    # row 2: sweep the whole row area first (multi-point, repeated clicks on
    # the same row are harmless), ONLY THEN click OK once. Clicking OK before
    # the row switched would log in the default row-1 account — must avoid.
    if row == 2:
        for frac in ROW2_SWEEP_FRACS:
            x, y = pt(frac)
            post_click(hwnd, x, y, log, tag='_row2')
            time.sleep(0.25)
        # give the UI a moment to settle the selection switch
        time.sleep(0.4)
        for frac in [OK_FRAC] + OK_ALT_FRACS:
            x, y = pt(frac)
            post_click(hwnd, x, y, log, tag='_ok')
            if wait_for_dismissal(hwnd, 4, 0.15):
                return True
        return False

    # row 1 (default selected): just click OK, then alternates.
    for frac in [OK_FRAC] + OK_ALT_FRACS:
        x, y = pt(frac)
        post_click(hwnd, x, y, log, tag='_ok')
        if wait_for_dismissal(hwnd, 4, 0.15):
            return True
    return False

# --- Foreground fallback (last resort) ---
def restore_foreground(prev_hwnd):
    if not prev_hwnd:
        return
    try:
        cur = user32.GetForegroundWindow()
        cur_tid = user32.GetWindowThreadProcessId(cur, None)
        prev_tid = user32.GetWindowThreadProcessId(prev_hwnd, None)
        if cur_tid and prev_tid and cur_tid != prev_tid:
            user32.AttachThreadInput(cur_tid, prev_tid, True)
        user32.SetForegroundWindow(prev_hwnd)
        time.sleep(0.1)
        if cur_tid and prev_tid and cur_tid != prev_tid:
            user32.AttachThreadInput(cur_tid, prev_tid, False)
    except Exception:
        pass

def send_input_key(vk):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.ii.ki.wVk = vk
    inp.ii.ki.wScan = 0
    inp.ii.ki.dwFlags = 0
    inp.ii.ki.time = 0
    inp.ii.ki.dwExtraInfo = 0
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))
    time.sleep(0.06)
    inp.ii.ki.dwFlags = KEYEVENTF_KEYUP
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))
    time.sleep(0.06)

def try_dismiss_foreground(hwnd, row, log):
    prev = user32.GetForegroundWindow()
    try:
        cur = user32.GetForegroundWindow()
        cur_tid = user32.GetWindowThreadProcessId(cur, None)
        tgt_tid = user32.GetWindowThreadProcessId(hwnd, None)
        if cur_tid and tgt_tid and cur_tid != tgt_tid:
            user32.AttachThreadInput(cur_tid, tgt_tid, True)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.12)
        user32.BringWindowToTop(hwnd)
        time.sleep(0.1)
        if cur_tid and tgt_tid and cur_tid != tgt_tid:
            user32.AttachThreadInput(cur_tid, tgt_tid, False)
    except Exception as e:
        log.append(f'fg_activate_exception: {e}')

    if row == 2:
        send_input_key(VK_DOWN)
        log.append('fg_key_down')
    send_input_key(VK_RETURN)
    log.append('fg_key_return')

    dismissed = wait_for_dismissal(hwnd, 10, 0.15)
    log.append(f'after_fg_keys dismissed={dismissed}')

    restore_foreground(prev)
    return dismissed

# --- Main ---
parser = argparse.ArgumentParser()
parser.add_argument('--row', type=int, default=2)
parser.add_argument('--qq-id', dest='qq_id', type=str, default='',
                    help='target QQ number (panel gid); enables OCR exact-row matching')
parser.add_argument('--nick', dest='nick', type=str, default='',
                    help='target account nickname; CJK keyword match beats gid matching')
parser.add_argument('--timeout', type=int, default=120)
parser.add_argument('--outfile', type=str, default='')
args = parser.parse_args()

outfile = args.outfile or os.path.join(os.path.dirname(os.path.abspath(__file__)), '_pick-result.txt')
log = []
row = args.row

try:
    log.append(f'row_target={row} qq_id={args.qq_id or "unset"} nick={args.nick or "unset"} timeout={args.timeout}s dpi_aware=1 bg_click=1')

    deadline = time.time() + args.timeout
    picker = None
    while time.time() < deadline:
        cands = enum_qq_windows()
        for c in cands:
            log.append(f"cand pid={c['pid']} proc={c['proc']} rect=({c['left']},{c['top']} {c['width']}x{c['height']}) fg={c['fg']} title=[{c['title']}]")
        if cands:
            exact = next((c for c in cands if '选择账号' in c['title']), None)
            fg_hit = next((c for c in cands if c['fg']), None)
            picker = exact or fg_hit or cands[0]
            log.append(f"PICKER_FOUND pid={picker['pid']} proc={picker['proc']} rect=({picker['left']},{picker['top']} {picker['width']}x{picker['height']}) fg={picker['fg']}")
            break
        time.sleep(0.4)

    if picker is None:
        log.append('picker_not_detected_within_timeout')
        with open(outfile, 'w', encoding='utf-8') as f:
            f.write('\n'.join(log) + '\n')
        sys.exit(2)

    hwnd = picker['hwnd']
    log.append(f'picker_rect=({picker["left"]},{picker["top"]} {picker["width"]}x{picker["height"]})')

    # 优先 OCR 精确匹配行（昵称关键词 > QQ号/gid，行顺序无关）；失败退回 --row 行号模式
    row_y_px = None
    if args.qq_id or args.nick:
        row_y_px = ocr_find_row_y(hwnd, args.qq_id, log, nick=args.nick)
        if row_y_px is not None:
            log.append(f'ocr_matched_row_y={row_y_px} -> clicking this row')
        else:
            log.append('ocr_no_match -> fallback to --row mode')

    dismissed = try_dismiss_background(hwnd, picker, row, log, row_y_px=row_y_px)
    log.append(f'after_bg_clicks dismissed={dismissed}')

    if not dismissed:
        log.append('FALLBACK_FOREGROUND_KEYS')
        dismissed = try_dismiss_foreground(hwnd, row, log)
        log.append(f'after_fg_fallback dismissed={dismissed}')

    mode = 'ocr' if row_y_px is not None else f'row{row}'
    log.append(f'mode={mode} dismissed={dismissed}')
    with open(outfile, 'w', encoding='utf-8') as f:
        f.write('\n'.join(log) + '\n')
    sys.exit(0 if dismissed else 1)

except Exception as e:
    log.append(f'FATAL: {e}')
    import traceback
    log.append(traceback.format_exc())
    with open(outfile, 'w', encoding='utf-8') as f:
        f.write('\n'.join(log) + '\n')
    sys.exit(99)

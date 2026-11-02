@echo off
rem ============================================================
rem  NapCat guard - install / repair autostart (Startup folder)
rem  Repointed 2026-10-18 to napcat-code-guard.py (the LIVE guard).
rem  The old HKCU-Run key pointed at farm-capture-daemon.py which is
rem  DEPRECATED (proxy + mini-program + OCR path).
rem
rem  HOW THE PATH IS HANDLED
rem    The project path contains non-ASCII characters. It is resolved
rem    at RUNTIME via %~dp0 and handed to PowerShell through an
rem    environment variable (cmd stores env vars as UTF-16, so no
rem    codepage garbling can occur). PowerShell then writes the
rem    launcher as UTF-8 WITHOUT BOM - the exact format the working
rem    launcher already uses.
rem ============================================================
cd /d "%~dp0"

set PY=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\python.exe
set PYW=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe

if not exist "%PY%" goto nopy

rem hand the real runtime paths to PowerShell
set GUARD_DIR=%~dp0
set GUARD_PYW=%PYW%

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$dir = $env:GUARD_DIR.TrimEnd('\');" ^
 "$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup';" ^
 "$target = Join-Path $startup 'napcat-code-guard.bat';" ^
 "$nl = [char]13 + [char]10;" ^
 "$text = '@echo off' + $nl + 'rem napcat-code-guard autostart (Startup folder)' + $nl + 'start \"\" \"' + $env:GUARD_PYW + '\" \"' + $dir + '\napcat-code-guard.py\"' + $nl;" ^
 "$enc = New-Object System.Text.UTF8Encoding($false);" ^
 "[System.IO.File]::WriteAllText($target, $text, $enc);" ^
 "Write-Output ('installed: ' + $target);" ^
 "Get-Content -LiteralPath $target | ForEach-Object { Write-Output ('  ' + $_) }"

echo.
echo Done. The guard will start silently at next login.
echo To start it right now, double-click the start bat.
echo.
pause
exit /b 0

:nopy
echo ERROR: python.exe not found at %PY%
pause
exit /b 1

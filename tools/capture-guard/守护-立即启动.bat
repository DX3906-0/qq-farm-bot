@echo off
rem ============================================================
rem  NapCat guard - start (silent, background)
rem  Repointed 2026-10-18: the old target farm-capture-daemon.py is
rem  DEPRECATED (proxy + mini-program + OCR path). The live guard is
rem  napcat-code-guard.py (pure HTTP via NapCat host).
rem  Normally you do NOT need this file - the guard autostarts at
rem  login via the Startup folder. Kept for manual restart.
rem ============================================================
cd /d "%~dp0"

set PY=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\python.exe
set PYW=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe

if not exist "%PY%" goto nopy

echo Starting napcat-code-guard daemon (silent) ...
start "" "%PYW%" "%~dp0napcat-code-guard.py"
timeout /t 3 >nul
echo Done. Log: napcat_guard.log
echo.
pause
exit /b 0

:nopy
echo ERROR: python.exe not found at %PY%
pause
exit /b 1

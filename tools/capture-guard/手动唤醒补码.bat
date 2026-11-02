@echo off
rem ============================================================
rem  NapCat guard - MANUAL WAKE + ONE CODE-FIX PASS
rem
rem  WHY THIS FILE EXISTS
rem    The farm panel "Start" button only reuses the STALE code kept
rem    in store.json. Tencent already destroyed that code, so every
rem    click triggers an instant 1006 risk-control ban.
rem    The ONLY valid way to fix a dropped QQ account is this local
rem    NapCat guard chain. This script drives it for you.
rem
rem  WHAT IT DOES
rem    1) stop the running guard (so two scans cannot race)
rem    2) optionally clear the circuit breaker
rem    3) run ONE full scan:
rem         wake NapCat host on demand -> fetch fresh code
rem         -> push to farm -> release account back to your own QQ
rem    4) restart the guard in the background (silent)
rem
rem  USAGE: just double-click this file.
rem  The whole run takes about 1-3 minutes (host cold start is slow).
rem  Do NOT close the window while it says "Running one full fix pass".
rem ============================================================
cd /d "%~dp0"

set PY=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\python.exe
set PYW=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe

if not exist "%PY%" goto nopy

echo ============================================
echo   NapCat guard - manual wake + fix
echo ============================================
echo.

if exist ".napcat-guard-circuit.json" (
    echo Current circuit breaker state:
    "%PY%" -c "import json;d=json.load(open('.napcat-guard-circuit.json',encoding='utf-8'));print('  manual (needs human scan) =',d.get('manual'));print('  pausedUntil               =',d.get('pausedUntil'));print('  nextOk (cooldown)         =',d.get('nextOk'))"
    echo.
)

echo Did the log say "manual scan" or "circuit tripped"?
echo   [1] No  - normal fix  (try this first)
echo   [2] Yes - clear breaker first
set /p CH="Choose 1 or 2 [1]: "
if "%CH%"=="" set CH=1
echo.

echo [1/4] Stopping the running guard ...
"%PY%" napcat-code-guard.py --stop
echo.

if "%CH%"=="2" goto doreset
echo [2/4] Circuit reset: SKIPPED
goto afterreset

:doreset
echo [2/4] Clearing the circuit breaker ...
"%PY%" napcat-code-guard.py --reset
goto afterreset

:afterreset
echo.

echo [3/4] Running one full fix pass. Output follows ...
echo       (this can take 1-3 minutes - please wait)
echo.
"%PY%" napcat-code-guard.py --once
echo.

echo [4/4] Restarting the guard in the background ...
if exist "%~dp0_launch-guard-now.vbs" (
    explorer.exe "%~dp0_launch-guard-now.vbs"
) else (
    start "" "%PYW%" "%~dp0napcat-code-guard.py"
)
timeout /t 3 >nul
echo.
echo Done. Full details: napcat_guard.log
echo.
pause
exit /b 0

:nopy
echo ERROR: python.exe not found at %PY%
pause
exit /b 1

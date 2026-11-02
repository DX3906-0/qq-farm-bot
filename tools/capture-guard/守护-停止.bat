@echo off
rem ============================================================
rem  NapCat guard - stop
rem  Repointed 2026-10-18 to napcat-code-guard.py (the live guard).
rem  NOTE: the circuit breaker is kept IN MEMORY. Stopping the guard
rem  is required before "manual wake + reset" can take effect.
rem ============================================================
cd /d "%~dp0"

set PY=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\python.exe

if not exist "%PY%" goto nopy

echo Stopping napcat-code-guard daemon ...
"%PY%" napcat-code-guard.py --stop
echo.
pause
exit /b 0

:nopy
echo ERROR: python.exe not found at %PY%
pause
exit /b 1

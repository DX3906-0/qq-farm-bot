@echo off
rem =========================================
rem  napcat-code-guard - stop (silent daemon)
rem  Stop the running NapCat code guard
rem =========================================
cd /d "%~dp0"

set PY=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\python.exe

if not exist "%PY%" goto nopy

echo Stopping napcat-code-guard daemon ...
"%PY%" napcat-code-guard.py --stop
goto end

:nopy
echo ERROR: python.exe not found at %PY%
pause
exit /b 1

:end
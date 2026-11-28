@echo off
rem =========================================
rem  napcat-code-guard - stop (silent daemon)
rem  Stop the running NapCat code guard
rem =========================================
cd /d "%~dp0"

if not defined FARM_PYTHON set FARM_PYTHON=python
set "PY=%FARM_PYTHON%"

where "%PY%" >nul 2>nul
if errorlevel 1 goto nopy

echo Stopping napcat-code-guard daemon ...
"%PY%" napcat-code-guard.py --stop
goto end

:nopy
echo ERROR: python.exe not found at %PY%
pause
exit /b 1

:end
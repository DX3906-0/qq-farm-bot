@echo off
rem =========================================
rem  napcat-code-guard - start (silent daemon)
rem  Start the NapCat code guard in the background
rem =========================================
cd /d "%~dp0"

set PY=C:\Users\HP\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe

if not exist "%PY%" goto nopy

echo Starting napcat-code-guard daemon ...
start "" "%PY%" "napcat-code-guard.py"
timeout /t 2 >nul
echo Done. Check napcat_guard.log for output.
goto end

:nopy
echo ERROR: pythonw.exe not found at %PY%
pause
exit /b 1

:end
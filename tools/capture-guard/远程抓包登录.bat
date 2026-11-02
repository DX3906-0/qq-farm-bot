@echo off
cd /d "%~dp0"
echo ============================================
echo   Remote Capture Login Tool
echo ============================================
echo.
echo Normal usage: just double-click this file (config auto-loaded).
echo Fully automatic: no manual confirm needed.
echo   - target account auto-inferred (offline / recently kicked / first)
echo   - pick-account dialog auto-clicked by OCR-matching the QQ number
echo   - capture auto-confirmed (fallback --ask-confirm restores manual mode)
echo.
echo Extra options:
echo   远程抓包登录.bat --cert-only          (download CA cert only)
echo   远程抓包登录.bat --restore-proxy      (restore system proxy)
echo   远程抓包登录.bat --timeout 120        (custom wait seconds)
echo   远程抓包登录.bat --no-open            (don't auto-open QQ Farm; manual instead)
echo   远程抓包登录.bat --open "x.lnk"       (specify the shortcut to launch)
echo   远程抓包登录.bat --restart-qq         (kill QQ first to force re-login)
echo   远程抓包登录.bat --ask-confirm        (ask y/n before writing the Code)
echo   远程抓包登录.bat --no-close-farm      (keep QQ Farm mini-program open after done)
echo.
echo Logs:
echo   _pick-result.txt   (OCR lines + click log of the pick-account dialog)
echo   _activate-farm.log (farm window loading/keep-alive log)
echo.
node remote-capture.js --panel http://YOUR_PANEL_HOST:3007 --user admin --pass "$FARM_PANEL_PASS" %* --probe-account --pick-account
exit /b %ERRORLEVEL%

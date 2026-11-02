@echo off
rem Uninstall autostart: remove HKCU Run key
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'QQFarmCaptureDaemon' -ErrorAction SilentlyContinue;" ^
 "if ((Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').'QQFarmCaptureDaemon') { Write-Output 'still registered' } else { Write-Output 'autostart removed' }"
echo.
echo Done.
pause

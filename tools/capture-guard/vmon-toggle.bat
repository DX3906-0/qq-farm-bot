@echo off
REM Toggle Parsec / Virtual Monitor / Sharing Monitor display adapters.
REM MUST run as Administrator (right-click -> Run as admin).
REM If enabled -> disable (no black-screen on boot); if disabled -> enable (for streaming).
powershell -NoProfile -Command "Get-PnpDevice | Where-Object { $_.Name -match 'Parsec Virtual Display|Virtual Monitor|Sharing Monitor' } | ForEach-Object { if ($_.Status -eq 'OK') { Disable-PnpDevice -InputObject $_ -Confirm:$false; Write-Host ('disabled: ' + $_.Name) } else { Enable-PnpDevice -InputObject $_ -Confirm:$false; Write-Host ('enabled: ' + $_.Name) } }"
pause

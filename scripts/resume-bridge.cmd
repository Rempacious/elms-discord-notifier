rem Re-enables the eLMS bridge tasks after a temporary pause.
rem Used by the one-shot "eLMS Resume Bridge" scheduled task.
@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
schtasks /Change /TN "eLMS Discord Notifier" /ENABLE >nul 2>&1
schtasks /Change /TN "eLMS Daily Digest" /ENABLE >nul 2>&1
echo [%DATE% %TIME%] bridge re-enabled >> logs\resume.log
endlocal

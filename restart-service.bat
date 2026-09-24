@echo off
title Ahead Local Server - Restart Service
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c `\"`\"%~dp0restart-service.bat`\"`\"' -Verb RunAs"
    exit /b
)

echo Restarting AheadLocalServer service...
schtasks /end /tn "AheadLocalServer" >nul 2>&1
timeout /t 2 /nobreak >nul
schtasks /run /tn "AheadLocalServer" >nul 2>&1
timeout /t 5 /nobreak >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-status.ps1"
echo.
pause

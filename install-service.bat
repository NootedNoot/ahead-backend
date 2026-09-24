@echo off
title Ahead Local Server - Auto-Start Installer
cd /d "%~dp0"

:: Check for Administrator privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ==========================================================
    echo    Requesting Administrator Privileges...
    echo ==========================================================
    echo Windows requires administrator permission to register a
    echo boot service that runs before user login (NT AUTHORITY\SYSTEM).
    echo.
    powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c `\"`\"%~dp0install-service.bat`\"`\"' -Verb RunAs"
    exit /b
)

:: Run the registration PowerShell script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-task.ps1"
echo.
echo Press any key to close this window...
pause >nul

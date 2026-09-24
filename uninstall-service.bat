@echo off
title Ahead Local Server - Uninstaller
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c `\"`\"%~dp0uninstall-service.bat`\"`\"' -Verb RunAs"
    exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0unregister-task.ps1"
echo.
pause

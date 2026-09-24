@echo off
title Ahead Local Server - Status Monitor
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-status.ps1"
echo.
pause

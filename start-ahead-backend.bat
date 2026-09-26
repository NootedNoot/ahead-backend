@echo off
title Ahead Backend Server
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-ahead.ps1"
pause

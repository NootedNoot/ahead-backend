# Unregisters AheadLocalServer Scheduled Task and stops any running processes.
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

$TaskName = "AheadLocalServer"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    AHEAD LOCAL SERVER - SYSTEM SERVICE UNINSTALLER       " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] Administrator privileges are required to remove the system task." -ForegroundColor Red
    exit 1
}

Write-Host "[*] Stopping and removing Scheduled Task '$TaskName'..." -ForegroundColor White
try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "[+] Scheduled task removed." -ForegroundColor Green
} catch {
    Write-Host "[!] Notice: $($_.Exception.Message)" -ForegroundColor Gray
}

# Stop Node and Cloudflared instances from ahead-backend
Write-Host "[*] Stopping backend processes..." -ForegroundColor White
try {
    $connections = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        if ($conn.OwningProcess -gt 0) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "*ahead-backend*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
} catch {}

Write-Host "[+] All Ahead Local Server processes stopped." -ForegroundColor Green
Write-Host "[+] Uninstallation complete." -ForegroundColor Green

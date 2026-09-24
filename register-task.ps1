# Registers the AheadLocalServer Windows Scheduled Task to run under NT AUTHORITY\SYSTEM at Windows startup.
# Requires Administrator privileges.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

$TaskName = "AheadLocalServer"
$TargetScript = Join-Path $ScriptDir "run-ahead-service.ps1"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "      AHEAD LOCAL SERVER - SYSTEM SERVICE INSTALLER       " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

# Check Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] Administrator privileges are required to register a system boot task." -ForegroundColor Red
    exit 1
}

Write-Host "[*] Configuring Scheduled Task '$TaskName' to run at Windows boot..." -ForegroundColor White

# 1. Define Action
$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$TargetScript`"" `
    -WorkingDirectory $ScriptDir

# 2. Define Trigger: At Computer Startup (before user login)
$Trigger = New-ScheduledTaskTrigger -AtStartup

# 3. Define Principal: NT AUTHORITY\SYSTEM (Highest privilege, runs unattended)
$Principal = New-ScheduledTaskPrincipal `
    -UserId "NT AUTHORITY\SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

# 4. Define Settings: Never timeout, allow on batteries, auto-restart on error
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

# 5. Stop and unregister existing task if present
try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[*] Stopping existing task '$TaskName'..." -ForegroundColor Gray
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
} catch {}

# 6. Register Task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Description "Ahead Local T1D Medical Backend & Cloudflare Tunnel 24/7 Supervisor. Runs at boot under SYSTEM." `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings | Out-Null

Write-Host "[+] Task '$TaskName' successfully registered with Windows Task Scheduler!" -ForegroundColor Green

# 7. Start the task immediately
Write-Host "[*] Starting '$TaskName' now..." -ForegroundColor White
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

# 8. Check health
$status = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host "`nTask State: $($status.State)" -ForegroundColor Cyan

$healthOk = $false
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 5 -ErrorAction Stop
    if ($resp.status -eq "ok") {
        $healthOk = $true
        Write-Host "[+] Local Backend Healthcheck: OK (PID: $($resp.uptime_seconds)s uptime)" -ForegroundColor Green
    }
} catch {
    Write-Host "[!] Local Backend still initializing (port 3000 warming up)..." -ForegroundColor Yellow
}

$urlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
if (Test-Path $urlFile) {
    $url = (Get-Content $urlFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($url) {
        Write-Host "`n==========================================================" -ForegroundColor Green
        Write-Host " ACTIVE CLOUDFLARE TUNNEL URL:" -ForegroundColor Yellow
        Write-Host " $url" -ForegroundColor Cyan
        Write-Host "==========================================================" -ForegroundColor Green
    }
}

Write-Host "`nInstallation Complete! Ahead backend will now automatically run" -ForegroundColor Green
Write-Host "every time this PC turns on or reboots, EVEN IF YOU ARE NOT LOGGED IN.`n" -ForegroundColor Green

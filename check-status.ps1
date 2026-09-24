# Displays live health and status of the Ahead Local Server
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

$TaskName = "AheadLocalServer"
$StatusFile = Join-Path $ScriptDir "ahead-status.json"
$TunnelUrlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
$LogFile = Join-Path $ScriptDir "ahead-service.log"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "             AHEAD LOCAL SERVER SYSTEM STATUS             " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Scheduled Task Status
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $color = if ($task.State -eq "Running") { "Green" } else { "Yellow" }
    Write-Host "Scheduled Task Name : $TaskName"
    Write-Host "Task State          : $($task.State)" -ForegroundColor $color
    Write-Host "Runs As             : NT AUTHORITY\SYSTEM (Starts at boot without login)" -ForegroundColor Gray
    Write-Host "Last Run Time       : $($info.LastRunTime)"
    Write-Host "Last Result Code    : $($info.LastTaskResult)"
} else {
    Write-Host "Scheduled Task      : NOT INSTALLED (Run install-service.bat to install)" -ForegroundColor Red
}

Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray

# 2. Local Port 3000 & Health Check
$health = $null
$rootOk = $false
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 3 -ErrorAction Stop
} catch {
    try {
        $root = Invoke-RestMethod -Uri "http://localhost:3000" -TimeoutSec 3 -ErrorAction Stop
        if ($root -like "*Ahead backend is running*") {
            $rootOk = $true
        }
    } catch {}
}

if ($health) {
    Write-Host "Local Backend       : ONLINE (http://localhost:3000)" -ForegroundColor Green
    Write-Host "Service Name        : $($health.service)"
    Write-Host "Uptime              : $($health.uptime_seconds) seconds"
    Write-Host "Database Status     : $($health.database)" -ForegroundColor $(if ($health.database -eq 'connected') { "Green" } else { "Yellow" })
} elseif ($rootOk) {
    Write-Host "Local Backend       : ONLINE (http://localhost:3000 - legacy instance)" -ForegroundColor Green
} else {
    # Check if anything is on port 3000
    $conn = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Host "Local Backend       : Port 3000 occupied by PID $($conn.OwningProcess[0]), but healthcheck didn't respond" -ForegroundColor Yellow
    } else {
        Write-Host "Local Backend       : OFFLINE (Port 3000 not listening)" -ForegroundColor Red
    }
}

Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray

# 3. Tunnel URL Status
$tunnelUrl = $null
if (Test-Path $TunnelUrlFile) {
    $tunnelUrl = (Get-Content $TunnelUrlFile -Raw -ErrorAction SilentlyContinue).Trim()
}

if ($tunnelUrl) {
    Write-Host "Public Tunnel URL   : $tunnelUrl" -ForegroundColor Cyan
    # Test reachability of tunnel URL
    try {
        $tResp = Invoke-RestMethod -Uri "$tunnelUrl/health" -TimeoutSec 5 -ErrorAction Stop
        if ($tResp.status -eq "ok") {
            Write-Host "Tunnel Connectivity : VERIFIED REACHABLE FROM PUBLIC INTERNET" -ForegroundColor Green
        }
    } catch {
        try {
            $tRoot = Invoke-RestMethod -Uri "$tunnelUrl" -TimeoutSec 5 -ErrorAction Stop
            if ($tRoot -like "*Ahead backend is running*") {
                Write-Host "Tunnel Connectivity : VERIFIED REACHABLE FROM PUBLIC INTERNET" -ForegroundColor Green
            } else {
                Write-Host "Tunnel Connectivity : Reachable, but unexpected response" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "Tunnel Connectivity : Ping failed or connecting..." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Public Tunnel URL   : None detected yet (Check cloudflared.log)" -ForegroundColor Yellow
}

Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray

# 4. Supervisor Status JSON
if (Test-Path $StatusFile) {
    try {
        $st = Get-Content $StatusFile -Raw | ConvertFrom-Json
        Write-Host "Supervisor Status   : $($st.status.ToUpper())" -ForegroundColor $(if ($st.status -eq 'running') { "Green" } else { "Yellow" })
        Write-Host "Node.js PID         : $($st.node_pid)"
        Write-Host "Cloudflared PID     : $($st.cloudflared_pid)"
        Write-Host "Crash Restarts      : Node=$($st.restarts_node), Tunnel=$($st.restarts_cloudflared)"
        Write-Host "Last Heartbeat      : $($st.last_heartbeat)"
    } catch {}
}

Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "Recent Supervisor Activity Log (last 10 entries):" -ForegroundColor White
if (Test-Path $LogFile) {
    Get-Content $LogFile -Tail 10 | ForEach-Object {
        if ($_ -match '\[CRITICAL\]|\[ERROR\]') {
            Write-Host "  $_" -ForegroundColor Red
        } elseif ($_ -match '\[SUCCESS\]') {
            Write-Host "  $_" -ForegroundColor Green
        } elseif ($_ -match '\[WARN\]') {
            Write-Host "  $_" -ForegroundColor Yellow
        } else {
            Write-Host "  $_" -ForegroundColor Gray
        }
    }
} else {
    Write-Host "  (No log file found yet)" -ForegroundColor Gray
}
Write-Host "==========================================================" -ForegroundColor Cyan

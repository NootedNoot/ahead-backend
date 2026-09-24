# Ahead Local Service Watchdog / Supervisor
# Designed to run under NT AUTHORITY\SYSTEM at Windows boot, even if no user is logged in.
# Keeps Node.js backend and Cloudflare Tunnel running 24/7/365 with automatic crash recovery.

[CmdletBinding()]
param(
    [switch]$Foreground = $false
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

$LogFile = Join-Path $ScriptDir "ahead-service.log"
$NodeLog = Join-Path $ScriptDir "node.log"
$CloudflaredLog = Join-Path $ScriptDir "cloudflared.log"
$StatusFile = Join-Path $ScriptDir "ahead-status.json"
$TunnelUrlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
$TokenFile = Join-Path $ScriptDir "tunnel-token.txt"
$CustomDomainFile = Join-Path $ScriptDir "custom-domain.txt"

function Write-ServiceLog {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    if ($Foreground) {
        switch ($Level) {
            "ERROR"    { Write-Host $line -ForegroundColor Red }
            "CRITICAL" { Write-Host $line -ForegroundColor Red }
            "WARN"     { Write-Host $line -ForegroundColor Yellow }
            "SUCCESS"  { Write-Host $line -ForegroundColor Green }
            default    { Write-Host $line -ForegroundColor White }
        }
    }
    try {
        Add-Content -Path $LogFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    } catch {}
}

function Rotate-LogFile {
    param([string]$Path, [long]$MaxBytes = 10485760) # 10MB
    if (Test-Path $Path) {
        try {
            $item = Get-Item $Path -ErrorAction SilentlyContinue
            if ($item -and $item.Length -gt $MaxBytes) {
                $old = "$Path.old"
                if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
                Move-Item -Path $Path -Destination $old -Force -ErrorAction SilentlyContinue
                Write-ServiceLog "Rotated log file $Path (exceeded 10MB)" "INFO"
            }
        } catch {}
    }
}

Write-ServiceLog "=========================================================="
Write-ServiceLog "AHEAD LOCAL SERVER SUPERVISOR STARTING"
Write-ServiceLog "Running as user: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-ServiceLog "Working directory: $ScriptDir"

# 1. Locate Node.js executable
$NodeExe = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $NodeExe)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        $NodeExe = $cmd.Source
    }
}

if (-not (Test-Path $NodeExe)) {
    Write-ServiceLog "Node.js executable NOT FOUND! Checked 'C:\Program Files\nodejs\node.exe' and PATH." "CRITICAL"
    exit 1
}
Write-ServiceLog "Node.js found: $NodeExe"

# 2. Locate Cloudflared executable
$CloudflaredExe = Join-Path $ScriptDir "bin\cloudflared.exe"
if (-not (Test-Path $CloudflaredExe)) {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) {
        $CloudflaredExe = $cmd.Source
    }
}

if (-not (Test-Path $CloudflaredExe)) {
    Write-ServiceLog "cloudflared.exe NOT FOUND at $CloudflaredExe" "CRITICAL"
    exit 1
}
Write-ServiceLog "Cloudflared found: $CloudflaredExe"

# 3. Clean up any existing / orphan server processes on port 3000 to prevent port conflict
try {
    $connections = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        $pidToKill = $conn.OwningProcess
        if ($pidToKill -gt 0 -and $pidToKill -ne $PID) {
            Write-ServiceLog "Clearing existing process $pidToKill listening on port 3000..." "WARN"
            Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-ServiceLog "Port check notice: $($_.Exception.Message)" "WARN"
}

# 4. Process Launchers
$NodeProcess = $null
$TunnelProcess = $null
$RestartsNode = 0
$RestartsCloudflared = 0
$StartTime = Get-Date

function Start-NodeServer {
    Rotate-LogFile $NodeLog
    Write-ServiceLog "Starting Node.js backend (server.js)..." "INFO"
    
    $nodeErrLog = Join-Path $ScriptDir "node-error.log"
    try {
        $proc = Start-Process `
            -FilePath $NodeExe `
            -ArgumentList "server.js" `
            -WorkingDirectory $ScriptDir `
            -RedirectStandardOutput $NodeLog `
            -RedirectStandardError $nodeErrLog `
            -PassThru -WindowStyle Hidden

        Write-ServiceLog "Node.js backend started successfully (PID: $($proc.Id))" "SUCCESS"
        return $proc
    } catch {
        Write-ServiceLog "Failed to start Node.js process: $($_.Exception.Message)" "CRITICAL"
        return $null
    }
}

function Start-CloudflareTunnel {
    Rotate-LogFile $CloudflaredLog
    
    # Check if a named tunnel token is provided
    $token = $null
    if (Test-Path $TokenFile) {
        $raw = (Get-Content $TokenFile -Raw -ErrorAction SilentlyContinue).Trim()
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $token = $raw
        }
    }

    $arguments = ""
    if ($token) {
        Write-ServiceLog "Starting named Cloudflare Tunnel with permanent token..." "INFO"
        $arguments = "tunnel run --token $token"
    } else {
        Write-ServiceLog "Starting Cloudflare Quick Tunnel (--url http://localhost:3000)..." "INFO"
        $arguments = "tunnel --url http://localhost:3000"
    }

    $cfOutLog = Join-Path $ScriptDir "cloudflared-out.log"
    try {
        $proc = Start-Process `
            -FilePath $CloudflaredExe `
            -ArgumentList $arguments `
            -WorkingDirectory $ScriptDir `
            -RedirectStandardOutput $cfOutLog `
            -RedirectStandardError $CloudflaredLog `
            -PassThru -WindowStyle Hidden

        Write-ServiceLog "Cloudflared process started (PID: $($proc.Id))" "SUCCESS"
        return $proc
    } catch {
        Write-ServiceLog "Failed to start Cloudflared process: $($_.Exception.Message)" "CRITICAL"
        return $null
    }
}

function Update-TunnelUrl {
    # Check if custom domain configured
    if (Test-Path $CustomDomainFile) {
        $cd = (Get-Content $CustomDomainFile -Raw -ErrorAction SilentlyContinue).Trim()
        if (-not [string]::IsNullOrWhiteSpace($cd)) {
            $cd | Out-File -FilePath $TunnelUrlFile -Encoding utf8 -Force
            return $cd
        }
    }

    # Otherwise scan cloudflared.log for trycloudflare.com URL
    if (Test-Path $CloudflaredLog) {
        try {
            $content = Get-Content $CloudflaredLog -Raw -ErrorAction SilentlyContinue
            if ($content -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
                $matchedUrl = $matches[0]
                $currentUrl = if (Test-Path $TunnelUrlFile) { (Get-Content $TunnelUrlFile -Raw -ErrorAction SilentlyContinue).Trim() } else { "" }
                if ($matchedUrl -ne $currentUrl) {
                    $matchedUrl | Out-File -FilePath $TunnelUrlFile -Encoding utf8 -Force
                    Write-ServiceLog "Active Cloudflare Tunnel URL detected: $matchedUrl" "SUCCESS"
                }
                return $matchedUrl
            }
        } catch {}
    }
    return $null
}

function Save-StatusJson {
    param([string]$CurrentUrl)
    try {
        $nodeAlive = $NodeProcess -and (-not $NodeProcess.HasExited)
        $tunnelAlive = $TunnelProcess -and (-not $TunnelProcess.HasExited)
        
        $statusObj = @{
            status = if ($nodeAlive -and $tunnelAlive) { "running" } else { "degraded" }
            started_at = $StartTime.ToString("o")
            last_heartbeat = (Get-Date).ToString("o")
            uptime_seconds = [int]((Get-Date) - $StartTime).TotalSeconds
            node_pid = if ($nodeAlive) { $NodeProcess.Id } else { $null }
            cloudflared_pid = if ($tunnelAlive) { $TunnelProcess.Id } else { $null }
            port = 3000
            tunnel_url = $CurrentUrl
            restarts_node = $RestartsNode
            restarts_cloudflared = $RestartsCloudflared
            system_user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        }
        $json = $statusObj | ConvertTo-Json -Compress
        $json | Out-File -FilePath $StatusFile -Encoding utf8 -Force
    } catch {}
}

# Start processes
$NodeProcess = Start-NodeServer
Start-Sleep -Seconds 2
$TunnelProcess = Start-CloudflareTunnel

$TunnelUrl = $null
$loopCount = 0

Write-ServiceLog "Watchdog loop active. Monitoring processes every 5 seconds..." "INFO"

# Main Supervision Loop
try {
    while ($true) {
        Start-Sleep -Seconds 5
        $loopCount++

        # Rotate supervisor log periodically
        if ($loopCount % 720 -eq 0) { # roughly every hour
            Rotate-LogFile $LogFile
        }

        # 1. Supervise Node.js
        if ($null -eq $NodeProcess -or $NodeProcess.HasExited) {
            $exitCode = if ($NodeProcess) { $NodeProcess.ExitCode } else { "N/A" }
            Write-ServiceLog "Node.js process exited unexpectedly with code $exitCode! Restarting..." "CRITICAL"
            $RestartsNode++
            Start-Sleep -Seconds 2
            $NodeProcess = Start-NodeServer
        }

        # 2. Supervise Cloudflared
        if ($null -eq $TunnelProcess -or $TunnelProcess.HasExited) {
            $exitCode = if ($TunnelProcess) { $TunnelProcess.ExitCode } else { "N/A" }
            Write-ServiceLog "Cloudflared process exited unexpectedly with code $exitCode! Restarting..." "CRITICAL"
            $RestartsCloudflared++
            Start-Sleep -Seconds 2
            $TunnelProcess = Start-CloudflareTunnel
        }

        # 3. Update tunnel URL and status
        $detectedUrl = Update-TunnelUrl
        if ($detectedUrl) { $TunnelUrl = $detectedUrl }
        Save-StatusJson -CurrentUrl $TunnelUrl
    }
} finally {
    Write-ServiceLog "Supervisor stopping. Terminating child processes..." "WARN"
    if ($NodeProcess -and (-not $NodeProcess.HasExited)) {
        Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($TunnelProcess -and (-not $TunnelProcess.HasExited)) {
        Stop-Process -Id $TunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Write-ServiceLog "Supervisor shutdown complete." "INFO"
}

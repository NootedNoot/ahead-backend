# Ahead Local Self-Hosted Backend Launcher
# 100% Self-Hosted on Local PC: Local Node.js + Local PostgreSQL 18 + Tunnel for Grandma ($0/mo)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Show-Header {
    Clear-Host
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "   AHEAD LOCAL SERVER CONTROL PANEL (100% SELF-HOSTED)    " -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Cyan
}

function Test-Endpoint {
    param([string]$Url, [int]$TimeoutSec = 4)
    try {
        $res = Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop
        if ($res.status -eq "ok") {
            return @{ Ok = $true; Database = $res.database; Uptime = $res.uptime_seconds }
        }
        return @{ Ok = $false; Error = "Invalid response" }
    } catch {
        return @{ Ok = $false; Error = $_.Exception.Message }
    }
}

function Start-Services {
    Show-Header

    # 1. Check Node.js
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] Node.js is not found on PATH. Please install Node.js." -ForegroundColor Red
        return
    }

    # 2. Check / Start Local PostgreSQL Server
    $PgBin = Join-Path $ScriptDir "bin\postgres\bin"
    $PgData = Join-Path $ScriptDir "data\db"
    $PgCtl = Join-Path $PgBin "pg_ctl.exe"
    
    if (Test-Path $PgCtl) {
        $pgStatus = & $PgCtl -D $PgData status 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[✔] Local PostgreSQL 18 database is RUNNING on port 5432" -ForegroundColor Green
        } else {
            Write-Host "[*] Starting local PostgreSQL database on port 5432..." -ForegroundColor White
            $logFile = Join-Path $ScriptDir "data\postgres.log"
            & $PgCtl -D $PgData -l $logFile -o "-p 5432" start
            Start-Sleep -Seconds 2
            Write-Host "[✔] Local PostgreSQL database started!" -ForegroundColor Green
        }
    } else {
        Write-Host "[!] Warning: Local PostgreSQL binary not found at $PgCtl" -ForegroundColor Yellow
    }

    # 3. Check / Start Node server
    $ExistingNode = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        try {
            $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            $cmd -like "*server.js*"
        } catch { $false }
    }

    $localHealth = Test-Endpoint -Url "http://127.0.0.1:3000/health"
    if ($localHealth.Ok) {
        Write-Host "[✔] Local Node.js server is RUNNING (PID: $($ExistingNode[0].Id), DB: $($localHealth.Database))" -ForegroundColor Green
    } else {
        if ($ExistingNode) {
            Write-Host "[*] Restarting unresponsive Node.js process..." -ForegroundColor Yellow
            $ExistingNode | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        Write-Host "[*] Starting Node.js backend server..." -ForegroundColor White
        Start-Process node -ArgumentList "server.js" -WorkingDirectory $ScriptDir -WindowStyle Hidden
        Start-Sleep -Seconds 2
        $localHealth = Test-Endpoint -Url "http://127.0.0.1:3000/health"
        if ($localHealth.Ok) {
            Write-Host "[✔] Node.js server started on http://localhost:3000 (DB: $($localHealth.Database))" -ForegroundColor Green
        } else {
            Write-Host "[!] Warning: Server started but health check failed. Check node.log" -ForegroundColor Yellow
        }
    }

    # 4. Local LAN IPs
    $LocalIPs = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { 
        $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254*" 
    }).IPAddress

    # 5. Check cloudflared binary & Start Tunnel
    $Cloudflared = Join-Path $ScriptDir "bin\cloudflared.exe"
    $ExistingTunnel = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
    $TunnelUrlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
    $TunnelUrl = if (Test-Path $TunnelUrlFile) { (Get-Content $TunnelUrlFile -Raw -ErrorAction SilentlyContinue).Trim() } else { $null }

    $tunnelHealth = if ($TunnelUrl) { Test-Endpoint -Url "$TunnelUrl/health" } else { @{ Ok = $false } }

    if ($ExistingTunnel -and $tunnelHealth.Ok) {
        Write-Host "[✔] Cloudflare Tunnel is RUNNING & VERIFIED (PID: $($ExistingTunnel[0].Id))" -ForegroundColor Green
    } else {
        if ($ExistingTunnel) {
            Write-Host "[*] Tunnel URL was stale or unresponsive. Restarting cloudflared..." -ForegroundColor Yellow
            $ExistingTunnel | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        if (Test-Path $Cloudflared) {
            Write-Host "[*] Starting fresh Cloudflare Tunnel for Grandma / Remote access..." -ForegroundColor White
            $TunnelLog = Join-Path $ScriptDir "cloudflared.log"
            if (Test-Path $TunnelLog) {
                try { Remove-Item $TunnelLog -Force -ErrorAction SilentlyContinue } catch {}
            }

            Start-Process -FilePath $Cloudflared `
                -ArgumentList "tunnel --url http://127.0.0.1:3000" `
                -WorkingDirectory $ScriptDir `
                -RedirectStandardError $TunnelLog `
                -WindowStyle Hidden

            Write-Host "[*] Waiting for Cloudflare Tunnel URL..." -ForegroundColor Gray
            $TunnelUrl = $null
            for ($i = 0; $i -lt 30; $i++) {
                Start-Sleep -Seconds 1
                if (Test-Path $TunnelLog) {
                    $logContent = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
                    if ($logContent -match "(https://[a-zA-Z0-9-]+\.trycloudflare\.com)") {
                        $TunnelUrl = $Matches[1]
                        $TunnelUrl | Out-File -FilePath $TunnelUrlFile -Encoding utf8 -Force
                        break
                    }
                }
            }
            if ($TunnelUrl) {
                Write-Host "[✔] New Tunnel URL obtained: $TunnelUrl" -ForegroundColor Green
                $websiteDir = Join-Path (Split-Path $ScriptDir -Parent) "ahead-website"
                if (Test-Path $websiteDir) {
                    Get-ChildItem -Path $websiteDir -Filter "*.html" | ForEach-Object {
                        $html = Get-Content $_.FullName -Raw -Encoding utf8
                        if ($html -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
                            $updated = $html -replace 'https://[a-zA-Z0-9-]+\.trycloudflare\.com', $TunnelUrl
                            if ($updated -ne $html) {
                                [System.IO.File]::WriteAllText($_.FullName, $updated, [System.Text.Encoding]::UTF8)
                            }
                        }
                    }
                }
            } else {
                Write-Host "[!] Tunnel started, but URL could not be parsed. Check cloudflared.log" -ForegroundColor Yellow
            }
        }
    }

    # 6. Print System Status Box (100% Self-Hosted & Local)
    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host "       SYSTEM CONNECTION SUMMARY (100% SELF-HOSTED)       " -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  Database:          Local PostgreSQL 18 (localhost:5432/ahead)" -ForegroundColor Cyan
    Write-Host "  Local PC URL:      http://localhost:3000" -ForegroundColor Cyan
    foreach ($ip in $LocalIPs) {
        Write-Host "  Local Network IP:  http://$($ip):3000" -ForegroundColor Cyan
    }
    if ($TunnelUrl) {
        Write-Host "  Tunnel URL:        $TunnelUrl" -ForegroundColor Cyan
    }
    Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  Ahead PC Windows:  Connected locally to http://127.0.0.1:3000" -ForegroundColor Gray
    Write-Host "  Ahead Lite (Grandma): Connects to self-hosted server above" -ForegroundColor Gray
    Write-Host "==========================================================" -ForegroundColor Green
}

# Main Loop
Start-Services

while ($true) {
    Write-Host "`nControls: [R]estart Services | [T]est Health | [Q]uit" -ForegroundColor White
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown").Character
    switch ($key) {
        { $_ -in 'r','R' } {
            Write-Host "`nRestarting all backend services..." -ForegroundColor Yellow
            $PgCtl = Join-Path $ScriptDir "bin\postgres\bin\pg_ctl.exe"
            $PgData = Join-Path $ScriptDir "data\db"
            if (Test-Path $PgCtl) {
                & $PgCtl -D $PgData stop -m fast | Out-Null
            }
            Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
                try {
                    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                    $cmd -like "*server.js*"
                } catch { $false }
            } | Stop-Process -Force -ErrorAction SilentlyContinue
            Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
            Start-Services
        }
        { $_ -in 't','T' } {
            Write-Host "`nTesting health endpoints..." -ForegroundColor Cyan
            $TunnelUrlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
            $tUrl = if (Test-Path $TunnelUrlFile) { (Get-Content $TunnelUrlFile -Raw).Trim() } else { $null }
            $loc = Test-Endpoint -Url "http://127.0.0.1:3000/health"
            $tun = if ($tUrl) { Test-Endpoint -Url "$tUrl/health" } else { @{ Ok = $false; Error = "No tunnel URL" } }
            Write-Host "  Local Backend:   $(if ($loc.Ok) { '[✔] OK (DB: ' + $loc.Database + ')' } else { '[✖] FAIL: ' + $loc.Error })" -ForegroundColor $(if ($loc.Ok) { 'Green' } else { 'Red' })
            Write-Host "  Tunnel (Remote): $(if ($tun.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $tun.Error })" -ForegroundColor $(if ($tun.Ok) { 'Green' } else { 'Red' })
        }
        { $_ -in 'q','Q' } {
            Write-Host "`nExiting Ahead Backend Control Panel..." -ForegroundColor Gray
            break
        }
    }
}

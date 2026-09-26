# Ahead Local Self-Hosted Backend Launcher
# Runs ahead-backend on port 3000 and exposes it via Cloudflare Tunnel for $0/month.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Show-Header {
    Clear-Host
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "       AHEAD BACKEND SERVER CONTROL PANEL ($0/mo)        " -ForegroundColor Yellow
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

    # 2. Check cloudflared binary
    $Cloudflared = Join-Path $ScriptDir "bin\cloudflared.exe"
    if (-not (Test-Path $Cloudflared)) {
        Write-Host "[ERROR] cloudflared.exe not found at $Cloudflared" -ForegroundColor Red
        return
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

    # 5. Check / Start Cloudflare Tunnel
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
        Write-Host "[*] Starting fresh Cloudflare Tunnel..." -ForegroundColor White
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
        } else {
            Write-Host "[!] Tunnel started, but URL could not be parsed. Check cloudflared.log" -ForegroundColor Yellow
        }
    }

    # 6. Check 24/7 Railway Production Cloud
    Write-Host "`n[*] Checking 24/7 Railway Production Cloud..." -ForegroundColor Gray
    $railwayHealth = Test-Endpoint -Url "https://ahead-backend-production-ee80.up.railway.app/health"
    if ($railwayHealth.Ok) {
        Write-Host "[✔] 24/7 Railway Production Cloud is ONLINE (DB: $($railwayHealth.Database))" -ForegroundColor Green
    } else {
        Write-Host "[!] Railway Production Cloud check warning: $($railwayHealth.Error)" -ForegroundColor Yellow
    }

    # 7. Print System Status Box
    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host "                SYSTEM CONNECTION SUMMARY                 " -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  Local PC URL:      http://localhost:3000" -ForegroundColor Cyan
    foreach ($ip in $LocalIPs) {
        Write-Host "  Local Network IP:  http://$($ip):3000" -ForegroundColor Cyan
    }
    if ($TunnelUrl) {
        Write-Host "  Tunnel URL:        $TunnelUrl" -ForegroundColor Cyan
    }
    Write-Host "  Railway Cloud:     https://ahead-backend-production-ee80.up.railway.app" -ForegroundColor Cyan
    Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  Ahead Lite (Grandma's Phone):" -ForegroundColor White
    Write-Host "    Connected 24/7 to Railway Cloud (works even if PC is off!)" -ForegroundColor Gray
    Write-Host "==========================================================" -ForegroundColor Green
}

# Main Loop
Start-Services

while ($true) {
    Write-Host "`nControls: [R]estart Services | [T]est Health | [Q]uit" -ForegroundColor White
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown").Character
    switch ($key) {
        'r' {
            Write-Host "`nRestarting all backend services..." -ForegroundColor Yellow
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
        'R' {
            Write-Host "`nRestarting all backend services..." -ForegroundColor Yellow
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
        't' {
            Write-Host "`nTesting health endpoints..." -ForegroundColor Cyan
            $TunnelUrlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
            $tUrl = if (Test-Path $TunnelUrlFile) { (Get-Content $TunnelUrlFile -Raw).Trim() } else { $null }
            $loc = Test-Endpoint -Url "http://127.0.0.1:3000/health"
            $tun = if ($tUrl) { Test-Endpoint -Url "$tUrl/health" } else { @{ Ok = $false; Error = "No tunnel URL" } }
            $rwy = Test-Endpoint -Url "https://ahead-backend-production-ee80.up.railway.app/health"
            Write-Host "  Local:   $(if ($loc.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $loc.Error })" -ForegroundColor $(if ($loc.Ok) { 'Green' } else { 'Red' })
            Write-Host "  Tunnel:  $(if ($tun.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $tun.Error })" -ForegroundColor $(if ($tun.Ok) { 'Green' } else { 'Red' })
            Write-Host "  Railway: $(if ($rwy.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $rwy.Error })" -ForegroundColor $(if ($rwy.Ok) { 'Green' } else { 'Red' })
        }
        'T' {
            Write-Host "`nTesting health endpoints..." -ForegroundColor Cyan
            $TunnelUrlFile = Join-Path $ScriptDir "active-tunnel-url.txt"
            $tUrl = if (Test-Path $TunnelUrlFile) { (Get-Content $TunnelUrlFile -Raw).Trim() } else { $null }
            $loc = Test-Endpoint -Url "http://127.0.0.1:3000/health"
            $tun = if ($tUrl) { Test-Endpoint -Url "$tUrl/health" } else { @{ Ok = $false; Error = "No tunnel URL" } }
            $rwy = Test-Endpoint -Url "https://ahead-backend-production-ee80.up.railway.app/health"
            Write-Host "  Local:   $(if ($loc.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $loc.Error })" -ForegroundColor $(if ($loc.Ok) { 'Green' } else { 'Red' })
            Write-Host "  Tunnel:  $(if ($tun.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $tun.Error })" -ForegroundColor $(if ($tun.Ok) { 'Green' } else { 'Red' })
            Write-Host "  Railway: $(if ($rwy.Ok) { '[✔] OK' } else { '[✖] FAIL: ' + $rwy.Error })" -ForegroundColor $(if ($rwy.Ok) { 'Green' } else { 'Red' })
        }
        'q' {
            Write-Host "`nExiting Ahead Backend Control Panel..." -ForegroundColor Gray
            break
        }
        'Q' {
            Write-Host "`nExiting Ahead Backend Control Panel..." -ForegroundColor Gray
            break
        }
    }
}

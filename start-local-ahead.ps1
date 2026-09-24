# Ahead Local Self-Hosted Backend Launcher
# Runs ahead-backend on port 3000 and exposes it via Cloudflare Tunnel for $0/month.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "       AHEAD LOCAL SERVER ($0/mo Self-Hosted)     " -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Cyan

# 1. Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not found on PATH. Please install Node.js." -ForegroundColor Red
    Pause
    Exit 1
}

# 2. Check cloudflared binary
$Cloudflared = Join-Path $ScriptDir "bin\cloudflared.exe"
if (-not (Test-Path $Cloudflared)) {
    Write-Host "[ERROR] cloudflared.exe not found at $Cloudflared" -ForegroundColor Red
    Pause
    Exit 1
}

# 3. Check / Start Node server
$ExistingNode = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
    $cmd -like "*server.js*"
}

if ($ExistingNode) {
    Write-Host "[+] Local Node.js server already running (PID: $($ExistingNode.Id))" -ForegroundColor Green
} else {
    Write-Host "[*] Starting Node.js backend server..." -ForegroundColor White
    $ServerProcess = Start-Process node -ArgumentList "server.js" -WorkingDirectory $ScriptDir -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host "[+] Backend server started (PID: $($ServerProcess.Id)) on http://localhost:3000" -ForegroundColor Green
}

# 4. Display Local LAN IP
$LocalIPs = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { 
    $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254*" 
}).IPAddress

Write-Host "`nLocal Network IP(s):" -ForegroundColor White
foreach ($ip in $LocalIPs) {
    Write-Host "  -> http://$($ip):3000" -ForegroundColor Cyan
}

# 5. Start Cloudflare Tunnel
Write-Host "`n[*] Starting Cloudflare Tunnel..." -ForegroundColor White
$TunnelLog = Join-Path $ScriptDir "cloudflared.log"
if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force }

$TunnelProc = Start-Process -FilePath $Cloudflared `
    -ArgumentList "tunnel --url http://localhost:3000" `
    -WorkingDirectory $ScriptDir `
    -RedirectStandardError $TunnelLog `
    -PassThru -WindowStyle Hidden

Write-Host "[*] Waiting for Cloudflare Tunnel URL..." -ForegroundColor Gray

$TunnelUrl = $null
$Timeout = 30
for ($i = 0; $i -lt $Timeout; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $TunnelLog) {
        $content = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
            $TunnelUrl = $matches[0]
            break
        }
    }
}

if ($TunnelUrl) {
    Write-Host "`n==================================================" -ForegroundColor Green
    Write-Host " TUNNEL ACTIVE! Use this URL in Ahead / Ahead Lite:" -ForegroundColor Yellow
    Write-Host " $TunnelUrl" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Green
    $TunnelUrl | Out-File -FilePath (Join-Path $ScriptDir "active-tunnel-url.txt") -Encoding utf8
} else {
    Write-Host "[!] Tunnel started, but URL could not be auto-parsed. Check cloudflared.log" -ForegroundColor Yellow
}

Write-Host "`nPress Ctrl+C to stop the Cloudflare Tunnel." -ForegroundColor Gray
try {
    Wait-Process -Id $TunnelProc.Id
} finally {
    if (-not $TunnelProc.HasExited) {
        Stop-Process -Id $TunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
}

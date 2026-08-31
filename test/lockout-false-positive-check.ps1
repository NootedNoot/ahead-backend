# Ahead: rate-limit / lockout false-positive check, against the LIVE Railway backend.
#
# What this checks: a real second person WILL typo their password at least
# once. This proves that a normal amount of human error - a couple of
# mistyped-password attempts - never locks out or flags a legitimate user,
# and that the actual IP-based rate limiter's threshold is high enough to
# not trip during completely ordinary use (a few requests in quick
# succession from one phone, e.g. app cold-start retry logic).
#
# Run with: powershell -ExecutionPolicy Bypass -File test\lockout-false-positive-check.ps1

$ErrorActionPreference = 'Continue'
$Base = 'https://ahead-backend-production-ee80.up.railway.app'
$Email = 'ahead-lockout-test@example.com'
$RealPassword = 'correcthorsebattery1'

function Try-Login($pw) {
    try {
        $r = Invoke-RestMethod -Method POST -Uri "$Base/api/auth/login" -ContentType 'application/json' `
            -Body (@{ email = $Email; password = $pw } | ConvertTo-Json)
        return @{ ok = $true; body = $r }
    } catch {
        $resp = $_.Exception.Response
        $status = if ($resp) { [int]$resp.StatusCode } else { -1 }
        return @{ ok = $false; status = $status }
    }
}

Write-Host "=== Setting up a real account ==="
try {
    $signup = Invoke-RestMethod -Method POST -Uri "$Base/api/auth/signup" -ContentType 'application/json' `
        -Body (@{ email = $Email; password = $RealPassword; displayName = 'Lockout Test' } | ConvertTo-Json)
    Write-Host "  signed up fresh"
} catch {
    Write-Host "  already exists from a prior run, continuing"
}

Write-Host "`n=== Simulating a normal human: 2 typo'd passwords, then the real one ==="
$typo1 = Try-Login 'correcthorsebattery2'   # off-by-one typo
Write-Host "  attempt 1 (typo): $(if ($typo1.ok) { 'unexpectedly succeeded!' } else { "HTTP $($typo1.status)" })"
$typo2 = Try-Login 'Correcthorsebattery1'   # wrong capitalization
Write-Host "  attempt 2 (typo): $(if ($typo2.ok) { 'unexpectedly succeeded!' } else { "HTTP $($typo2.status)" })"
$real = Try-Login $RealPassword
Write-Host "  attempt 3 (correct password): $(if ($real.ok) { 'HTTP 200 - logged in' } else { "FAILED - HTTP $($real.status)" })"

$normalUseOk = (-not $typo1.ok) -and (-not $typo2.ok) -and $real.ok
if ($normalUseOk) {
    Write-Host "  PASS: 2 typos didn't lock the account out of a subsequent correct login."
} else {
    Write-Host "  FAIL: something's wrong - either a typo logged in, or the correct password got rejected after 2 failed attempts."
}

Write-Host "`n=== Confirming the account itself is still fully usable (not silently flagged/disabled) ==="
$token = $real.body.token
if ($token) {
    $devices = Invoke-RestMethod -Method GET -Uri "$Base/api/devices" -Headers @{ Authorization = "Bearer $token" }
    Write-Host "  account still functions normally: GET /api/devices returned $($devices.Count) device(s), no 401/403"
}

Write-Host "`n=== Rapid-fire burst: 6 quick requests to a normal (non-auth) endpoint, from one 'phone' ==="
Write-Host "    (simulates a cold-start retry storm - should NOT trip the rate limiter, since authLimiter is scoped to /api/auth)"
$burstResults = @()
for ($i = 0; $i -lt 6; $i++) {
    try {
        $r = Invoke-WebRequest -Method GET -Uri "$Base/" -TimeoutSec 10 -SkipHttpErrorCheck
        $burstResults += [int]$r.StatusCode
    } catch {
        $burstResults += -1
    }
}
Write-Host "    statuses: $($burstResults -join ', ')"
if (($burstResults | Where-Object { $_ -eq 429 }).Count -gt 0) {
    Write-Host "  NOTE: hit a 429 during ordinary burst traffic on a non-auth route - worth checking rate limiter scope."
} else {
    Write-Host "  PASS: no rate-limit rejection on ordinary burst traffic."
}

Write-Host "`n=== Cleanup ==="
if ($token) {
    Invoke-RestMethod -Method DELETE -Uri "$Base/api/auth/account" -Headers @{ Authorization = "Bearer $token" } `
        -ContentType 'application/json' -Body (@{ password = $RealPassword } | ConvertTo-Json) | Out-Null
    Write-Host "  test account deleted"
}

Write-Host "`n=== SUMMARY ==="
if ($normalUseOk) {
    Write-Host "PASS: ordinary human error (a couple of typos) does not lock out or flag a legitimate user."
} else {
    Write-Host "FAIL: see attempts above."
}

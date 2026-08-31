# Ahead: concurrent multi-user load test, against the LIVE Railway backend.
#
# What this actually checks: server.js used to hold trend state in two
# plain `let` globals shared by EVERY request (lastProcessedDate,
# latestTrend) - fine when exactly one phone called it, a real
# cross-user data leak risk once more than one person could hit the
# server at the same instant. The multi-tenant rework removed those
# globals in favor of per-user DB rows, and isolation-check.ps1 already
# proved isolation holds for ONE request at a time. This proves it holds
# under N users hitting /api/check-trend AT THE SAME MOMENT - the one
# scenario a sequential test can never catch, since a race condition by
# definition only shows up under real concurrency.
#
# Run with: powershell -ExecutionPolicy Bypass -File test\concurrent-load-check.ps1
# No manual/Supabase step needed - unlike isolation-check.ps1, this never
# grants a share, so it never touches the email_verified_at gate.

$ErrorActionPreference = 'Stop'
$Base = 'https://ahead-backend-production-ee80.up.railway.app'
$Password = 'correcthorsebattery1'
$UserCount = 8

Write-Host "=== Signing up $UserCount throwaway accounts ==="
$users = @()
for ($i = 0; $i -lt $UserCount; $i++) {
    $email = "ahead-load-test-$i@example.com"
    try {
        $resp = Invoke-RestMethod -Method POST -Uri "$Base/api/auth/signup" -ContentType 'application/json' `
            -Body (@{ email = $email; password = $Password; displayName = "Load Test $i" } | ConvertTo-Json)
    } catch {
        # already exists from a prior run - log back in
        $resp = Invoke-RestMethod -Method POST -Uri "$Base/api/auth/login" -ContentType 'application/json' `
            -Body (@{ email = $email; password = $Password } | ConvertTo-Json)
    }
    $device = Invoke-RestMethod -Method POST -Uri "$Base/api/devices" `
        -Headers @{ Authorization = "Bearer $($resp.token)" } -ContentType 'application/json' `
        -Body (@{ label = "load-test-device-$i" } | ConvertTo-Json)
    # Each user gets a DISTINCT, easily-recognizable sgv band (100+i*100)
    # so cross-contamination is obvious at a glance in the results, not
    # something you'd have to diff carefully to notice.
    $users += [PSCustomObject]@{
        Index    = $i
        Email    = $email
        UserId   = $resp.user.id
        Token    = $resp.token
        ApiKey   = $device.apiKey
        BaseSgv  = 100 + ($i * 100)
    }
    Write-Host "  user $i : $($resp.user.id)  base sgv $($100 + $i * 100)"
}

Write-Host "`n=== Firing all $UserCount check-trend requests AT THE SAME TIME (background jobs) ==="
$nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$jobs = @()
foreach ($u in $users) {
    $readings = @(
        @{ date = $nowMs - 600000; sgv = $u.BaseSgv },
        @{ date = $nowMs - 300000; sgv = $u.BaseSgv + 1 },
        @{ date = $nowMs;          sgv = $u.BaseSgv + 2 }
    )
    $jobs += Start-Job -ScriptBlock {
        param($base, $apiKey, $readings)
        try {
            $r = Invoke-RestMethod -Method POST -Uri "$base/api/check-trend" `
                -Headers @{ 'X-Ahead-Api-Key' = $apiKey } -ContentType 'application/json' `
                -Body (@{ readings = $readings } | ConvertTo-Json)
            return @{ ok = $true; body = $r }
        } catch {
            return @{ ok = $false; error = $_.Exception.Message }
        }
    } -ArgumentList $Base, $u.ApiKey, $readings
}
$results = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job
$failCount = ($results | Where-Object { -not $_.ok }).Count
Write-Host "  $($results.Count) requests completed, $failCount failed outright"

Write-Host "`n=== Verifying EACH user's stored readings only ever contain THEIR OWN sgv band ==="
$contaminated = @()
foreach ($u in $users) {
    $entries = Invoke-RestMethod -Method GET -Uri "$Base/api/readings?ownerId=$($u.UserId)" `
        -Headers @{ Authorization = "Bearer $($u.Token)" }
    $badRows = $entries.entries | Where-Object { $_.sgv -lt $u.BaseSgv -or $_.sgv -gt ($u.BaseSgv + 2) }
    $ownRows = $entries.entries | Where-Object { $_.sgv -ge $u.BaseSgv -and $_.sgv -le ($u.BaseSgv + 2) }
    if ($badRows.Count -gt 0) {
        $contaminated += $u
        Write-Host "  user $($u.Index) [$($u.UserId)]: CONTAMINATED - found sgv values outside its own band: $($badRows.sgv -join ', ')"
    } else {
        Write-Host "  user $($u.Index) [$($u.UserId)]: clean - $($ownRows.Count)/3 own readings, no foreign values"
    }
}

Write-Host "`n=== Cleaning up: deleting all $UserCount test accounts ==="
foreach ($u in $users) {
    try {
        Invoke-RestMethod -Method DELETE -Uri "$Base/api/auth/account" `
            -Headers @{ Authorization = "Bearer $($u.Token)" } -ContentType 'application/json' `
            -Body (@{ password = $Password } | ConvertTo-Json) | Out-Null
    } catch {
        Write-Host "  (cleanup failed for user $($u.Index), may already be gone: $($_.Exception.Message))"
    }
}

Write-Host "`n=== RESULT ==="
if ($contaminated.Count -eq 0 -and $failCount -eq 0) {
    Write-Host "PASS: $UserCount concurrent users, zero request failures, zero cross-user data contamination."
} else {
    Write-Host "FAIL: $failCount request failures, $($contaminated.Count) users with contaminated data. Investigate before handing this off to a real second user."
}

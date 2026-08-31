# Ahead: two-account data-isolation check, against the LIVE Railway backend.
# Not part of the app or the automated test suite - a one-off manual script
# for exactly the question "does the backend really keep two users' data
# separate," using two real accounts (A = you, B = a throwaway test user).
#
# Run with: powershell -ExecutionPolicy Bypass -File test\isolation-check.ps1
# (or just paste it into an interactive PowerShell terminal a block at a time)
#
# NOTE ON EMAIL VERIFICATION: granting a share TO someone requires that
# person's account have a verified email (routes/shares.js) - a real gap
# closed 2026-08-27 so a share can't be granted to an email nobody actually
# controls. Account B below has no real inbox, so partway through you need
# to flip it manually, once, in Supabase's SQL editor:
#
#   UPDATE users SET email_verified_at = now() WHERE email = 'ahead-isolation-test-b@example.com';
#
# The script pauses and tells you exactly when.

$ErrorActionPreference = 'Stop'
$Base = 'https://ahead-backend-production-ee80.up.railway.app'
$EmailA = 'ahead-isolation-test-a@example.com'
$EmailB = 'ahead-isolation-test-b@example.com'
$Password = 'correcthorsebattery1'   # 10+ chars, required by /api/auth/signup

function Invoke-Json($Method, $Path, $Headers, $Body) {
    $uri = "$Base$Path"
    try {
        if ($Body) {
            return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json)
        } else {
            return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers
        }
    } catch {
        # Invoke-RestMethod throws on non-2xx - surface the real body/status instead of losing it
        $resp = $_.Exception.Response
        $status = if ($resp) { [int]$resp.StatusCode } else { 'no response' }
        $reader = if ($resp) { New-Object System.IO.StreamReader($resp.GetResponseStream()) } else { $null }
        $bodyText = if ($reader) { $reader.ReadToEnd() } else { $_.Exception.Message }
        Write-Host "  HTTP $status : $bodyText"
        try { return $bodyText | ConvertFrom-Json } catch { return $null }
    }
}

Write-Host "=== 1. Sign up account A ==="
$respA = Invoke-Json POST '/api/auth/signup' $null @{ email = $EmailA; password = $Password; displayName = 'Isolation Test A' }
if (-not $respA.token) {
    Write-Host "  (account A already exists - logging in instead)"
    $respA = Invoke-Json POST '/api/auth/login' $null @{ email = $EmailA; password = $Password }
}
$TokenA = $respA.token
$UserAId = $respA.user.id
Write-Host "  user A id: $UserAId"

Write-Host "`n=== 2. Sign up account B ==="
$respB = Invoke-Json POST '/api/auth/signup' $null @{ email = $EmailB; password = $Password; displayName = 'Isolation Test B' }
if (-not $respB.token) {
    Write-Host "  (account B already exists - logging in instead)"
    $respB = Invoke-Json POST '/api/auth/login' $null @{ email = $EmailB; password = $Password }
}
$TokenB = $respB.token
$UserBId = $respB.user.id
Write-Host "  user B id: $UserBId"

Write-Host "`n>>> Before continuing, verify B's email in Supabase's SQL editor:"
Write-Host "    UPDATE users SET email_verified_at = now() WHERE email = '$EmailB';"
Read-Host "Press Enter once you've run that"

$authA = @{ Authorization = "Bearer $TokenA" }
$authB = @{ Authorization = "Bearer $TokenB" }

Write-Host "`n=== 3. Mint a device key for A (simulates a real phone's ahead-android install) ==="
$deviceA = Invoke-Json POST '/api/devices' $authA @{ label = 'isolation-test-A-phone' }
$deviceA | ConvertTo-Json
$ApiKeyA = $deviceA.apiKey

Write-Host "`n=== 4. Push synthetic readings under A's device key ==="
$nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$readingsA = @(
    @{ date = $nowMs - 600000; sgv = 110 },
    @{ date = $nowMs - 300000; sgv = 115 },
    @{ date = $nowMs; sgv = 120 }
)
$deviceKeyHeader = @{ 'X-Ahead-Api-Key' = $ApiKeyA }
$checkResp = Invoke-Json POST '/api/check-trend' $deviceKeyHeader @{ readings = $readingsA }
$checkResp | ConvertTo-Json -Depth 5

Write-Host "`n=== 5. B tries to read A's stream WITHOUT a share -> expect 403 ==="
Invoke-Json GET "/api/readings?ownerId=$UserAId" $authB $null | ConvertTo-Json

Write-Host "`n=== 6. B reads their OWN (empty) stream -> confirm it's genuinely separate, not A's data leaking through ==="
Invoke-Json GET "/api/readings?ownerId=$UserBId" $authB $null | ConvertTo-Json

Write-Host "`n=== 7. A grants B a share ==="
$shareResp = Invoke-Json POST '/api/shares' $authA @{ viewerEmail = $EmailB }
$shareResp | ConvertTo-Json
$ShareId = $shareResp.shareId

Write-Host "`n=== 8. B reads A's stream again -> expect 200 with A's actual readings now ==="
Invoke-Json GET "/api/readings?ownerId=$UserAId" $authB $null | ConvertTo-Json -Depth 5

Write-Host "`n=== 9. A revokes the share ==="
Invoke-Json DELETE "/api/shares/$ShareId" $authA $null | ConvertTo-Json

Write-Host "`n=== 10. B reads A's stream again -> expect 403 again, share is really gone ==="
Invoke-Json GET "/api/readings?ownerId=$UserAId" $authB $null | ConvertTo-Json

Write-Host "`n=== 11. Clean up: delete both test accounts ==="
Invoke-Json DELETE '/api/auth/account' $authA @{ password = $Password } | ConvertTo-Json
Invoke-Json DELETE '/api/auth/account' $authB @{ password = $Password } | ConvertTo-Json

Write-Host "`n=== 12. Confirm A's device key is dead post-deletion ==="
Invoke-Json POST '/api/check-trend' $deviceKeyHeader @{ readings = $readingsA } | ConvertTo-Json

Write-Host "`nDone. Expected results summary:"
Write-Host "  Step 5:  HTTP 403 (no share yet)"
Write-Host "  Step 6:  entries: []  (B's own stream, empty, not A's data)"
Write-Host "  Step 8:  HTTP 200 with the 3 readings pushed in step 4"
Write-Host "  Step 10: HTTP 403 again (revoke actually took effect)"
Write-Host "  Step 12: HTTP 401 (deleted account's device key is dead)"

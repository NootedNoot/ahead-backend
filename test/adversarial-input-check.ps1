# Ahead: adversarial/malformed input check, against the LIVE Railway backend.
#
# Throws deliberately bad input at every public endpoint and checks the
# server degrades gracefully (a clean 4xx) instead of crashing (5xx),
# leaking a stack trace, or - worst case - actually doing the injection.
# Every parameterized-query claim in this codebase's own doc comments gets
# an actual adversarial check here instead of staying a claim.
#
# Run with: powershell -ExecutionPolicy Bypass -File test\adversarial-input-check.ps1
# Safe to run repeatedly - never creates a persistent account (each bad
# signup should fail; the one deliberately-valid signup at the end is
# used only to reach authenticated endpoints, then deleted).

$ErrorActionPreference = 'Continue'
$Base = 'https://ahead-backend-production-ee80.up.railway.app'
$results = @()

function Test-Case($Name, $Method, $Path, $Headers, $RawBody, $ExpectStatusPattern) {
    # Windows PowerShell 5.1 (this environment) has no -SkipHttpErrorCheck -
    # that's a PowerShell 7+ Invoke-WebRequest flag. An earlier version of
    # this script used it unconditionally, which threw a parameter-binding
    # error on EVERY call before any request was even sent - the catch
    # block's "older PS" fallback never actually triggered because a
    # parameter-binding error has no HTTP response object at all, so every
    # case silently reported HTTP -1 and the whole run was void. Plain
    # try/catch against a real 4xx/5xx (the same pattern isolation-check.ps1
    # and concurrent-load-check.ps1 already use successfully) is correct here.
    $uri = "$Base$Path"
    try {
        $params = @{ Method = $Method; Uri = $uri; TimeoutSec = 20 }
        if ($Headers) { $params.Headers = $Headers }
        if ($RawBody -ne $null) { $params.ContentType = 'application/json'; $params.Body = $RawBody }
        $resp = Invoke-WebRequest @params
        $status = [int]$resp.StatusCode
        $bodySnippet = if ($resp.Content.Length -gt 200) { $resp.Content.Substring(0,200) } else { $resp.Content }
    } catch {
        $r = $_.Exception.Response
        if ($r) {
            $status = [int]$r.StatusCode
            $reader = New-Object System.IO.StreamReader($r.GetResponseStream())
            $bodySnippet = $reader.ReadToEnd()
            if ($bodySnippet.Length -gt 200) { $bodySnippet = $bodySnippet.Substring(0,200) }
        } else {
            $status = -1
            $bodySnippet = $_.Exception.Message
        }
    }
    $looksLikeCrash = $bodySnippet -match '(?i)stack|at Object\.|at Module\.|TypeError|ReferenceError|node_modules'
    $isServerError = $status -ge 500
    # Explicit, not a chained -and/-or one-liner - an earlier version of
    # this line had a real operator-precedence bug: PowerShell's -and/-or
    # share one precedence level and evaluate strictly left-to-right (no
    # C-style "&& binds tighter than ||"), so combining an ExpectStatusPattern
    # regex-OR-check with the 'any-4xx' special case in one chained
    # expression silently required status>=400 even for patterns like
    # 'any-4xx|^200$' that were meant to accept 200 too - a genuine
    # legitimate 200 would have been marked FAIL. Separate, explicit
    # booleans are worth the extra lines here.
    $matchesExplicitPattern = ($ExpectStatusPattern -ne 'any-4xx') -and ($status -match $ExpectStatusPattern)
    $matchesAny4xx = $status -ge 400 -and $status -lt 500
    $matchesAny4xxOr200 = $matchesAny4xx -or $status -eq 200
    $acceptedByPattern = if ($ExpectStatusPattern -eq 'any-4xx') { $matchesAny4xx }
                         elseif ($ExpectStatusPattern -eq 'any-4xx|^200$') { $matchesAny4xxOr200 }
                         else { $matchesExplicitPattern }
    $pass = (-not $isServerError) -and (-not $looksLikeCrash) -and $acceptedByPattern
    # $script: scope explicitly - a function's own `$results += ...` writes
    # to a LOCAL copy inside the function's scope, never the outer script
    # variable, so every earlier version of this script silently accumulated
    # nothing and ended with the misleading "0 cases run ... PASS" line
    # despite dozens of real OK/WARN/CRASH lines already printed above it.
    $script:results += [PSCustomObject]@{ Name = $Name; Status = $status; Pass = $pass; Body = $bodySnippet }
    $flag = if ($pass) { "OK  " } elseif ($isServerError) { "CRASH" } elseif ($looksLikeCrash) { "LEAK " } else { "WARN " }
    Write-Host "[$flag] $Name -> HTTP $status"
    if (-not $pass) { Write-Host "        body: $bodySnippet" }
}

Write-Host "=== Auth endpoint abuse ==="
Test-Case "signup: SQLi-shaped email" POST '/api/auth/signup' $null (@{ email = "' OR '1'='1"; password = 'correcthorsebattery1' } | ConvertTo-Json) 'any-4xx'
Test-Case "signup: password too short" POST '/api/auth/signup' $null (@{ email = 'adv-short-pw@example.com'; password = '123' } | ConvertTo-Json) 'any-4xx'
Test-Case "signup: missing password field" POST '/api/auth/signup' $null (@{ email = 'adv-nopw@example.com' } | ConvertTo-Json) 'any-4xx'
Test-Case "signup: null email" POST '/api/auth/signup' $null (@{ email = $null; password = 'correcthorsebattery1' } | ConvertTo-Json) 'any-4xx'
Test-Case "signup: script-tag email (stored XSS shape)" POST '/api/auth/signup' $null (@{ email = "<script>alert(1)</script>@example.com"; password = 'correcthorsebattery1' } | ConvertTo-Json) 'any-4xx'
Test-Case "signup: massively long email (buffer/DoS shape)" POST '/api/auth/signup' $null (@{ email = ("a" * 5000) + "@example.com"; password = 'correcthorsebattery1' } | ConvertTo-Json) 'any-4xx'
Test-Case "login: nonexistent user" POST '/api/auth/login' $null (@{ email = 'definitely-nobody@example.com'; password = 'whatever12345' } | ConvertTo-Json) '^401$'
Test-Case "login: malformed raw JSON body" POST '/api/auth/login' $null '{ this is not valid json ][' '^400$'
Test-Case "login: wrong content type (form-encoded body claiming JSON)" POST '/api/auth/login' $null 'email=a@b.com&password=x' 'any-4xx'

Write-Host "`n=== check-trend abuse (no auth header at all) ==="
Test-Case "check-trend: no X-Ahead-Api-Key header" POST '/api/check-trend' $null (@{ readings = @(@{date=1;sgv=100},@{date=2;sgv=110}) } | ConvertTo-Json) '^401$'
Test-Case "check-trend: garbage api key" POST '/api/check-trend' @{ 'X-Ahead-Api-Key' = 'ahead_dk_totally_made_up_garbage_key_1234567890' } (@{ readings = @(@{date=1;sgv=100},@{date=2;sgv=110}) } | ConvertTo-Json) '^401$'

Write-Host "`n=== Signing up ONE legitimate account to reach authenticated endpoints ==="
$goodEmail = "ahead-adversarial-test@example.com"
try {
    $good = Invoke-RestMethod -Method POST -Uri "$Base/api/auth/signup" -ContentType 'application/json' `
        -Body (@{ email = $goodEmail; password = 'correcthorsebattery1' } | ConvertTo-Json)
} catch {
    $good = Invoke-RestMethod -Method POST -Uri "$Base/api/auth/login" -ContentType 'application/json' `
        -Body (@{ email = $goodEmail; password = 'correcthorsebattery1' } | ConvertTo-Json)
}
$device = Invoke-RestMethod -Method POST -Uri "$Base/api/devices" -Headers @{ Authorization = "Bearer $($good.token)" } `
    -ContentType 'application/json' -Body (@{ label = 'adversarial-test' } | ConvertTo-Json)
$apiKey = $device.apiKey
$deviceHeader = @{ 'X-Ahead-Api-Key' = $apiKey }
$userAuth = @{ Authorization = "Bearer $($good.token)" }

Write-Host "`n=== check-trend: malformed reading payloads (real device key, bad body) ==="
Test-Case "check-trend: only 1 reading (need >= 2)" POST '/api/check-trend' $deviceHeader (@{ readings = @(@{date=1;sgv=100}) } | ConvertTo-Json) '^400$'
Test-Case "check-trend: empty readings array" POST '/api/check-trend' $deviceHeader (@{ readings = @() } | ConvertTo-Json) '^400$'
Test-Case "check-trend: readings is not an array" POST '/api/check-trend' $deviceHeader (@{ readings = "not-an-array" } | ConvertTo-Json) '^400$'
Test-Case "check-trend: missing readings key entirely" POST '/api/check-trend' $deviceHeader (@{ tuning = @{} } | ConvertTo-Json) '^400$'
Test-Case "check-trend: negative sgv" POST '/api/check-trend' $deviceHeader (@{ readings = @(@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-600000);sgv=-50},@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()));sgv=-40}) } | ConvertTo-Json) 'any-4xx'
Test-Case "check-trend: absurd sgv (99999)" POST '/api/check-trend' $deviceHeader (@{ readings = @(@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-600000);sgv=99999},@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()));sgv=99999}) } | ConvertTo-Json) 'any-4xx'
Test-Case "check-trend: sgv as a string, not a number" POST '/api/check-trend' $deviceHeader (@{ readings = @(@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-600000);sgv="one-hundred"},@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()));sgv="one-ten"}) } | ConvertTo-Json) 'any-4xx'
Test-Case "check-trend: date as a negative number" POST '/api/check-trend' $deviceHeader (@{ readings = @(@{date=-999999999999;sgv=100},@{date=-1;sgv=110}) } | ConvertTo-Json) 'any-4xx'
Test-Case "check-trend: SQLi-shaped extra field" POST '/api/check-trend' $deviceHeader (@{ readings = @(@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-600000);sgv=100},@{date=([long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()));sgv=110}); lastBolusTimestamp = "1; DROP TABLE readings; --" } | ConvertTo-Json) 'any-4xx'

Write-Host "`n=== check-trend: large batch (DoS/perf shape - 3000 readings in one call) ==="
$nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$bigReadings = 1..3000 | ForEach-Object { @{ date = $nowMs - ($_ * 60000); sgv = 100 + ($_ % 50) } }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Test-Case "check-trend: 3000-reading batch" POST '/api/check-trend' $deviceHeader (@{ readings = $bigReadings } | ConvertTo-Json -Depth 5) 'any-4xx|^200$'
$sw.Stop()
Write-Host "        (took $($sw.ElapsedMilliseconds) ms)"

Write-Host "`n=== Authorization boundary abuse ==="
Test-Case "readings: no ownerId, no auth header" GET '/api/readings' $null $null '^401$'
Test-Case "readings: ownerId is garbage non-UUID string" GET '/api/readings?ownerId=not-a-real-uuid-at-all' $userAuth $null 'any-4xx'
Test-Case "shares: grant to an email with no account" POST '/api/shares' $userAuth (@{ viewerEmail = 'nobody-real-1234567@example.com' } | ConvertTo-Json) '^404$'
Test-Case "shares: grant to self" POST '/api/shares' $userAuth (@{ viewerEmail = $goodEmail } | ConvertTo-Json) 'any-4xx'
Test-Case "devices: revoke a device id that doesn't exist" POST '/api/devices/00000000-0000-0000-0000-000000000000/revoke' $userAuth $null '^404$'
Test-Case "admin: regular user JWT against an admin-only endpoint" GET '/api/admin/users' $userAuth $null '^401$'

Write-Host "`n=== Cleanup ==="
Invoke-RestMethod -Method DELETE -Uri "$Base/api/auth/account" -Headers $userAuth -ContentType 'application/json' `
    -Body (@{ password = 'correcthorsebattery1' } | ConvertTo-Json) | Out-Null
Write-Host "  test account deleted"

Write-Host "`n=== SUMMARY ==="
$failed = @($results | Where-Object { -not $_.Pass })
Write-Host "$($results.Count) cases run, $($failed.Count) failed"
if ($results.Count -eq 0) {
    # A real failure mode this script had once already (2026-08-30): a
    # PowerShell-version incompatibility made every Test-Case throw before
    # $results ever got appended to, and an empty array trivially satisfied
    # "$failed.Count -eq 0" - a script bug silently printing PASS having
    # tested nothing at all. Fail loudly instead of falling through to PASS.
    Write-Host "FAIL: zero cases actually ran - this is a script bug, not a real pass. Do not trust this result."
} elseif ($failed.Count -gt 0) {
    Write-Host "Failing cases:"
    $failed | ForEach-Object { Write-Host "  - $($_.Name) -> HTTP $($_.Status)" }
} else {
    Write-Host "PASS: every adversarial input was rejected cleanly (4xx), no 500s, no leaked stack traces."
}

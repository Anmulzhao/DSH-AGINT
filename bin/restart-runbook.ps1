# AGINT Restart Runbook (Windows PowerShell, ASCII-only)
#
# Background: bin/safe-update.sh restart fails on Git Bash with
#   "pgrep: command not found" (mingw lacks procps package).
# This script uses native Windows taskkill + Get-CimInstance to replace pgrep,
# implementing SIGTERM-like graceful stop (taskkill without /F -> wait 30s ->
# taskkill /F as fallback).
#
# Boss runs manually (Zhi Jin sandbox cannot start/stop dsh web).
#
# IMPORTANT: stdout from PowerShell -File may be lost during some shell
# invocations. ALL output is also written to:
#   C:\Users\Administrator\AppData\Local\Temp\dsh-restart.log
# Boss should tail this file to verify what happened:
#   Get-Content -Path C:\Users\Administrator\AppData\Local\Temp\dsh-restart.log -Wait
#
# Usage: powershell -ExecutionPolicy Bypass -File .\restart-runbook.ps1
#
# v0.6.7 (2026-09-08) fix:
#   - precheck #1 (hash scan) no longer aborts the runbook under
#     $ErrorActionPreference='Stop'. Scopes EAP to Continue for the prechecks
#     and iterates with a foreach statement over a pre-collected array.
#     PS 5.1 quirk (observed while mounting agint-memory-provider): with EAP=Stop,
#     `Get-ChildItem -Path .. -Directory -Filter 'agint-*' -ErrorAction
#     SilentlyContinue | ForEach-Object {<multi-line body>}` inside an if-block
#     re-throws a spurious "Cannot bind argument to parameter 'Path' because it
#     is null" at ForEach-Object, killing the runbook before any kill/start.
# v0.6.6 (2026-09-07) updates:
#   - precheck #1 (hash) now scans ALL agint-*/lib/tools.js in host + repo
#     instead of hard-coded evolution-memory; reports drift without failing
#   - precheck #2 (preset rows) reads the actual count from host preset
#     instead of hard-coded 14; logs and continues regardless
#   - section 2.2 injects $env:AGINT_HOME before starting dsh web
#     (AGENTS.md line 19: AGINT_HOME pinning is required to avoid the silent
#     "wiki/dream/evolve read empty data" trap)
#   - section 3 (verification) expanded to cover all 16 current preset tool rows
#

$ErrorActionPreference = 'Stop'
$dshWebLog = 'C:\Users\Administrator\AppData\Local\Temp\dsh-web.log'
$leasePath = 'C:\Users\Administrator\.dsh\sentinel.lease'
$scriptLog = 'D:\DSH\project\DSH-AGINT\reviews\dsh-restart.log'

# AGINT_HOME pinned value per AGENTS.md line 19 (boss verified).
# Set BEFORE anything reads plugin storage paths (wiki / dream / evolve / abtest).
$AGINT_HOME = 'C:\Users\Administrator\projects\AGINT'

# Truncate log
if (Test-Path $scriptLog) { Remove-Item $scriptLog -Force }

function Write-Log([string]$msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $scriptLog -Value $line
}
function Log([string]$msg) { Write-Log $msg }
function Ok([string]$msg) { Write-Log "[OK] $msg" }
function Warn([string]$msg) { Write-Log "[WARN] $msg" }
function Fail([string]$msg) { Write-Log "[FAIL] $msg"; exit 1 }

Log '=== AGINT Restart Runbook (v0.6.7) ==='
Log "Script log: $scriptLog"

# --- 0. Pre-checks -----------------------------------------------
Log '-- 0. Pre-checks --'

# 0a. Scan ALL agint-* plugins for lib/tools.js hash drift between repo and host.
#     Drift is reported (not fatal) — caller decides whether to fix before restart.
Log '0a. Hash check: all agint-*/lib/tools.js (repo vs host)'
$repoRoot = 'D:\DSH\project\DSH-AGINT\plugins'
$hostRoot = 'C:\Users\Administrator\.dsh\profiles\web\plugins'
$drift = @()
# v0.6.7: prechecks are non-fatal by design, so scope EAP back to Continue for
# this scan. Under EAP=Stop, PowerShell 5.1 re-throws a spurious
# "Cannot bind argument to parameter 'Path' because it is null" at
# ForEach-Object for `Get-ChildItem -Path .. -Directory [-Filter ..] |
# ForEach-Object {<multi-line body>}` inside an if-block, aborting the runbook
# before any kill/start. foreach statement + pre-collected array avoids it.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $repoPlugins = @(Get-ChildItem -Path $repoRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'agint-*' })
    foreach ($pluginDir in $repoPlugins) {
        $name = $pluginDir.Name
        $repoTool = Join-Path $pluginDir.FullName 'lib\tools.js'
        # Quality sub-plugins live one level deeper (plugins/agint-quality/agint-quality-eval/lib/tools.js)
        if (-not (Test-Path $repoTool)) {
            $repoTool = Get-ChildItem -Path $pluginDir.FullName -Recurse -Filter 'tools.js' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -like '*\lib\tools.js' } |
                Select-Object -First 1 -ExpandProperty FullName
        }
        $hostTool = Join-Path (Join-Path $hostRoot $name) 'lib\tools.js'
        if (-not (Test-Path $hostTool)) {
            $hostTool = Get-ChildItem -Path (Join-Path $hostRoot $name) -Recurse -Filter 'tools.js' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -like '*\lib\tools.js' } |
                Select-Object -First 1 -ExpandProperty FullName
        }
        # v0.6.7: an empty inner search leaves the variable $null, and both $null
        # and '' are rejected by Test-Path with a TERMINATING binding error
        # (surfaced once the EAP=Stop ForEach-Object quirk was fixed). Guard with
        # IsNullOrEmpty so a plugin without lib/tools.js can't abort the scan.
        if (-not [string]::IsNullOrEmpty($repoTool) -and (Test-Path $repoTool) -and
            -not [string]::IsNullOrEmpty($hostTool) -and (Test-Path $hostTool)) {
            $hRepo = (Get-FileHash $repoTool -Algorithm SHA256).Hash
            $hHost = (Get-FileHash $hostTool -Algorithm SHA256).Hash
            if ($hRepo -ne $hHost) {
                $drift += "$name repo=$($hRepo.Substring(0,12)) host=$($hHost.Substring(0,12))"
            }
        } elseif (-not [string]::IsNullOrEmpty($repoTool) -and (Test-Path $repoTool)) {
            $drift += "$name repo-only (host missing)"
        }
    }
}
finally {
    $ErrorActionPreference = $prevEap
}
if ($drift.Count -eq 0) {
    Ok "all tools.js hashes consistent (repo == host)"
} else {
    Warn "tools.js drift detected ($($drift.Count) entries):"
    foreach ($d in $drift) { Warn "  - $d" }
    Warn 'fix drift with:  node D:\DSH\sync-abtest-host.mjs  (or per-plugin cp)'
}

# 0b. Preset rows count — read actual host count, no hard-coded expectation.
Log '0b. Preset tool rows'
$preset = 'C:\Users\Administrator\.dsh\.agent-presets\agint\agent.cordis.yml'
if (-not (Test-Path $preset)) { Fail "preset not found: $preset" }
$rows = @(Select-String -Path $preset -Pattern '^- id: agint-.*-tools$')
Log "preset agint-*-tools rows = $($rows.Count)"
if ($rows.Count -lt 7) { Fail "preset rows count $($rows.Count) < 7 (suspicious — at minimum memory+wiki+cron+rules+metrics+evolve+dream)" }
Ok "preset rows = $($rows.Count)"

# --- 1. Diagnose: how many dsh web instances + port 3080 holder ------------------
Log '-- 1. Diagnose existing dsh web processes + port 3080 --'
$dshPids = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" `
    | Where-Object { $_.CommandLine -like '*dsh*' -or $_.CommandLine -like '*cordis*' } `
    | Select-Object -ExpandProperty ProcessId
Log "dsh web processes: $($dshPids -join ', ')"
if ($dshPids.Count -gt 1) { Warn "Multiple dsh web instances (safe-update.sh may have launched extra one) -- will kill all" }

# Also find any process holding port 3080 (via netstat + tasklist cross-reference)
$port3080 = netstat -ano | Select-String ":3080\s.*LISTENING" | ForEach-Object {
    ($_ -split '\s+')[-1]   # last column = PID
} | Sort-Object -Unique
Log "port 3080 LISTENING PIDs: $($port3080 -join ', ')"

# --- 2.1 Graceful stop -----------------------------------------
Log '-- 2.1 Graceful stop --'
Log "Killing port 3080 holders FIRST (EADDRINUSE prevention)"
foreach ($procId in $port3080) {
    Log "kill PID $procId (port 3080 holder)"
    $p = Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $procId" -NoNewWindow -Wait -PassThru -RedirectStandardOutput "NUL" -RedirectStandardError "NUL" -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

Log "Killing dsh web processes"
foreach ($procId in $dshPids) {
    Log "kill PID $procId (taskkill without /F -> WM_CLOSE -> wait 30s)"
    # Use Start-Process to fully suppress taskkill stderr/stdout
    $p = Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $procId" -NoNewWindow -Wait -PassThru -RedirectStandardOutput "NUL" -RedirectStandardError "NUL" -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) {
        $still = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $still) { Ok "PID $procId exited ($($i+1)s)"; break }
        Start-Sleep -Seconds 1
    }
    $still = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($still) {
        Warn "PID $procId still alive -> taskkill /F force kill"
        $p2 = Start-Process -FilePath "taskkill.exe" -ArgumentList "/F /PID $procId" -NoNewWindow -Wait -PassThru -RedirectStandardOutput "NUL" -RedirectStandardError "NUL" -ErrorAction SilentlyContinue
    }
}

# --- 2.2 Start dsh web ------------------------------------------
Log '-- 2.2 Start dsh web --'
$cwd = 'C:\Users\Administrator\projects'
if (-not (Test-Path $cwd)) { Fail "working dir not found: $cwd" }
Set-Location $cwd

# Pin AGINT_HOME in the dsh web process environment (AGENTS.md line 19).
# Without this, wiki / dream / evolve silently read empty data because
# AGINT_HOME defaults to D:\DSH\project\DSH-AGINT (the source tree, whose
# wiki/ dir is empty) instead of C:\Users\Administrator\projects\AGINT
# (the live data root).
Log "pinning AGINT_HOME=$AGINT_HOME for the dsh web subprocess"
$env:AGINT_HOME = $AGINT_HOME
if (-not (Test-Path $AGINT_HOME)) { Warn "AGINT_HOME path not found: $AGINT_HOME (wiki/dream/evolve will read empty until path exists)" }

# Use cmd /c start /B for nohup equivalent
$proc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "dsh web > `"$dshWebLog`" 2>&1" `
    -WorkingDirectory $cwd `
    -WindowStyle Hidden `
    -PassThru
Log "dsh web started (cmd wrapper PID=$($proc.Id))"
Log "log: $dshWebLog"

# --- 2.3 Wait for sentinel.lease -----------------------------------
Log '-- 2.3 Wait for sentinel.lease (<= 60s) --'
$leaseFound = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $leasePath) {
        $lease = Get-Content $leasePath
        Ok "sentinel.lease: $lease"
        $leaseFound = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $leaseFound) { Fail "sentinel.lease timeout (60s not created), check $dshWebLog" }

# --- 3. Verification (boss manually calls tools, see runbook doc) --
Log '-- 3. Post-restart verification (manual tool calls) --'
Log 'Verify in any new AGINT session:'
Log '  rule_audit                  -> hits + asks + advisories + denies all reachable'
Log '  memory_search <keyword>     -> long-term memory reachable'
Log '  wiki_search <keyword>       -> wiki reachable (AGINT_HOME pinned OK if non-empty)'
Log '  metrics_summary             -> 13 indicators fresh'
Log '  cron_list                   -> 8 jobs with lastRunAt populated after first tick'
Log '  abtest_list_tests           -> "no tests yet" (K19 round-trip OK)'
Log '  rule_check tool=abtest_start   -> expected ASK (or NO_MATCH — known bug, see propose 87113823)'
Log '  rule_check tool=abtest_report  -> expected ASK (same caveat)'
Log '  rule_check tool=eventBus_publish -> ASK (known-good control)'
Log '  dream_status                -> lastSweep recent'
Log '  selfModel_snapshot          -> capability map reachable (CAN/CANNOT/UNCERTAIN)'
Log 'See docs/operations/safe-update-sop.md for the full post-restart checklist.'

Ok 'Restart runbook complete'
Log "Full output: $scriptLog"
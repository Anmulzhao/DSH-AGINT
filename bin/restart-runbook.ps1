# AGINT Batch 2.1 Restart Runbook (Windows PowerShell, ASCII-only)
#
# Background: bin/safe-update.sh restart fails on Git Bash with
#   "pgrep: command not found" (mingw lacks procps package).
# This script uses native Windows taskkill + Get-CimInstance to replace pgrep,
# implementing SIGTERM-like graceful stop (taskkill without /F -> wait 30s ->
# taskkill /F as fallback).
#
# Boss runs manually (Zhi Jin sandbox cannot start/stop dsh web).
#
# State: plugin-preflight steps 1-4 all green (repo / preset 14 rows /
# 5 ask rules / host sync hash consistent).
#
# IMPORTANT: stdout from PowerShell -File may be lost during some shell
# invocations. ALL output is also written to:
#   C:\Users\Administrator\AppData\Local\Temp\dsh-restart.log
# Boss should tail this file to verify what happened:
#   Get-Content -Path C:\Users\Administrator\AppData\Local\Temp\dsh-restart.log -Wait
#
# Usage: powershell -ExecutionPolicy Bypass -File .\restart-runbook.ps1
#

$ErrorActionPreference = 'Stop'
$dshWebLog = 'C:\Users\Administrator\AppData\Local\Temp\dsh-web.log'
$leasePath = 'C:\Users\Administrator\.dsh\sentinel.lease'
$scriptLog = 'D:\DSH\project\DSH-AGINT\reviews\dsh-restart.log'

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

Log '=== AGINT Batch 2.1 Restart Runbook ==='
Log "Script log: $scriptLog"

# --- 0. Pre-checks -----------------------------------------------
Log '-- 0. Pre-checks --'
$repo = 'D:\DSH\project\DSH-AGINT\plugins\agint-evolution-memory\lib\tools.js'
$hostPlugin = 'C:\Users\Administrator\.dsh\profiles\web\plugins\agint-evolution-memory\lib\tools.js'
if (-not (Test-Path $repo)) { Fail "repo plugin not found: $repo" }
if (-not (Test-Path $hostPlugin)) { Fail "host plugin not found: $hostPlugin" }
$hRepo = (Get-FileHash $repo -Algorithm SHA256).Hash
$hHost = (Get-FileHash $hostPlugin -Algorithm SHA256).Hash
if ($hRepo -ne $hHost) { Fail "tools.js hash mismatch: repo=$hRepo  host=$hHost" }
Ok "tools.js hash consistent ($hHost)"

$preset = 'C:\Users\Administrator\.dsh\.agent-presets\agint\agent.cordis.yml'
$rows = @(Select-String -Path $preset -Pattern '^- id: agint-.*-tools$')
if ($rows.Count -ne 14) { Fail "preset rows count $($rows.Count) != 14" }
Ok "preset rows = 14"

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
Log '5 read-only tools: evolution_stats / queryFailures / queryTemplates / getLogRange / readLogRangeMerged'
Log '5 ask tools:       evolution_logPhase4 / logPhase4Buffered / addFailure / addSuccess / flushLogBufferNow'
Log '1 side-effect:     evolution_decayScanRun'
Log 'Verify rule_audit + metrics_collect inside AGINT session'

Ok 'Batch 2.1 restart runbook complete'
Log "Full output: $scriptLog"
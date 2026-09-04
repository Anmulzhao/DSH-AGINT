# Dry-run: only step 0 (pre-checks) of restart-runbook.ps1
# Boss can use this to verify pre-check output before doing actual restart
$ErrorActionPreference = 'Stop'
$scriptLog = 'D:\DSH\project\DSH-AGINT\reviews\dsh-restart-dry.log'
if (Test-Path $scriptLog) { Remove-Item $scriptLog -Force }

function Write-Log([string]$msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $scriptLog -Value $line
}

Write-Log '=== Batch 2.1 Restart Runbook -- DRY-RUN (pre-checks only) ==='
Write-Log "Script log: $scriptLog"

# Step 0: Pre-checks
Write-Log '-- 0. Pre-checks --'
$repo = 'D:\DSH\project\DSH-AGINT\plugins\agint-evolution-memory\lib\tools.js'
$hostPlugin = 'C:\Users\Administrator\.dsh\profiles\web\plugins\agint-evolution-memory\lib\tools.js'
if (-not (Test-Path $repo)) { Write-Log "[FAIL] repo plugin not found: $repo"; exit 1 }
if (-not (Test-Path $hostPlugin)) { Write-Log "[FAIL] host plugin not found: $hostPlugin"; exit 1 }
$hRepo = (Get-FileHash $repo -Algorithm SHA256).Hash
$hHost = (Get-FileHash $hostPlugin -Algorithm SHA256).Hash
Write-Log ("repo hash: " + $hRepo)
Write-Log ("host hash: " + $hHost)
if ($hRepo -ne $hHost) { Write-Log "[FAIL] tools.js hash mismatch"; exit 1 }
Write-Log "[OK] tools.js hash consistent"

$preset = 'C:\Users\Administrator\.dsh\.agent-presets\agint\agent.cordis.yml'
$rows = @(Select-String -Path $preset -Pattern '^- id: agint-.*-tools$')
Write-Log ("preset rows count: " + $rows.Count)
if ($rows.Count -ne 14) { Write-Log "[FAIL] preset rows count != 14"; exit 1 }
Write-Log "[OK] preset rows = 14"

# Step 1: Diagnose (read-only)
Write-Log '-- 1. Diagnose (read-only) --'
$dshPids = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" `
    | Where-Object { $_.CommandLine -like '*dsh*' -or $_.CommandLine -like '*cordis*' } `
    | Select-Object -ExpandProperty ProcessId
Write-Log ("dsh web PIDs: " + ($dshPids -join ', '))

Write-Log '-- DRY-RUN complete. Steps 2.1-3 require actual restart. --'
Write-Log "Full log: $scriptLog"
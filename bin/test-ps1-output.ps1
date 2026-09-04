# Test: verify restart-runbook.ps1 stdout flush
$ErrorActionPreference = 'Stop'
Write-Host "[TEST] script started"
Write-Host "[TEST] args = $($args -join ', ')"
Write-Host "[TEST] PWD = $(Get-Location)"
Write-Host "[TEST] script path = $PSCommandPath"
Write-Host "[TEST] PowerShell version = $($PSVersionTable.PSVersion)"
Write-Host "[TEST] exiting now"
exit 0
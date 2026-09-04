# Check restart-runbook.ps1 syntax via PowerShell 5.1 parser
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('D:\DSH\project\DSH-AGINT\bin\restart-runbook.ps1', [ref]$tokens, [ref]$errors)
if ($errors) {
    Write-Host "PARSE ERRORS:"
    $errors | ForEach-Object {
        Write-Host ("  line {0}:col {1} {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message)
    }
    exit 1
} else {
    Write-Host ("PARSE OK: 0 errors, {0} tokens, {1} AST nodes" -f $tokens.Count, $ast.EndBlock.Statements.Count)
    exit 0
}
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$triggerPath = Join-Path $root 'ops\sync-trigger.json'

$payload = @{
  requested_at = [DateTime]::UtcNow.ToString('o')
  reason = 'manual sync trigger'
}

$json = $payload | ConvertTo-Json
[System.IO.File]::WriteAllText($triggerPath, $json + [Environment]::NewLine, [System.Text.Encoding]::UTF8)

Write-Output "Updated $triggerPath"

<#
.SYNOPSIS
  Registers the daily eLMS schedule digest with Windows Task Scheduler.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-digest-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-digest-task.ps1 -At 06:30
#>
param([string]$At = '07:00', [string]$TaskName = 'eLMS Daily Digest')

$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root 'run-digest.cmd'
if (-not (Test-Path $cmd)) { Write-Error "run-digest.cmd not found in $root"; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) { Set-Content -Path (Join-Path $root '.node-path') -Value $node -Encoding ASCII; Write-Host "node: $node" }

Write-Host "Registering '$TaskName' daily at $At -> $cmd"
schtasks /Create /TN "$TaskName" /TR "`"$cmd`"" /SC DAILY /ST $At /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "SYSTEM registration failed (needs elevation); falling back to the current user." -ForegroundColor Yellow
  schtasks /Create /TN "$TaskName" /TR "`"$cmd`"" /SC DAILY /ST $At /RL HIGHEST /F | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error "Could not register the task. Run from an elevated prompt."; exit 1 }
}

schtasks /Query /TN "$TaskName" /FO LIST /V | Select-String -Pattern 'TaskName|Status|Next Run Time|Schedule Type|Start Time|Task To Run'
Write-Host "`nPost one now with:  schtasks /Run /TN `"$TaskName`"" -ForegroundColor Green

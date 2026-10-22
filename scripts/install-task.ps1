<#
.SYNOPSIS
  Registers the eLMS -> Discord poller with Windows Task Scheduler.

.DESCRIPTION
  Runs run-poll.cmd every N minutes (default: POLL_MINUTES from .env, else 10).
  Tries SYSTEM first so it keeps working with nobody logged in; if that needs
  elevation we have, it falls back to the current user.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Minutes 5
#>
param([int]$Minutes = 0, [string]$TaskName = 'eLMS Discord Notifier')

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

if ($Minutes -le 0 -and (Test-Path $envFile)) {
  $line = Select-String -Path $envFile -Pattern '^\s*POLL_MINUTES\s*=\s*(\d+)' | Select-Object -First 1
  if ($line) { $Minutes = [int]$line.Matches[0].Groups[1].Value }
}
if ($Minutes -le 0) { $Minutes = 10 }

$cmd = Join-Path $root 'run-poll.cmd'
if (-not (Test-Path $cmd)) { Write-Error "run-poll.cmd not found next to this script ($root)"; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  Set-Content -Path (Join-Path $root '.node-path') -Value $node -Encoding ASCII
  Write-Host "node: $node"
} else {
  Write-Warning "node was not found on PATH; install Node.js 20+ or write its path into .node-path"
}

Write-Host "Registering '$TaskName' every $Minutes minute(s) -> $cmd"

schtasks /Create /TN "$TaskName" /TR "`"$cmd`"" /SC MINUTE /MO $Minutes /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "SYSTEM registration failed (needs elevation). Falling back to the current user." -ForegroundColor Yellow
  schtasks /Create /TN "$TaskName" /TR "`"$cmd`"" /SC MINUTE /MO $Minutes /RL HIGHEST /F | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error "Could not register the task. Run this script from an elevated prompt."; exit 1 }
}

schtasks /Query /TN "$TaskName" /FO LIST /V | Select-String -Pattern 'TaskName|Status|Next Run Time|Repeat: Every|Task To Run'
Write-Host "`nRun it once now with:  schtasks /Run /TN `"$TaskName`"" -ForegroundColor Green

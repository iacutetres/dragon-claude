$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectPath = Split-Path -Parent $scriptDir
$healthUrl = "http://localhost:3080/health"
$appUrl = "http://localhost:3080"
$maxAttempts = 60

# If you move this script outside the repo, set $projectPath manually.
# $projectPath = "D:\path\to\dragon-claude"

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$projectPath'; node server.js"

for ($i = 0; $i -lt $maxAttempts; $i++) {
  try {
    Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1 | Out-Null
    Start-Process $appUrl
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

Write-Host "The server did not start in time."
exit 1

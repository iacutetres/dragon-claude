#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
HEALTH_URL="http://localhost:3080/health"
APP_URL="http://localhost:3080"

# If you move this script outside the repo, set PROJECT_PATH manually.
# PROJECT_PATH="/absolute/path/to/dragon-claude"

osascript -e 'tell application "Terminal"
    activate
    do script "cd '"$PROJECT_PATH"' && node server.js"
end tell'

for i in {1..60}; do
  if curl -sf "$HEALTH_URL" >/dev/null; then
    open -a "Google Chrome" "$APP_URL"
    exit 0
  fi
  sleep 0.5
done

echo "The server did not start in time."
exit 1

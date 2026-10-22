#!/usr/bin/env bash
# One poll cycle for cron/systemd timers on Linux/macOS.
# Example crontab line (every 10 minutes):
#   */10 * * * * /usr/bin/env bash /path/to/elms-notify/scripts/run-poll.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs data
if [ -f logs/poll.log ] && [ "$(wc -c < logs/poll.log)" -gt 2097152 ]; then
  mv -f logs/poll.log logs/poll.log.1
fi
printf '[%s] start\n' "$(date -Is)" >> logs/poll.log
node "$ROOT/src/poll.js" >> logs/poll.log 2>&1
rc=$?
printf '[%s] exit=%s\n' "$(date -Is)" "$rc" >> logs/poll.log
exit "$rc"

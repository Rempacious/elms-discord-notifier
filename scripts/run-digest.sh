#!/usr/bin/env bash
# Daily schedule digest for cron on Linux/macOS.
#  0 7 * * * /usr/bin/env bash /path/to/elms-discord-notifier/scripts/run-digest.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs data digest
if [ -f logs/digest.log ] && [ "$(wc -c < logs/digest.log)" -gt 2097152 ]; then
  mv -f logs/digest.log logs/digest.log.1
fi
printf '[%s] start\n' "$(date -Is)" >> logs/digest.log
node "$ROOT/src/digest.js" "$@" >> logs/digest.log 2>&1
rc=$?
printf '[%s] exit=%s\n' "$(date -Is)" "$rc" >> logs/digest.log
exit "$rc"

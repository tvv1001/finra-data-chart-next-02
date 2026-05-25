#!/usr/bin/env bash
# install-crawler-cron.sh
# Installs (or removes) a cron job that runs a short crawl periodically to
# refresh external FINRA/SEC data without hammering upstream providers.
# By default this schedules a run every 3 minutes. Adjust INTERVAL_MINUTES
# to change frequency (must be >=2 to avoid blocking).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_TAG="# finra-short-crawler"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

# How often to run (minutes). Enforce minimum 2 minutes to avoid aggressive polling.
INTERVAL_MINUTES=${INTERVAL_MINUTES:-3}
if [[ $INTERVAL_MINUTES -lt 2 ]]; then
  echo "INTERVAL_MINUTES must be >= 2" >&2
  exit 1
fi

CRAWLER_SCRIPT="$PROJECT_DIR/scripts/continuous_slow_crawl.js"
LOG_FILE="$PROJECT_DIR/data/continuous_slow_crawl.log"

if [[ "${1:-}" == "--remove" ]]; then
  CURRENT_CRON="$(crontab -l 2>/dev/null || true)"
  NEW_CRON="$(echo "$CURRENT_CRON" | grep -v "$CRON_TAG" || true)"
  echo "$NEW_CRON" | crontab -
  echo "Removed short crawler cron job."
  exit 0
fi

# We'll install a @reboot job that starts the continuous crawler once on boot.
# The crawler itself loops and sleeps between batches; this avoids multiple
# overlapping cron-started processes.
CRON_LINE="@reboot cd \"$PROJECT_DIR\" && nohup \"$NODE_BIN\" \"$CRAWLER_SCRIPT\" >> \"$LOG_FILE\" 2>&1 & $CRON_TAG"

CURRENT_CRON="$(crontab -l 2>/dev/null || true)"
NEW_CRON="$(echo "$CURRENT_CRON" | grep -v "$CRON_TAG" || true)"
if [[ -n "$NEW_CRON" ]]; then
  NEW_CRON="$NEW_CRON
$CRON_LINE"
else
  NEW_CRON="$CRON_LINE"
fi

echo "$NEW_CRON" | crontab -

echo "Short crawler cron job installed:"
echo "  $CRON_LINE"
echo "Log: $LOG_FILE"
echo "To remove: bash scripts/install-crawler-cron.sh --remove"

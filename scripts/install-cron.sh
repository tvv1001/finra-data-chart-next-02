#!/usr/bin/env bash
# install-cron.sh
# Registers (or updates) the daily 6am status-integrity check cron job.
#
# Usage:
#   bash scripts/install-cron.sh
#   bash scripts/install-cron.sh --remove   # remove the cron job

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_PATH="$PROJECT_DIR/scripts/daily_status_check.js"
LOG_FILE="$PROJECT_DIR/data/daily_status_check.log"
CRON_TAG="# finra-daily-status-check"

# Detect node path
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

# Build the cron line:  every day at 06:00
CRON_LINE="0 6 * * * cd \"$PROJECT_DIR\" && \"$NODE_BIN\" \"$SCRIPT_PATH\" >> \"$LOG_FILE\" 2>&1 $CRON_TAG"

# Read current crontab (ignore error if empty)
CURRENT_CRON="$(crontab -l 2>/dev/null || true)"

if [[ "${1:-}" == "--remove" ]]; then
  NEW_CRON="$(echo "$CURRENT_CRON" | grep -v "$CRON_TAG" || true)"
  echo "$NEW_CRON" | crontab -
  echo "Removed cron job."
  exit 0
fi

# Remove any existing entry for this job, then append the new line
NEW_CRON="$(echo "$CURRENT_CRON" | grep -v "$CRON_TAG" || true)"
if [[ -n "$NEW_CRON" ]]; then
  NEW_CRON="$NEW_CRON
$CRON_LINE"
else
  NEW_CRON="$CRON_LINE"
fi

echo "$NEW_CRON" | crontab -
echo "Cron job installed:"
echo "  $CRON_LINE"
echo ""
echo "Logs will be written to:"
echo "  $LOG_FILE"
echo ""
echo "To remove:  bash scripts/install-cron.sh --remove"
echo "To test now: node scripts/daily_status_check.js --dry-run"
echo "To test one: node scripts/daily_status_check.js --crd=3487 --dry-run"

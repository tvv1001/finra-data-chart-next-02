#!/usr/bin/env bash
# install-revalidate-cron.sh
# Registers (or updates) a daily revalidation cron job for external presence.
# Usage:
#   bash scripts/install-revalidate-cron.sh
#   bash scripts/install-revalidate-cron.sh --remove   # remove the cron job

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_PATH="$PROJECT_DIR/scripts/revalidate_external_presence.js"
LOG_FILE="$PROJECT_DIR/data/revalidate_external_presence.log"
CRON_TAG="# finra-revalidate-external"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

# Install a single combined daily maintenance cron job that runs both
# the existing daily status check and the revalidation script sequentially.
# This ensures there is only one cron entry for FINRA maintenance.
# Schedule daily at 06:00 (status) then revalidation immediately after.
COMBINED_TAG="# finra-daily-maintenance"
STATUS_SCRIPT="$PROJECT_DIR/scripts/daily_status_check.js"
REVALIDATE_SCRIPT="$PROJECT_DIR/scripts/revalidate_external_presence.js"
STATUS_LOG="$PROJECT_DIR/data/daily_status_check.log"
REVALIDATE_LOG="$PROJECT_DIR/data/revalidate_external_presence.log"

# Combined cron runs status first then revalidate; logs appended separately.
CRON_LINE="0 6 * * * cd \"$PROJECT_DIR\" && \"$NODE_BIN\" \"$STATUS_SCRIPT\" >> \"$STATUS_LOG\" 2>&1; \"$NODE_BIN\" \"$REVALIDATE_SCRIPT\" >> \"$REVALIDATE_LOG\" 2>&1 $COMBINED_TAG"

CURRENT_CRON="$(crontab -l 2>/dev/null || true)"

if [[ "${1:-}" == "--remove" ]]; then
  # Remove any related tags (previous single-job tags and combined tag)
  NEW_CRON="$(echo "$CURRENT_CRON" | grep -v "# finra-daily-status-check" | grep -v "# finra-revalidate-external" | grep -v "$COMBINED_TAG" || true)"
  echo "$NEW_CRON" | crontab -
  echo "Removed combined FINRA maintenance cron job."
  exit 0
fi

# Remove any existing FINRA-related cron entries (old tags), then append combined line
NEW_CRON="$(echo "$CURRENT_CRON" | grep -v "# finra-daily-status-check" | grep -v "# finra-revalidate-external" | grep -v "$COMBINED_TAG" || true)"
if [[ -n "$NEW_CRON" ]]; then
  NEW_CRON="$NEW_CRON
$CRON_LINE"
else
  NEW_CRON="$CRON_LINE"
fi

echo "$NEW_CRON" | crontab -

echo "Combined FINRA maintenance cron job installed:"
echo "  $CRON_LINE"
echo ""
echo "Status logs: $STATUS_LOG"
echo "Revalidate logs: $REVALIDATE_LOG"
echo ""
echo "To remove:  bash scripts/install-revalidate-cron.sh --remove"
echo "To test now: node scripts/daily_status_check.js --dry-run && node scripts/revalidate_external_presence.js --dry-run"

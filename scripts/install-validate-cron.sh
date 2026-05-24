#!/usr/bin/env bash
# Install a daily cronjob to run the external link validator script at 03:30 UTC daily.
# Usage: ./scripts/install-validate-cron.sh [--user <username>] [--hour <H>] [--minute <M>]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_CMD="/usr/bin/env node"
SCRIPT_PATH="$SCRIPT_DIR/validate_external_links.js"
HOUR="3"
MINUTE="30"
USER_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hour) HOUR="$2"; shift 2;;
    --minute) MINUTE="$2"; shift 2;;
    --user) USER_ARG="$2"; shift 2;;
    --apply) APPLY_FLAG="--apply"; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [ ! -f "$SCRIPT_PATH" ]; then
  echo "Validator script not found: $SCRIPT_PATH" >&2
  exit 2
fi

CRON_CMD="$NODE_CMD $SCRIPT_PATH >> $SCRIPT_DIR/../data/national/external_link_validation_cron.log 2>&1"
CRON_SCHEDULE="$MINUTE $HOUR * * *"
CRON_LINE="$CRON_SCHEDULE $CRON_CMD"

# Install into current user's crontab
(crontab -l 2>/dev/null | grep -v -F "$SCRIPT_PATH" || true; echo "$CRON_LINE") | crontab -

echo "Installed cron job: $CRON_LINE"

echo "Note: the cron job appends output to data/national/external_link_validation_cron.log"

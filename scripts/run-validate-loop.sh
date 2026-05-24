#!/usr/bin/env bash
set -euo pipefail

# Local-only validator loop
# Usage: RUN_HOURS=8 INTERVAL=1800 ./scripts/run-validate-loop.sh

INTERVAL=${INTERVAL:-1800} # seconds between runs (default 30m)
RUN_HOURS=${RUN_HOURS:-8}   # how many hours to run (default 8 hours)
LOG_DIR="$(pwd)/data/national"
mkdir -p "$LOG_DIR"
TS=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
LOG_FILE="$LOG_DIR/validate-loop-${TS}.log"

echo "Starting local validate loop: interval=${INTERVAL}s, run_hours=${RUN_HOURS}, log=${LOG_FILE}"
END_TIME=$(( $(date +%s) + RUN_HOURS * 3600 ))

while [ $(date +%s) -lt $END_TIME ]; do
  NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[${NOW_ISO}] running validator" | tee -a "$LOG_FILE"
  if node scripts/validate_external_links.js >>"$LOG_FILE" 2>&1; then
    echo "[${NOW_ISO}] validator finished successfully" | tee -a "$LOG_FILE"
  else
    echo "[${NOW_ISO}] validator run failed" | tee -a "$LOG_FILE"
  fi
  # sleep with small granularity so INT can interrupt faster
  SECONDS_LEFT=$(( END_TIME - $(date +%s) ))
  if [ $SECONDS_LEFT -le 0 ]; then
    break
  fi
  SLEEP_FOR=$INTERVAL
  if [ $SLEEP_FOR -gt $SECONDS_LEFT ]; then
    SLEEP_FOR=$SECONDS_LEFT
  fi
  sleep $SLEEP_FOR
done

echo "["$(date -u +"%Y-%m-%dT%H:%M:%SZ")"] validate loop completed" | tee -a "$LOG_FILE"

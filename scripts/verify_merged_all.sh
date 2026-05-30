#!/usr/bin/env bash
set -euo pipefail

# Configurable variables (can be set via env):
# API_BASE should point to the merged individual endpoint root (no trailing slash)
API_BASE="${API_BASE:-http://localhost:4444/api/finra/merged/individual}"
# Optional pause between requests in seconds (supports fractional, default 0)
SLEEP_SEC="${SLEEP_SEC:-0}"

OUT_CSV="/tmp/merged_verification_$(date +%Y%m%d_%H%M%S).csv"
OUT_JSONL="/tmp/merged_verification_$(date +%Y%m%d_%H%M%S).jsonl"

echo "crd,found,size" > "$OUT_CSV"
rm -f "$OUT_JSONL"

echo "Using API_BASE=$API_BASE (SLEEP_SEC=$SLEEP_SEC)"

for f in data/raw/finra:individual:*.json; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  crd="${base#finra:individual:}"
  crd="${crd%.json}"
  url="$API_BASE/$crd"

  tmp=$(mktemp)
  status=""
  # Perform request but don't let curl failures exit the script
  if ! status=$(curl -sS -w "%{http_code}" -o "$tmp" "$url"); then
    status="000"
  fi

  # size of the raw response bytes
  size=$(wc -c < "$tmp" 2>/dev/null || echo 0)

  if [ "$status" != "200" ]; then
    # Non-200 or request error: record as missing / error
    echo "$crd,false,$size" >> "$OUT_CSV"
    printf '%s\n' "{\"crd\":\"$crd\",\"error\":\"http_$status\",\"size\":$size}" >> "$OUT_JSONL"
    rm -f "$tmp"
    # optional pause to avoid hammering server
    if [ -n "$SLEEP_SEC" ] && [ "$SLEEP_SEC" != "0" ]; then sleep "$SLEEP_SEC"; fi
    continue
  fi

  # If we got 200, validate JSON before piping to jq
  if jq -e . "$tmp" >/dev/null 2>&1; then
    found=$(jq -r '.found // false' "$tmp")
    echo "$crd,$found,$size" >> "$OUT_CSV"
    jq -c --arg crd "$crd" '{crd: $crd, payload: .}' "$tmp" >> "$OUT_JSONL"
  else
    # invalid JSON payload (HTML error page, empty, etc.)
    echo "$crd,false,$size" >> "$OUT_CSV"
    printf '%s\n' "{\"crd\":\"$crd\",\"error\":\"invalid_json\",\"size\":$size}" >> "$OUT_JSONL"
  fi

  rm -f "$tmp"

  # optional pause to avoid hitting external services too fast
  if [ -n "$SLEEP_SEC" ] && [ "$SLEEP_SEC" != "0" ]; then sleep "$SLEEP_SEC"; fi
done

echo "Wrote $OUT_CSV and $OUT_JSONL"
echo "$OUT_CSV"

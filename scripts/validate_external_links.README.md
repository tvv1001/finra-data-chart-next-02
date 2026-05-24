Validator script for external FINRA/SEC summary links

Files:

- scripts/validate*external_links.js - Node script that scans data/national/finra-graph.json and validates FINRA/SEC summary URLs. Writes report to data/national/external_link_validation*<timestamp>.json.
- scripts/install-validate-cron.sh - helper to install a daily cron job that runs the validator.

Usage:

# Run once (report only):

node scripts/validate_external_links.js

# Run and apply fixes (will create a backup of the graph JSON):

node scripts/validate_external_links.js --apply

# Install a cron job (runs daily at 03:30 UTC by default):

./scripts/install-validate-cron.sh

Notes:

- The script uses the runtime's global fetch (Node 18+). If your Node is older, install node-fetch or use a newer Node runtime.
- The --apply flag will modify data/national/finra-graph.json to clear hasFinraPage / hasSecPage flags for unreachable URLs and will create a timestamped backup.

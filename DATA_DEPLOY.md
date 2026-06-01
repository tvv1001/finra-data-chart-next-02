This repository keeps large raw crawl outputs separate from deployable primed bundles.

Guidelines

- Keep the canonical raw crawl output outside the repository (e.g. /home/lenny/Dev/webDev/Data-finra-sec/data/raw).
- Use `scripts/build_primed_from_raw.js` to generate smaller primed-cache bundles that are safe to commit and deploy.
- Deploy only the `data/national/primed-cache/*.json` and `*.bin` files (and `manifest.json`) — do NOT deploy the entire raw dataset.

Quick commands

```bash
# Build primed bundles from external raw dir
EXTERNAL_RAW_DIR=/path/to/external/raw node scripts/build_primed_from_raw.js

# Verify bundles were written
ls -lh data/national/primed-cache
cat data/national/primed-cache/manifest.json
```

Continuous workflow

- Run the build script on the crawler host after each crawl and push the primed bundles to your deployment artifact store (e.g., S3, release assets) rather than committing raw JSON files into git.
- If you need Redis priming in CI, upload the primed bundles or call `scripts/import_local_cache.js` with LOCAL_DATA_DIR pointing to the primed bundle location.

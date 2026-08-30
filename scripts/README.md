# Active scripts (day-to-day only)

Nuclear keep-list: only what `pnpm dev` / `pnpm build` / tests need. Everything else is under `archive/legacy-scripts/scripts/`.

## Dev
- `start-local-redis.sh` — used by `pnpm dev` / `pnpm dev:clean`

## Build (`pnpm build` / `prebuild`)
- `prebuild.js` — Next prebuild hook
- `build_workers.js` — pure JS `d3-force` worker bundle
- `build_search_indexes.js`, `copy-search-indexes.js` — search sidecars → `public/search-indexes/`
- `build_primed_cache_bundle.js` — primed cache (prebuild when raw caches exist)
- `build_graph_from_cache.js` — local graph artifact when needed
- `fetch_graph_from_server.js` — optional remote graph sync from prebuild

## E2E
- `run-e2e-docker.sh`, `run-e2e.README.md`
- Smoke includes `tests/e2e/firm-connection-bidirectional.spec.ts`: opens a person page, asserts every employer firm’s `firm-connections` roster includes that person CRD, and reports roster count drift vs `tests/e2e/fixtures/firm-connection-counts.{crd}.json`. Re-baseline with `UPDATE_FIRM_CONNECTION_SNAPSHOT=1`; hard-fail on drift with `FIRM_CONN_STRICT_COUNTS=1`.

## Restore ops scripts
Crawl, deploy-to-Upstash, firm-connections batch, CRD log, etc. live in `archive/legacy-scripts/scripts/`. Run them from there with `node archive/legacy-scripts/scripts/<name>` if you need them again.

# Search sidecar notes

The entire graph app hydrates identity (especially firm names) from gzip search-index flatfiles, not from ad-hoc live FINRA/SEC detail calls.

## Files

Source of truth after index build:

- `data/national/search-index.finra.firm.json.gz`
- `data/national/search-index.finra.individual.json.gz`
- `data/national/search-index.sec.firm.json.gz`
- `data/national/search-index.sec.individual.json.gz`

Runtime copies:

- `public/search-indexes/search-index.*.json.gz`

Each firm hit includes `firm_id` / `firm_name`. Use those fields when a graph node would otherwise render as `Firm <CRD>` or `Node firm:<CRD>`.

## Hydration path

1. Build indexes: `scripts/build_search_indexes.js`
2. Copy to public: `scripts/copy-search-indexes.js`
3. `src/lib/localSearch.ts` loads the gzip sidecar (never Redis search indexes)
4. Expand, graph-search, and client append look up CRDs in that sidecar and cache the real name

Cached names live on the node and in browser `localStorage` key `finra_node_label_cache` so a later merge cannot revert them to a generic label.

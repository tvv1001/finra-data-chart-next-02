Local data cache conventions

This repository keeps raw upstream payloads under `data/raw/` using source-first filenames such as `finra:individual:4240769.json`. The rebuild pipeline normalizes those files into the cache layouts expected by the app's runtime loaders.

To rebuild the local cache:

`pnpm data:rebuild`

To do the daily raw-source check and import from the externally maintained latest cache:

`pnpm data:sync`

To do the daily sync and immediately rebuild the generated cache artifacts afterward:

`pnpm data:daily`

The rebuild now generates all of the following in one pass:

- canonical cache files in `data/national/` named like:
  - `api.brokercheck.finra.org_search_individual_<CRD>.json`
  - `api.brokercheck.finra.org_search_firm_<CRD>.json`
  - `api.adviserinfo.sec.gov_search_individual_<CRD>.json`
  - `api.adviserinfo.sec.gov_search_firm_<CRD>.json`
- nested mirrors for merge loaders:
  - `data/national/brokercheck.finra.org/`
  - `data/national/adviserinfo.sec.gov/`
- primed cache bundles in both compatibility locations:
  - `data/national/primed-cache/`
  - `data/primed-cache/`
- gzip bundle companions (`*.bin`) for faster runtime bundle hydration
- validation and inventory reports:
  - `data/national/rebuild-manifest.json`
  - `data/national/rebuild-validation.json`

The primed bundles are keyed to the runtime cache conventions already used by the app, including:

- `finra:individual:<CRD>:hl=true&includePrevious=true&wt=json`
- `sec:individual:<CRD>:hl=true&includePrevious=true&wt=json`
- `finra:firm:<CRD>:hl=true&wt=json`
- `sec:firm:<CRD>`

By default the rebuild reads from the repo-local `data/raw/` folder and writes back into this repo's `data/` tree. If you intentionally want to target a different data directory, set `FINRA_DATA_DIR` explicitly before running the rebuild.

The daily sync command compares the repo-local `data/raw/` folder against the external latest raw cache at `/home/lenny/Dev/webDev/Data-finra-sec/data/raw`, copies any missing or changed files into this repo, and writes a report to `data/national/raw-sync-report.json`.

If you ever move the external latest raw cache, set `FINRA_EXTERNAL_RAW_DIR` before running `pnpm data:sync` or `pnpm data:daily`.

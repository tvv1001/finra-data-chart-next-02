# Upstash Redis and CRD-Check Policy

Applies to: data crawler scripts, API cache helpers, build pipelines, and any code that reads/writes the app's runtime/derived data.

Summary

- This project uses Upstash (Redis REST) as the single canonical cache for runtime data. Do not write or rely on other Redis providers or local Redis instances for production/data-sync flows.
- When a task or script needs to "check for new CRDs" or look for updated CRDs, it MUST search for the highest CRD numbers first and proceed descending. This preference applies to both discovering new CRDs and detecting updates to existing CRDs.

Rules

1. Upstash-only Redis
   - Production and CI data-sync flows must use Upstash REST endpoints only.
   - Expect these environment variables to exist and be used when interacting with Upstash:
     - `UPSTASH_REDIS_REST_URL` (the REST URL)
     - `UPSTASH_REDIS_REST_TOKEN` (the auth token)
   - Do not check in credentials. If a .env or secrets placeholder is needed, create a `.env.example` with placeholder keys and document how to set real secrets in CI/hosting.

     1.a Runtime data source prohibition
     - Runtime processes (cron jobs, schedulers, serverless functions, API routes that perform discovery) MUST NOT fall back to a local raw data directory as a source of truth. The local raw import (for example the sibling `../Data-finra-sec/data/raw/` directory) is a read-only external import used for offline rebuilds and must not be used by scheduled or on-demand runtime discovery flows.
     - If a script needs to seed or rebuild from the local raw import, do that in an explicit import step (e.g. `scripts/build_primed_from_raw.js`) that runs as a controlled job and updates Upstash-backed caches. Runtime jobs must use Upstash as the canonical source during execution.

2. CRD discovery ordering
   - Any code that says or implies "check for new CRDs" must:
     - Attempt to find the highest CRD numbers first (descending order). This reduces scan work for newly minted high-number CRDs and surfaces recent additions/updates faster.
     - When scanning ranges or batches, prefer fetching ranges like `MAX..MIN` (descending) or explicitly sort results by CRD number descending.
     - When deciding whether a CRD is new vs updated, compare the remote Upstash-cached record metadata (e.g., updated_at, version) and prioritize newer CRD numbers first for efficiency.

3. Scan strategy guidance
   - For large spaces of numeric CRDs, implement an exponential/backoff probing approach: probe high-number checkpoints first (e.g., current_max, current_max - step, ...), then narrow range if necessary.
   - Prefer batched requests that return ordered results when possible, and always request the server or index to sort by CRD descending if supported.

4. Implementation guidance (examples)
   - Scripts under `scripts/` that crawl or rebuild caches should read Upstash creds from env and use the project's existing Redis helper functions.
   - Example pseudo-pattern:
     - Fetch `current_max_crd = get_cached_max_crd()`
     - For i from current_max_crd down to 1 step N: check CRD i..i-N+1 in descending order
     - If remote API supports sorting, request `sort=crd_desc` and process results in returned order

5. Testing & CI
   - Tests or CI jobs that simulate cache interactions should mock Upstash REST endpoints rather than requiring a live Redis instance.
   - If an integration job needs real Upstash access, use dedicated test credentials stored in the CI secret store and scoped to a test namespace.

Notes

- This is a project-level policy to standardize data-sync behavior and performance when discovering CRDs. If an exception is required (for a one-off migration, for example), open a short PR describing why and how the exception will be cleaned up.

Contact

- If you have questions about how an existing script should be migrated to follow this rule, open an issue or ping the maintainer in the PR description and reference this file.

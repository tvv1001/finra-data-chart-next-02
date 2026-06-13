---
name: FINRA SEC API Pattern Guidelines
description: "Use when editing FINRA BrokerCheck or SEC AdviserInfo API routes, crawler scripts, graph/sidebar code that links to upstream records, or docs/prompts that describe this app's external API patterns. Covers validated detail endpoints, search endpoints, placeholder usage, and cache naming."
applyTo:
  - 'src/app/api/finra/**'
  - 'scripts/**'
  - 'src/lib/finra-graph.ts'
  - 'src/lib/finra-graph/**/*.ts'
  - '.github/copilot-instructions.md'
  - '.github/SKILL.md'
  - 'README.md'
---

When working from `data/raw/` or the external imported raw set:

- On VS Code / Copilot startup for this repository, first check for the latest external import at `../Data-finra-sec/data/raw/`.
- If that external raw directory exists, prefer it as the freshest import source before relying on this repo's local `data/raw/`.
- For data refresh, graph rebuild, primed bundle, search-index, or deploy-prep tasks, sync from that external raw directory into this repo's `data/raw/` first.
- After syncing into `data/raw/`, rebuild the local derived artifacts needed to prep a Redis-backed deployment, including graph outputs and deployment bundle inputs.
- Treat the imported raw directory as read-only; never edit it in place.
- Prefer the imported raw files when validating upstream shape or history coverage, then update derived repo data separately.
- For record inventory tasks, check both top-level individual and firm CRDs, and use `previousEmployments` / `previousIAEmployments` for individuals and `registrations` for firms.
- When syncing or rebuilding derived caches, use append-safe logic that skips records already present instead of assuming a full rebuild.
- If a task involves docs or prompts, describe the source as the latest source of truth and avoid implying that local derived caches are canonical.

# FINRA / SEC API pattern guidelines

This instruction supplements `.github/copilot-instructions.md` for work that touches upstream FINRA BrokerCheck and SEC AdviserInfo integrations.

## Prefer app-validated endpoint shapes

Use the patterns already validated by this application and its live upstream tests.

### Detail fetches by CRD/source ID

search will use all endpoints below and gather all of the total items:

- To search only:
  - `https://api.brokercheck.finra.org/search/firm?query=<QUERY>`
  - `https://api.brokercheck.finra.org/search/individual?query=<QUERY>`
  - `https://api.adviserinfo.sec.gov/search/firm?query=<QUERY>`
  - `https://api.adviserinfo.sec.gov/search/individual?query=<QUERY>`

- Individual detail:
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?includePrevious=true`
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?includePrevious=true`
  - Broker-only SEC individual shells (`iaScope: "NotInScope"` with no IA employment history) are not actionable adviser detail records and should not be saved as SEC examples.

- Firm detail:
  - `https://api.brokercheck.finra.org/search/firm/<CRD>`
  - `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json`

For this app, live testing confirmed that the SEC direct firm detail form `search/firm/<CRD>?wt=json` returns structured detail content and should be preferred over a query-by-ID URL when the task is detail hydration.

## Use placeholders, not baked-in examples

When writing docs, prompts, or instructions:

- Prefer placeholders such as `<CRD>`, `<QUERY>`
- Do not bake in misleading examples like `query=smith` unless the example is intentionally demonstrating a human search term.
- Use `https` in examples unless documenting a specific legacy compatibility case.

Placeholder meanings:

- `<CRD>`: individual or firm CRD / source identifier
- `<QUERY>`: free-text term or blank string where the upstream endpoint supports it
- `<FIRM_PREFIX>`: adviser firm-name prefix used by SEC individual search-by-firm flows

## Keep route defaults aligned with the existing app

When adding or editing route helpers, preserve the defaults already used by this app unless the task explicitly changes them:

- `start=0` for search routes
- `includePrevious=true` for individual detail enrichment unless intentionally disabled
- saved detail payloads in `data/raw/` should use source-specific wrapper shapes: FINRA `{ "content": <normalized detail payload> }`, SEC `{ "iacontent": <normalized detail payload> }`

Avoid inventing alternate naming schemes in docs or scripts unless the task explicitly includes a migration.

## Keep functional docs strictly aligned with the current working state

When updating `README.md`, repo instruction files, or prompts that describe graph functionality:

- treat the current runtime implementation as the source of truth
- validate behavior against the relevant code paths before documenting it
- avoid documenting intended behavior unless that behavior is already implemented and verified

If the implementation and docs disagree, update the docs to match the verified current behavior unless the task explicitly requires changing the implementation too.

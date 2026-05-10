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

# FINRA / SEC API pattern guidelines

This instruction supplements `.github/copilot-instructions.md` for work that touches upstream FINRA BrokerCheck and SEC AdviserInfo integrations.

## Prefer app-validated endpoint shapes

Use the patterns already validated by this application and its live upstream tests.

### Detail fetches by CRD/source ID

Prefer direct detail endpoints when the goal is to fetch a specific person or firm record:

- Individual detail:
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?hl=true&wt=json`
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?wt=json`
- Expanded individual detail with previous registrations:
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?hl=true&includePrevious=true&nrows=<NROWS>&r=<R>&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?hl=true&includePrevious=true&nrows=<NROWS>&r=<R>&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
- Firm detail:
  - `https://api.brokercheck.finra.org/search/firm/<CRD>?hl=true&wt=json`
  - `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json`
- Expanded firm detail:
  - `https://api.brokercheck.finra.org/search/firm/<CRD>?hl=true&nrows=<NROWS>&query=<QUERY>&start=<START>&wt=json`

For this app, live testing confirmed that the SEC direct firm detail form `search/firm/<CRD>?wt=json` returns structured detail content and should be preferred over a query-by-ID URL when the task is detail hydration.

## Use query endpoints for search, not canonical detail docs

Use free-text or ID-as-query endpoints only for search experiences, search proxies, or crawler seeding:

- FINRA free-text search:
  - `https://api.brokercheck.finra.org/search/individual?query=<QUERY>&hl=true&wt=json&nrows=<NROWS>&start=<START>`
  - `https://api.brokercheck.finra.org/search/firm?query=<QUERY>&hl=true&wt=json&nrows=<NROWS>&start=<START>`
- SEC free-text search:
  - `https://api.adviserinfo.sec.gov/search/individual?query=<QUERY>&hl=true&wt=json&nrows=<NROWS>&start=<START>`
  - `https://api.adviserinfo.sec.gov/search/firm?query=<QUERY>&hl=true&wt=json&nrows=<NROWS>&start=<START>`
- AdviserInfo firm-prefix search used by this codebase:
  - `https://api.adviserinfo.sec.gov/search/individual?firm=<FIRM_PREFIX>`

Do not document `query=<numeric id>` as the preferred SEC firm detail pattern unless you are explicitly describing a search or seeding workflow. In this repo, `query=<CRD>` may return hit lists or multiple matches because the same number can match different identifier fields, while direct `search/firm/<CRD>` is the better detail-fetch reference.

## Use placeholders, not baked-in examples

When writing docs, prompts, or instructions:

- Prefer placeholders such as `<CRD>`, `<QUERY>`, `<NROWS>`, `<START>`, and `<R>`.
- Do not bake in misleading examples like `query=smith` unless the example is intentionally demonstrating a human search term.
- Use `https` in examples unless documenting a specific legacy compatibility case.

Placeholder meanings:

- `<CRD>`: individual or firm CRD / source identifier
- `<QUERY>`: free-text term or blank string where the upstream endpoint supports it
- `<NROWS>`: result window size
- `<START>`: pagination offset
- `<R>`: upstream ranking/window parameter
- `<FIRM_PREFIX>`: adviser firm-name prefix used by SEC individual search-by-firm flows

## Keep route defaults aligned with the existing app

When adding or editing route helpers, preserve the defaults already used by this app unless the task explicitly changes them:

- `hl=true`
- `wt=json`
- `nrows=12`
- `start=0` for search routes
- `includePrevious=true` for individual detail enrichment unless intentionally disabled

If you change defaults, update both:

- runtime route code under `src/app/api/finra/**`
- any docs or instruction files that mention those endpoint shapes

## Cache naming must match repo convention

When generating or documenting cached upstream payloads, use filenames that match the existing convention:

- `api.brokercheck.finra.org_search_individual_<CRD>.json`
- `api.adviserinfo.sec.gov_search_individual_<CRD>.json`
- `api.brokercheck.finra.org_search_firm_<CRD>.json`
- `api.adviserinfo.sec.gov_search_firm_<CRD>.json`

Avoid inventing alternate naming schemes in docs or scripts unless the task explicitly includes a migration.

## Verify before updating docs or prompts

Before changing endpoint guidance in `.github/copilot-instructions.md`, `.github/SKILL.md`, `README.md`, or API proxy code:

- compare the proposed URL shape against the current route implementation in `src/app/api/finra/**`
- prefer the pattern already used by the app unless live testing or the task proves a better replacement
- if route code and docs differ, fix the mismatch instead of copying the stale form forward

## Good examples

- Good: “Use `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json` for SEC firm detail hydration.”
- Good: “Use `https://api.adviserinfo.sec.gov/search/firm?query=<QUERY>&hl=true&wt=json&nrows=<NROWS>&start=<START>` for firm search.”
- Avoid: “Use `https://api.adviserinfo.sec.gov/search/firm/<CRD>?hl=true&nrows=12&query=smith&r=25&sort=score+desc&wt=json`” as a generic canonical example.

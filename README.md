# FINRA Network Graph

An interactive force-directed graph that visualizes relationships between registered individuals and firms sourced from FINRA BrokerCheck and the SEC's IAPD (Investment Adviser Public Disclosure). Built with Next.js 15, D3 v7, and a local JSON cache that mirrors the upstream APIs.

Live demo: https://finra-data-chart-next-02.vercel.app

---

## Preview

![FINRA Network Graph screenshot](public/graph-screenshot.png)

---

## Quick start

```bash
pnpm install
pnpm run dev:clean  # http://localhost:3000 (recommended after stale build/runtime errors)

# or, if you do not need a clean start:
# pnpm run dev      # http://localhost:3000

# Populate the local data cache in iterative identifier-led batches
pnpm run prime:all

# Rebuild the graph from whatever is already cached on disk
pnpm run build:graph

# Production build (also refreshes deployable graph artifacts from data/national)
pnpm run build
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Prefix for client-side API calls; leave blank for relative paths |
| `NEXT_PUBLIC_ENABLE_SERVER_PROFILE_SYNC` | Set to `1` to persist profile selections server-side |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Required in deployment for shared Redis-backed graph/profile/seed persistence and API response caching; local dev falls back to filesystem/in-memory when absent |
| `CRON_SECRET` | Optional but recommended for protecting the production prime-check route used by Vercel Cron |
| `FINRA_PRIME_BATCH_LIMIT` / `FINRA_PRIME_CONCURRENCY` | Optional tuning for the bounded production prime-check batch |

On a fresh deployment with Redis enabled, the app will bootstrap `finra:graph` and `finra:seed-bank` from the bundled `data/national/` artifacts on the first graph read if Redis is still empty. That is generally much faster and more reliable than trying to recrawl tens of thousands of upstream FINRA/SEC records at runtime inside a serverless function.

The app does **not** run a true always-on crawler in production. On Vercel Hobby, `vercel.json` now schedules a bounded daily prime check via `GET /api/finra/prime-check` once per day. That route warms Redis-backed FINRA/SEC response caches for recently viewed firms and individuals without relying on a permanently running process or unsupported high-frequency cron execution.

As people use the website, detail requests to `/api/finra/individual/[crd]` and `/api/finra/firm/[id]` already fetch live FINRA/SEC data on cache misses and store those responses in Redis via `cachedFetch`. The app now also remembers recently viewed individual and firm IDs so the daily cron can revisit them and keep those hot paths warm.

For best performance, use the identifier-led local priming flow (`pnpm run prime:all`) before deployment, ship the refreshed `data/national/` artifacts with the deployment, and let the deployed app warm Redis from those bundled files.

`pnpm run build` now refreshes `data/national/finra-graph.json` and `data/national/finra-seed-bank.json` before `next build`, and `.vercelignore` intentionally keeps `data/national/` in the deployment bundle while excluding the duplicate `data/external/` mirror to avoid shipping twice the same upstream payloads.

To stay under Vercel upload limits, the build now also creates merged primed-cache bundle files under `data/national/primed-cache/` and excludes the loose raw detail directories from deployment. On a Redis cache miss, `cachedFetch` first checks those bundled primed-cache files and, if a match exists, merges that payload into Redis before ever calling the live upstream API.

---

## Data sources

| Source                                              | What is fetched                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `api.brokercheck.finra.org/search/individual/<CRD>` | Broker-check individual detail (employments, disclosures, exams, SRO/state registrations) |
| `api.brokercheck.finra.org/search/firm/<CRD>`       | Broker-dealer Form BD data (owners, disclosures, states, addresses)                       |
| `api.adviserinfo.sec.gov/search/individual/<CRD>`   | IA (investment adviser) individual detail                                                 |
| `api.adviserinfo.sec.gov/search/firm/<CRD>`         | IA firm Form ADV data                                                                     |

Responses are cached under `data/national/` with filenames that match the URL pattern, e.g. `api.brokercheck.finra.org_search_individual_4240769.json`. The cache is refreshed by the scraper scripts; the Next.js API routes serve from the cache first and fall back to the live APIs on a miss.

Seed CRDs are stored in `data/seed-profiles.json` and drive which individuals and firms are loaded at startup.

---

## Node types

Each node in the graph is one of three types, rendered with a distinct shape and colour.

### Individual — blue circle

Represents a registered person (broker, investment adviser representative, or owner). Node radius scales with the square root of its connection count so highly-connected people are visually prominent.

**Red fill** — if the person is the _source_ of at least one `controls` link (i.e. a direct owner of a firm listed on Form BD), their fill changes from blue to red. This happens live after the graph loads, so the colour may change as detail data is fetched.

**Dim / half-opacity** — a _stub_ individual has been found in a Form BD owner list but has not yet had their full CRD record fetched. The node is rendered at 50% opacity. Once selected, the full record is fetched and the node fills in.

### Firm — amber square

Represents a registered broker-dealer or investment adviser firm. Square size scales with degree (number of connections).

The **border stroke** colour signals the dominant link type entering that firm:

| Border colour     | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| Red (`#ef4444`)   | More `controls` links than `employed_by` links |
| Slate (`#64748b`) | More `employed_by` links than `controls` links |
| White             | No links, or equal counts of both              |

When a firm has **both** `controls` and `employed_by` links, a second dashed outer rect is drawn in the minority colour to show the mixed relationship.

Stub firms (dim, 45% opacity) are firm nodes synthesised from a person's employment history but not yet enriched with Form BD data.

### Entity — yellow diamond

Represents a non-individual owner listed on Form BD — typically a holding company, LLC, or trust that controls a firm but does not itself have a FINRA CRD number. Drawn as a rotated square (diamond).

---

## Edge (link) types

All edges are directed and carry an arrowhead pointing toward the target.

### `employed_by` — person → firm

Drawn for every entry in a person's `currentEmployments`, `currentIAEmployments`, `previousEmployments`, or `previousIAEmployments` arrays from BrokerCheck / IAPD.

**Colour rules:**

| State                         | Colour                                   |
| ----------------------------- | ---------------------------------------- |
| Previous registration         | Dark slate `#2f343a`, 65% opacity, 1.1px |
| Current / active registration | Red `#ff0c0c`, 65% opacity, 1.1px        |

**How "current" is determined** (evaluated by `isCurrentRegistration`):

1. If the link carries an explicit `isCurrent` boolean, that value is used directly.
2. Otherwise, the source person node's `currentEmployments` and `currentIAEmployments` arrays are checked. If the target firm's ID appears there, the link is current.
3. If the target firm appears only in `previousEmployments` / `previousIAEmployments`, the link is previous.
4. If the firm is absent from both lists, the link falls back to `endDate`: a `null` or empty end date is treated as current.

### `controls` — person or entity → firm

Created from the `directOwners` array on a firm's Form BD. Signals that the source person or entity has a formal ownership or control position over the target firm.

Always drawn in red (`#ff0c0c`), regardless of current/previous status, because Form BD owners are inherently present-tense declarations unless the firm is inactive.

---

## Disclosure indicator

Nodes where `disclosureFlag` or `iaDisclosureFlag` is truthy (set from BrokerCheck / IAPD detail) get an **orange dashed ring** drawn around the node shape:

- **Individual** — dashed circle slightly larger than the node radius, orange `#f97316`, 1.5px
- **Firm** — dashed rect slightly larger than the square, same colour and weight

This ring is visible as soon as the detail data is loaded. Nodes loaded from the graph cache already carry the flag; stub nodes may gain it after the first selection triggers a detail fetch.

---

## Interaction

| Action | Effect |
| --- | --- |
| **Click node** | Selects the node, opens the detail sidebar, highlights connected edges (red for controls/current, cyan-blue for previous), spreads neighbours outward, and triggers a server expand to load 1-hop neighbours not yet in the graph |
| **Click background** | Deselects current node, restores default edge colours |
| **Scroll / pinch** | Zoom in/out; labels are hidden below a zoom threshold to reduce paint overhead |
| **Drag node** | Pins the node at the dragged position; direct neighbours are temporarily freed so they move fluidly alongside |
| **Filter box** | Live text filter — dims non-matching nodes and their edges |
| **Fetch box** | Query by name, CRD, or firm ID to load additional nodes from the server graph into the visible layout |
| **Reveal hops selector** | Controls how many hops of neighbours are revealed on each click (1 / 2 / 3 / all) |

### Selection highlight colours

| Edge type                | Highlighted colour  | Width |
| ------------------------ | ------------------- | ----- |
| `controls`               | Vivid red `#ff2222` | 2.5px |
| `employed_by` (current)  | Vivid red `#ff2222` | 2.5px |
| `employed_by` (previous) | Cyan-blue `#38bdf8` | 2px   |

---

## Legend

| Symbol             | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| Blue circle        | Individual (registered person)                      |
| Red circle         | Owner / Controller (individual who controls a firm) |
| Dim blue circle    | Stub — Form BD name only, full CRD not yet loaded   |
| Amber square       | Firm (broker-dealer or IA)                          |
| Yellow diamond     | Entity (non-CRD owner, e.g. holding company)        |
| Dark line →        | Employed by (previous registration)                 |
| Red line →         | Employed by (current) or Controls                   |
| Orange dashed ring | Has regulatory / disciplinary disclosures           |

---

## Architecture overview

```
data/
  seed-profiles.json          ← CRDs that seed the initial graph load
  national/                   ← cached raw API responses (JSON)
  external/                   ← additional fetched firm detail (JSON)

scripts/
  node_scraper.js             ← fetches individual/firm detail from FINRA/SEC APIs
  batch_crawl_and_build.js    ← runs scraper then build_graph_from_cache in sequence
  build_graph_from_cache.js   ← reads cached JSON, builds finra-graph.json
  parallel_crawler.js         ← concurrent scraper for large datasets
  enrich_nodes.js             ← post-processing enrichment pass
  recompute_graph_meta.js     ← recomputes degree / hub stats without a full rebuild
  check_local_integrity.js    ← validates cache completeness

src/
  app/
    page.tsx                  ← root page; loads FinraGraph component
    api/finra/                ← Next.js API route handlers
  components/
    FinraGraph.tsx            ← React wrapper; bootstraps the D3 engine into the DOM
  lib/
    finra-graph.ts            ← D3 rendering engine (TypeScript)
    finra-graph/
      detailUtils.ts          ← sidebar detail-panel data extraction helpers
      formatters.ts           ← value formatting utilities (dates, currency, etc.)
      sidebar.ts              ← sidebar render logic and event handlers
    graphStore.ts             ← server-side graph read/write (file + Redis)
    cache.ts                  ← Upstash Redis / in-memory cache layer
```

### API routes

| Route                                    | Purpose                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `GET /api/finra/graph`                   | Returns full or subset graph JSON                |
| `GET /api/finra/individual/[crd]`        | Individual detail (cache → FINRA API)            |
| `GET /api/finra/firm/[id]`               | Firm detail (cache → FINRA API)                  |
| `GET /api/finra/merged/individual/[crd]` | Merged FINRA + SEC individual record             |
| `GET /api/finra/merged/firm/[id]`        | Merged FINRA + SEC firm record                   |
| `GET /api/finra/expand/[nodeId]`         | 1-hop neighbourhood for a given node             |
| `GET /api/finra/search`                  | Name / CRD search against the local graph        |
| `GET /api/finra/location-search`         | People / firms near a city or ZIP code           |
| `POST /api/finra/run-scraper`            | SSE-streamed scraper run (streams stdout/stderr) |
| `GET /api/finra/profile/[name]`          | Load / save a named seed profile                 |
| `GET /api/finra/cache-stats`             | Cache hit/miss counters                          |

---

## Scripts reference

```bash
# Full crawl + graph rebuild from scratch
node scripts/batch_crawl_and_build.js

# Continuous crawl (keeps going until all pending CRDs are fetched)
node scripts/continuous_crawl_and_rebuild.js

# Rebuild graph from existing cache (no network calls)
node scripts/build_graph_from_cache.js
  --employment-scope current|previous|all|none   # which employment links to include (default: all)

# Check integrity of the local cache
node scripts/check_local_integrity.js

# Recompute graph metadata (degrees, hub scores) without full rebuild
node scripts/recompute_graph_meta.js

# Enrich existing nodes with additional fields
node scripts/enrich_nodes.js
```

---

## Deployment

The app is deployed on Vercel. The `vercel.json` configures function timeouts for the scraper route. Upstash Redis is optional — without it the API route cache falls back to a Node.js in-memory `Map` that resets on each cold start.

```bash
npx vercel --prod
```

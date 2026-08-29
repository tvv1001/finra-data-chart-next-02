# GEMINI.md — FINRA Network Graph

Concise onboarding for any AI working in this repo. Prefer current code + `.env.local` over older docs when they disagree.

## What this app is

Interactive relationship explorer for **FINRA BrokerCheck** and **SEC AdviserInfo** data (individuals, firms, control/employment links).

Stack: **Next.js 15 (App Router), React 19, D3 v7, Pixi.js 8, TypeScript, Redis**. Graph logic lives mainly in `src/lib/finra-graph.ts` / `src/components/FinraGraph.tsx`. Dashboard: `src/app/dashboard/`. Shared APIs: `src/app/api/finra/**`.

This app is a **PWA** and is designed to run from **Redis cache only** when configured (`USE_REDIS_ONLY=1`).

## Data layers (priority)

1. **`data/` (raw + derived)** — offline source of truth for imports/rebuilds. Completeness is **not guaranteed**; some CRDs may still be missing downloads. Treat as read/import material, not as something every runtime path must hit.
2. **Local Redis** (`redis://127.0.0.1:6379`, Commander UI `http://127.0.0.1:8081/`) — **main Redis DB on localhost** when `USE_LOCAL_REDIS=1`. Graph + dashboard share this store.
3. **Two Upstash cloud Redis DBs** (primary + mirror) — must **stay in sync**. Used in production to balance load / avoid bottlenecks when hydrating many nodes. Never mutate cloud casually; sync/deploy only when the user asks.
4. **Search sidecars** (`data/national/search-index.*.json.gz` → `public/search-indexes/`) — gzip flatfiles for dashboard + graph search and CRD name hydration. Prefer sidecar `firm_name` over `Firm <CRD>` stubs. **Never store or query search indexes in Redis** (`search:indexes:*` is retired). See `docs/search-sidecar.md`.

**Production is reference-only** for agent work: read/audit OK; writes/deploys go `develop` → normal release. A shared production URL is **an example of the issue** — never deploy to Vercel from the agent, and never push local Redis to prod Redis unless the user explicitly instructs that sync. Details: `.github/instructions/prod-reference-workflow.instructions.md` and `.github/instructions/upstash-redis-and-crd-check.instructions.md`. Grok workflow: `/local-first-fix` (`.grok/workflows/local-first-fix.rhai`).

## Env flags (see `.env.local`)

| Flag | Role |
| --- | --- |
| `USE_LOCAL_REDIS=1` | Route Redis clients to local `127.0.0.1:6379` |
| `USE_REDIS_ONLY=1` | Prefer Redis; skip disk/raw fallbacks where implemented |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Cloud DB1 |
| `UPSTASH_REDIS_REST_URL_MIRROR` / `_TOKEN_MIRROR` | Cloud DB2 (keep reconciled with DB1 + local) |
| `UPSTASH_REDIS_DISABLE_2` / `_DISABLE_MIRROR` | Optionally disable dual-DB proxy |
| `UPSTASH_ALLOW_WRITES` | Gate Redis writes (`1` to allow) |
| `EXTERNAL_API_DISABLED` | Block live FINRA/SEC fetches |
| `WRITE_NATIONAL` / `SCRAPE_FIRMS` | Offline crawl/write controls |

On **localhost**, HTTP/app/DB caching that would hide freshness issues should stay **off / short-lived** so dashboard and graph reflect Redis truth. Across graph + dashboard, **in-memory caching of shared payloads is encouraged** for UX (same dataset, fewer Redis round-trips).

## Performance & cost rules

- Optimize for **high throughput** and smooth graph interaction (large node sets).
- **Minimize Redis reads/writes** (Upstash cost + latency). Batch, reuse in-memory results, avoid chatty key scans in hot paths.
- External FINRA/SEC validation is **slow and deliberate**, not on every click. Sequential crawl, respect 429 / `retry-after`. There are **no Vercel crons**.
- Dual cloud DBs exist to **load-balance** node loading — keep them mirrored; do not assume one side is disposable.

## Graph ↔ dashboard contract

- Both surfaces use the **same Redis-backed person/firm data**.
- Dashboard middle pane **“Queue graph”** = dashboard selection history (`localHistory`).
- **“GRAPH CLICK HISTORY”** mirrors the graph’s `finra_selection_log` (localStorage).
- **Graph** button (back to the node graph): CRDs listed in **Queue graph** are passed via a **sessionStorage bridge** (`src/lib/queueGraphBridge.ts`) — **no query string**. The graph consumes the bridge once on init and **background-fetches** those CRDs onto the canvas (`hydratePendingSelectedNodeIds` / `ensureRouteNodeAvailable`).
- Clicking **Graph** ends the current Queue graph session: dashboard selection history (`finra_dashboard_history`) is cleared immediately so the next visit to `/dashboard` starts a **new empty Queue graph**.
- Queue graph list has **no item cap** — show the full selection history.
- Shared selection helpers live around `collectSelectedNodeIdsForGraphHref` / `finra_selection_log` in `src/app/dashboard/page.tsx` and `src/lib/finra-graph.ts`.

## Click animation contract

Node-click reveal/spread may move the clicked node and newly revealed neighbors only. Settled nodes must stay frozen across subsequent clicks (no full-graph reheat, no WASM re-animate of the whole canvas on incremental reveals).

## Commands

- `pnpm run dev` — local Redis + Redis Commander + Next dev
- `pnpm run dev:clean` — same with clean `.next`
- `pnpm run build` / `build:graph` / `build:search-index` / `build:primed-cache`
- `pnpm run deploy:upstash-artifacts` — explicit sync of artifacts to Redis (user-directed)
- `pnpm run test:unit` / `pnpm run test:e2e`

## Where to look

| Area | Path |
| --- | --- |
| Graph behavior / animation | `src/lib/finra-graph.ts` |
| Graph UI shell | `src/components/FinraGraph.tsx` |
| Dashboard + Queue graph | `src/app/dashboard/page.tsx` |
| Redis client / dual DB | `src/lib/redisClient.ts` |
| Graph persistence | `src/lib/graphStore.ts` |
| Search / labels | `src/lib/localSearch.ts`, `docs/search-sidecar.md` |
| Copilot / scoped rules | `.github/copilot-instructions.md`, `.github/instructions/*` |

## Do / don’t

- **Do** keep local Redis, DB1, and DB2 reconciled when syncing; merge drift, don’t blind-overwrite unique live keys.
- **Do** prefer Redis + sidecars + in-memory reuse over live upstream on interactive paths.
- **Do** keep crawl/validation sequential when you run it locally.
- **Do** treat person current/previous employment as the freshest reverse index for firm rosters (official firm-roster search is incomplete for many low/old firm CRDs). Optional local job only: `pnpm run reverse-index:firm-connections`. Individual page loads may also upsert with skip-unchanged. There is no Vercel cron for this.
- **Don’t** treat incomplete `data/` as a blocker for Redis-only / PWA paths.
- **Don’t** write production Upstash unless the user explicitly requests deploy/sync.
- **Don’t** deploy to Vercel from an agent session. Don’t treat a prod URL as a deploy request.
- **Don’t** invent alternate ingestion paths; dashboard + approved cron/scripts own CRD intake.
- **Don’t** put search indexes in Redis. Graph and dashboard search/name hydration use gzip sidecars only.
- **Do** treat Redis `firm-connections:firm:{id}` as the dashboard/graph people roster. Firm detail stays small; `/connections` reads that key.

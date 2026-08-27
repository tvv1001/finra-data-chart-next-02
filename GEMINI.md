# GEMINI.md - FINRA Network Graph

This project is an interactive relationship explorer for FINRA BrokerCheck and SEC AdviserInfo data, visualizing individuals, firms, and control relationships.

## Project Overview

- **Main Technologies**: Next.js 15 (App Router), React 19, D3 v7, Pixi.js 8, TypeScript, Redis.
- **Core Architecture (Redis-Only)**:
  - **Source of Truth**: All runtime data (graph, seed bank, recent seeds) is stored in a **local Redis server**.
  - **Graph Storage**: Managed in `src/lib/graphStore.ts`. Supports chunked manifests and gzipped/base64 payloads for large graphs.
  - **Search Sidecar**: Search uses gzipped flatfiles (`search-index.*.json.gz`) located in `public/search-indexes/` for fast, low-memory local lookups.
  - **Synchronization**: The main app and the dashboard (`/dashboard`) are kept in sync by reading from and writing to the same Redis instance.
  - **Performance**: Pre-generated artifacts are still used to bootstrap Redis, but `next.config.ts` excludes large local data from serverless bundles.

## Building and Running

### Key Commands

- `pnpm install`: Install dependencies.
- `pnpm run dev`: Starts local Redis (`127.0.0.1:6379`, db0), Redis Commander (`http://127.0.0.1:8081/`), then the Next.js dev server.
- `pnpm run dev:clean`: Same as `dev`, but with a clean Next.js cache.
- `pnpm run redis:start` / `pnpm run redis:commander`: Start Redis or Redis Commander on their own.
- `pnpm run build`: Production build. Regenerates search indexes and artifacts.
- `pnpm run deploy:upstash-artifacts`: **Critical**. Rebuilds and syncs all graph and search artifacts to Redis.
- `pnpm run prime:all`: Iteratively expand the local cache (before deploying to Redis).

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | **Required**. Redis endpoint for the shared source of truth. |
| `UPSTASH_REDIS_REST_TOKEN` | **Required**. Redis authentication token. |
| `ADMIN_SECRET` | Required for sensitive dashboard and maintenance actions. |

## Development Conventions

### Coding Style & Architecture

- **Redis-First**: Always assume data is in Redis. Use `src/lib/graphStore.ts` and `src/lib/cache.ts` for all data access.
- **Search Logic**: Search lookups are performed via `src/lib/localSearch.ts`, which prefers the gzipped sidecar files.
- **Dashboard Sync**: Use `/api/dashboard/refresh` to fetch and integrate new CRDs. This automatically merges data into the Redis-backed graph.
- **No Local Files at Runtime**: Avoid logic that depends on `data/national` or `data/raw` during runtime on Vercel; these folders are excluded from deployment.

### Testing Strategy

- **Unit Tests**: Use **Vitest** for data normalization and merge logic.
- **Integration Tests**: Focus on Redis-backed API route behavior.
- **E2E Tests**: Use **Playwright** for the full search -> fetch -> synchronize -> visualize flow.

## Key Directory Structure

- `src/app/dashboard/`: Dashboard for managing CRD inventory and Redis synchronization.
- `src/lib/`: Core logic for Redis management, gzipped search, and graph interactions.
- `public/search-indexes/`: Deployment-time gzipped search index sidecars.
- `data/`: Used for local data preparation before syncing to Redis. **Excluded from production bundles.**

## API & Data Patterns

- **Upstream Integration**: Proxied via `/api/finra/**`. Data is cached in Redis upon fetch.
- **Synchronization Flow**: Dashboard Fetch -> Redis Record Save -> Main Graph Merge -> Seed Bank Update.
- **Crawling Stability**:
  - **Sequential Only**: All crawling and fetching (Dashboard & Scripts) must be strictly sequential (concurrency=1).
  - **429 Handling**: If a 429 error is hit, the system MUST respect the `retry-after` header if present. If absent, it MUST pause for a randomized 2-4 minutes before resuming, using exponential backoff with a 0.6x-1.4x jitter for general network errors.
  - **Scrapy Integration**: `scripts/scrapy.py` (Playwright-based) is used as a fallback for anti-bot detection, featuring human-like pacing and randomized jitter.
- **Chunked Data**: Large keys in Redis are automatically handled via `manifest` and `part` keys.

## Troubleshooting

- **Sync Issues**: If the dashboard and graph seem out of sync, trigger a graph rebuild/sync via the dashboard or `pnpm run deploy:upstash-artifacts`.
- **Search Missing**: Ensure search indexes are built and present in `public/search-indexes` or Redis.
- **Memory/Bundle Size**: If Vercel deployment fails due to size, check `next.config.ts` exclusions.

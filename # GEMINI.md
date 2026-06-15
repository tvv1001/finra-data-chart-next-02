# GEMINI.md - FINRA Network Graph

This project is an interactive relationship explorer for FINRA BrokerCheck and SEC AdviserInfo data. It visualizes individuals, firms, and control relationships as a navigable network.

## Project Overview

- **Main Technologies**: Next.js 15 (App Router), React 19, D3 v7, Pixi.js 8, TypeScript, Upstash Redis.
- **Core Architecture**:
  - The graph runtime is driven by **D3** and **Pixi.js** for performance, managed in `src/lib/finra-graph.ts`.
  - It uses a **local-first** search strategy, falling back to proxied FINRA/SEC API calls.
  - Deployment-time performance is achieved through **pre-generated artifacts** (`finra-graph.json`, `finra-seed-bank.json`) and **primed cache bundles**.
  - Shared state and caching are backed by **Upstash Redis** in production.

## Building and Running

### Key Commands

- `pnpm install`: Install dependencies.
- `pnpm run dev:clean`: Start the development server with a clean Next.js cache.
- `pnpm run build:graph`: Rebuild the `finra-graph.json` artifact from local cached JSON data.
- `pnpm run build:primed-cache`: Generate consolidated cache bundles for deployment.
- `pnpm run build`: Production build (regenerates search indexes and artifacts).
- `pnpm run prime:all`: Iteratively expand the local cache by crawling discovered IDs.
- `pnpm run deploy:upstash-artifacts`: Build and sync all graph and search artifacts to Redis.

### Environment Variables

| Variable                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Redis endpoint for shared caching and graph storage. |
| `UPSTASH_REDIS_REST_TOKEN` | Redis authentication token.                          |
| `NEXT_PUBLIC_API_URL`      | Optional base URL for API calls.                     |

## Development Conventions

### Coding Style & Architecture

- **Graph Logic**: Most graph interaction and rendering logic is in `src/lib/finra-graph.ts`. Avoid moving this into React state; prefer D3-driven SVG/Canvas updates.
- **Data Normalization**: Use helpers in `src/lib/finra-graph/detailUtils.ts` and `formatters.ts` for consistent data presentation.
- **Relationships**: Normalized into `employed_by`, `previous_employed_by`, and `controls`.
- **Node IDs**: Use standardized prefixes: `person:<CRD>`, `firm:<CRD>`.

### Testing Strategy

The project uses a tiered testing approach as defined in `TESTING_STRATEGY.md`:

- **Unit Tests**: Use **Vitest** for pure logic, normalization, and formatting.
  - Command: `pnpm run test:unit`
- **Integration Tests**: Use **Vitest** for API route handlers and storage behavior.
- **E2E Tests**: Use **Playwright** for complex UI flows (selection, trace mode, session persistence).
  - Command: `pnpm run test:e2e`
  - Recommendation: Run Playwright inside Docker for consistency (see `scripts/run-e2e-docker.sh`).

## Key Directory Structure

- `data/national/`: Contains pre-generated graph artifacts and primed cache bundles.
- `scripts/`: Maintenance and build scripts for the data pipeline.
- `src/lib/`: Core logic, including graph management (`finra-graph.ts`) and cache management (`cache.ts`).
- `src/app/api/finra/`: Server-side API routes for graph, search, and detail hydration.
- `tests/`: Unit and E2E test suites.

## API & Data Patterns

- **Upstream Sources**:
  - FINRA BrokerCheck: `api.brokercheck.finra.org`
  - SEC AdviserInfo (IAPD): `api.adviserinfo.sec.gov`
- **Cache Precedence**: Local Disk -> Redis (if configured) -> Primed Cache Bundle -> Upstream API.
- **Cron Jobs**: A single Vercel cron job (`/api/finra/external-validity`) maintains data freshness in production.

## Troubleshooting

- **Memory Issues**: For large graph builds, increase Node heap: `env NODE_OPTIONS=--max-old-space-size=8192 pnpm build`.
- **Stale Cache**: Use `pnpm run dev:clean` if the local dev server shows inconsistent state.
- **Redis Sync**: Ensure `pnpm run deploy:upstash-artifacts` is run when graph artifacts change to keep production in sync.

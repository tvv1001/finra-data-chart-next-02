# Session handoff

## Current restored state

- Branch: `prod-restore/c4d2970`
- Restored commit: `c4d2970`
- Reason: this was identified as the likely deployed `origin/main` commit matching the current Vercel production site.

## What was verified

- `pnpm build` succeeded on commit `c4d2970`.
- A local production server was started successfully on `http://localhost:3002` from this restored branch.
- The live site `https://finra-data-chart-next-02.vercel.app` and the local restored build matched on initial HTML/title-level checks.

## Upstash cache snapshot retrieved

- Source key: `finra:graph`
- Retrieved from Upstash REST API and saved locally to:
  - `/tmp/finra_graph_upstash.json`
- Parsed graph summary:
  - Nodes: `3361`
  - Links: `2158`
- Example node ids:
  - `person:1547929`
  - `person:15867`
  - `person:2806324`
  - `person:1626688`
  - `firm:138033`

## Still pending

- Query Vercel deployment metadata directly (requires Vercel personal token).
- Optionally copy the Upstash `finra:graph` payload into `data/national/finra-graph.json` and run the app against that exact cache snapshot.
- Optionally push `prod-restore/c4d2970` to origin and open a PR.

## Safe next commands

```bash
pnpm build
pnpm exec next start -p 3002
```

## Notes

- Secrets were provided in chat during this session; they are intentionally not copied into this file.
- If chat/session saving is blocked, create a fresh session and point it at this file first.

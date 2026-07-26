---
name: Prod Reference Only Workflow
description: 'Use when touching data refresh, cache/graph rebuild, deployment prep, or any task that can affect production data/state. Enforces read-only production reference and branch-first promotion workflow.'
applyTo:
  - 'src/**'
  - 'scripts/**'
  - 'data/**'
  - 'README.md'
  - '.github/copilot-instructions.md'
  - '.github/workflows/**'
---

# Production reference and promotion workflow

Treat production as a **read-only reference source** for verification.

## Required behavior

- Do **not** directly update production data/state from agent tasks.
- Do **not** run direct prod mutation/deploy operations as part of routine fixes.
- Use production endpoints only to validate, compare, or audit behavior/data.
- Implement code/data changes in this repo first.
- Route all release changes through the `develop` branch workflow.
- Production promotion is performed only after branch-based validation and user-controlled release steps.

## Operational guidance

- Safe on prod: GET/read-only checks, audits, parity validation, and diagnostics.
- Unsafe on prod: write, reset, purge, upsert, deploy, or mutation operations.
- If a task appears to require a direct prod update, stop and switch to a branch-first plan:
  1. prepare the fix locally,
  2. commit/push to `develop`,
  3. validate,
  4. promote to production via normal release flow.

## Communication requirement

When discussing deployment/data steps, explicitly state that production is reference-only and that mutation/deployment should proceed from `develop` to production.

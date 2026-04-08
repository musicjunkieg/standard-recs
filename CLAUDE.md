# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Workers app that recommends [Standard.site](https://standard.site) documents to users based on their Bluesky likes. Uses D1, Vectorize, Workflows, and Durable Objects.

## Commands

```bash
npm run dev          # Local dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run db:init      # Apply schema.sql to remote D1
npm run db:init:local # Apply schema.sql to local D1
```

No test runner or linter is configured.

## Secrets

`VOYAGE_API_KEY` is set via `wrangler secret put VOYAGE_API_KEY` — never commit it.

## Architecture

**Entry point:** `src/index.ts` — exports the fetch handler (Hono), cron handler, and re-exports the Workflow and DO classes.

**Env bindings:** `src/env.ts` — typed bindings for D1 (`DB`), Vectorize (`VECTORS`), Workflow (`SYNC_PIPELINE`), DO (`JETSTREAM_LISTENER`), and config vars.

**Two execution paths exist:**

1. **SyncPipelineWorkflow** (`src/workflow.ts`) — durable multi-step pipeline with two modes:
   - `full`: daily cron runs sync-likes → prune → discover-publishers → sync-docs → embed → recommend
   - `user`: enrollment backfill for a single DID (same steps, scoped to one user)
   - Each step is independently retried via Workflow step durability.

2. **JetstreamListener DO** (`src/durable/jetstream-listener.ts`) — singleton Durable Object holding a persistent WebSocket to the AT Protocol Jetstream, filtered to `site.standard.document`. Discovers publishers in real time. Auto-reconnects via alarms.

**Hono API** (`src/api/routes.ts`) — public endpoints (enroll, recs, stats) and admin endpoints (sync triggers, Jetstream DO control). Enrollment resolves a Bluesky handle to a DID and kicks off a user-mode Workflow.

**Sync modules** (`src/sync/`):
- `users.ts` — handle → DID resolution via `@atproto/api`
- `likes.ts` — fetches Bluesky likes, stores in D1, prunes stale ones
- `documents.ts` — fetches Standard.site documents from publishers
- `discover.ts` — publisher discovery from social graph + seed list

**Recommendation pipeline** (`src/recommend/`):
- `embed.ts` — sends text to Voyage AI, upserts vectors into Vectorize
- `index.ts` — builds per-user taste vectors, queries Vectorize for cosine similarity, writes recommendations to D1

## Key patterns

- The DO is a singleton accessed via `idFromName("singleton")`. Internal routing uses URL pathname (`/start`, `/stop`, `/status`).
- Hono is configured with `{ Bindings: Env }` for typed access to Cloudflare bindings via `c.env`.
- JSX uses Hono's JSX runtime (`hono/jsx`) — configured in tsconfig.json via `jsxImportSource`.
- Config vars (`SYNC_BATCH_SIZE`, `WINDOW_DAYS`, `TOP_N`) are strings in wrangler.toml, parsed to ints at usage sites.
- D1 batch queries are used in the stats endpoint for parallel reads.

## D1 schema

Five tables: `users`, `likes`, `documents`, `publishers`, `recommendations`. Schema is in `schema.sql`. Publishers are auto-discovered (Jetstream DO + social graph); manual seeding is optional via `/admin/add-publisher`.

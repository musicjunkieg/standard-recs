# standard-recs

Recommend [Standard.site](https://standard.site) documents based on your Bluesky likes.

Built on Cloudflare Workers, D1, Vectorize, Workflows, and Durable Objects.

## How it works

1. User types their handle into the enrollment page (typeahead via [waow.tech](https://typeahead.waow.tech))
2. A **Workflow** backfills their last 30 days of likes, discovers publishers, and generates recommendations
3. A **Durable Object** holds a persistent Jetstream WebSocket, discovering new Standard.site publishers in real time
4. A daily **cron** triggers the full pipeline Workflow to keep everything fresh

## Setup

```bash
npm install

# Create Cloudflare resources
wrangler d1 create standard-recs-db
wrangler vectorize create standard-recs-vectors --dimensions=1024 --metric=cosine

# Update wrangler.toml with the database_id from above

# Initialize schema + set secret
npm run db:init
wrangler secret put VOYAGE_API_KEY

# Deploy
npm run deploy

# Start the Jetstream listener for real-time publisher discovery
curl -X POST https://your-worker.workers.dev/admin/jetstream/start

# Trigger the first full sync
curl -X POST https://your-worker.workers.dev/admin/sync
```

## API

```
GET  /                              → Enrollment page (typeahead search)
GET  /api                           → JSON endpoint listing
POST /enroll                        → { "handle": "you.bsky.social" }
                                      Triggers a Workflow to backfill likes
GET  /recs/:did                     → Recommendations for a user
GET  /users                         → List enrolled users
GET  /stats                         → Database stats + Jetstream DO status

POST /admin/sync                    → Trigger full pipeline Workflow
POST /admin/sync-user/:did          → Trigger single-user Workflow
POST /admin/jetstream/start         → Start persistent publisher discovery
POST /admin/jetstream/stop          → Stop Jetstream listener
GET  /admin/jetstream/status        → Listener connection status
POST /admin/add-publisher           → { "did": "did:plc:...", "label": "..." }
```

## Architecture

```
src/
├── index.ts                        — Worker entry: fetch + cron → Workflow
├── env.ts                          — Bindings (D1, Vectorize, Workflow, DO)
├── workflow.ts                     — SyncPipelineWorkflow (durable execution)
├── api/
│   ├── routes.ts                   — Hono API
│   └── enroll-page.ts              — Enrollment UI with typeahead.waow.tech
├── durable/
│   └── jetstream-listener.ts       — DO: persistent Jetstream WebSocket
├── sync/
│   ├── users.ts                    — Enrollment (handle → DID)
│   ├── likes.ts                    — Bluesky likes sync
│   ├── documents.ts                — Standard.site document indexer
│   └── discover.ts                 — Publisher discovery (seed + social graph)
└── recommend/
    ├── embed.ts                    — Voyage AI embeddings → Vectorize
    └── index.ts                    — Taste vectors + cosine similarity
```

## How the pieces fit together

**Workflows** replace the old `waitUntil` cron handler. The sync pipeline
is broken into durable steps — sync likes, prune, discover publishers,
sync documents, embed, recommend. If the Voyage API rate-limits during
embedding, only that step retries. Enrollment also triggers a Workflow
instance so a user's 30-day backfill can run as long as it needs.

**Durable Object** replaces the hacky 10-second Jetstream scan. The
`JetstreamListener` DO holds a persistent WebSocket to Jetstream filtered
to `site.standard.document`. Publishers get registered the moment they
create a document — true real-time discovery running 24/7. If the
connection drops, an alarm reconnects automatically.

**D1** stores users, likes, documents, publishers, and recommendations.
**Vectorize** stores embeddings for cosine similarity search. Both are
queried directly from Workflow steps and the Hono API.

## Publisher discovery (no manual curation needed)

Publishers are found automatically through three paths:

1. **Jetstream DO** — persistent listener catches every new document on the network
2. **Social graph** — cron checks if authors of liked posts also publish documents
3. **Seed list** — known publisher DIDs in code (optional bootstrap)

## Cost estimate (2-3k users)

| Resource | Estimate |
|---|---|
| Workers + Workflows | Included in paid plan |
| Durable Objects | Pennies (one singleton DO) |
| D1 | Well within paid plan limits |
| Vectorize | 30M queried dimensions/mo included |
| Voyage AI embeddings | Free (200M token free tier) |

## Privacy model (v1)

Recommendations are **public**. Enrollment is opt-in — you submit your
handle knowing your recommendation page will be visible. Private-by-default
is a v2 concern.

# standard-recs

Recommend [Standard.site](https://standard.site) documents based on your Bluesky likes.

Built on Cloudflare Workers, D1, Vectorize, Workflows, and Durable Objects.

The same Worker serves three branded variants on three custom domains, each
with its own ranking strategy:

| Variant         | Hostname                  | Ranking                                                              |
|-----------------|---------------------------|----------------------------------------------------------------------|
| `standard`      | `standardrecs.site`       | Top-N cosine similarity to your taste vector                         |
| `nonstandard`   | `nonstandardrecs.site`    | MMR over the tail of the candidate pool, diversified against `standard` |
| `substandard`   | `substandardrecs.site`    | MMR over a separate query against the **negated** taste vector ("you'll hate these") |

Variant routing is done via the `Host` header in `src/api/routes.ts`; an unknown
host (e.g. `localhost:8787` in dev) falls back to `standard`.

## How it works

1. User submits their Bluesky handle to the enrollment page. The Worker
   redirects them through AT Protocol OAuth — they authorize on their PDS,
   land back on `/oauth/callback`, and a row is inserted into `users`.
2. A **Workflow** (`mode: "user"`) backfills the last 30 days of the user's
   likes via the OAuth-scoped `app.bsky.feed.getActorLikes`, runs publisher
   discovery, syncs documents in batches, embeds anything new, and writes
   recommendations to D1.
3. A daily **cron** (06:00 UTC) starts the same Workflow in `mode: "full"`,
   running the same steps across every enrolled user and every known publisher.
4. A singleton **Durable Object** (`JetstreamListener`) holds a persistent
   WebSocket to AT Protocol Jetstream filtered to `site.standard.publication`
   and `site.standard.document`. It registers new publishers and indexes new
   documents in real time, and reconnects via DO alarms if the socket drops.

## Setup

```bash
npm install

# Create Cloudflare resources
wrangler d1 create standard-recs-db
wrangler vectorize create standard-recs-vectors --dimensions=1024 --metric=cosine

# Update wrangler.toml with the database_id from the d1 create output

# Initialize schema
npm run db:init

# Required secrets
wrangler secret put VOYAGE_API_KEY      # Voyage AI embeddings
wrangler secret put OAUTH_PRIVATE_KEY   # JWK private key (ES256) for AT Proto OAuth
wrangler secret put ADMIN_TOKEN         # Bearer token for /admin/* routes

# Deploy
npm run deploy

# Start the Jetstream listener for real-time discovery + indexing
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://standardrecs.site/admin/jetstream/start

# Trigger the first full pipeline run
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://standardrecs.site/admin/sync
```

`OAUTH_PRIVATE_KEY` must be a single ES256 JWK (importable by
`@atproto/jwk-jose`'s `JoseKey.fromImportable`). The corresponding public key
is served at `/oauth/jwks.json` and the client metadata at
`/oauth/client-metadata.json`.

There is no test runner or linter configured.

## Commands

```bash
npm run dev           # wrangler dev
npm run deploy        # wrangler deploy
npm run db:init       # apply schema.sql to remote D1
npm run db:init:local # apply schema.sql to local D1
```

## API

### Public

```
GET  /                           Enrollment page (variant-specific)
GET  /api                        JSON endpoint listing
GET  /enroll?handle=…            Redirects to the user's PDS for OAuth
GET  /oauth/callback             OAuth code exchange → kicks off user-mode Workflow
GET  /oauth/client-metadata.json AT Proto OAuth client metadata
GET  /oauth/jwks.json            Public JWKS for client authentication
GET  /recs                       Handle-lookup form
GET  /recs/by-handle/:handle     Resolve handle → DID, then 302 to /recs/:did
GET  /recs/:did                  Recommendations (HTML for browsers, JSON for API)
GET  /stats                      Counts + Jetstream DO status
```

`/recs/:did` is content-negotiated by the `Accept` header. Results are ordered
by `rank ASC`, which preserves the algorithm-specific pick order (top-N cosine
for `standard`, MMR greedy order for `nonstandard` and `substandard`). Sorting
by raw score would scramble MMR's diversity choices.

### Admin (require `Authorization: Bearer $ADMIN_TOKEN`)

```
GET  /admin/users                List enrolled users (DIDs + handles)
POST /admin/sync                 Trigger full pipeline Workflow
POST /admin/sync-user/:did       Trigger single-user Workflow
POST /admin/jetstream/start      Connect the Jetstream DO
POST /admin/jetstream/stop       Disconnect the Jetstream DO
GET  /admin/jetstream/status     DO connection state + counters
POST /admin/add-publisher        Manually seed a publisher: { did, label? }
POST /admin/compare-recs?did=…   Side-by-side rec lists for tuning
                                 (?variants=standard,nonstandard or
                                  legacy ?did=… for query/document namespace compare)
GET  /admin/test-embed           Round-trip Voyage + Vectorize with a probe vector
POST /admin/debug-embed          Embed 5 real likes + 5 real docs end-to-end
```

`/admin/users` was previously at `/users` (unauthenticated) and is now gated
because the full DID list is sensitive.

## Architecture

```
src/
├── index.ts                    Worker entry: fetch + scheduled → Workflow
├── env.ts                      Typed bindings (D1, Vectorize, Workflow, DO, secrets, vars)
├── workflow.ts                 SyncPipelineWorkflow — durable steps
├── variants.ts                 Variant registry (standard, nonstandard, substandard)
├── api/
│   ├── routes.ts               Hono app: public + admin + OAuth routes
│   ├── enroll-page.ts          Variant-aware enrollment HTML
│   ├── recs-page.ts            Variant-aware recs HTML
│   ├── recs-lookup-page.ts     /recs handle-lookup form
│   └── shared-styles.ts        Design tokens, masthead, atmosphere
├── oauth/
│   ├── client.ts               WorkersOAuthClient factory + client metadata
│   └── stores.ts               D1-backed state and session stores
├── durable/
│   └── jetstream-listener.ts   Persistent Jetstream WebSocket + alarms
├── sync/
│   ├── users.ts                Enrolled-user helpers
│   ├── likes.ts                getActorLikes paginator + prune
│   ├── documents.ts            Per-publisher batched document sync
│   ├── discover.ts             Publisher discovery (lightrail + social graph + seed)
│   ├── lightrail.ts            lightrail.microcosm.blue listReposByCollection client
│   ├── pds-resolver.ts         DID → PDS host resolution (with bridge detection)
│   ├── pds-fetch.ts            listRecords + commit-rev helpers
│   └── fetch-helper.ts         Friendly fetch wrapper (UA, timeouts)
└── recommend/
    ├── embed.ts                Voyage AI voyage-3.5-lite → Vectorize
    ├── index.ts                Taste vector + per-variant ranking
    ├── mmr.ts                  Maximal Marginal Relevance
    └── vector-id.ts            Stable hashed Vectorize IDs from at:// URIs
```

## SyncPipelineWorkflow

Two modes share most steps:

```
full mode (cron):
  sync-all-likes  →  prune-likes  →  cleanup-oauth-state  →  discover
                  →  sync-documents-batch-* (loop)         →  embed  →  recommend

user mode (enrollment):
  sync-likes-{did}  →  discover  →  sync-documents-batch-* (loop)
                    →  embed-for-user-{did}  →  recommend-for-user-{did}
```

Each `step.do` is independently retried and memoized — a Voyage rate-limit on
embedding doesn't re-run likes sync. The `discover` step has a custom policy
(2 retries, 30s backoff, 20 min timeout) because the default 10-minute timeout
proved too long for a stuck attempt.

Document sync is the awkward one. Each Workflow invocation has its own
subrequest budget, and a full corpus walk can blow it. So `runBatchedDocumentSync`
splits the work into independently-durable `sync-documents-batch-{scope}-{i}`
steps that each claim `SYNC_DOCS_BATCH_SIZE` publishers via a compare-and-swap
on `last_synced_at`, and the loop bails when a batch comes back short. If the
loop hits `SYNC_DOCS_MAX_BATCHES` without draining, the embed and recommend
steps are **skipped** — partial corpora produce misleading recs and waste
Voyage quota.

## Recommendation pipeline

For each user with embedded likes:

1. Pull their like vectors from Vectorize (chunked because `getByIds` caps at 20).
2. Compute a recency-weighted average ("taste vector") with a 7-day exponential
   half-life — a like from a week ago is worth half of today's.
3. Query Vectorize against the `documents` namespace with `topK=50` (the
   per-query cap with `returnMetadata: "all"` and `returnValues: true`) to get
   the candidate pool.
4. Rank into three disjoint variant lists:
   - **standard**: first `TOP_N` candidates by raw cosine.
   - **nonstandard**: MMR over `validMatches.slice(TOP_N)`, seeded with the
     `standard` picks so it diversifies *away* from what standard chose.
   - **substandard**: a second Vectorize query against the *negated* taste
     vector pulls the most-anti-aligned docs, then MMR over that pool. URIs
     already claimed by standard/nonstandard are filtered out.
5. Persist all three variants in `recommendations` with the variant string and
   a `rank` column that preserves pick order.

The disjointness invariant matters: the `recommendations` PK is
`(did, document_uri)` with no `variant` column, so two variants can't ever
emit the same URI for the same user. The recommendation code enforces this
with a simple slice (for nonstandard) and a URI Set filter (for substandard).

`MMR_LAMBDA` (default `0.6`) is the relevance/diversity knob — see
`src/recommend/mmr.ts` for the formula.

## Embedding

- Provider: Voyage AI `voyage-3.5-lite`, 1024 dimensions, free tier covers this
  project comfortably.
- Likes are embedded as `input_type: "query"` by default. Set
  `LIKE_EMBED_MODE=document` or `both` to also/instead embed them as
  `"document"`. Doc-mode like vectors live in the `likes_doc` namespace with
  vector IDs prefixed `d:`. `LIKE_QUERY_NAMESPACE` (`likes` or `likes_doc`)
  controls which namespace the recommender reads at query time.
- Documents are embedded as `input_type: "document"` and live in the
  `documents` namespace.
- Batches are 100 records at a time; each batch only stamps `embedded_at` on
  D1 rows after the upserts succeed, so a Voyage failure leaves rows queued
  for the next run rather than orphan-stamping them.
- `EMBED_BATCH_LIMIT` (default 2000) caps how many rows are pulled per
  workflow step.

## Publisher discovery

Three paths, all idempotent (`INSERT OR IGNORE`):

1. **lightrail** (`auto:lightrail`) — `runDiscovery` queries
   [lightrail.microcosm.blue](https://lightrail.microcosm.blue) for every DID
   in the atmosphere that publishes a `site.standard.publication` record.
   This is the primary discovery path; it routinely pulls thousands of DIDs
   per run.
2. **Social graph** (`auto:social-graph`) — for up to 50 unseen authors of
   liked posts, check whether they also publish a publication record on their
   own PDS, and add them if so.
3. **Jetstream DO** (`auto:jetstream-do`) — the live WebSocket inserts
   publishers the moment they create a publication record. Document creates
   from known publishers are also indexed in real time; updates upsert via
   `INSERT OR REPLACE`; deletes remove from both Vectorize and D1.
4. **Seed list** — `SEED_PUBLISHERS` in `src/sync/discover.ts` is empty by
   default; add manual entries here, or call `POST /admin/add-publisher`.

Bridged publishers (those whose PDS resolves to a Bluesky-bridge host) are
detected during document sync and pruned in place — their docs, vectors, and
publisher row are removed.

## D1 schema

`schema.sql` is the source of truth. Tables:

| Table             | Purpose                                                                 |
|-------------------|-------------------------------------------------------------------------|
| `users`           | Enrolled DIDs + handles + sync timestamps                               |
| `likes`           | Bluesky likes within the rolling window, with text and `embedded_at`    |
| `documents`       | `site.standard.document` records, with text and `embedded_at`           |
| `publishers`      | Discovered publisher DIDs, label, `last_synced_at`, `last_synced_rev`   |
| `publications`    | Resolved publication metadata (URL, name) for link rendering            |
| `recommendations` | (did, document_uri, score, **variant**, **rank**, generated_at) per user |
| `oauth_state`     | Transient OAuth authorization-flow state (cleaned hourly)               |
| `oauth_sessions`  | Per-DID OAuth sessions for token refresh                                |

There is no migration system; the schema file documents the migration history
in comments at the bottom and `CREATE TABLE IF NOT EXISTS` statements bootstrap
fresh databases directly into the final shape.

## Config vars

Set in `wrangler.toml` under `[vars]`. All are strings, parsed at usage.

| Var                     | Default    | Meaning                                              |
|-------------------------|------------|------------------------------------------------------|
| `SYNC_BATCH_SIZE`       | `50`       | Users per `sync-all-likes` step                      |
| `SYNC_DOCS_BATCH_SIZE`  | `50`       | Publishers per `sync-documents-batch-*` step         |
| `SYNC_DOCS_MAX_BATCHES` | `300`      | Safety cap on the doc-sync loop                      |
| `WINDOW_DAYS`           | `30`       | Like retention window                                |
| `TOP_N`                 | `10`       | Recs per variant per user                            |
| `WORKER_URL`            | (deploy)   | Canonical app URL, used in OAuth client metadata     |
| `LIKE_EMBED_MODE`       | `query`    | `query` / `document` / `both`                        |
| `LIKE_QUERY_NAMESPACE`  | `likes`    | `likes` or `likes_doc` for the recommend-time query  |
| `MMR_LAMBDA`            | `0.6`      | MMR relevance/diversity balance ∈ [0, 1]             |
| `EMBED_BATCH_LIMIT`     | `2000`     | Rows pulled per embed step                           |

Secrets (set via `wrangler secret put`):
- `VOYAGE_API_KEY`
- `OAUTH_PRIVATE_KEY`
- `ADMIN_TOKEN`

## Privacy model (v1)

Recommendations are **public**. Enrollment is opt-in via OAuth — you authorize
this app on your PDS knowing your `/recs/:did` page will be visible. Private
recs are a v2 concern.

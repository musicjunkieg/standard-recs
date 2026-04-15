# Doc Sync Rev Check + Jetstream Update/Delete — Design

**Date:** 2026-04-14
**Status:** Approved for implementation
**Related:** Supersedes the "Bug 2" half of the 4-day-old memory note `project_embed_scaling.md`. Bug 1 (embed scaling) shipped as PR #22. This is the companion work on the document-sync path.

## Problem

Every daily cron invocation of `syncDocumentsFromRepo` starts from `cursor=undefined` and pages through every `site.standard.document` record in every enrolled publisher's repository, regardless of whether anything in that repository has changed since the last cron. `INSERT OR REPLACE` makes the D1 side idempotent, but the listRecords network cost is paid in full on every run. With ~6500 publishers at ~1–3s per PDS call, that adds up to multiple hours of wall time and will eventually blow the Workflow per-step subrequest budget.

Compounding the problem: when a Standard.site author edits or deletes a document, there's no path in the current system that tracks the change.

- The batch cron's `INSERT OR REPLACE` only reflects an edit if we re-fetch the record — which we do today, but only as a side-effect of re-fetching *everything*.
- The real-time Jetstream Durable Object at `src/durable/jetstream-listener.ts:134` explicitly drops every commit event whose `operation !== "create"`. Updates and deletes from Jetstream are silently ignored.
- Nothing, anywhere in the code, ever deletes a document from D1 or from the Vectorize index when a publisher unpublishes it. Deleted documents persist as ghosts in recommendations forever.

You mentioned Standard.site authors regularly edit their publications. The gap is real, not hypothetical.

## Goal

Make the daily doc sync incremental (skip publishers whose repositories haven't changed) *and* make the real-time Jetstream path cover edits and deletes in addition to creates. Bundle both in one PR because they complement each other: the cron handles "publisher was discovered after their edit" and the Jetstream path handles "publisher edits after they were discovered."

Out of scope for this change (explicitly, to prevent review drift):

- Parallelism within a document-sync batch. The current `syncDocumentsBatch` loop processes publishers sequentially via a claim-and-sync CAS pattern. Parallelising it interacts with D1 write contention and per-Worker subrequest budget; it's a separate design exercise.
- Jetstream DO cursor persistence across reconnects. Today the DO reconnects fresh on WebSocket drop. A proper implementation would track the last-seen `seq` in DO storage and resume via Jetstream's `cursor` query param. That's a future PR; this PR accepts that a DO downtime window produces bounded drift that self-heals when the affected publisher next commits anything.
- Periodic full-resync rotation (e.g., reset 1/N of publishers' cursors per day). Not needed once the rev check and the Jetstream update/delete paths are both in place — the only gap is DO-downtime drift, which is bounded.
- Any change to `syncDocumentsBatch`'s claim/CAS pattern, or to the bridged-PDS handling. Both are load-bearing and unrelated to this work.
- Any change to the publication-sync side (`site.standard.publication` records inside `syncDocumentsFromRepo`). Publications are few per publisher and cheap; rev-gating them is unnecessary complexity.

## Approach

Two orthogonal mechanisms landing together.

### Cron-side: rev check before listRecords

Add a nullable `last_synced_rev TEXT` column to `publishers`. Before calling `listRecords` for a publisher, call `com.atproto.sync.getLatestCommit(did)` and compare the returned `rev` to the stored value.

- **Match** → skip the listRecords walk entirely. Return `skipped: true, newRev: <the same rev>` so the caller re-stamps `last_synced_rev` (a no-op write, but it keeps the column consistent with the latest confirmed observation — useful if we ever want to surface "when did we last verify this rev" distinct from "when did we last claim this publisher").
- **Mismatch OR either side is NULL** → run the current listRecords walk as today, update `last_synced_rev` to the new value on successful completion.
- **`getLatestCommit` throws or returns null** → log once at warn level, set `currentRev = null`, fall through to the current listRecords walk, leave `last_synced_rev` untouched. The next cron will retry the rev probe.

Why not something cleverer like `getRepo` with a `since` parameter? `getRepo` returns a CAR file diff, and CAR parsing in a Worker adds a dependency and complexity that we don't currently need. The rev check gives us the "can we skip?" signal cheaply; that's the high-order bit.

### Why `rev` has acceptable noise

`rev` is a repo-wide logical clock — every commit to any collection in the repository bumps it, not just `site.standard.document`. From the AT Proto sync spec: "`rev` for a repository (DID) always increases" and "Commits can be 'empty', meaning no actual record content changed, and only the `rev` was incremented."

**Implication:** a publisher who's active on Bluesky but inactive on Standard.site will show as "changed" on every cron, because their Bluesky activity is bumping `rev`. For that subset of publishers, we'll pay the rev-check cost on top of the full listRecords cost — strictly more expensive than today by one cheap HTTP call per publisher. We accept this because:

1. The rev check is cheap (one tiny JSON response vs. one or more full-page listRecords responses).
2. The category of "chatty Bluesky, quiet Standard" publishers is a subset, not all of them. The cost is bounded.
3. For fully-inactive publishers (which are likely the majority, since Standard.site writing is presumably not a daily activity for most authors), the rev check is a massive speedup.
4. The moment a chatty-Bluesky publisher actually publishes something on Standard.site, we'd have done the listRecords anyway, so the overhead "recovers" itself on the publication event.

The degraded case is never worse-than-today by more than one HTTP call; the happy case is much better. No circumstances make the rev check a net loss.

### Real-time side: Jetstream DO handles update and delete

Current state: `handleMessage` in `jetstream-listener.ts` filters `operation !== "create"` and drops everything else.

Target state: accept `create`, `update`, and `delete` for `site.standard.document`. Route them as follows.

| operation | action |
|---|---|
| `create` | existing `indexDocumentIfKnown` path — validate, check publisher is known + non-bridged, run `upsertDocumentStmt` |
| `update` | **NEW:** same as `create`. `upsertDocumentStmt` is already `INSERT OR REPLACE`, so an edit overwrites the existing row cleanly |
| `delete` | **NEW:** delete the row from `documents`, any `recommendations` referencing that `document_uri`, and the corresponding vector from Vectorize |

For `site.standard.publication` events, only `create` is handled (as today). Update and delete on publications stay as no-ops:

- Publication **updates** are rare and harmless to drop — the next cron's listRecords walk picks up the URL change via the existing `INSERT OR REPLACE` into `publications`.
- Publication **deletes** should not automatically remove the publisher from our enrolled set. A publication being removed is an ambiguous signal (could be a re-publish under a new record, a temporary state during a migration, or an actual un-enrollment). The safe default is "leave the publisher registered; let bridged-detection or manual admin tooling handle it if needed."

### The delete path, in detail

New private method `deleteDocument(did: string, rkey: string)` on the Jetstream DO.

1. Construct the URI: `at://${did}/site.standard.document/${rkey}`.
2. Compute the vector ID via the existing `vectorIds([uri])` helper from `src/recommend/vector-id.ts`. This is the same mapping the cron path uses, so there's no risk of drift.
3. Attempt `env.VECTORS.deleteByIds([vectorId])` first inside a try/catch. On failure, log at warn level and continue — the D1 side still runs regardless. A failed vector delete produces an orphan vector that a future cleanup job can recover by diffing Vectorize IDs against `documents.uri`.
4. Run a `db.batch` of two DELETEs, in order:
   ```sql
   DELETE FROM recommendations WHERE document_uri = ?
   DELETE FROM documents WHERE uri = ?
   ```
   `recommendations` first so a partial failure at the `documents` step doesn't leave dangling rec rows pointing at a still-present doc. Wrap the batch in try/catch; on failure, log at warn level and continue.
5. Increment `documentsDeleted` **only when the second batch statement actually removed a row** — i.e., when `results[1].meta.changes > 0`. D1 batch returns a `D1Result[]` where each entry's `meta.changes` is the rows-affected count for that statement. A delete event for a document we never indexed succeeds as a no-op batch with `changes: 0`; counting those would inflate the metric and mislead operators. The other DO counters (`documentsIndexed`, `documentsUpdated`, `documentsRejected`, `publishersFound`) all follow the same "only on real effects" pattern.

**Counter semantics caveat.** `documentsDeleted` reflects **successful D1 document-row removals**, not "both sides fully deleted." Because the vector delete runs first in its own try/catch, it's possible for the vector delete to fail (orphan vector lingers) while the D1 delete succeeds and `documentsDeleted` increments. `/admin/jetstream/status` therefore does **not** guarantee both sides were deleted — it guarantees the D1 row is gone. Operators relying on the counter for audit purposes should pair it with a periodic orphan-vector sweep (future work).

**Why delete the vector first, then D1?** If the vector delete fails, we have an orphan vector living in Vectorize — recoverable via a future cleanup job that diffs Vectorize IDs against `documents.uri`. If the D1 delete fails, we have an orphan D1 row that we'll re-see on the next cron and could retry against. Orphan vectors are cheaper to clean up than orphan D1 rows because Vectorize has cheap bulk-delete. The ordering picks the cheaper recovery path.

**Unknown-publisher filter:** do NOT apply the "known publisher" check on deletes. If a publisher was known at some point in the past (we have documents for them) and later got removed from `publishers` (e.g., marked `bridged`), we still want to respect the delete of their old documents. The DELETEs are no-ops if nothing is there, cost nothing, and close the ghost-doc gap.

### Validation on update events

Update events include the new record content in `commit.record`, same shape as create events. Feed it through the existing `validateStandardDocument` check. If the updated record is malformed (missing `site`, `title`, or `publishedAt`), log at warn level and skip — same as the create path does today, just now with the addition of a new `documentsRejected` counter so the rejection rate is observable via `/admin/jetstream/status`.

### Refactor shape inside `handleMessage`

Rather than stuffing three branches into the existing function, extract a small helper:

```ts
private async handleDocumentOp(
  did: string,
  operation: "create" | "update" | "delete",
  rkey: string,
  record: unknown,
): Promise<void>
```

And pull the existing `indexDocumentIfKnown(did, msg)` shape into `indexDocumentIfKnown(did: string, rkey: string, record: unknown)` — the parsing belongs in the top-level `handleMessage`, not inside the indexer. This is a trivial refactor that makes the update path a one-line addition.

## Schema

One `ALTER TABLE`, no index.

```sql
ALTER TABLE publishers ADD COLUMN last_synced_rev TEXT;
```

Column is nullable with no default. Interpretation: `NULL` means "never successfully rev-checked" and is treated as a mismatch (forcing a full sync). No index is needed because the column is only ever read when we already have the `publishers` row in hand via the existing claim query — it's returned alongside `did` and `label` in the same `SELECT`.

`schema.sql` gets edited to reflect final-state shape (new column in the `CREATE TABLE publishers` block, appearing after `pds_url`), and the Migration history comment block gains a new entry:

```sql
--   2026-04-14 (doc sync rev check — Bug 2):
--     ALTER TABLE publishers ADD COLUMN last_synced_rev TEXT;
```

## Forward/backward compatibility

Unlike the embed scaling fix, this change is **fully bidirectional**:

- **Old code + new column:** old code never reads or writes `last_synced_rev`. The column is dead weight but doesn't break anything.
- **New code + missing column:** new code would fail at claim time (the extended `SELECT` would error on unknown column). So: **migrate before deploy**. Same ordering as Bug 1.
- **New code + column present + NULL values:** new code interprets NULL as "mismatch," does a full sync, populates the rev on success. Natural backfill across the first post-deploy cron.

No coordination needed beyond the schema-before-code ordering. No downtime.

## Signatures

### New primitive in `src/sync/pds-fetch.ts`

```ts
export async function getLatestCommitRev(
  pds: string,
  did: string,
): Promise<string | null>;
```

Returns the `rev` field from `com.atproto.sync.getLatestCommit` on success, `null` on any non-2xx HTTP response or malformed JSON. Matches the existing `listRecordsFromPds` contract: errors return `null`, network/parse exceptions propagate.

**Implementation detail:** use `friendlyFetch` from `src/sync/fetch-helper.ts`, not bare `fetch`. `listRecordsFromPds` already uses `friendlyFetch` for its timeout / error-handling semantics; `getLatestCommitRev` must match. The URL shape is `${pds}/xrpc/com.atproto.sync.getLatestCommit?did=${did}`.

### Modified signature: `syncDocumentsFromRepo` in `src/sync/documents.ts`

```ts
export async function syncDocumentsFromRepo(
  db: D1Database,
  vectors: VectorizeIndex,
  did: string,
  lastSyncedRev: string | null,   // NEW parameter
): Promise<{
  fetched: number;
  stored: number;
  errors: number;
  bridged: boolean;
  newRev: string | null;          // NEW field
  skipped: boolean;                // NEW field
}>;
```

The caller (`syncDocumentsBatch`) is the only invoker; no other code reads this return shape.

### Modified shape: `syncDocumentsBatch` return

```ts
return {
  processed: number;
  fetched: number;
  stored: number;
  errors: number;
  bridged: number;
  skipped: number;   // NEW — count of publishers where rev matched
};
```

This threads up into `runBatchedDocumentSync`'s existing per-batch log line so operators can see skip rates directly: `processed=X stored=Y skipped=Z bridged=W errors=V`.

## Control flow inside `syncDocumentsFromRepo`

Ordered:

1. **Resolve PDS.** Unchanged.
2. **Bridged check.** Unchanged — `markBridgedPublisher` still runs before any rev logic. Bridged publishers are permanently skipped regardless of their rev.
3. **Rev probe.** Try `getLatestCommitRev(pds, did)`. On throw or null: `currentRev = null`, log once at warn level. Otherwise: `currentRev = <the rev>`.
4. **Rev comparison.** If `currentRev !== null && lastSyncedRev !== null && currentRev === lastSyncedRev`:
   - Return `{ fetched: 0, stored: 0, errors: 0, bridged: false, newRev: currentRev, skipped: true }`.
   - `skipped: true` is the observability signal. `newRev: currentRev` causes the caller to re-stamp the same value (no-op write) to keep the "last confirmed" semantics consistent.
5. **Publication sync.** Unchanged (rev check does not gate this — publications are 1–2 records per publisher, the cost is negligible, and publications can be updated without changing the document-collection rev).
6. **Document listRecords walk.** Unchanged from today.
7. **On successful walk completion:** set `newRev = currentRev` (could be null if the probe failed; in that case, the caller will skip the rev-column update this run). Return the usual shape with `skipped: false`.

## Control flow inside `syncDocumentsBatch`

The existing claim query SELECTs `did, label`. Extend it to SELECT `did, label, last_synced_rev`. Pass `candidate.last_synced_rev` into `syncDocumentsFromRepo` as the fourth argument.

On return, if `result.newRev !== null`, issue a second UPDATE after the existing CAS-style `last_synced_at` stamp:

```sql
UPDATE publishers SET last_synced_rev = ? WHERE did = ?
```

**Ordering invariant:** `last_synced_at` is stamped BEFORE processing the publisher (as today, to prevent concurrent workflows double-claiming). `last_synced_rev` is stamped AFTER successful processing. If the sync crashes mid-publisher, `last_synced_at` is already bumped so the 23h cooldown prevents re-attempts until the next window, and `last_synced_rev` is still the old value, so the eventual retry will treat it as a mismatch and do a full resync. That's the correct recovery path.

**Why two UPDATE statements instead of one?** The `last_synced_at` CAS pattern is load-bearing — its WHERE clause compares against a stale read to detect concurrent claim races. Combining the `last_synced_rev` update into the same statement would either require changing the CAS semantics or conditionally nullifying the rev update on race loss, both of which are error-prone. Two separate updates, with the rev update firing only on successful sync completion, is simpler and easier to reason about. The cost is negligible (one extra D1 prepared statement per successfully-synced publisher).

## Counters and observability

### Cron path

Extend the batch-log line in `runBatchedDocumentSync` to include the new `skipped` field:

```text
batch full-0: processed=50 stored=2 bridged=0 skipped=47 errors=1
```

This is the primary signal for whether the rev check is working. On an established corpus where most publishers are idle, we expect `skipped` to dominate within a cron or two. If `skipped` stays at 0 across runs, something is wrong.

### Jetstream DO

Three new counters on the DO state, surfaced via `/admin/jetstream/status`:

- `documentsUpdated` — increments on successful handling of an `update` event for `site.standard.document`
- `documentsDeleted` — increments on successful full deletion (both vector and D1)
- `documentsRejected` — increments when `validateStandardDocument` returns null on a `create` or `update` event. (This counter replaces the existing silent drop with an observable one. It's tiny additional scope and buys us visibility into how often publishers push malformed records.)

## Verification plan

Post-deploy, in order:

1. **Migration applied:**
   ```bash
   npx wrangler d1 execute standard-recs-db --remote --command="PRAGMA table_info(publishers);"
   ```
   Should list `last_synced_rev` as a column. A quick sanity check.

2. **First cron populates the rev column for successfully synced publishers:**
   ```bash
   npx wrangler d1 execute standard-recs-db --remote --command="SELECT COUNT(*) FROM publishers WHERE last_synced_rev IS NOT NULL;"
   ```
   After the first post-deploy cron completes, this should be non-zero and climbing toward the total publisher count over successive runs (non-bridged, non-errored).

3. **Skip rate visible in batch logs:**
   ```bash
   npx wrangler tail
   ```
   On the second post-deploy cron (first cron after `last_synced_rev` is populated), batch log lines should show `skipped > 0`. A typical healthy log line:
   ```text
   batch full-0: processed=50 stored=0 bridged=0 skipped=48 errors=0
   ```

4. **Wall-clock improvement:** compare the number of Workflow steps between a pre-deploy full cron and a post-deploy full cron. Not a hard assertion — the improvement scales with how many publishers are actually idle — but a rough signal.

5. **Jetstream DO counters expose update/delete:**
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://standardrecs.site/admin/jetstream/status
   ```
   Response should include `documentsUpdated`, `documentsDeleted`, `documentsRejected` fields. They'll be zero until activity happens; the existence of the fields in the response is what we're checking for initially.

6. **Delete path end-to-end (optional, manual):** find a document in D1 (`SELECT uri FROM documents LIMIT 1`), note the URI, ask a publisher to unpublish (or, more realistically, wait for one to happen organically). On the unpublish event, `documentsDeleted` should increment and a follow-up `SELECT COUNT(*) FROM documents WHERE uri = ?` should return 0.

## Failure recovery

If the rev check causes a regression post-deploy (e.g., a PDS implementation we didn't anticipate returns malformed `rev` values):

- **Lightweight revert:**
  ```bash
  npx wrangler d1 execute standard-recs-db --remote --command="UPDATE publishers SET last_synced_rev = NULL;"
  ```
  Forces every publisher back to the full-sync path on the next cron. No redeploy needed. Takes effect immediately.

- **Full revert:** `git revert <merge-commit>` and redeploy. The column stays in the schema (it's nullable and ignored by old code).

- **Targeted revert (single PDS):**
  ```bash
  npx wrangler d1 execute standard-recs-db --remote --command="UPDATE publishers SET last_synced_rev = NULL WHERE pds_url = '<broken-pds>';"
  ```
  Scoped disable of the rev check for publishers on a specific PDS.

## Files touched

| File | Change |
|---|---|
| `schema.sql` | Add `last_synced_rev TEXT` to `CREATE TABLE publishers`; append Migration history entry |
| `src/sync/pds-fetch.ts` | New `getLatestCommitRev` export |
| `src/sync/documents.ts` | `syncDocumentsFromRepo` gains `lastSyncedRev` param and `newRev`/`skipped` return fields; `syncDocumentsBatch` extends claim query, threads rev, issues second UPDATE, extends return shape |
| `src/workflow.ts` | `runBatchedDocumentSync` batch-log line includes `skipped` count |
| `src/durable/jetstream-listener.ts` | `handleMessage` routes update/delete; new `deleteDocument` method; `indexDocumentIfKnown` signature refactored to take `rkey`/`record` directly; three new counters exposed via `/admin/jetstream/status` |
| `docs/superpowers/specs/2026-04-14-doc-sync-rev-check-design.md` | This file |
| `docs/superpowers/plans/2026-04-14-doc-sync-rev-check.md` | Implementation plan (next step) |

No changes to `wrangler.toml`. No new env vars. No new secrets. No dependency changes.

## Non-goals (explicit, to prevent scope creep in review)

- **Not** parallelising the document-sync batch loop. Separate concern.
- **Not** adding Jetstream DO cursor persistence. Separate concern.
- **Not** adding a periodic full-resync rotation. The rev check + DO update path handle the gap.
- **Not** gating the publication sync on rev. Publications are cheap; the complexity isn't worth the microscopic savings.
- **Not** changing `syncDocumentsBatch`'s claim/CAS pattern. Load-bearing and unrelated.
- **Not** rotating or auditing `last_synced_at` semantics. It remains a 23h cooldown, stamped pre-processing.
- **Not** implementing a retention policy on the new `documentsUpdated` / `documentsDeleted` / `documentsRejected` counters. They're unbounded in-memory counters on the DO, same as the existing `publishersFound` and `documentsIndexed`. Reset on DO restart. If long-term observability becomes a concern, that's a separate PR that probably wants to write to a real metrics backend rather than DO state.
- **Not** fixing the pre-existing `markBridgedPublisher` vector-ID mismatch (`src/sync/documents.ts:161`). That function calls `vectors.deleteByIds(ids)` where `ids = docs.map((d) => d.uri)` — raw AT URIs. But documents are stored in Vectorize under SHA-256-hashed IDs per `src/recommend/vector-id.ts:26`, so those delete calls are effectively no-ops and bridged publishers leave orphan vectors behind. The new `deleteDocument` path on the Jetstream DO in this PR correctly uses `vectorIds([uri])`, which is internally consistent; but an implementer working in `documents.ts` may notice the mismatch in `markBridgedPublisher` and be tempted to "helpfully fix" it in-line. **Do not.** It's a separate bug with its own implications (what happens to orphan vectors from already-marked bridged publishers? Is a backfill cleanup needed?) and deserves its own spec and PR. Leave it alone for now; I'll track it as follow-up work after this PR ships.

# Embed Scaling Fix: Design

**Date:** 2026-04-13
**Status:** Approved for implementation
**Author:** Bryan Guffey (design), Claude (scribe)

## Motivation

The daily cron pipeline caps its embedding step at 500 rows per table per run — but the SELECTs have no filter for already-embedded rows:

```sql
-- src/recommend/embed.ts (current state)
SELECT uri, liked_post_text FROM likes
WHERE liked_post_text IS NOT NULL AND liked_post_text != ''
ORDER BY liked_at DESC
LIMIT 500

SELECT uri, title, description, text_content FROM documents
WHERE (text_content IS NOT NULL AND text_content != '')
   OR (description IS NOT NULL AND description != '')
LIMIT 500
```

Every cron run re-embeds the same first 500 rows (for documents: the first 500 by table insertion order; for likes: the 500 most recent likes across all users). Anything past row 500 never gets embedded and is invisible to recommendations.

**Observable impact on production today (2026-04-13):**

- **1 user enrolled**, 934 likes in D1. Only the ~500 most recent likes are in Vectorize. The older ~434 likes contribute nothing to the user's taste vector or to any downstream recommendation.
- **13,334 documents** in D1 from the lightrail-driven publisher sync. Only the first ~500 by insertion order are in Vectorize. The other ~12,800 are invisible to `vectors.query()` — they exist in D1 but can never surface as a recommendation.
- **The variant system from PR #21 amplifies the bug.** Nonstandardrecs's MMR picks from the same taste vector built from the same truncated 500 embeddings. Both standard and nonstandard operate on a biased slice.

This spec is the fix for Bug 1 in `~/.claude/projects/-Users-bryan-guffey-Code-standard-recs/memory/project_embed_scaling.md`. Bug 2 (document sync re-fetching all publishers every cron) is scoped to a separate follow-up PR.

## Scope

**In scope:**

- Add `embedded_at TEXT` column to both `likes` and `documents` tables.
- Filter the two existing SELECTs in `embed.ts` with `WHERE embedded_at IS NULL`.
- Stamp rows on successful Vectorize upsert via a batched `UPDATE ... SET embedded_at = datetime('now') WHERE uri IN (...)`.
- New env var `EMBED_BATCH_LIMIT = "2000"` replacing the hardcoded `LIMIT 500` in both SELECTs.
- New partial indexes `idx_likes_unembedded` and `idx_documents_unembedded` (both with `WHERE embedded_at IS NULL`) supporting the filtered SELECTs without holding entries for already-embedded rows.
- Schema change follows the CREATE-TABLE-as-final-state pattern established in PR #21: `schema.sql` describes the final shape directly; historical ALTERs live as commented migration history at the bottom.
- Production migration via ad-hoc `wrangler d1 execute --remote --command=...` (same pattern as the `variant` and `rank` columns).

**Out of scope:**

- Bug 2: `sync/documents.ts` re-fetching all publishers every cron. Separate PR.
- A retry counter for rows that fail to embed repeatedly (`embed_attempts INTEGER`). Not observed in practice; premature scaffolding for a failure mode that doesn't exist.
- Changes to the MMR ranking, the variant system, the OAuth flow, the admin endpoints, or any page template.
- A general-purpose migration system (timestamped files + tracking table). The commented history in `schema.sql` is the agreed-upon non-choice for a project with a single prod DB and low schema-change cadence.
- Dynamic batch-size tuning (adaptive based on wall-clock, backlog size, etc.). The single env var knob is enough for now.

## Architecture

One column per table, one filter per SELECT, one UPDATE per successful batch. No new files. No new modules. Pure surgery in `embed.ts` + schema + wrangler config + one env binding.

The behavioral invariant:

> A row is embedded iff it has been successfully upserted into Vectorize iff `embedded_at IS NOT NULL`.

The SELECT-UPDATE sequence enforces this invariant by running the `UPDATE ... SET embedded_at = datetime('now')` **inside the same `try` block** as the successful `vectors.upsert()` call. Order of operations within the try:

1. Compute embeddings via Voyage API (`getEmbeddings`).
2. Length-parity check.
3. `vectors.upsert(vectorBatch)` — the authoritative "this is in Vectorize."
4. `UPDATE ... SET embedded_at = datetime('now') WHERE uri IN (?, ?, ...)` — the stamp.
5. `embedded += batch.length`.

If any step fails, the `catch` block logs the error, increments `errors += batch.length`, and skips the stamp. Rows stay `NULL` and retry on the next cron. The critical safety property is that the stamp is never recorded unless the preceding upsert succeeded — the failure mode "stamped but not in Vectorize" is structurally impossible.

If the upsert succeeds but the UPDATE itself fails (transient D1 issue, rare), the outcome is "double-embedded next cron": the row gets re-embedded (idempotent overwrite in Vectorize, zero functional impact) and the stamp is retried. The failure window is at most one cron cycle.

## Schema change

`schema.sql` describes the final shape directly via `CREATE TABLE IF NOT EXISTS`. Fresh database bootstrap via `npm run db:init` gets the final columns + indexes in one pass:

```sql
CREATE TABLE IF NOT EXISTS likes (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  liked_post_uri TEXT NOT NULL,
  liked_post_text TEXT,
  liked_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedded_at TEXT,
  FOREIGN KEY (did) REFERENCES users(did)
);

CREATE INDEX IF NOT EXISTS idx_likes_did ON likes(did);
CREATE INDEX IF NOT EXISTS idx_likes_liked_at ON likes(liked_at);
CREATE INDEX IF NOT EXISTS idx_likes_unembedded
  ON likes(liked_at DESC) WHERE embedded_at IS NULL;

CREATE TABLE IF NOT EXISTS documents (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  site TEXT,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  text_content TEXT,
  tags TEXT,
  published_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at);
CREATE INDEX IF NOT EXISTS idx_documents_unembedded
  ON documents(indexed_at) WHERE embedded_at IS NULL;
```

**`embedded_at` is nullable with no DEFAULT** because "never embedded" has no sensible default value; `NULL` is the natural signal.

**The two new indexes are partial indexes** — they only include rows matching `WHERE embedded_at IS NULL`. This is strictly tighter than a full index on `embedded_at`: during the initial backfill they hold all ~934 + ~13,334 rows, but as the backlog drains they shrink toward zero entries, and in steady state they're near-empty (just the handful of rows added since the previous cron). The likes index includes `liked_at DESC` as the sort key to support the `ORDER BY liked_at DESC` in the SELECT; the documents index includes `indexed_at` for predictable iteration order (though the SELECT has no explicit ORDER BY). SQLite's partial index support is native and D1 passes it through directly. If profiling later shows any issue, the fallback is a plain index on `embedded_at`.

**Historical ad-hoc migrations applied to production:**

```sql
-- applied 2026-04-13 via wrangler d1 execute --remote --command=...
ALTER TABLE likes ADD COLUMN embedded_at TEXT;
ALTER TABLE documents ADD COLUMN embedded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_likes_unembedded
  ON likes(liked_at DESC) WHERE embedded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_unembedded
  ON documents(indexed_at) WHERE embedded_at IS NULL;
```

These are recorded as comments at the bottom of `schema.sql` under the existing "Migration history" section, extending the pattern PR #21 established for the `variant` and `rank` columns.

**Existing rows get `NULL` for `embedded_at` via the new column's nullability.** The first post-deploy cron run then re-embeds whatever fits under `EMBED_BATCH_LIMIT=2000` — including rows that were already in Vectorize from previous cron runs. This is a one-time duplicate-work cost on the first post-deploy cron. `Vectorize.upsert()` is idempotent — re-embedding an existing vector just overwrites it with the same values. No behavioral change, no data loss, one-time API cost roughly equivalent to a single normal cron.

## Code changes

All edits in `src/recommend/embed.ts` plus one small thread-through in `src/workflow.ts` and one binding in `src/env.ts`.

### `src/recommend/embed.ts`

**New constant at top of file:**

```ts
const DEFAULT_EMBED_BATCH_LIMIT = 2000;
```

**`embedAll` signature adds a new parameter:**

```ts
export async function embedAll(
  db: D1Database,
  vectors: VectorizeIndex,
  apiKey: string,
  embedMode: LikeEmbedMode = "query",
  embedBatchLimit: number = DEFAULT_EMBED_BATCH_LIMIT,
): Promise<EmbedResult>
```

This mirrors the `lambda` parameter pattern from PR #21's Task 6: new param at the end, safe default, no caller breakage.

**Likes SELECT gets the `embedded_at` filter + parameterized limit:**

```ts
const { results: unembeddedLikes } = await db
  .prepare(
    `SELECT uri, liked_post_text FROM likes
     WHERE liked_post_text IS NOT NULL
       AND liked_post_text != ''
       AND embedded_at IS NULL
     ORDER BY liked_at DESC
     LIMIT ?`,
  )
  .bind(embedBatchLimit)
  .all<{ uri: string; liked_post_text: string }>();
```

**Documents SELECT gets the same treatment:**

```ts
const { results: docs } = await db
  .prepare(
    `SELECT uri, title, description, text_content FROM documents
     WHERE ((text_content IS NOT NULL AND text_content != '')
         OR (description IS NOT NULL AND description != ''))
       AND embedded_at IS NULL
     LIMIT ?`,
  )
  .bind(embedBatchLimit)
  .all<{
    uri: string;
    title: string;
    description: string | null;
    text_content: string | null;
  }>();
```

The documents SELECT has no explicit `ORDER BY`, matching the existing behavior (stable table order for the initial batch). No need to change.

**Likes batch loop restructures to handle `LIKE_EMBED_MODE=both` correctly.** The existing `embedLikesIntoNamespace` helper has the per-batch loop internal to itself, which means in `both` mode it's called twice with the same rows — once per namespace. If the stamp goes inside the helper, the first call stamps and the second call might fail mid-batch, leaving rows stamped but absent from the second namespace. That breaks the invariant "embedded_at IS NOT NULL iff in Vectorize."

**Fix: hoist the batch loop to `embedAll` so a single batch iteration covers all requested namespaces and stamps only after all upserts for that batch succeed.** The `embedLikesIntoNamespace` helper is deleted — its Voyage call, parity check, and Vectorize upsert all move inline into the new loop. The helper existed to DRY up the two-namespace case, but the stamp invariant forces the two namespace calls to share a try block with the stamp, so keeping them as separate helper invocations and coordinating stamping across calls is strictly worse than inlining.

The new batch loop shape in `embedAll`, replacing the two `embedLikesIntoNamespace` calls:

```ts
// --- Likes (one or both namespaces depending on mode, with
// per-batch stamping only after all requested namespaces succeed) ---
const wantQuery = embedMode === "query" || embedMode === "both";
const wantDoc = embedMode === "document" || embedMode === "both";

if (unembeddedLikes.length > 0 && (wantQuery || wantDoc)) {
  const batches = chunk(unembeddedLikes, BATCH_SIZE);

  for (const batch of batches) {
    try {
      const texts = batch.map((l) => l.liked_post_text);
      const baseIds = await vectorIds(batch.map((l) => l.uri));

      if (wantQuery) {
        const embeddings = await getEmbeddings(texts, apiKey, "query");
        if (embeddings.length !== texts.length) {
          throw new Error(
            `Voyage returned ${embeddings.length} embeddings for ${texts.length} inputs (query namespace)`,
          );
        }
        const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
          id: baseIds[i],
          values,
          namespace: LIKES_NAMESPACE_QUERY,
          metadata: { type: "like", uri: batch[i].uri },
        }));
        await vectors.upsert(vectorBatch);
        queryEmbedCount += batch.length;
      }

      if (wantDoc) {
        const embeddings = await getEmbeddings(texts, apiKey, "document");
        if (embeddings.length !== texts.length) {
          throw new Error(
            `Voyage returned ${embeddings.length} embeddings for ${texts.length} inputs (doc namespace)`,
          );
        }
        const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
          id: LIKES_DOC_ID_PREFIX + baseIds[i],
          values,
          namespace: LIKES_NAMESPACE_DOC,
          metadata: { type: "like", uri: batch[i].uri },
        }));
        await vectors.upsert(vectorBatch);
        docEmbedCount += batch.length;
      }

      // All requested namespaces have successfully upserted this
      // batch. Stamp the rows now so they don't re-embed next cron.
      // Must be inside the same try as the upserts above — if any
      // upsert threw, we never reach the stamp and the catch block
      // leaves embedded_at NULL, preserving the invariant.
      const placeholders = batch.map(() => "?").join(",");
      await db
        .prepare(
          `UPDATE likes SET embedded_at = datetime('now') WHERE uri IN (${placeholders})`,
        )
        .bind(...batch.map((l) => l.uri))
        .run();
    } catch (err) {
      errors += batch.length;
      console.error(`Like embedding batch failed:`, truncErr(err));
    }
  }
}
```

**The inlined loop counters (`queryEmbedCount`, `docEmbedCount`) are incremented immediately after each successful `vectors.upsert()`, before the stamp runs.** This is intentional: if the stamp UPDATE fails (transient D1 blip) after the upserts succeeded, the catch block will increment `errors += batch.length` and the next cron re-embeds the batch (idempotent overwrite). The per-namespace counts end up slightly over-reporting in that specific failure window, which is a harmless observability quirk rather than a functional bug. The alternative (defer the increments to after the stamp) would under-report successful embeds in the same failure window, which is strictly worse for diagnosing backlog drain progress.

**Documents loop — same stamp pattern, simpler because there's only one namespace:**

In the existing documents batch loop in `embedAll`, inside the try, after the successful `await vectors.upsert(vectorBatch);` line:

```ts
// Stamp the just-embedded documents. Same rationale as the likes
// stamp above: inside the try so upsert-success/stamp-skip can't
// happen; the only racey window is stamp-UPDATE-fails-after-upsert-
// succeeded which is benign (idempotent re-embed next cron).
const placeholders = batch.map(() => "?").join(",");
await db
  .prepare(
    `UPDATE documents SET embedded_at = datetime('now') WHERE uri IN (${placeholders})`,
  )
  .bind(...batch.map((d) => d.uri))
  .run();
```

(Documents only ever go to the `"documents"` namespace so there's no multi-namespace coordination — the stamp inside the existing try is already structurally safe.)

**Log line at the bottom of `embedAll` is extended with the effective limit** so operators can tell at a glance whether the cap was binding:

```ts
console.log(
  `Embedded ${likesProcessed} likes ` +
    `(query=${queryEmbedCount}, doc=${docEmbedCount}), ` +
    `${docCount} documents (${errors} errors). ` +
    `Limit: ${embedBatchLimit}.`,
);
```

If `likesProcessed === embedBatchLimit` or `docCount === embedBatchLimit`, the limit was binding and the backlog isn't yet drained. If the counts are less than the limit, the pool is empty (or close to it).

### `src/workflow.ts`

Both existing `embedAll` call sites (one in `runUserSync`, one in `runFullPipeline`) add a new line reading `EMBED_BATCH_LIMIT` via the existing `parseIntOrDefault` helper and pass it through as the 5th argument to `embedAll`. This mirrors the `parseMmrLambda` pattern from PR #21:

```ts
const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
const embedBatchLimit = parseIntOrDefault(this.env.EMBED_BATCH_LIMIT, 2000);
const result = await embedAll(
  this.env.DB,
  this.env.VECTORS,
  this.env.VOYAGE_API_KEY,
  embedMode,
  embedBatchLimit,
);
```

(Note: `parseIntOrDefault` already exists in `workflow.ts` and is used for other env vars. No new helper function needed.)

### `src/env.ts`

One new line inside the `// Config vars` section, after `MMR_LAMBDA`:

```ts
EMBED_BATCH_LIMIT: string;       // "2000" — per-table cap on rows embedded per cron run
```

### `wrangler.toml`

One new line inside the `[vars]` section:

```toml
EMBED_BATCH_LIMIT = "2000"
```

**Note the stash/pop dance for pre-session dirty state.** The repo's `wrangler.toml` has pre-existing local edits (`TOP_N = "12"`, `WORKER_URL = "https://standardrecs.site"`) that must survive this change without being committed. Same pattern as PR #21's Task 3 — stash before editing, commit the clean change, pop the stash and resolve the trivial merge.

## Data flow

### Cron time (sync workflow)

1. Existing sync pipeline runs (sync-likes → prune → cleanup-oauth → discover → sync-documents).
2. Workflow reaches the `embed` step.
3. `embedAll` is called with the parsed `embedBatchLimit` from env.
4. **Likes half:**
   - SELECT filters by `embedded_at IS NULL`, ordered by `liked_at DESC`, limited to `embedBatchLimit`.
   - If `unembeddedLikes.length === 0`, both branches (query / doc namespace per `LIKE_EMBED_MODE`) skip immediately.
   - Otherwise, an inlined batch loop in `embedAll` chunks the rows at 100/call to Voyage, upserts each result to Vectorize (to one namespace for `query`/`document` mode, or both for `both` mode — all within a single try block per batch), stamps the successful batches with `UPDATE likes SET embedded_at = datetime('now')` inside the same try, and logs errors for failed batches (which leave their rows unstamped for retry).
5. **Documents half:**
   - Same pattern: SELECT filters `embedded_at IS NULL`, limited to `embedBatchLimit`, batched 100/call, upserted, stamped, logged.
6. The top-level log line reports per-namespace embed counts, document count, error count, and the effective limit for the run.
7. Workflow continues to the recommend step (unchanged).

### First post-deploy cron (the expensive one)

Today's data (1 user, 934 likes, 13,334 documents) produces this first-run shape:

- **Likes**: 934 NULL rows → SELECT returns 934 → Voyage embeds all 934 → Vectorize upserts 934 → stamp 934. Everything finishes in one pass. The limit is not binding.
- **Documents**: 13,334 NULL rows → SELECT returns 2000 (limited) → Voyage embeds 2000 → Vectorize upserts 2000 → stamp 2000. Limit binding; ~11,334 rows remain NULL for subsequent crons.

Subsequent daily cron runs drain ~2000 documents each until the backlog is cleared (~7 days). After the backlog is drained, each cron run only embeds rows newly synced by the `sync-documents` step — which at current lightrail discovery rates is tens of rows per day, well below the limit.

### Steady state

After the backlog is drained, the embed step's SELECT returns only rows added since the previous cron ran. The `WHERE embedded_at IS NULL` predicate is effectively a "find new since last cron" filter without needing an explicit cursor.

## Error handling

### Success path
1. Batch succeeds in its entirety → all rows stamped, embed count incremented, error count unchanged.

### Voyage failure (rate limit, network error, malformed response)
1. `getEmbeddings` throws inside the try.
2. `catch` block logs the error, increments `errors += batch.length`, moves on to the next batch.
3. None of the rows in the failed batch are stamped → they retry on the next cron.

### Length parity check failure
1. Voyage returned fewer embeddings than inputs (partial failure or response truncation).
2. The parity check at the top of the try throws before any upsert happens.
3. `catch` logs the error with the mismatch count, increments `errors += batch.length`, moves on.
4. No stamps, no upserts. Clean.

### Vectorize upsert failure
1. `vectors.upsert` throws inside the try.
2. `catch` logs, increments errors, no stamps.
3. Rows retry on next cron.

### Stamp UPDATE failure (transient D1)
1. `vectors.upsert` succeeded — rows are now in Vectorize.
2. `db.prepare(...).run()` on the UPDATE throws.
3. `catch` logs an error, increments `errors += batch.length`, moves on.
4. Rows are in Vectorize but unstamped → they re-embed on the next cron.
5. Next cron's upsert is idempotent (overwrite with same vector) → no functional impact.

This is the only "embed without stamp" race, and it's benign. The opposite race (stamp without embed) is structurally impossible because the stamp runs after the upsert, inside the same try.

### Whole-pipeline failure (unrelated code throws before `embedAll`)
1. Workflow step errors, gets retried via standard Workflow retry semantics.
2. On next attempt, `embedAll` re-runs from the top with the same database state.
3. Any rows that had been stamped in a previous aborted attempt stay stamped (no re-embed); any that hadn't get picked up. Forward progress is preserved.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `schema.sql` | modify | `CREATE TABLE likes` gains `embedded_at TEXT` (nullable). `CREATE TABLE documents` gains `embedded_at TEXT` (nullable). Two new partial indexes: `idx_likes_unembedded` on `likes(liked_at DESC) WHERE embedded_at IS NULL` and `idx_documents_unembedded` on `documents(indexed_at) WHERE embedded_at IS NULL`. Historical ALTERs added to the "Migration history" section at the bottom. |
| `src/recommend/embed.ts` | modify | New `DEFAULT_EMBED_BATCH_LIMIT` constant. `embedAll` gains a 5th parameter `embedBatchLimit` with default. Two SELECTs gain `AND embedded_at IS NULL` + parameterized `LIMIT ?`. **The `embedLikesIntoNamespace` private helper is deleted**; its per-batch loop inlines into `embedAll` directly so a single try block covers Voyage → parity check → Vectorize upsert(s) → stamp UPDATE across all requested namespaces for that batch. The documents loop gains a stamp UPDATE inside its existing try. Log line extended with effective limit. |
| `src/workflow.ts` | modify | Both `embedAll` call sites (`runUserSync` and `runFullPipeline`) read `EMBED_BATCH_LIMIT` via `parseIntOrDefault` and pass it through as the 5th positional arg. |
| `src/env.ts` | modify | New `EMBED_BATCH_LIMIT: string` binding in the Config vars section. |
| `wrangler.toml` | modify | New `EMBED_BATCH_LIMIT = "2000"` in `[vars]`. Stash/pop dance required because of pre-session local edits. |

Net: 0 new files, 5 modified files, 2 schema columns + 2 schema indexes (plus historical migration comments).

## Rollout + verification

### Pre-deploy

1. Branch off `main` as `fix/embed-scaling` (already done during spec writing).
2. Apply the edits to the five files above.
3. `npx tsc --noEmit` — clean exit.
4. `npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun-embed-scaling 2>&1 | tail -40` — bindings table should show `env.EMBED_BATCH_LIMIT ("2000")` alongside the others.
5. Commit, push, open PR.

### Production deploy sequence

After PR merge:

1. `git switch main && git pull`
2. **Apply schema migrations to remote D1 ad-hoc** via individual commands (wrangler's batch apply aborts on duplicate-column errors from earlier rounds):
   ```bash
   npx wrangler d1 execute standard-recs-db --remote \
     --command="ALTER TABLE likes ADD COLUMN embedded_at TEXT"
   npx wrangler d1 execute standard-recs-db --remote \
     --command="ALTER TABLE documents ADD COLUMN embedded_at TEXT"
   npx wrangler d1 execute standard-recs-db --remote \
     --command="CREATE INDEX IF NOT EXISTS idx_likes_unembedded ON likes(liked_at DESC) WHERE embedded_at IS NULL"
   npx wrangler d1 execute standard-recs-db --remote \
     --command="CREATE INDEX IF NOT EXISTS idx_documents_unembedded ON documents(indexed_at) WHERE embedded_at IS NULL"
   ```
   (Bryan runs these from his shell, not the sandbox — wrangler needs to write its log file to `~/Library/Preferences/.wrangler/` which the sandbox blocks.)
3. `npm run deploy` — standard deploy. Bindings table should show the new env var.
4. `curl -X POST https://standardrecs.site/admin/sync` — trigger the first post-fix cron.
5. **Wait and observe.** First cron will do significant work:
   - Likes embed: 934 rows in a single pass (Bryan's full backlog). Look for `Embedded 934 likes (query=934, doc=0), ...` in `wrangler tail` output.
   - Documents embed: 2000 rows (first slice under the new limit). Look for `Embedded ... 2000 documents ...`.
   - Expected wall-clock: 60-120s for the embed step. Voyage batches are 100/call, ~1-2s each with Vectorize upsert overhead. 934 likes = 10 batches; 2000 docs = 20 batches; ~30 batches total.

### Post-deploy verification

```bash
npx wrangler d1 execute standard-recs-db --remote \
  --command="SELECT COUNT(*) AS total, COUNT(embedded_at) AS embedded FROM likes"
npx wrangler d1 execute standard-recs-db --remote \
  --command="SELECT COUNT(*) AS total, COUNT(embedded_at) AS embedded FROM documents"
```

**Expected on first cron completion:**
- `likes`: `total=934, embedded=934` (full backlog drained in one pass)
- `documents`: `total≈13334, embedded=2000` (first 2000 stamped, ~11,334 remaining)

**Expected on day 7:**
- `documents`: `total≈13334, embedded≈13334` (backlog drained after 7 daily crons)

**Steady state (day 8+):**
- Each cron embeds only rows added since the previous cron. Counts should change only by the daily delta from `sync-documents` and any user-driven enrollment syncs.

**Fail signals to watch for:**

- **Embedded count doesn't increase between crons.** Something is wrong with the stamp UPDATE. Check `wrangler tail` for `Document embedding batch failed` or `Like embedding batch failed` entries.
- **`errors > 0` in the embed log.** Expected occasionally on Voyage or D1 blips; chronic errors point at a real problem. Spot-check which batches are failing via the log entries.
- **`likesProcessed === EMBED_BATCH_LIMIT`** after the first cron. Shouldn't happen at current data volumes (934 < 2000), but if it does, the likes backlog is deeper than expected.
- **Wall-clock on the embed step dominates cron runtime or blows the Workflow step timeout.** Drop `EMBED_BATCH_LIMIT` to 1000 or 500 via wrangler.toml edit + `npm run deploy`.

### Rollback

If something goes catastrophically wrong:

1. Revert the PR via GitHub UI or `git revert <merge-commit> && git push`.
2. Redeploy: `npm run deploy`.
3. The `embedded_at` columns stay on the tables harmlessly after revert — the reverted `embedAll` simply doesn't read or write them.
4. To force re-embed everything on the next cron after rollback, run the two UPDATEs as separate invocations (D1's `--command=` flag accepts a single statement per call):
   ```bash
   npx wrangler d1 execute standard-recs-db --remote \
     --command="UPDATE likes SET embedded_at = NULL"
   npx wrangler d1 execute standard-recs-db --remote \
     --command="UPDATE documents SET embedded_at = NULL"
   ```

### Known one-time cost

The first post-deploy cron embeds every currently-embedded-but-unstamped row because `embedded_at IS NULL` on all rows after the migration. For Bryan's current production data this is:

- 934 likes (already in Vectorize from previous crons, but marked as unembedded) — embedded again.
- 2000 documents (up to the limit) — most of the first ~500 are re-embeds, rest are new.

Voyage cost: roughly 3000 API calls × ~200 chars each ≈ 600K tokens out of the 200M free-tier budget. Negligible.

Vectorize cost: 2934 upserts — each one overwrites an existing vector with the same values. No D1 cost change, no query cost change.

The duplicate work is a one-time transitional cost that goes away after the first cron completes. Not worth avoiding via a more complex migration.

## Open questions / deferred

- **Bug 2 (document sync re-fetches all publishers every cron).** Separate PR, coming next after this one ships.
- **Retry counter for pathological rows.** Not in scope because no such rows have been observed. If a specific row consistently fails to embed over multiple crons, the `console.error` logs will surface it and manual intervention is cheap.
- **Per-table batch limits.** Currently `EMBED_BATCH_LIMIT` applies to both likes and documents equally. If one table dominates cron wall-clock, we can split into `EMBED_LIKES_LIMIT` and `EMBED_DOCS_LIMIT` — but that's YAGNI until profiling shows it matters.
- **Re-embed triggers for documents whose text changes.** Standard.site documents are immutable per URI (new text = new URI), so this is not a concern today. If the Standard.site data model ever allows in-place edits, we'd need a `re_embed_after` column or a separate invalidation signal.

## Not in this spec

- No changes to `computeTasteVector`, `pickMMR`, `generateUserRecommendations`, or any recommend-side logic.
- No changes to the variants system, the three-subdomain routing, or any page template.
- No changes to OAuth, the admin endpoints (`/admin/sync`, `/admin/compare-recs`, etc.), or the Jetstream DO.
- No changes to `sync/likes.ts`, `sync/documents.ts`, `sync/discover.ts`, or any sync module.
- No new test runner (still no test runner in the project; verification is typecheck + dry-run + post-deploy observation).

---

## Approval trail

- **Bryan** approved Section 1 (architecture: one column per table, one filter per SELECT, one UPDATE per successful batch, no new files).
- **Bryan** approved Section 2 (schema: CREATE TABLE as final state, nullable `embedded_at`, two new indexes, production ad-hoc migrations, existing rows get NULL and re-embed on first post-fix cron).
- **Bryan** approved Section 3 (code: new `DEFAULT_EMBED_BATCH_LIMIT` constant, `embedAll` gains a 5th parameter, SELECT filter + parameterized limit, stamp inside the try, log extended with effective limit).
- **Bryan** approved Section 4 (rollout: branch → edits → typecheck → dry-run → PR → merge → ad-hoc ALTERs → deploy → first sync → observation).

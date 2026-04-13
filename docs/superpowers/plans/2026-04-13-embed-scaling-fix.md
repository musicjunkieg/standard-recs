# Embed Scaling Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Bug 1 from `memory/project_embed_scaling.md`: add `embedded_at` tracking to both `likes` and `documents` so the cron's embed step filters out already-embedded rows and makes monotonic forward progress instead of re-embedding the same hot 500 rows every run.

**Architecture:** One column per table (`embedded_at TEXT`, nullable), one filter per SELECT (`WHERE embedded_at IS NULL`), one `UPDATE` per successful batch inside the same try block as the Vectorize upsert. The existing `embedLikesIntoNamespace` helper is deleted so a single inline batch loop in `embedAll` can atomically upsert to all requested namespaces AND stamp the rows — which is required for `LIKE_EMBED_MODE=both` to preserve the "embedded_at IS NOT NULL iff in Vectorize" invariant. New env var `EMBED_BATCH_LIMIT = "2000"` replaces the hardcoded `LIMIT 500`.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite with partial index support), Vectorize, Voyage AI, TypeScript.

**Spec:** [`docs/superpowers/specs/2026-04-13-embed-scaling-fix-design.md`](../specs/2026-04-13-embed-scaling-fix-design.md) — read this first. The plan here is the execution sequence; the spec is the rationale.

**Branch:** `fix/embed-scaling` (already created, spec commits `2a80cae` / `1db70af` / `2944053` already landed).

---

## Before you begin

### Project context you need

- **No test runner.** `CLAUDE.md` is explicit: *"No test runner or linter is configured."* Don't import `pytest`/`vitest`/`jest`/`node:test`. Verification throughout this plan is:
  1. `npx tsc --noEmit` — TypeScript typecheck. Clean exit = pass.
  2. `npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun` — bundler + bindings validation.
  3. `git diff` after each edit, to confirm the change matches the task and nothing leaked.
  4. Post-deploy smoke tests (final task, requires user to run `npm run deploy` from their own shell because the sandbox can't write to `~/Library/Preferences/.wrangler`).
- **Pre-session dirty state on `wrangler.toml`** that must survive this plan without being committed. The file shows `TOP_N = "12"`, `WORKER_URL = "https://standardrecs.site"`, plus the `[[routes]]` blocks. For the `wrangler.toml` edit in Task 4, use the stash-edit-commit-pop dance established in PR #21 Task 3.
- **Already on `feat/recs-variants`? No.** You should be on `fix/embed-scaling` (created from `main` earlier for the spec). Confirm with `git branch --show-current` before starting.
- **Project rule:** every change goes on a feature branch and ships via PR. You're already on the right branch. Don't touch `main`.
- **Commit message format:** conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, etc.) with the `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer on every commit.

### What you're about to change

**Files modified:** 5 total.

| File | What changes |
|---|---|
| `schema.sql` | `CREATE TABLE likes` gains `embedded_at TEXT`. `CREATE TABLE documents` gains `embedded_at TEXT`. Two new partial indexes (`idx_likes_unembedded`, `idx_documents_unembedded`). Historical ALTERs appended to the "Migration history" comment block at the bottom. |
| `src/recommend/embed.ts` | New `DEFAULT_EMBED_BATCH_LIMIT = 2000` constant. `embedAll` gains a 5th parameter `embedBatchLimit: number = 2000`. Two SELECTs get `AND embedded_at IS NULL` + parameterized `LIMIT ?`. **The `embedLikesIntoNamespace` helper is deleted** and its per-batch loop inlines into `embedAll` directly. Stamp UPDATE added inside both the new inline likes loop AND the existing documents loop. Log line extended with the effective limit. |
| `src/workflow.ts` | Both `embedAll` call sites (`runUserSync`, `runFullPipeline`) add `const embedBatchLimit = parseIntOrDefault(this.env.EMBED_BATCH_LIMIT, 2000)` inside their `step.do(...)` closures and pass it as the 5th positional arg to `embedAll`. |
| `src/env.ts` | New `EMBED_BATCH_LIMIT: string` binding in the Config vars section after `MMR_LAMBDA`. |
| `wrangler.toml` | New `EMBED_BATCH_LIMIT = "2000"` in the `[vars]` section (stash/pop dance required). |

**Files NOT touched:** `src/variants.ts`, `src/recommend/mmr.ts`, `src/recommend/index.ts`, `src/api/routes.ts`, `src/api/enroll-page.ts`, `src/api/recs-page.ts`, `src/api/recs-lookup-page.ts`, any sync module. If you catch yourself editing any of these, something's wrong — stop.

---

## Tasks

### Task 1: Update `schema.sql` with the final-state shape + migration history

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Read the current state of `schema.sql`**

```bash
cat schema.sql
```

Expected contents include: `CREATE TABLE IF NOT EXISTS likes (...)`, `CREATE TABLE IF NOT EXISTS documents (...)`, and a `-- Migration history` comment block at the bottom left over from PR #21. The `recommendations` table already has `variant` and `rank` columns inline in its CREATE TABLE from PR #21.

- [ ] **Step 2: Add `embedded_at TEXT` to `CREATE TABLE likes`**

Find the existing `CREATE TABLE IF NOT EXISTS likes` block. Add a new column AFTER `indexed_at` and BEFORE the `FOREIGN KEY` clause:

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
```

The column has no `DEFAULT` — nullable is the signal for "never embedded."

- [ ] **Step 3: Add the likes partial index**

After the existing `CREATE INDEX IF NOT EXISTS idx_likes_liked_at ...` line, add:

```sql
CREATE INDEX IF NOT EXISTS idx_likes_unembedded
  ON likes(liked_at DESC) WHERE embedded_at IS NULL;
```

Note: the index sort key is `liked_at DESC` to support the SELECT's `ORDER BY liked_at DESC`. The `WHERE embedded_at IS NULL` clause makes it a partial index — it shrinks to zero entries after the backlog drains.

- [ ] **Step 4: Add `embedded_at TEXT` to `CREATE TABLE documents`**

Find the existing `CREATE TABLE IF NOT EXISTS documents` block. Add `embedded_at TEXT` as a new column AFTER `indexed_at`:

```sql
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
```

- [ ] **Step 5: Add the documents partial index**

After the existing `CREATE INDEX IF NOT EXISTS idx_documents_published ...` line, add:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_unembedded
  ON documents(indexed_at) WHERE embedded_at IS NULL;
```

Note: the sort key is `indexed_at` (not `DESC`) because the documents SELECT has no explicit `ORDER BY` clause — the default stable iteration order is fine. The partial index clause is identical to the likes one.

- [ ] **Step 6: Append to the Migration history comment block**

Find the existing Migration history comment block at the bottom of `schema.sql` (the one from PR #21 with `variant` and `rank`). Append a new entry for this round:

```sql
--   2026-04-13 round 4 (embed scaling fix — Bug 1):
--     ALTER TABLE likes ADD COLUMN embedded_at TEXT;
--     ALTER TABLE documents ADD COLUMN embedded_at TEXT;
--     CREATE INDEX IF NOT EXISTS idx_likes_unembedded
--       ON likes(liked_at DESC) WHERE embedded_at IS NULL;
--     CREATE INDEX IF NOT EXISTS idx_documents_unembedded
--       ON documents(indexed_at) WHERE embedded_at IS NULL;
```

Insert this AFTER the existing "round 3" block (the `rank` column) and BEFORE the "If you're bootstrapping a new database" closing paragraph.

- [ ] **Step 7: Review the diff**

```bash
git diff schema.sql
```

Confirm:
- `CREATE TABLE likes` has `embedded_at TEXT` as a new line between `indexed_at` and `FOREIGN KEY`.
- `CREATE TABLE documents` has `embedded_at TEXT` as a new line after `indexed_at`.
- Two new `CREATE INDEX IF NOT EXISTS` partial-index statements, both with `WHERE embedded_at IS NULL`.
- The new migration history entry is between the round 3 `rank` entry and the closing paragraph.
- No changes to any other tables (users, publishers, publications, recommendations, oauth_state, oauth_sessions).

- [ ] **Step 8: Commit**

```bash
git add schema.sql
git commit -m "$(cat <<'EOF'
feat(schema): add embedded_at to likes + documents with partial indexes

Both tables gain a nullable `embedded_at TEXT` column as a first-class
field on their CREATE TABLE statements, plus partial indexes
(idx_likes_unembedded on liked_at DESC WHERE embedded_at IS NULL;
idx_documents_unembedded on indexed_at WHERE embedded_at IS NULL)
that support the filtered SELECTs in embed.ts without holding
entries for already-embedded rows.

Schema describes the final state directly; historical ALTERs go in
the commented migration history at the bottom of schema.sql,
following the PR #21 pattern.

The ad-hoc wrangler d1 execute --remote --command=... commands to
apply this to production are documented in the design spec's rollout
section and will run during the deploy step, not as part of this
commit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Delete `embedLikesIntoNamespace` and inline the batch loop into `embedAll`

This is the biggest task in the plan. The helper is deleted and its logic moves inline so a single batch iteration can handle all requested namespaces atomically with the stamp.

**Files:**
- Modify: `src/recommend/embed.ts`

- [ ] **Step 1: Read the current state of `embed.ts`**

```bash
cat src/recommend/embed.ts
```

Locate:
- `DEFAULT_EMBED_BATCH_LIMIT` constant — doesn't exist yet, will add.
- `EmbedResult` type (around line 40).
- `embedLikesIntoNamespace` helper (around line 46-90) — will be deleted.
- `embedAll` function (around line 93+) — will be restructured.
- The documents batch loop inside `embedAll` (towards the end) — will get a stamp UPDATE added.
- The `console.log` summary line at the end.

- [ ] **Step 2: Add the `DEFAULT_EMBED_BATCH_LIMIT` constant**

Near the top of `embed.ts`, next to the other module-level constants (after `BATCH_SIZE = 100;` or similar), add:

```typescript
const DEFAULT_EMBED_BATCH_LIMIT = 2000;
```

- [ ] **Step 3: Delete the `embedLikesIntoNamespace` helper**

Find the entire `async function embedLikesIntoNamespace(...)` block and **delete it**. From the `/**` docstring above it through the closing `}`. Roughly 45 lines.

This helper is being replaced by an inline loop in `embedAll` that can handle the both-mode stamp invariant correctly.

- [ ] **Step 4: Update `embedAll`'s signature**

Find:

```typescript
export async function embedAll(
  db: D1Database,
  vectors: VectorizeIndex,
  apiKey: string,
  embedMode: LikeEmbedMode = "query",
): Promise<EmbedResult> {
```

Add a 5th parameter `embedBatchLimit: number = DEFAULT_EMBED_BATCH_LIMIT`:

```typescript
export async function embedAll(
  db: D1Database,
  vectors: VectorizeIndex,
  apiKey: string,
  embedMode: LikeEmbedMode = "query",
  embedBatchLimit: number = DEFAULT_EMBED_BATCH_LIMIT,
): Promise<EmbedResult> {
```

- [ ] **Step 5: Update the likes SELECT**

Find the existing likes SELECT inside `embedAll`:

```typescript
const { results: unembeddedLikes } = await db
  .prepare(
    `SELECT uri, liked_post_text FROM likes
     WHERE liked_post_text IS NOT NULL AND liked_post_text != ''
     ORDER BY liked_at DESC
     LIMIT 500`,
  )
  .all<{ uri: string; liked_post_text: string }>();
```

Replace with the filtered + parameterized version:

```typescript
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

The two changes: the WHERE clause gains `AND embedded_at IS NULL`, and the hardcoded `LIMIT 500` becomes `LIMIT ?` with `.bind(embedBatchLimit)`.

- [ ] **Step 6: Replace the two-helper-call likes block with the inlined batch loop**

Find the existing block that calls `embedLikesIntoNamespace` twice (once for query namespace, once for doc namespace) and accumulates counts:

```typescript
let queryEmbedCount = 0;
let docEmbedCount = 0;

const wantQuery = embedMode === "query" || embedMode === "both";
const wantDoc = embedMode === "document" || embedMode === "both";

if (wantQuery) {
  const result = await embedLikesIntoNamespace(
    vectors,
    apiKey,
    unembeddedLikes,
    "query",
    LIKES_NAMESPACE_QUERY,
    "",
  );
  queryEmbedCount += result.embedded;
  errors += result.errors;
}

if (wantDoc) {
  const result = await embedLikesIntoNamespace(
    vectors,
    apiKey,
    unembeddedLikes,
    "document",
    LIKES_NAMESPACE_DOC,
    LIKES_DOC_ID_PREFIX,
  );
  docEmbedCount += result.embedded;
  errors += result.errors;
}
```

(Your exact source may differ slightly — the above reflects the PR #21 shape. Locate the real block by searching for `embedLikesIntoNamespace`.)

Replace the entire block with the new inlined loop:

```typescript
let queryEmbedCount = 0;
let docEmbedCount = 0;

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
      // batch. Stamp the rows now so they don't re-embed on the next
      // cron. Must be inside the same try as the upserts above — if
      // any upsert threw, we never reach the stamp and the catch
      // block leaves embedded_at NULL, preserving the invariant
      // "embedded_at IS NOT NULL iff in Vectorize."
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

**Key points:**

- `queryEmbedCount` and `docEmbedCount` are incremented *after each successful upsert*, before the stamp. If the stamp UPDATE fails (rare transient D1 issue), the catch block will increment `errors += batch.length` — the counts will be over-reported by one batch in that specific failure mode, which is the intentional design choice documented in the spec. Under-reporting on a successful upsert would be strictly worse for observability.
- The single try block covers the Voyage call, parity check, Vectorize upsert(s), AND the stamp. Any failure in any step skips the stamp → rows retry next cron.
- The `if (unembeddedLikes.length > 0 && (wantQuery || wantDoc))` guard short-circuits when there's nothing to do — no wasted work in `query-only` mode when the backlog is empty or in an impossible mode state.

- [ ] **Step 7: Update the documents SELECT**

Find the existing documents SELECT inside `embedAll`:

```typescript
const { results: docs } = await db
  .prepare(
    `SELECT uri, title, description, text_content FROM documents
     WHERE (text_content IS NOT NULL AND text_content != '')
        OR (description IS NOT NULL AND description != '')
     LIMIT 500`,
  )
  .all<{ uri: string; title: string; description: string | null; text_content: string | null }>();
```

Replace with:

```typescript
const { results: docs } = await db
  .prepare(
    `SELECT uri, title, description, text_content FROM documents
     WHERE ((text_content IS NOT NULL AND text_content != '')
         OR (description IS NOT NULL AND description != ''))
       AND embedded_at IS NULL
     LIMIT ?`,
  )
  .bind(embedBatchLimit)
  .all<{ uri: string; title: string; description: string | null; text_content: string | null }>();
```

Two changes:
1. The existing `(text_content ...) OR (description ...)` is wrapped in parens and `AND embedded_at IS NULL` is appended. The extra parens around the OR are critical — without them, SQL operator precedence would evaluate `OR` with one side being `AND embedded_at IS NULL`, which is a different predicate than intended.
2. Hardcoded `LIMIT 500` becomes `LIMIT ?` with `.bind(embedBatchLimit)`.

- [ ] **Step 8: Add the stamp UPDATE inside the documents batch loop**

Find the existing documents batch loop (the `for (const batch of batches)` block following the documents SELECT). Inside its `try`, after both `await vectors.upsert(vectorBatch);` AND `docCount += batch.length;` — the stamp must be the last statement in the try, so put it at the very end of the try block immediately before the closing `}`:

```typescript
// Stamp the just-embedded documents. Inside the try so upsert-
// success/stamp-skip can't happen; stamp-UPDATE-fails-after-upsert-
// succeeded is benign (idempotent re-embed next cron).
const placeholders = batch.map(() => "?").join(",");
await db
  .prepare(
    `UPDATE documents SET embedded_at = datetime('now') WHERE uri IN (${placeholders})`,
  )
  .bind(...batch.map((d) => d.uri))
  .run();
```

Unlike the likes loop, the documents loop already uses a per-batch try/catch — just add the stamp at the end of that existing try, after the upsert succeeds.

- [ ] **Step 9: Extend the summary log line**

Find the existing `console.log` at the end of `embedAll` — it looks something like:

```typescript
console.log(
  `Embedded ${likesProcessed} likes ` +
    `(query=${queryEmbedCount}, doc=${docEmbedCount}), ` +
    `${docCount} documents (${errors} errors)`,
);
```

Extend it to report the effective batch limit:

```typescript
console.log(
  `Embedded ${likesProcessed} likes ` +
    `(query=${queryEmbedCount}, doc=${docEmbedCount}), ` +
    `${docCount} documents (${errors} errors). ` +
    `Limit: ${embedBatchLimit}.`,
);
```

The limit in the log lets operators spot whether the cap was the binding constraint on a given cron (if `docCount === embedBatchLimit`, the limit was binding and backlog isn't yet drained; if `docCount < embedBatchLimit`, the pool is empty).

- [ ] **Step 10: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean exit, no errors.

**Common failures:**

- `Cannot find name 'VectorizeVector'` → the inlined loop references `VectorizeVector[]`. This type comes from `@cloudflare/workers-types` which is a global (already in tsconfig) — not an import. If you see this, check that you didn't accidentally delete something at the top of the file that declared the type namespace.
- `'LIKES_NAMESPACE_QUERY' is not defined` / `'LIKES_NAMESPACE_DOC' is not defined` / `'LIKES_DOC_ID_PREFIX' is not defined` → these are existing module-level constants from PR #21. If you see this, the delete of `embedLikesIntoNamespace` accidentally took the constants with it. Restore them at the top of the file.
- `'chunk' is not defined` / `'getEmbeddings' is not defined` / `'vectorIds' is not defined` / `'truncErr' is not defined` → these are existing helpers/imports in `embed.ts`. Check imports at the top of the file.

If any of these fire, STOP and report BLOCKED with the exact error message — don't try to patch the types without understanding what broke.

- [ ] **Step 11: Review the full diff**

```bash
git diff src/recommend/embed.ts
```

This diff is large (estimated ~80 lines changed). Read it end-to-end and confirm:

- `DEFAULT_EMBED_BATCH_LIMIT = 2000` added near other constants.
- `embedLikesIntoNamespace` function is entirely deleted.
- `embedAll` has the new `embedBatchLimit: number = DEFAULT_EMBED_BATCH_LIMIT` parameter.
- Likes SELECT has `AND embedded_at IS NULL` + parameterized `LIMIT ?`.
- The inlined likes batch loop is present, with a single try covering both namespaces + the stamp UPDATE.
- `queryEmbedCount` / `docEmbedCount` are incremented inside their respective `if` blocks, not at the bottom of the try.
- The stamp UPDATE for likes is the last statement inside the try (after both namespace checks).
- Documents SELECT has extra parens around the OR predicate + `AND embedded_at IS NULL` + parameterized `LIMIT ?`.
- Documents batch loop has a new stamp UPDATE inside its try.
- Log line includes `Limit: ${embedBatchLimit}.`.
- No changes to unrelated helpers (`getEmbeddings`, `chunk`, `truncErr`, `vectorIds`) or constants (`VOYAGE_API`, `VOYAGE_MODEL`, `EMBEDDING_DIMENSIONS`, `LIKES_NAMESPACE_QUERY`, `LIKES_NAMESPACE_DOC`, `LIKES_DOC_ID_PREFIX`, `parseEmbedMode`, `parseLikesNamespace`, `LikeEmbedMode`).

- [ ] **Step 12: Commit**

```bash
git add src/recommend/embed.ts
git commit -m "$(cat <<'EOF'
feat(embed): filter by embedded_at, stamp on success, delete helper

Three interlinked changes that together fix Bug 1 from the embed
scaling memory note:

1. Filter both SELECTs by `WHERE embedded_at IS NULL` so the cron
   only picks up rows that haven't been successfully embedded yet.
   Combined with the stamp UPDATE below, this turns embedAll into a
   monotonic-forward-progress loop instead of re-embedding the same
   hot 500 rows every run.

2. Delete the `embedLikesIntoNamespace` helper and inline its
   per-batch loop into `embedAll` directly. The helper's
   double-invocation pattern for LIKE_EMBED_MODE=both couldn't
   safely coordinate stamping across namespaces — the first call
   would stamp rows that the second call might then fail to embed.
   The inlined version has a single try block per batch that covers
   Voyage → parity check → Vectorize upsert(s) → stamp UPDATE across
   all requested namespaces, preserving "embedded_at IS NOT NULL iff
   in Vectorize" across all three LIKE_EMBED_MODE values.

3. New `DEFAULT_EMBED_BATCH_LIMIT = 2000` constant replaces the
   hardcoded `LIMIT 500`. `embedAll` gains a 5th parameter
   `embedBatchLimit` with the constant as default. Both SELECTs use
   parameterized `LIMIT ?` bound to that value. The documents
   SELECT's OR predicate is wrapped in parens to protect operator
   precedence once the new `AND embedded_at IS NULL` clause is
   appended.

Per-namespace counters (queryEmbedCount/docEmbedCount) are
intentionally incremented after each successful upsert, before the
stamp — if the stamp UPDATE fails (rare transient D1 issue), the
counts over-report by one batch, but the alternative (incrementing
after the stamp) would under-report successful embeds in the same
failure window, which is strictly worse for diagnosing backlog
drain progress.

The summary log line now includes `Limit: N` so operators can spot
at a glance whether the cap was binding on a given cron.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Thread `EMBED_BATCH_LIMIT` through `workflow.ts` call sites

**Files:**
- Modify: `src/workflow.ts`

- [ ] **Step 1: Locate the two `embedAll` call sites**

```bash
grep -n "embedAll(" src/workflow.ts
```

Expected: two matches, one in `runUserSync` (around line 87-95) and one in `runFullPipeline` (around line 157-165). Both calls are already passing `embedMode` as the 4th argument from PR #21.

- [ ] **Step 2: Update `runUserSync`'s embed step**

Find the block in `runUserSync` that calls `embedAll`:

```typescript
await step.do(`embed-for-user-${did}`, async () => {
  const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
  const result = await embedAll(
    this.env.DB,
    this.env.VECTORS,
    this.env.VOYAGE_API_KEY,
    embedMode,
  );
  return { likes: result.likes, documents: result.documents };
});
```

Add a new line to parse `EMBED_BATCH_LIMIT` using the existing `parseIntOrDefault` helper, and pass it as the 5th positional arg to `embedAll`:

```typescript
await step.do(`embed-for-user-${did}`, async () => {
  const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
  const embedBatchLimit = parseIntOrDefault(this.env.EMBED_BATCH_LIMIT, 2000);
  const result = await embedAll(
    this.env.DB,
    this.env.VECTORS,
    this.env.VOYAGE_API_KEY,
    embedMode,
    embedBatchLimit,
  );
  return { likes: result.likes, documents: result.documents };
});
```

`parseIntOrDefault` is already imported at the top of `workflow.ts` (used for `TOP_N`, `SYNC_BATCH_SIZE`, etc.). No new import needed.

- [ ] **Step 3: Update `runFullPipeline`'s embed step**

Same pattern. Find the embed block in `runFullPipeline`:

```typescript
const embedResult = await step.do("embed", async () => {
  const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
  const result = await embedAll(
    this.env.DB,
    this.env.VECTORS,
    this.env.VOYAGE_API_KEY,
    embedMode,
  );
  return { likes: result.likes, documents: result.documents, errors: result.errors };
});
```

Change to:

```typescript
const embedResult = await step.do("embed", async () => {
  const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
  const embedBatchLimit = parseIntOrDefault(this.env.EMBED_BATCH_LIMIT, 2000);
  const result = await embedAll(
    this.env.DB,
    this.env.VECTORS,
    this.env.VOYAGE_API_KEY,
    embedMode,
    embedBatchLimit,
  );
  return { likes: result.likes, documents: result.documents, errors: result.errors };
});
```

Note: the `const embedBatchLimit = ...` line goes **inside** the `step.do` closure, not outside. Workflow step closures must be self-contained for retry safety — each step re-parses its env vars fresh on every retry.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. If the call signature on `embedAll` doesn't match (e.g., "Expected 5 arguments, but got 5" would be fine; "Expected 4 arguments, but got 5" means embed.ts Task 2 didn't land correctly), go back and check the commit from Task 2.

- [ ] **Step 5: Review the diff**

```bash
git diff src/workflow.ts
```

Confirm:
- Two new `const embedBatchLimit = parseIntOrDefault(this.env.EMBED_BATCH_LIMIT, 2000);` lines, one per call site.
- Both `embedAll` calls now pass `embedBatchLimit` as the 5th positional argument.
- No other changes.
- The new lines are INSIDE their respective `step.do` closures.

- [ ] **Step 6: Commit**

```bash
git add src/workflow.ts
git commit -m "$(cat <<'EOF'
feat(workflow): pass EMBED_BATCH_LIMIT into both embed call sites

Both runUserSync and runFullPipeline now parse EMBED_BATCH_LIMIT
from env via the existing parseIntOrDefault helper (with 2000 as
fallback) and thread it through as the 5th positional argument to
embedAll. Both parses live inside their respective step.do
closures so Workflow retries re-read the env fresh.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add `EMBED_BATCH_LIMIT` env binding and wrangler var

Same stash-edit-commit-pop dance used in PR #21 Task 3 for preserving the pre-session dirty state on `wrangler.toml`.

**Files:**
- Modify: `src/env.ts`
- Modify: `wrangler.toml`

- [ ] **Step 1: Add the binding to `src/env.ts`**

Open `src/env.ts`. Find the `// Config vars` section. Add one line after the existing `MMR_LAMBDA`:

```typescript
  MMR_LAMBDA: string;              // "0.6" — nonstandardrecs MMR lambda knob
  EMBED_BATCH_LIMIT: string;       // "2000" — per-table rows-per-cron cap (likes + documents)
```

- [ ] **Step 2: Typecheck after env.ts edit**

```bash
npx tsc --noEmit
```

Expected: clean. (It should be — `EMBED_BATCH_LIMIT` is now a valid property on `Env` and the workflow call site from Task 3 can see it.)

- [ ] **Step 3: Stash the pre-session dirty `wrangler.toml` edits**

```bash
git stash push -m "pre-session wrangler.toml local config" -- wrangler.toml
```

Verify with `git status` that `wrangler.toml` no longer appears as modified. The working tree now shows the committed version (from the merged PR #21): `TOP_N = "10"`, the old workers.dev `WORKER_URL`, and the three `[[routes]]` blocks.

Don't panic that `TOP_N` looks "wrong" — that's the committed baseline. The user's local `TOP_N = "12"` override lives in the stash and will come back after Step 7.

- [ ] **Step 4: Add `EMBED_BATCH_LIMIT = "2000"` to `[vars]`**

Open `wrangler.toml` and find the `[vars]` section (around line 59-68). It currently ends with:

```toml
LIKE_EMBED_MODE = "query"
LIKE_QUERY_NAMESPACE = "likes"
MMR_LAMBDA = "0.6"
```

Add a new line at the end of `[vars]`:

```toml
EMBED_BATCH_LIMIT = "2000"
```

The section should now end with:

```toml
[vars]
SYNC_BATCH_SIZE = "50"
SYNC_DOCS_BATCH_SIZE = "50"
SYNC_DOCS_MAX_BATCHES = "300"
WINDOW_DAYS = "30"
TOP_N = "10"
WORKER_URL = "https://standard-recs.bryan-78d.workers.dev"
LIKE_EMBED_MODE = "query"
LIKE_QUERY_NAMESPACE = "likes"
MMR_LAMBDA = "0.6"
EMBED_BATCH_LIMIT = "2000"
```

- [ ] **Step 5: Dry-run deploy to validate bindings**

```bash
npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun-embed-scaling 2>&1 | tail -30
```

Expected output includes `env.EMBED_BATCH_LIMIT ("2000")` in the bindings table alongside the other config vars. No errors about route pattern validation or missing bindings.

**Ignore** the known wrangler warnings: `Vectorize Index bindings do not support local development` and `Scheduled Workers are not automatically triggered during local development`. Those appear on every dry-run.

**If the command errors on any permission-related issue** (e.g., can't write to `~/Library/Preferences/.wrangler`), that's the sandbox issue the user has hit before — note it in the report but continue; the dry-run still validates what it can before the permission error.

- [ ] **Step 6: Commit `src/env.ts` and `wrangler.toml`**

```bash
git add src/env.ts wrangler.toml
git commit -m "$(cat <<'EOF'
feat(config): add EMBED_BATCH_LIMIT env var (default 2000)

New config var controlling the per-table rows-per-cron cap in
embedAll. Replaces the previously-hardcoded LIMIT 500 with a
tunable knob that can be flipped via wrangler.toml + redeploy if
the default turns out to be wrong in production.

Default 2000 means: at current data volumes (~1 user, ~1k likes,
~13k documents), the first post-deploy cron drains the full likes
backlog in one pass and needs ~7 daily cron runs to backfill the
document corpus. If that catch-up cadence is too slow or too fast,
flip EMBED_BATCH_LIMIT via wrangler.toml and redeploy — no code
change required.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Pop the stash (expect a conflict)**

```bash
git stash pop
```

**Expect this to conflict** in `wrangler.toml`'s `[vars]` section. The stash was taken from a working tree where `TOP_N = "12"` and `WORKER_URL = "https://standardrecs.site"` (the user's local overrides), but your commit changed the same region by appending `EMBED_BATCH_LIMIT = "2000"` just below `MMR_LAMBDA`.

- [ ] **Step 8: Resolve the conflict**

Open `wrangler.toml` and find the `<<<<<<<` markers. Resolve by combining:

- Keep `TOP_N = "12"` and `WORKER_URL = "https://standardrecs.site"` from the **stash** side (the user's local edits).
- Keep `LIKE_EMBED_MODE = "query"`, `LIKE_QUERY_NAMESPACE = "likes"`, `MMR_LAMBDA = "0.6"`, and **`EMBED_BATCH_LIMIT = "2000"`** from the **committed** side.

The resolved `[vars]` section should read:

```toml
[vars]
SYNC_BATCH_SIZE = "50"
SYNC_DOCS_BATCH_SIZE = "50"
SYNC_DOCS_MAX_BATCHES = "300"
WINDOW_DAYS = "30"
TOP_N = "12"
WORKER_URL = "https://standardrecs.site"
LIKE_EMBED_MODE = "query"
LIKE_QUERY_NAMESPACE = "likes"
MMR_LAMBDA = "0.6"
EMBED_BATCH_LIMIT = "2000"
```

Confirm no conflict markers remain:

```bash
grep -c '^<<<<<<\|^======\|^>>>>>>' wrangler.toml
```

Expected: `0`.

- [ ] **Step 9: Unstage the resolution so `wrangler.toml` returns to dirty state**

```bash
git add wrangler.toml
git restore --staged wrangler.toml
git stash drop
```

This sequence:
1. Marks the conflict resolved (`git add`).
2. Immediately unstages without losing the file content (`git restore --staged`).
3. Drops the now-applied stash.

`git status` should show `modified: wrangler.toml` (unstaged). The only diff against the committed version should be `TOP_N` and `WORKER_URL` — same as the pre-session dirty state at the start of this task. `git diff wrangler.toml` should show a 4-line diff (2 removed, 2 added) with no conflict markers.

---

### Task 5: Final typecheck + dry-run + branch review

Pre-deploy verification task. No file changes — only checks.

- [ ] **Step 1: Final typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Dry-run deploy**

```bash
npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun-final 2>&1 | tail -40
```

Expected: clean bundle, bindings table shows all env vars including `env.EMBED_BATCH_LIMIT ("2000")`, no route validation errors, no TypeScript errors.

- [ ] **Step 3: Verify the full branch diff**

```bash
git log --oneline main..HEAD
```

Expected: 7 commits on the branch — 3 spec commits (draft + 2 review rounds) + 4 implementation commits from Tasks 1-4:

```
<hash> feat(config): add EMBED_BATCH_LIMIT env var (default 2000)
<hash> feat(workflow): pass EMBED_BATCH_LIMIT into both embed call sites
<hash> feat(embed): filter by embedded_at, stamp on success, delete helper
<hash> feat(schema): add embedded_at to likes + documents with partial indexes
<hash> docs(spec): address spec review round 2 (stale refs from round 1 rewrite)
<hash> docs(spec): address spec review round 1
<hash> docs(spec): embed scaling fix (bug 1) design
```

- [ ] **Step 4: Verify the files changed**

```bash
git diff main..HEAD --stat
```

Expected files:
- `docs/superpowers/specs/2026-04-13-embed-scaling-fix-design.md` (new)
- `docs/superpowers/plans/2026-04-13-embed-scaling-fix.md` (new, this file)
- `schema.sql` (small change — 2 columns + 2 partial indexes + migration history)
- `src/recommend/embed.ts` (biggest change — helper deleted, loop inlined, SELECTs + stamps updated)
- `src/workflow.ts` (small — 2 lines per call site)
- `src/env.ts` (1 line added)
- `wrangler.toml` (1 line added)

No other files should be in the diff. If anything else shows up, STOP and investigate before continuing.

- [ ] **Step 5: Confirm pre-session dirty state is intact**

```bash
git status --short
```

Expected: exactly `M wrangler.toml` plus the pre-existing untracked files (`.claude/`, `docs/stitch/`, old plan docs). Nothing else modified, nothing else staged.

```bash
git diff wrangler.toml
```

Expected: the 4-line diff showing `TOP_N = "10" → "12"` and `WORKER_URL = "https://standard-recs.bryan-78d.workers.dev" → "https://standardrecs.site"`. Nothing else. If you see `EMBED_BATCH_LIMIT` in this diff, it means the stash pop resolution in Task 4 Step 8 didn't finish properly — go back and fix.

---

### Task 6: Push branch and open PR

**Files:** none (git operations)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin fix/embed-scaling
```

Expected: push succeeds, shows a GitHub URL for opening the PR.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "fix: embed scaling — filter embedded_at, stamp on success" --body "$(cat <<'EOF'
## Summary

Fixes Bug 1 from `memory/project_embed_scaling.md`: the cron's embed step caps at 500 rows per table per run with no filter for already-embedded rows, so older likes and documents never get embedded and are invisible to recommendations.

## The fix

- New `embedded_at TEXT` column on both `likes` and `documents` (nullable, no default). Both SELECTs filter `WHERE embedded_at IS NULL`.
- Successful Vectorize upserts stamp the row via a batched `UPDATE ... SET embedded_at = datetime('now') WHERE uri IN (?, ?, ...)` inside the same try as the upsert, so stamp-without-embed is structurally impossible.
- The `embedLikesIntoNamespace` helper is deleted and its per-batch loop is inlined into `embedAll` directly. This was required because `LIKE_EMBED_MODE=both` calls the helper twice with the same rows; stamping inside the helper on the first call would leave rows stamped but absent from the second namespace if the second call failed. Inlining lets a single try block cover all requested namespaces and the stamp atomically.
- New env var `EMBED_BATCH_LIMIT = "2000"` replaces the hardcoded `LIMIT 500`. Tunable via `wrangler.toml` + redeploy if the default turns out wrong.
- Two new partial indexes (`idx_likes_unembedded`, `idx_documents_unembedded`, both `WHERE embedded_at IS NULL`) support the filtered SELECTs without holding entries for already-embedded rows — they shrink to zero in steady state.

## What's new

| File | Change |
|---|---|
| `schema.sql` | `embedded_at` columns + partial indexes in CREATE TABLE; historical ALTERs in migration history comment |
| `src/recommend/embed.ts` | Helper deleted, loop inlined, SELECTs filter by `embedded_at IS NULL`, new stamp UPDATEs |
| `src/workflow.ts` | `EMBED_BATCH_LIMIT` parsed and passed to both `embedAll` call sites |
| `src/env.ts` | New `EMBED_BATCH_LIMIT: string` binding |
| `wrangler.toml` | New `EMBED_BATCH_LIMIT = "2000"` |

## Test plan (post-merge)

- [ ] Merge this PR to `main`
- [ ] Apply schema migrations to remote D1 via ad-hoc commands (see spec rollout section):
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
- [ ] `npm run deploy`
- [ ] `curl -X POST https://standardrecs.site/admin/sync`
- [ ] Watch `wrangler tail standard-recs` for embed step log: expect `Embedded 934 likes (query=934, doc=0), 2000 documents (0 errors). Limit: 2000.` on the first run
- [ ] Spot-check D1 counts:
  ```bash
  npx wrangler d1 execute standard-recs-db --remote \
    --command="SELECT COUNT(*) AS total, COUNT(embedded_at) AS embedded FROM likes"
  npx wrangler d1 execute standard-recs-db --remote \
    --command="SELECT COUNT(*) AS total, COUNT(embedded_at) AS embedded FROM documents"
  ```
  Expected on first cron: likes `total=934, embedded=934`; documents `total≈13334, embedded=2000`.
- [ ] Let subsequent daily crons chip away at the document backlog; ~7 daily runs to fully backfill.
- [ ] After backlog drain, spot-check that `embedded_at IS NULL` counts stay near-zero in steady state (only new rows from recent sync runs).

## Rollback

Revert the PR. The `embedded_at` columns stay on the tables harmlessly after revert. To force re-embed everything, run:
```bash
npx wrangler d1 execute standard-recs-db --remote \
  --command="UPDATE likes SET embedded_at = NULL"
npx wrangler d1 execute standard-recs-db --remote \
  --command="UPDATE documents SET embedded_at = NULL"
```

## Caveats

- **First post-deploy cron re-embeds the currently-embedded-but-unstamped hot rows.** Existing rows get `NULL` for `embedded_at` via the new column, so the first cron sees them as unembedded and calls Voyage again. Vectorize upsert is idempotent (same vectors, same IDs, overwrite in place) so there's zero functional impact — just a one-time duplicate Voyage cost of ~600K tokens (well under the 200M free-tier budget).
- **The 500-row cap on document sync publishers (Bug 2) is still unfixed.** That's a separate PR coming next. This PR fixes Bug 1 only.

## Spec

[`docs/superpowers/specs/2026-04-13-embed-scaling-fix-design.md`](docs/superpowers/specs/2026-04-13-embed-scaling-fix-design.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: PR URL returned. Share with Bryan.

- [ ] **Step 3: Report the PR URL**

After the PR is open, return its URL in the final report.

---

### Task 7: Post-merge deploy + smoke test (user-gated)

**This task requires user involvement.** It can't run inside the sandbox because `wrangler` needs to write to `~/Library/Preferences/.wrangler/` which the macOS Seatbelt sandbox blocks. The user runs `npm run deploy` from their own shell; I can run post-deploy verification commands.

**Files:** none (deploy + verify)

- [ ] **Step 1: Wait for PR review + merge**

Pause and wait for the user (and CodeRabbit) to review the PR. Address any review findings that come in — this is the "spec review" loop but for the PR.

- [ ] **Step 2: Apply schema migrations to remote D1**

Once the PR is merged, apply the migrations from the user's shell (they need to run these; the sandbox blocks wrangler's log file write):

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

Each command should succeed with `success: true` and a small meta block. If the ALTER commands error with `duplicate column name`, the migration has already been applied — move on.

- [ ] **Step 3: Deploy**

From the user's shell:

```bash
npm run deploy
```

Expected: standard wrangler deploy output, bindings table shows all env vars including `env.EMBED_BATCH_LIMIT ("2000")`, `Uploaded` and `Deployed` confirmations, custom domain routes attached.

- [ ] **Step 4: Trigger a fresh sync**

```bash
curl -X POST https://standardrecs.site/admin/sync
```

Expected: `{"triggered":true,"instanceId":"full-...","note":"Full pipeline Workflow started."}` — HTTP 200.

- [ ] **Step 5: Wait for the sync to finish**

Several minutes. Watch the worker via `npx wrangler tail standard-recs` (from user's shell — sandbox again). Look for:

- `Embedded 934 likes (query=934, doc=0), 2000 documents (0 errors). Limit: 2000.` (or similar — counts may vary slightly if new rows synced during the run)
- `Recommendations: N total` indicating the recommend step completed

**If the embed step log shows nonzero errors**, investigate via wrangler tail before declaring success. Transient failures are OK (expected on Voyage blips); chronic failures indicate a real problem.

- [ ] **Step 6: Verify embed counts via D1**

```bash
npx wrangler d1 execute standard-recs-db --remote \
  --command="SELECT COUNT(*) AS total, COUNT(embedded_at) AS embedded FROM likes"
npx wrangler d1 execute standard-recs-db --remote \
  --command="SELECT COUNT(*) AS total, COUNT(embedded_at) AS embedded FROM documents"
```

Expected after first post-fix cron:
- `likes`: `total=934, embedded=934` (or close — if new likes synced during the run, total and embedded should both be the same number just bumped higher)
- `documents`: `total≈13334, embedded=2000` (or close — the 2000 is the binding limit; total may bump by a few new docs that snuck in)

**The critical assertion:** `embedded` should equal `total` for likes (full backlog drained in one pass) and should be exactly the `EMBED_BATCH_LIMIT` value (2000) for documents, modulo small deltas from concurrent syncs.

- [ ] **Step 7: Spot-check the recs still work**

```bash
curl -X POST "https://standardrecs.site/admin/compare-recs?did=did:plc:h3wpawnrlptr4534chevddo6&variants=standard,nonstandard" 2>&1 | python3 -m json.tool | head -50
```

Expected: the compare-recs endpoint returns both variants with enriched rec lists. The rec content may differ slightly from what it showed pre-fix because the taste vector is now built from all 934 embedded likes instead of the top 500, but both variants should still populate.

**If either variant comes back empty**, something broke during the refactor — investigate immediately. Most likely cause: the inlined batch loop dropped a required step (e.g., missing `vectorIds` call, wrong namespace string, wrong metadata shape) and Vectorize doesn't have the new embeddings.

- [ ] **Step 8: Check subsequent cron runs over the next 7 days**

The backlog drain pattern: the first cron empties the likes backlog (934 rows) and takes 2000 docs out of the 13334. Each subsequent daily cron takes another ~2000 docs. After ~7 cron runs, `documents.embedded = documents.total` and the log line should show counts well below the limit (only new rows synced since the previous cron).

Watch for:

- **Monotonic progress.** `embedded` count should increase or stay flat on every cron, never decrease.
- **Limit binding.** While the backlog drains, `docCount` in the log line equals `EMBED_BATCH_LIMIT` (2000). Once drained, it drops to ~tens per cron.
- **Near-zero errors.** Any chronic failures need investigation.

---

## Plan summary

- **7 tasks**, one of them (Task 7) user-gated for deploy + smoke.
- **5 files modified**, roughly ~150 lines of net code change (most of it in the inlined batch loop in `embed.ts`).
- **2 new columns + 2 new partial indexes** in schema.sql.
- **1 new env var** (`EMBED_BATCH_LIMIT`).
- **The biggest mechanical risk** is Task 2 (deleting `embedLikesIntoNamespace` and inlining the loop). Everything else is a couple of lines each.
- **The biggest operational risk** is the first post-deploy cron doing a large one-time re-embed of all currently-embedded rows. Cost is bounded (~600K tokens) but cron wall-clock will be significantly longer than usual (expect 2-3 minutes vs ~30 seconds for the embed step).

---

## Known limitations / deferred

- **Bug 2 (document sync re-fetches all publishers).** Next PR after this one merges. Separate spec.
- **Retry counter for pathological rows.** Deferred — no such rows observed in practice.
- **Per-table batch limits.** `EMBED_BATCH_LIMIT` applies to both tables equally. If one table dominates cron wall-clock, can split into `EMBED_LIKES_LIMIT` + `EMBED_DOCS_LIMIT`. YAGNI until profiling shows it matters.
- **A real migrations system.** The CREATE-TABLE-as-final-state + commented history pattern is the agreed-upon non-choice for this project's single-DB, low-cadence schema changes. If it ever becomes insufficient, a real migrations directory with timestamped files + tracking table is the upgrade path.

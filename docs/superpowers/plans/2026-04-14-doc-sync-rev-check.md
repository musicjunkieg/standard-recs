# Doc Sync Rev Check + Jetstream Update/Delete — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cron-side doc sync skip publishers whose repositories haven't changed since last run (via `com.atproto.sync.getLatestCommit`), and extend the Jetstream Durable Object to handle `update` and `delete` operations for `site.standard.document` (not just `create`). Bundle both in one PR because they complement each other.

**Architecture:** One nullable column (`publishers.last_synced_rev`), one new PDS primitive (`getLatestCommitRev`), three sites of change in the document sync path (rev check, claim query extension, second UPDATE for rev stamping), one log-line extension, and one batch of Jetstream DO changes (operation routing, delete path, three new counters). No new env vars, no new secrets, no new dependencies.

**Tech Stack:** Cloudflare Workers, Hono, D1, Vectorize, Cloudflare Workflows, Durable Objects, TypeScript, `@atproto/api` (only for type references — the new PDS call uses raw `friendlyFetch`, matching the existing `listRecordsFromPds` pattern).

**Spec:** `docs/superpowers/specs/2026-04-14-doc-sync-rev-check-design.md` (same branch)

**Branch:** `fix/doc-sync-rev-check` (already created off `main` — the spec + spec-review-round-1 commits are already on it)

**Pre-session state notes for the implementer:**
- `wrangler.toml` has unstaged local edits (`TOP_N = "12"`, `WORKER_URL = "https://standardrecs.site"`) that must **not** be committed. They are long-lived dev-box overrides. This plan does **not** touch `wrangler.toml`, so the dirty state should pass through untouched. If you find yourself needing to commit `wrangler.toml` for any reason, stop and ask the controller.
- Other untracked paths (`.claude/`, `docs/stitch/`, two plan files under `docs/superpowers/plans/` from earlier sessions) are not part of this PR and must not be staged.
- No test runner is configured in this repo per `CLAUDE.md`. Validation is exclusively `npx tsc --noEmit` and `npx wrangler deploy --dry-run`. Do not invent tests.

**Critical non-goal — do not "helpfully fix":**

While working in `src/sync/documents.ts`, you will see that `markBridgedPublisher` at line 161 calls `vectors.deleteByIds(ids)` where `ids = docs.map((d) => d.uri)` — raw AT URIs. But documents are stored in Vectorize under SHA-256-hashed IDs per `src/recommend/vector-id.ts:26`, so those delete calls are effectively no-ops and bridged publishers leave orphan vectors behind. **This is a pre-existing bug. It is NOT in scope for this PR.** The spec calls this out explicitly in its Non-goals section. Do not fix it here. Do not comment on it in commit messages. The new `deleteDocument` path on the Jetstream DO in this PR correctly uses `vectorIds([uri])`, which is internally consistent for *this* change. If you touch `markBridgedPublisher`, stop and escalate to the controller.

---

## Chunk 1: Schema and PDS primitive

### Task 1: Add `last_synced_rev` to `publishers` in `schema.sql`

**Why:** This is the type-level and migration-history anchor for the new column. All subsequent tasks reference the column; having it land first in a single atomic commit means every subsequent commit can reference it without ambiguity. The column is nullable with no default, so old code that SELECTs `publishers.*` is unaffected.

**Files:**
- Modify: `schema.sql`

**Steps:**

- [ ] **Step 1: Read `schema.sql` to confirm the current `CREATE TABLE publishers` shape**

  You should see a block at roughly lines 68–74:
  ```sql
  CREATE TABLE IF NOT EXISTS publishers (
    did TEXT PRIMARY KEY,
    label TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_synced_at TEXT,
    pds_url TEXT
  );
  ```

- [ ] **Step 2: Add `last_synced_rev TEXT` to the publishers table**

  Insert a new column AFTER `pds_url TEXT`, with a trailing comma on `pds_url` to make room. Final shape:
  ```sql
  CREATE TABLE IF NOT EXISTS publishers (
    did TEXT PRIMARY KEY,
    label TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_synced_at TEXT,
    pds_url TEXT,
    last_synced_rev TEXT
  );
  ```

  Do **not** reorder existing columns. Do **not** add a comment on the new line. Do **not** add an index — the column is only read when the row is already in hand via the existing claim query.

- [ ] **Step 3: Append a new entry to the Migration history comment block**

  Find the Migration history block at the bottom of `schema.sql` (starts around line 100 with `-- Migration history`). The most recent entry is for the 2026-04-13 embed scaling fix. Append a new entry after it:
  ```sql
  --
  --   2026-04-14 (doc sync rev check — Bug 2):
  --     ALTER TABLE publishers ADD COLUMN last_synced_rev TEXT;
  ```

  Use the same indentation and formatting as the surrounding entries. Leave the existing trailing explanatory paragraph about `ALTER TABLE ADD COLUMN` being idempotent-unsafe intact — it still applies.

- [ ] **Step 4: Verify no other tables reference the new column**

  Run: `grep -n "last_synced_rev" schema.sql`

  Expected: exactly two matches, both in the `publishers` table block you just edited (one in the `CREATE TABLE` at the top of the file, one in the Migration history comment). Zero matches elsewhere.

- [ ] **Step 5: Commit**

  ```bash
  git add schema.sql
  git commit -m "$(cat <<'EOF'
  feat(schema): add last_synced_rev to publishers for rev-based skip

  Nullable, no default, no index. Column is only read when the
  publishers row is already in hand via syncDocumentsBatch's claim
  query, so an index would be dead weight.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 6: Verify commit scope**

  Run: `git show HEAD --stat`
  Expected: `schema.sql | 4 +`-ish (the new column line, two new comment lines, and one comma bump on the previous column line — the exact diffstat will vary slightly by how the commas shake out, but it's strictly additive).

  Run: `git status --short`
  Expected: only the pre-session dirty state (`M wrangler.toml`, four `??` untracked paths). No other `M` files.

---

### Task 2: Add `getLatestCommitRev` primitive to `src/sync/pds-fetch.ts`

**Why:** This is the new PDS call. Lives in `pds-fetch.ts` next to `listRecordsFromPds` because both are low-level PDS primitives and putting them together keeps `documents.ts` from needing to know about raw HTTP. Matches the existing pattern: returns `null` on non-2xx, lets network/JSON errors propagate for the caller to try/catch.

**Files:**
- Modify: `src/sync/pds-fetch.ts`

**Steps:**

- [ ] **Step 1: Read `src/sync/pds-fetch.ts` to confirm the current shape**

  The file currently exports one function, `listRecordsFromPds`. It imports `friendlyFetch` from `./fetch-helper.js`. This task adds a second export using the same helper.

- [ ] **Step 2: Add the new `getLatestCommitRev` function after `listRecordsFromPds`**

  Append this to the end of the file (after the closing brace of `listRecordsFromPds`):

  ```ts
  /**
   * Query a PDS for the current repo revision via
   * com.atproto.sync.getLatestCommit.
   *
   * Returns just the `rev` (a TID), which is the repo's logical clock.
   * This is the high-order bit for incremental sync: if the stored `rev`
   * matches the returned one, nothing in the repository has changed
   * since we last looked, and the caller can skip a full listRecords
   * walk. `rev` is repo-wide (bumps on any commit to any collection),
   * so chatty-Bluesky publishers will still show as "changed" even when
   * they haven't touched our collection — that's an accepted tradeoff;
   * the rev check is cheap and the degraded case is still no worse
   * than the current full-sync-every-cron behavior.
   *
   * @param pds - Base URL of the PDS (e.g., `https://pds.example.com`)
   * @param did - Repository DID to query
   * @returns The `rev` string on success, or `null` when the HTTP
   *          response is not OK or the body is malformed. Network
   *          or JSON parsing errors propagate to the caller.
   */
  export async function getLatestCommitRev(
    pds: string,
    did: string,
  ): Promise<string | null> {
    const url = new URL(`${pds}/xrpc/com.atproto.sync.getLatestCommit`);
    url.searchParams.set("did", did);

    const res = await friendlyFetch(url.toString());
    if (!res.ok) return null;

    const body = (await res.json()) as { cid?: string; rev?: string };
    return typeof body.rev === "string" ? body.rev : null;
  }
  ```

  The JSDoc comment is load-bearing: it explains the repo-wide-rev tradeoff inline at the call site so a future reader doesn't have to trace back to the spec. Keep it.

- [ ] **Step 3: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean. The new function has no call sites yet (Task 3 adds them), so this is strictly additive.

- [ ] **Step 4: Verify no unintended changes**

  Run: `git diff src/sync/pds-fetch.ts`
  Expected: only a diff adding the new function. No modifications to `listRecordsFromPds` or the existing imports.

- [ ] **Step 5: Commit**

  ```bash
  git add src/sync/pds-fetch.ts
  git commit -m "$(cat <<'EOF'
  feat(sync): add getLatestCommitRev primitive for incremental sync

  Returns just the repo's current rev (TID) via
  com.atproto.sync.getLatestCommit, which is the fingerprint we
  need to decide whether listRecords can be skipped.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 6: Verify scope**

  Run: `git show HEAD --stat`
  Expected: `src/sync/pds-fetch.ts | N +` where N is the added-lines count (roughly 30 with the JSDoc).

---

## Chunk 2: Wire the rev check through the doc sync path

### Task 3: Extend `syncDocumentsFromRepo` and `syncDocumentsBatch` in `src/sync/documents.ts`

**Why:** This is the single atomic change that wires the rev check into the cron path end-to-end. Splitting it would leave the tree in a state where `syncDocumentsFromRepo` takes a parameter its only caller doesn't pass — a compile error. Keep it atomic.

**Files:**
- Modify: `src/sync/documents.ts`

**Critical reminder:** do NOT touch `markBridgedPublisher`. It's a pre-existing bug, scoped out of this PR, and the controller will reject any commit that changes it. See the "Critical non-goal" section at the top of this plan.

**Steps:**

- [ ] **Step 1: Add `getLatestCommitRev` to the top-of-file imports**

  Find the import from `./pds-fetch.js`. It currently reads:
  ```ts
  import { listRecordsFromPds } from "./pds-fetch.js";
  ```

  Change it to:
  ```ts
  import { listRecordsFromPds, getLatestCommitRev } from "./pds-fetch.js";
  ```

- [ ] **Step 2: Extend `DocSyncResult` with a `skipped` field**

  Find the `DocSyncResult` type (around line 18). It currently reads:
  ```ts
  export type DocSyncResult = {
    discovered: number;
    fetched: number;
    stored: number;
    errors: number;
  };
  ```

  Add a `skipped` field after `errors`:
  ```ts
  export type DocSyncResult = {
    discovered: number;
    fetched: number;
    stored: number;
    errors: number;
    skipped: number;
  };
  ```

  Note: this type is the public surface for external callers. A `grep -n "DocSyncResult" src/` should reveal whether anything other than `documents.ts` imports it. If so, those call sites need to be updated too. If only `documents.ts` uses it internally (likely), no follow-up is needed.

- [ ] **Step 3: Extend the inline return type on `syncDocumentsBatch` to add `skipped`**

  Find `syncDocumentsBatch`'s return type (around line 41):
  ```ts
  ): Promise<{
    processed: number;
    fetched: number;
    stored: number;
    errors: number;
    bridged: number;
  }> {
  ```

  Add `skipped: number` after `bridged`:
  ```ts
  ): Promise<{
    processed: number;
    fetched: number;
    stored: number;
    errors: number;
    bridged: number;
    skipped: number;
  }> {
  ```

- [ ] **Step 4: Add a `skipped` counter variable at the top of the function**

  At the top of `syncDocumentsBatch`'s body, you'll see:
  ```ts
  let processed = 0;
  let fetched = 0;
  let stored = 0;
  let errors = 0;
  let bridged = 0;
  ```

  Add:
  ```ts
  let processed = 0;
  let fetched = 0;
  let stored = 0;
  let errors = 0;
  let bridged = 0;
  let skipped = 0;
  ```

- [ ] **Step 5: Extend the claim query to select `last_synced_rev`**

  Find the SELECT inside `syncDocumentsBatch` (around line 79):
  ```ts
  const candidate = await db
    .prepare(
      `SELECT did, label FROM publishers
        WHERE (last_synced_at IS NULL
               OR last_synced_at < datetime('now', '-23 hours'))
          AND COALESCE(label, '') != 'bridged'
        ORDER BY last_synced_at ASC NULLS FIRST
        LIMIT 1`,
    )
    .first<{ did: string; label: string | null }>();
  ```

  Change the SELECT clause to also include `last_synced_rev`, and extend the `.first<>` type to match:
  ```ts
  const candidate = await db
    .prepare(
      `SELECT did, label, last_synced_rev FROM publishers
        WHERE (last_synced_at IS NULL
               OR last_synced_at < datetime('now', '-23 hours'))
          AND COALESCE(label, '') != 'bridged'
        ORDER BY last_synced_at ASC NULLS FIRST
        LIMIT 1`,
    )
    .first<{ did: string; label: string | null; last_synced_rev: string | null }>();
  ```

  Do NOT modify the WHERE clause, ORDER BY, or LIMIT — those are load-bearing parts of the claim pattern.

- [ ] **Step 6: Update the call to `syncDocumentsFromRepo` and handle the new return fields**

  Find the try/catch block that invokes `syncDocumentsFromRepo` (around line 111):
  ```ts
  try {
    const result = await syncDocumentsFromRepo(db, vectors, claimed.did);
    fetched += result.fetched;
    stored += result.stored;
    errors += result.errors;
    if (result.bridged) bridged++;
    if (result.stored > 0) {
      console.log(`    ${claimed.label ?? claimed.did}: ${result.stored} docs`);
    }
  } catch (err) {
    errors++;
    console.error(`    Failed: ${claimed.did}`, err);
  }
  ```

  Replace it with:
  ```ts
  try {
    const result = await syncDocumentsFromRepo(
      db,
      vectors,
      claimed.did,
      claimed.last_synced_rev,
    );
    fetched += result.fetched;
    stored += result.stored;
    errors += result.errors;
    if (result.bridged) bridged++;
    if (result.skipped) skipped++;
    if (result.newRev !== null) {
      // Stamp the rev AFTER successful processing. If sync crashes
      // mid-publisher, last_synced_rev stays at the old value and
      // the next attempt will treat it as a mismatch → full resync.
      // Ordering relative to the last_synced_at stamp (which happens
      // pre-processing for CAS race protection) is intentional: see
      // the spec's "Control flow inside syncDocumentsBatch" section.
      await db
        .prepare(`UPDATE publishers SET last_synced_rev = ? WHERE did = ?`)
        .bind(result.newRev, claimed.did)
        .run();
    }
    if (result.stored > 0) {
      console.log(`    ${claimed.label ?? claimed.did}: ${result.stored} docs`);
    }
  } catch (err) {
    errors++;
    console.error(`    Failed: ${claimed.did}`, err);
  }
  ```

  The inline comment about the ordering invariant is load-bearing: it explains WHY the second UPDATE is here instead of combined into the pre-processing CAS, which a future reader would otherwise try to "simplify."

- [ ] **Step 7: Update the return statements at the end of `syncDocumentsBatch`**

  Find the two return statements at the end of the function (around lines 126–130):
  ```ts
  if (processed === 0) {
    return { processed: 0, fetched: 0, stored: 0, errors: 0, bridged: 0 };
  }

  return { processed, fetched, stored, errors, bridged };
  ```

  Extend both to include `skipped`:
  ```ts
  if (processed === 0) {
    return { processed: 0, fetched: 0, stored: 0, errors: 0, bridged: 0, skipped: 0 };
  }

  return { processed, fetched, stored, errors, bridged, skipped };
  ```

- [ ] **Step 8: Update `syncDocumentsFromRepo`'s signature and return shape**

  Find the function declaration (around line 210):
  ```ts
  export async function syncDocumentsFromRepo(
    db: D1Database,
    vectors: VectorizeIndex,
    did: string,
  ): Promise<{ fetched: number; stored: number; errors: number; bridged: boolean }> {
  ```

  Change to:
  ```ts
  export async function syncDocumentsFromRepo(
    db: D1Database,
    vectors: VectorizeIndex,
    did: string,
    lastSyncedRev: string | null,
  ): Promise<{
    fetched: number;
    stored: number;
    errors: number;
    bridged: boolean;
    newRev: string | null;
    skipped: boolean;
  }> {
  ```

- [ ] **Step 9: Add the rev probe + comparison after the bridged check, before publication sync**

  Inside `syncDocumentsFromRepo`, find the block after the bridged-PDS handling (around line 231, after the `if (isBridgedPds(pds))` branch returns) and BEFORE the publication sync try block (around line 235, `try { const pubBody = await listRecordsFromPds<StandardPublication>(…)`).

  Insert this block between them:
  ```ts
  // Rev probe: cheap check for whether anything in the repo has
  // changed since last cron. Match → skip the full listRecords
  // walk. Mismatch or probe failure → fall through to the current
  // sync path. `rev` is repo-wide so a chatty Bluesky publisher
  // bumps it on every unrelated commit — the degraded case is
  // strictly no worse than today (one cheap HTTP call overhead).
  // See docs/superpowers/specs/2026-04-14-doc-sync-rev-check-design.md
  // for the full tradeoff analysis.
  let currentRev: string | null = null;
  try {
    currentRev = await getLatestCommitRev(pds, did);
  } catch (err) {
    console.warn(`  getLatestCommitRev threw for ${did}:`, err);
    currentRev = null;
  }

  if (
    currentRev !== null &&
    lastSyncedRev !== null &&
    currentRev === lastSyncedRev
  ) {
    // Repo unchanged — skip the full walk. Returning newRev =
    // currentRev causes the caller to re-stamp the same value,
    // which is a no-op write but keeps last_synced_rev consistent
    // with the latest confirmed observation.
    return {
      fetched: 0,
      stored: 0,
      errors: 0,
      bridged: false,
      newRev: currentRev,
      skipped: true,
    };
  }
  ```

  The comment is load-bearing and references the spec explicitly so a reader investigating "why is this code here?" can find the full rationale without having to run `git blame`.

- [ ] **Step 10: Update the bridged-publisher early return to include `newRev: null, skipped: false`**

  Find the bridged-PDS branch (around line 225):
  ```ts
  if (isBridgedPds(pds)) {
    const marked = await markBridgedPublisher(db, vectors, did);
    if (!marked) {
      return { fetched: 0, stored: 0, errors: 1, bridged: false };
    }
    return { fetched: 0, stored: 0, errors: 0, bridged: true };
  }
  ```

  Update BOTH return statements to include the new fields:
  ```ts
  if (isBridgedPds(pds)) {
    const marked = await markBridgedPublisher(db, vectors, did);
    if (!marked) {
      return { fetched: 0, stored: 0, errors: 1, bridged: false, newRev: null, skipped: false };
    }
    return { fetched: 0, stored: 0, errors: 0, bridged: true, newRev: null, skipped: false };
  }
  ```

  Rationale: bridged publishers are permanently skipped, so we don't stamp a rev for them. `newRev: null` tells the caller "don't issue the second UPDATE." `skipped: false` because the cron did meaningful work (it called `markBridgedPublisher`) — `skipped` means "the rev check determined nothing needed doing." Conflating the two would pollute the observability signal.

- [ ] **Step 11: Update the two mid-walk error returns in `syncDocumentsFromRepo` to include the new fields**

  Find the two error returns inside the `while (true)` loop:
  ```ts
  return { fetched, stored, errors: errors + 1, bridged: false };
  ```
  and
  ```ts
  return { fetched, stored, errors: errors + 1, bridged: false };
  ```

  (They are currently identical — one for `listRecordsFromPds` throwing, one for it returning null. Both are around lines 273–279.)

  Update both to:
  ```ts
  return { fetched, stored, errors: errors + 1, bridged: false, newRev: null, skipped: false };
  ```

  Rationale: a partial walk failure means we don't know the full final state of the repo, so we refuse to stamp the new rev. The next cron will rev-check again and probably retry the full walk. Correct recovery behavior.

- [ ] **Step 12: Update the success return at the end of `syncDocumentsFromRepo`**

  Find the final return (around line 313):
  ```ts
  return { fetched, stored, errors, bridged: false };
  ```

  Update to:
  ```ts
  return {
    fetched,
    stored,
    errors,
    bridged: false,
    newRev: currentRev,
    skipped: false,
  };
  ```

  Rationale: on a successful full walk, stamp the rev we observed. If `currentRev` is `null` (because the probe failed upstream), we don't stamp — the next cron will rev-check again. `skipped: false` because we did the full walk.

- [ ] **Step 13: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean. If you get errors, the most likely cause is a missed return statement that still has the old 4-field shape. Search: `grep -n "bridged: false" src/sync/documents.ts` — every match should now be followed (in the same or adjacent line) by the new `newRev`/`skipped` fields.

- [ ] **Step 14: Sanity sweep — any other caller of `syncDocumentsFromRepo`?**

  Run: `grep -rn "syncDocumentsFromRepo" src/`
  Expected: exactly two matches — the export in `documents.ts` and the single call inside `syncDocumentsBatch` (also in `documents.ts`). If you find a third caller elsewhere in the tree, stop and escalate — the plan assumes exactly one caller and the new required parameter would break any other.

- [ ] **Step 15: Commit**

  ```bash
  git add src/sync/documents.ts
  git commit -m "$(cat <<'EOF'
  feat(sync): rev-check publishers before listRecords walk

  syncDocumentsFromRepo now calls com.atproto.sync.getLatestCommit
  before the full walk. If rev matches publishers.last_synced_rev,
  the walk is skipped entirely and the publisher is reported as
  `skipped` in the batch result. Mismatch or probe failure falls
  through to the current full-sync path with no regression.

  syncDocumentsBatch's claim query is extended to select the new
  column, and a second UPDATE fires after successful sync to stamp
  the new rev. The two-UPDATE pattern preserves the load-bearing
  CAS semantics of the existing last_synced_at stamp.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 16: Verify scope**

  Run: `git show HEAD --stat`
  Expected: only `src/sync/documents.ts` modified.

  Run: `git diff HEAD~1 HEAD -- src/sync/documents.ts | grep -c "^+"` and `... | grep -c "^-"` to sanity-check the size of the diff. Expected: somewhere around 40–60 additions, 10–20 deletions. If it's dramatically bigger, you accidentally reformatted the file.

---

### Task 4: Extend the batch log line in `src/workflow.ts`

**Why:** The new `skipped` counter threads up through `syncDocumentsBatch`'s return, but nothing surfaces it to operators until the log line in `runBatchedDocumentSync` includes it. This task is a tiny log-line edit; keeping it as its own commit makes the "what changed in observability" diff one-line clean.

**Files:**
- Modify: `src/workflow.ts`

**Steps:**

- [ ] **Step 1: Read the relevant chunk of `src/workflow.ts`**

  Find `runBatchedDocumentSync` (around line 225) and within it, the `console.log` block that emits the batch log line (around lines 254–258). It currently reads:
  ```ts
  if (result.stored > 0 || result.bridged > 0 || result.errors > 0) {
    console.log(
      `  batch ${scope}-${i}: processed=${result.processed} stored=${result.stored} bridged=${result.bridged} errors=${result.errors}`,
    );
  }
  ```

- [ ] **Step 2: Extend the log predicate and log line to include `skipped`**

  Change the gating condition so non-zero skip counts also produce a log line (so operators can see the optimization firing), and add `skipped=${result.skipped}` to the message:

  ```ts
  if (
    result.stored > 0 ||
    result.bridged > 0 ||
    result.errors > 0 ||
    result.skipped > 0
  ) {
    console.log(
      `  batch ${scope}-${i}: processed=${result.processed} stored=${result.stored} bridged=${result.bridged} skipped=${result.skipped} errors=${result.errors}`,
    );
  }
  ```

  Placement of `skipped=` in the log: between `bridged=` and `errors=`. This groups the "work-was-avoided" signals (`bridged` and `skipped`) together and keeps `errors` at the end where operators expect to see it.

  Note: adding `result.skipped > 0` to the predicate means that on an established corpus where most publishers get skipped, every batch will log — that's the point, so you can see the rev check doing its job. If this proves too noisy in practice, we can tune the predicate later; for the initial rollout, we want the visibility.

- [ ] **Step 3: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean. The `result.skipped` access will typecheck cleanly because Task 3 added the field to the return shape.

- [ ] **Step 4: Verify scope**

  Run: `git diff src/workflow.ts`
  Expected: only the log-line block modified. No other changes to `workflow.ts`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/workflow.ts
  git commit -m "$(cat <<'EOF'
  feat(workflow): surface skipped count in batch log line

  `batch X-Y: processed=N stored=M bridged=B skipped=S errors=E`

  Adds skipped to the log predicate too so batches that are
  entirely skipped still produce a visible log line — that's
  the signal operators need to confirm the rev check is firing.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 6: Verify scope**

  Run: `git show HEAD --stat`
  Expected: `src/workflow.ts | N +/-` with small N.

---

## Chunk 3: Jetstream DO expansion

### Task 5: Refactor `indexDocumentIfKnown` signature in `src/durable/jetstream-listener.ts`

**Why:** The current `indexDocumentIfKnown(did, msg)` signature couples the message parsing to the indexer. Task 6 will add update and delete paths that need the same `rkey` and `record` values. Refactoring the signature now, as its own commit, separates "shape change" from "new behavior" — each commit compiles cleanly and the diff is easy to review.

**Files:**
- Modify: `src/durable/jetstream-listener.ts`

**Steps:**

- [ ] **Step 1: Read the current `indexDocumentIfKnown` and its caller**

  `indexDocumentIfKnown` is around line 164. Its caller is in `handleMessage` at line 141 (`await this.indexDocumentIfKnown(did, msg);`).

  Current signature:
  ```ts
  private async indexDocumentIfKnown(
    did: string,
    msg: { commit?: { rkey?: string; record?: unknown } },
  ): Promise<void> {
    const rkey = msg.commit?.rkey;
    const rawRecord = msg.commit?.record;
    if (!rkey) return;
    // … rest unchanged
  }
  ```

- [ ] **Step 2: Change the signature to accept `rkey` and `record` directly**

  Update the function:
  ```ts
  private async indexDocumentIfKnown(
    did: string,
    rkey: string,
    record: unknown,
  ): Promise<void> {
    const validated = validateStandardDocument(record);
    if (!validated) {
      console.warn(`Jetstream: invalid document record from ${did}/${rkey}`);
      return;
    }

    // Only insert documents from known, non-bridged publishers
    const known = await this.env.DB
      .prepare(
        `SELECT 1 FROM publishers WHERE did = ? AND COALESCE(label, '') != 'bridged'`,
      )
      .bind(did)
      .first();
    if (!known) return;

    const uri = `at://${did}/${DOCUMENT_COLLECTION}/${rkey}`;
    try {
      await upsertDocumentStmt(this.env.DB, uri, did, validated).run();
      this.documentsIndexed++;
    } catch {
      // D1 write failed — non-fatal
    }
  }
  ```

  Key changes:
  - Parameters are now `(did, rkey, record)`; the msg parsing lives in the caller
  - Renamed local `rawRecord` → `record` (parameter) and `record` → `validated` (the validated form)
  - Removed the `if (!rkey) return;` guard — the caller now enforces the non-null `rkey` contract, so receiving a blank rkey would be a type error, not a runtime check

- [ ] **Step 3: Update the caller in `handleMessage`**

  Find the block that routes `DOCUMENT_COLLECTION` commits (around line 140):
  ```ts
  } else if (collection === DOCUMENT_COLLECTION) {
    await this.indexDocumentIfKnown(did, msg);
  }
  ```

  Update to extract `rkey` and `record` from the message and pass them explicitly:
  ```ts
  } else if (collection === DOCUMENT_COLLECTION) {
    const rkey = msg.commit?.rkey as string | undefined;
    const record = msg.commit?.record as unknown;
    if (!rkey) return;
    await this.indexDocumentIfKnown(did, rkey, record);
  }
  ```

  This mirrors how `handleMessage` already extracts `did`, `collection`, and `operation` from `msg`.

- [ ] **Step 4: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean. If you get a type error, the most likely cause is the `msg.commit?.rkey as string | undefined` cast — the existing `msg` type at line 124 (`JSON.parse(…)`) is `any`, so all field accesses are `any`. The explicit cast is there for readability; the TypeScript compiler will accept it either way.

- [ ] **Step 5: Commit**

  ```bash
  git add src/durable/jetstream-listener.ts
  git commit -m "$(cat <<'EOF'
  refactor(jetstream): split rkey/record parsing out of indexDocumentIfKnown

  Prep for Task 6: the update and delete paths will need rkey and
  record directly, so the message parsing belongs in handleMessage
  and the indexer takes them as explicit parameters. No behavior
  change in this commit — validation and known-publisher check are
  untouched.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: Add update/delete handling and new counters in `src/durable/jetstream-listener.ts`

**Why:** The actual behavior change — extending the DO to handle `update` and `delete` operations for `site.standard.document`, adding a new `deleteDocument` method, and exposing three new counters via the status response. This is the biggest task in the plan; Task 5 made it possible to do in one atomic commit.

**Files:**
- Modify: `src/durable/jetstream-listener.ts`

**Steps:**

- [ ] **Step 1: Add the `vectorIds` import**

  At the top of the file, find the imports block:
  ```ts
  import { DurableObject } from "cloudflare:workers";
  import type { Env } from "../env.js";
  import { upsertDocumentStmt, type StandardDocument } from "../sync/documents.js";
  ```

  Add an import for `vectorIds`:
  ```ts
  import { DurableObject } from "cloudflare:workers";
  import type { Env } from "../env.js";
  import { upsertDocumentStmt, type StandardDocument } from "../sync/documents.js";
  import { vectorIds } from "../recommend/vector-id.js";
  ```

- [ ] **Step 2: Add three new instance counters**

  Find the class's instance field declarations (around lines 22–26):
  ```ts
  private ws: WebSocket | null = null;
  private publishersFound = 0;
  private documentsIndexed = 0;
  private connected = false;
  private lastEventAt: string | null = null;
  ```

  Add three new counters after `documentsIndexed`:
  ```ts
  private ws: WebSocket | null = null;
  private publishersFound = 0;
  private documentsIndexed = 0;
  private documentsUpdated = 0;
  private documentsDeleted = 0;
  private documentsRejected = 0;
  private connected = false;
  private lastEventAt: string | null = null;
  ```

- [ ] **Step 3: Expose the new counters in both `/start` and `/status` endpoints**

  Find the `/start` response construction (around lines 34–40):
  ```ts
  case "/start":
    await this.ensureConnected();
    return Response.json({
      status: "running",
      connected: this.connected,
      publishersFound: this.publishersFound,
      documentsIndexed: this.documentsIndexed,
      lastEventAt: this.lastEventAt,
    });
  ```

  Update to include the three new counters:
  ```ts
  case "/start":
    await this.ensureConnected();
    return Response.json({
      status: "running",
      connected: this.connected,
      publishersFound: this.publishersFound,
      documentsIndexed: this.documentsIndexed,
      documentsUpdated: this.documentsUpdated,
      documentsDeleted: this.documentsDeleted,
      documentsRejected: this.documentsRejected,
      lastEventAt: this.lastEventAt,
    });
  ```

  Then find the `/status` response (around lines 46–52):
  ```ts
  case "/status":
    return Response.json({
      connected: this.connected,
      publishersFound: this.publishersFound,
      documentsIndexed: this.documentsIndexed,
      lastEventAt: this.lastEventAt,
    });
  ```

  Apply the same three additions:
  ```ts
  case "/status":
    return Response.json({
      connected: this.connected,
      publishersFound: this.publishersFound,
      documentsIndexed: this.documentsIndexed,
      documentsUpdated: this.documentsUpdated,
      documentsDeleted: this.documentsDeleted,
      documentsRejected: this.documentsRejected,
      lastEventAt: this.lastEventAt,
    });
  ```

- [ ] **Step 4: Update `handleMessage` to route create/update/delete for `site.standard.document`**

  Find the operation filter (around line 133) and the publication/document routing (around lines 138–143). The current code reads:
  ```ts
  if (!did || !collection || operation !== "create") return;

  this.lastEventAt = new Date().toISOString();

  if (collection === PUBLICATION_COLLECTION) {
    await this.registerPublisher(did);
  } else if (collection === DOCUMENT_COLLECTION) {
    const rkey = msg.commit?.rkey as string | undefined;
    const record = msg.commit?.record as unknown;
    if (!rkey) return;
    await this.indexDocumentIfKnown(did, rkey, record);
  }
  ```

  (Note: the `rkey`/`record` extraction is from Task 5.)

  Update to:
  ```ts
  if (!did || !collection || !operation) return;

  this.lastEventAt = new Date().toISOString();

  if (collection === PUBLICATION_COLLECTION) {
    // Only handle publication creates. Updates and deletes on
    // publication records are intentional no-ops: publication URL
    // changes are picked up by the next cron's listRecords walk
    // (INSERT OR REPLACE), and a publication delete is an
    // ambiguous signal we don't want to act on automatically.
    // See docs/superpowers/specs/2026-04-14-doc-sync-rev-check-design.md
    // for the full rationale.
    if (operation === "create") {
      await this.registerPublisher(did);
    }
    return;
  }

  if (collection === DOCUMENT_COLLECTION) {
    const rkey = msg.commit?.rkey as string | undefined;
    if (!rkey) return;
    const record = msg.commit?.record as unknown;
    await this.handleDocumentOp(did, operation, rkey, record);
  }
  ```

  Key changes:
  - The top-level filter drops `operation !== "create"` — we now accept all operations and dispatch on collection+operation inside
  - Publication collection is handled inline (create only; update/delete are no-ops with an explanatory comment)
  - Document collection routes through a new `handleDocumentOp` helper

- [ ] **Step 5: Add the `handleDocumentOp` helper method**

  Add this new private method immediately above the existing `indexDocumentIfKnown` definition (around line 164). It dispatches create/update/delete to the appropriate handler:

  ```ts
  /**
   * Route a site.standard.document commit op to the appropriate
   * handler. `create` and `update` share the indexer path because
   * upsertDocumentStmt is already INSERT OR REPLACE. `delete`
   * runs a new path that removes from D1 + Vectorize.
   */
  private async handleDocumentOp(
    did: string,
    operation: string,
    rkey: string,
    record: unknown,
  ): Promise<void> {
    if (operation === "create") {
      await this.indexDocumentIfKnown(did, rkey, record);
      return;
    }
    if (operation === "update") {
      await this.indexDocumentIfKnown(did, rkey, record);
      this.documentsUpdated++;
      return;
    }
    if (operation === "delete") {
      await this.deleteDocument(did, rkey);
      return;
    }
    // Unknown operation — silently ignore. Jetstream event schema
    // is stable (create/update/delete), but being defensive here
    // means future ops don't crash the handler.
  }
  ```

  **Subtlety on the update path:** we increment `documentsUpdated` AFTER `indexDocumentIfKnown` returns. If the known-publisher check failed or the validation failed, the indexer returned early without writing anything, but we still bump the counter. This is fine — `documentsUpdated` counts *update events seen for known collections*, not *successful writes*. If you want strict "writes committed" semantics, you'd need `indexDocumentIfKnown` to return a success/failure flag, which is more refactoring than this PR should take on. The current counter semantics are consistent with how `documentsIndexed` is incremented (inside `indexDocumentIfKnown` only on successful write).

  Wait — the above subtlety is wrong. Let me re-check. Looking at the current `indexDocumentIfKnown` after Task 5: it increments `this.documentsIndexed++` only AFTER a successful `.run()` (inside the try). So `documentsIndexed` is "successful writes." If we increment `documentsUpdated` unconditionally after the call, those counters aren't consistent. Fix: move the `documentsUpdated++` increment to live INSIDE `indexDocumentIfKnown` somehow, or — simpler — branch in `indexDocumentIfKnown` on whether this was an update vs create. But that couples the counter concern to the indexer, which is ugly.

  **Cleaner fix:** make `indexDocumentIfKnown` return a boolean indicating whether it actually wrote, and the caller uses that to decide which counter to bump.

  Update `indexDocumentIfKnown`'s return type from `Promise<void>` to `Promise<boolean>` (returning `true` on successful write, `false` on any early return or write failure). Then in `handleDocumentOp`, the update branch becomes:
  ```ts
  if (operation === "update") {
    const wrote = await this.indexDocumentIfKnown(did, rkey, record);
    if (wrote) this.documentsUpdated++;
    return;
  }
  ```

  And the create branch stays as:
  ```ts
  if (operation === "create") {
    await this.indexDocumentIfKnown(did, rkey, record);
    return;
  }
  ```

  Note: we do NOT bump `documentsIndexed` in `handleDocumentOp` for the create branch because `indexDocumentIfKnown` already bumps it internally. That asymmetry is slightly ugly but keeping `documentsIndexed` as-is avoids a behavior change. For the update branch, the counter bump is outside because `documentsUpdated` is new.

  **Also** update `indexDocumentIfKnown`'s bodies to return the appropriate boolean:
  - Early return on validation failure: `return false;`
  - Early return on unknown publisher: `return false;`
  - After successful write (`this.documentsIndexed++`): `return true;`
  - Catch block on write failure: `return false;`

  **And** in the validation-failure early return, increment `documentsRejected` as well:
  ```ts
  const validated = validateStandardDocument(record);
  if (!validated) {
    console.warn(`Jetstream: invalid document record from ${did}/${rkey}`);
    this.documentsRejected++;
    return false;
  }
  ```

- [ ] **Step 6: Add the `deleteDocument` method**

  Add this private method immediately above `handleDocumentOp` (or below `indexDocumentIfKnown` — anywhere in the class is fine, just keep delete-related methods grouped):

  ```ts
  /**
   * Delete a document from both Vectorize and D1 on a Jetstream
   * delete event. Vector delete first, then D1 — orphan vectors
   * are cheaper to recover from than orphan D1 rows (see the spec
   * for the ordering rationale).
   *
   * Does NOT check the known-publisher filter. A publisher that
   * was known at some point in the past may have been removed
   * from the publishers table (e.g., marked bridged) but still
   * have documents in D1 that we want to respect deletes for.
   * DELETEs against nothing are cheap no-ops.
   */
  private async deleteDocument(did: string, rkey: string): Promise<void> {
    const uri = `at://${did}/${DOCUMENT_COLLECTION}/${rkey}`;

    // Vector first: if this fails, we get an orphan vector, which
    // is recoverable by a future diff-against-documents cleanup.
    try {
      const [vectorIdHash] = await vectorIds([uri]);
      await this.env.VECTORS.deleteByIds([vectorIdHash]);
    } catch (err) {
      console.warn(`Jetstream: vector delete failed for ${uri}:`, err);
    }

    // D1 second: batch two statements so recommendations are
    // cleaned up before the documents row (preventing a window
    // where a rec row points at a just-deleted doc row).
    try {
      await this.env.DB.batch([
        this.env.DB
          .prepare(`DELETE FROM recommendations WHERE document_uri = ?`)
          .bind(uri),
        this.env.DB
          .prepare(`DELETE FROM documents WHERE uri = ?`)
          .bind(uri),
      ]);
      this.documentsDeleted++;
    } catch (err) {
      console.warn(`Jetstream: D1 delete failed for ${uri}:`, err);
    }
  }
  ```

  Note: we increment `documentsDeleted` only after the D1 batch succeeds, even if the vector delete failed earlier. Rationale: the user-visible effect (doc gone from D1 and from recommendations) is what matters; the orphan vector is a recoverable internal state. If you want strict "both sides succeeded" semantics, you'd need a more elaborate partial-failure state; for observability purposes, the current semantics are honest.

- [ ] **Step 7: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean.

  If you get a type error on `const [vectorIdHash] = await vectorIds([uri]);`, it's because `vectorIds` returns `Promise<string[]>` — destructuring a single element is fine, just make sure the import at the top of the file is from `../recommend/vector-id.js`.

- [ ] **Step 8: Sanity sweep on the counter contract**

  Run: `grep -n "documentsRejected\|documentsUpdated\|documentsDeleted" src/durable/jetstream-listener.ts`
  Expected: each counter appears:
  - Once as a field declaration
  - Twice in the response bodies (`/start` and `/status`)
  - Once at its increment site (for `documentsRejected` and `documentsUpdated`) or in the delete method (for `documentsDeleted`)

  Total: 4 matches per counter, 12 total for all three.

- [ ] **Step 9: Verify the JS DO routing is consistent**

  Run: `grep -n "operation ===" src/durable/jetstream-listener.ts`
  Expected: matches for `"create"`, `"update"`, `"delete"` inside `handleDocumentOp`, and one `"create"` inside `handleMessage` for the publication routing. No other `operation ===` checks.

  Run: `grep -n "indexDocumentIfKnown" src/durable/jetstream-listener.ts`
  Expected: the definition and two call sites — one for create, one for update, both inside `handleDocumentOp`. If you see a call site in `handleMessage` still, you missed the refactor.

- [ ] **Step 10: Dry-run deploy to confirm the DO still compiles and routes cleanly**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -30`

  Expected: the bindings table should still list `JETSTREAM_LISTENER` as a DO binding. No typecheck errors. Total Upload size may grow slightly — that's fine.

  You may see a sandbox EPERM warning about `~/Library/Preferences`. Ignore it.

- [ ] **Step 11: Commit**

  ```bash
  git add src/durable/jetstream-listener.ts
  git commit -m "$(cat <<'EOF'
  feat(jetstream): handle document update/delete + add counters

  The DO previously dropped every commit op except "create",
  leaving edits and deletes invisible to the system. Now:

  - create and update both route through indexDocumentIfKnown
    (upsertDocumentStmt is INSERT OR REPLACE, so updates overwrite
    cleanly). The new documentsUpdated counter tracks writes from
    the update path.
  - delete routes through a new deleteDocument method that removes
    the document from Vectorize and from D1 (recommendations +
    documents), ordered vector-first so the cheaper orphan is
    preserved on partial failure.
  - documentsRejected exposes the existing silent-drop of
    malformed records (create or update) as an observable counter.

  Publication updates and deletes remain no-ops. /admin/jetstream/
  status surfaces all three new counters.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 12: Verify scope**

  Run: `git show HEAD --stat`
  Expected: only `src/durable/jetstream-listener.ts` modified. Diffstat probably 60–100 lines added, 10–20 removed.

---

## Chunk 4: Verification and handoff

### Task 7: Final verification, push, PR

**Why:** The code change is all commits 1–6. This task verifies the branch is clean, the working tree invariants are preserved, and opens the PR. No new file edits. As with the previous PRs, the deploy and D1 migration are explicitly user-gated.

**Files:** None modified.

**Steps:**

- [ ] **Step 1: Verify the working tree**

  Run: `git status --short`

  Expected:
  ```text
   M wrangler.toml
  ?? .claude/
  ?? docs/stitch/
  ?? docs/superpowers/plans/2026-04-08-oauth-likes-implementation.md
  ?? docs/superpowers/plans/2026-04-12-likes-doc-embedding-experiment.md
  ```

  If you see any other `M` line, stop and investigate — the plan did not authorize modifying any file other than the six listed in Tasks 1–6 (plus this plan document, which was added by the controller before dispatch).

  Run: `git diff wrangler.toml`
  Expected: only the two pre-session lines — `TOP_N` from `"10"` to `"12"`, `WORKER_URL` from the `workers.dev` URL to `https://standardrecs.site`. No other changes.

- [ ] **Step 2: Verify the branch commit list**

  Run: `git log --oneline main..HEAD`

  Expected (top to bottom, most recent first):
  ```text
  <task-6-sha> feat(jetstream): handle document update/delete + add counters
  <task-5-sha> refactor(jetstream): split rkey/record parsing out of indexDocumentIfKnown
  <task-4-sha> feat(workflow): surface skipped count in batch log line
  <task-3-sha> feat(sync): rev-check publishers before listRecords walk
  <task-2-sha> feat(sync): add getLatestCommitRev primitive for incremental sync
  <task-1-sha> feat(schema): add last_synced_rev to publishers for rev-based skip
  <round-1-sha> docs(spec): address spec review round 1
  <spec-sha> docs(spec): doc sync rev check + Jetstream update/delete (Bug 2)
  <plan-sha> docs(plan): doc sync rev check implementation plan
  ```

  (The `<plan-sha>` entry was committed by the controller before dispatch. The exact commit title may be slightly different — that's fine as long as it's a `docs(plan):` commit adding this plan file.)

  If the list is shorter or longer than this, stop and check with the controller.

- [ ] **Step 3: Final full-tree typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean.

- [ ] **Step 4: Final dry-run deploy**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -50`

  Expected: the bindings table should list everything it listed before — D1, Vectorize, Workflows, JETSTREAM_LISTENER Durable Object, plus all env vars. Nothing new should appear (we didn't add any env vars or bindings). Total Upload size may be slightly bigger than before this branch.

- [ ] **Step 5: Push the branch**

  ```bash
  git push -u origin fix/doc-sync-rev-check
  ```

- [ ] **Step 6: Open the PR**

  ```bash
  gh pr create --title "fix(sync): rev-check publishers + handle Jetstream update/delete (Bug 2)" --body "$(cat <<'EOF'
  ## Summary

  Bundles two complementary fixes to the document-sync path.

  **Cron side — rev check before listRecords walk.** Adds a nullable \`last_synced_rev\` column to \`publishers\`. Before \`syncDocumentsFromRepo\` walks a publisher's document collection, it calls \`com.atproto.sync.getLatestCommit\` and compares the returned \`rev\` to the stored value. Match → skip the walk. Mismatch or probe failure → fall through to current behavior. On successful walk completion, the new rev is stamped via a second UPDATE (not folded into the existing pre-processing CAS stamp on \`last_synced_at\`, which is load-bearing). A new \`skipped\` counter threads up through \`DocSyncResult\` into \`runBatchedDocumentSync\`'s batch log line so operators can see the optimization firing.

  **Real-time side — Jetstream DO handles update + delete.** The DO previously dropped every commit op except \`create\`. Now \`update\` routes through the existing indexer (\`upsertDocumentStmt\` is already \`INSERT OR REPLACE\`, so edits overwrite cleanly), and \`delete\` routes through a new \`deleteDocument\` method that removes the document from Vectorize and from D1 (both \`recommendations\` and \`documents\`, in that order). Publication-record updates and deletes remain no-ops. Three new counters (\`documentsUpdated\`, \`documentsDeleted\`, \`documentsRejected\`) are exposed via \`/admin/jetstream/status\`.

  Together, the two mechanisms close the gap on incremental sync and give us a real delete path for the first time.

  Spec: \`docs/superpowers/specs/2026-04-14-doc-sync-rev-check-design.md\`
  Plan: \`docs/superpowers/plans/2026-04-14-doc-sync-rev-check.md\`

  ## Pre-deploy (required)

  Apply the migration before deploying — the new code's extended SELECT will fail on an unknown column otherwise:

  \`\`\`bash
  npx wrangler d1 execute standard-recs-db --remote --command="ALTER TABLE publishers ADD COLUMN last_synced_rev TEXT;"
  \`\`\`

  Old code is unaffected by the presence of the column (it doesn't read it), so you can safely run the migration any time before merging.

  ## Test plan

  - [ ] Run migration on remote D1 (see Pre-deploy)
  - [ ] Merge this PR
  - [ ] \`npm run deploy\`
  - [ ] Trigger a sync: \`curl -X POST -H "Authorization: Bearer \$ADMIN_TOKEN" https://standardrecs.site/admin/sync\`
  - [ ] Watch \`wrangler tail\` for batch log lines. First post-deploy cron will show \`skipped=0\` (nothing has a stored rev yet); subsequent crons should show \`skipped\` climbing as rows get stamped.
  - [ ] Spot-check D1: \`npx wrangler d1 execute standard-recs-db --remote --command="SELECT COUNT(*) FROM publishers WHERE last_synced_rev IS NOT NULL;"\` — should climb toward the total publisher count over a run or two.
  - [ ] Verify new Jetstream counters exist in the status response:
    \`\`\`bash
    curl -H "Authorization: Bearer \$ADMIN_TOKEN" https://standardrecs.site/admin/jetstream/status
    \`\`\`
    Response should include \`documentsUpdated\`, \`documentsDeleted\`, \`documentsRejected\` fields (initially zero).
  - [ ] (Organic) watch for a publisher edit in the wild — \`documentsUpdated\` should tick.
  - [ ] (Organic) watch for a publisher unpublish — \`documentsDeleted\` should tick and a follow-up \`SELECT COUNT(*) FROM documents WHERE uri = '<deleted uri>'\` should return 0.

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Return the PR URL in your summary.

- [ ] **Step 7: Handoff**

  Do not merge, deploy, or run the migration yourself — these actions are user-gated per `CLAUDE.md` and the subagent-driven-development skill. Return control to the controller with a DONE status and the PR URL.

---

## Deferred follow-ups (not part of this plan)

- **Parallelism within `syncDocumentsBatch`.** The loop processes publishers sequentially. With the rev check making most iterations cheap, the savings from parallelism are smaller than they were pre-rev-check — but for batches where many publishers actually need syncing, parallelism would still help. Separate design exercise.
- **Jetstream DO cursor persistence across reconnects.** The DO currently reconnects fresh on WebSocket drop; events in the gap window are lost. A real implementation persists the last-seen `seq` to DO storage and resumes via Jetstream's `cursor` query param. Bounded in this PR by the fact that a DO-missed edit eventually catches up when any other commit bumps the publisher's rev.
- **`markBridgedPublisher` vector-ID mismatch.** Pre-existing bug at `src/sync/documents.ts:161` — calls `vectors.deleteByIds(rawURIs)` but documents are stored under hashed IDs. Leaves orphan vectors for bridged publishers. Explicitly out of scope for this PR (see the "Critical non-goal" at the top of this plan). Separate PR with its own design, because "what happens to orphan vectors from already-marked bridged publishers" needs a backfill answer.
- **Retention policy on DO counters.** The new counters are unbounded in-memory values that reset on DO restart. Same as the existing `publishersFound` / `documentsIndexed`. If long-term observability becomes a priority, the right move is a real metrics backend, not DO state.

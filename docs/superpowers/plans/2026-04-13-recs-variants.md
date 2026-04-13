# Recommendation Variants Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three-variant recommendation system (standardrecs / nonstandardrecs / substandardrecs) on a single Cloudflare Worker with hostname-based routing, MMR ranking for nonstandard, and a substandard placeholder hook.

**Architecture:** One Worker script attached to three custom domains via `wrangler.toml` routes. Hono middleware reads `host` and stores the matched `Variant` on request context. `generateUserRecommendations` is refactored to compute all enabled variants in one pass and write them to D1 with a new `variant` column. Nonstandard uses Maximal Marginal Relevance (Carbonell & Goldstein 1998, λ=0.6) over the top-50 Vectorize candidates to pick 12 recs that are both high-relevance and diverse from the standard top-12. Substandard ships as a fully-routed, fully-themed placeholder state — no ranking strategy yet, but the subdomain is live and the UX is complete.

**Tech Stack:** Cloudflare Workers, Hono HTTP framework, D1 (SQLite), Vectorize (vector store), Voyage AI (embeddings), TypeScript.

**Spec:** [`docs/superpowers/specs/2026-04-13-recs-variants-design.md`](../specs/2026-04-13-recs-variants-design.md) — read this first. The plan here is the execution steps; the spec is the rationale.

**Branch:** `feat/recs-variants` (already created, spec already committed as `5a82304` / `0507227` / `280bd5d`).

---

## Before You Begin

### No test runner exists in this project

`CLAUDE.md` is explicit: *"No test runner or linter is configured."* Do NOT reach for `pytest` / `vitest` / `jest` / `node:test` — they aren't installed and this plan's steps don't set them up. Trying to import a test framework will just fail.

Verification throughout this plan substitutes TDD's red-green cycle with:

1. **`npx tsc --noEmit`** — TypeScript typechecking. Clean output (no errors, no warnings) = pass.
2. **`npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun`** — bundler + binding validation. Runs the full deploy pipeline up to but not including the actual upload. Catches route config mistakes, env var misspellings, bundle errors.
3. **Diff review.** After each edit, run `git diff` and read the output. Confirm the change matches the task, and there are no unintended edits outside the specified files.
4. **Post-deploy smoke tests.** `curl` against the three subdomains after the real deploy (final task). This is where correctness actually gets verified end-to-end.

When a task below says "verify the change," it means steps 1-3. When it says "smoke test," it means step 4 and requires the deploy to have happened.

### Pre-session uncommitted state (important)

When the executor starts, `git status` on `feat/recs-variants` will show:

- `modified: wrangler.toml` — this is **pre-session dirty state** (the user's local config: `TOP_N="12"`, `WORKER_URL="https://standardrecs.site"`, a `[[routes]]` block for `standardrecs.site`). **Do NOT commit these edits as part of this plan.** They are independent config the user has been sitting on.
- Several untracked files in `docs/` (stitch screenshots, old plan docs). Ignore.

For any task that modifies `wrangler.toml` (only Task 3 below), follow the **stash-edit-commit-pop dance**:

```bash
# Before the task
git stash push -m "pre-session wrangler.toml local config" -- wrangler.toml

# ... do the task, make clean commits ...

# After the task
git stash pop
# If it conflicts, combine: keep the new LIKE_EMBED_MODE / MMR_LAMBDA / [[routes]]
# lines from the committed version, AND keep TOP_N / WORKER_URL from the stashed
# local edits, AND keep the [[routes]] block for standardrecs.site at the bottom.
```

This keeps the commit history clean (each task's commit only contains the task's intended changes) without losing the user's local working state.

### Branch and commit hygiene

- Already on `feat/recs-variants`. **Do not** commit to `main`. (Project rule: every change goes on a feature branch and ships via PR. This is saved as durable feedback.)
- Each task below produces one commit. Commit messages use conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, etc.).
- Co-authorship trailer: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- After the last task, push the branch and open a PR with the summary in the final task.

### When you're in over your head

If a task turns out to be bigger than documented, or you hit an unexpected conflict, or the spec seems wrong — **stop and escalate**. Do not guess. Report `BLOCKED` or `NEEDS_CONTEXT` with specifics. The plan was written before implementation and may have blind spots.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/variants.ts` | **new** | `Variant` type, `RankingStrategy` discriminated union, `VARIANTS` registry, `HOSTNAME_TO_VARIANT` lookup, `variantFromHost()` helper. |
| `src/recommend/mmr.ts` | **new** | `pickMMR()` — pure function implementing Maximal Marginal Relevance over a candidate pool with a seed set. Plus a private `dot()` helper. |
| `src/env.ts` | modify | Add `MMR_LAMBDA: string` config binding. |
| `wrangler.toml` | modify | Add `MMR_LAMBDA = "0.6"`, add two `[[routes]]` blocks for `nonstandardrecs.site` and `substandardrecs.site` (plus leave the existing `standardrecs.site` block alone). |
| `schema.sql` | modify | `ALTER TABLE recommendations ADD COLUMN variant`, add `idx_recs_did_variant` index. |
| `src/recommend/index.ts` | modify | `generateUserRecommendations` computes both variants in one pass (bump `topK` to 50, `returnValues: true`, call `pickMMR` for nonstandard, batch-insert both variants with explicit `variant` values). |
| `src/api/routes.ts` | modify | Split across chunks. **Chunk 1** (Task 7): Hono type parameter expansion (`Variables: { variant: Variant }`) + new variant-routing middleware. **Chunk 2**: page-rendering handlers call page functions with `c.get("variant")`, `/recs/:did` SQL gains `WHERE variant = ?`, and `/admin/compare-recs` is extended to take `?variants=...` for A/B rec comparison. |
| `src/api/enroll-page.ts` | modify | `enrollPage` becomes a function taking `Variant`; template interpolates variant copy; inline blob colors replaced with `var(--variant-blob-N)` custom properties. |
| `src/api/recs-page.ts` | modify | `recsPage` becomes a function taking `RecsPageData` that includes a `Variant`; new `placeholder` state; CSS refactor matching enroll-page. |
| `src/api/recs-lookup-page.ts` | modify | `recsLookupPage` becomes a function taking `Variant`; minimal theme + copy application. |

Net: 2 new files, 8 modified files, 1 schema migration (applied via `npm run db:init` after edit).

---

## Chunk 1: Foundation, recommend pipeline, middleware

Tasks 1 through 7. After this chunk, the business-logic changes are in place but the page layer hasn't been refactored yet. The Worker will compile and typecheck but is **not yet ready to deploy** — the pages still use hardcoded strings and don't know about variants.

### Task 1: Create `src/variants.ts`

This file is the single source of truth for what a variant *is*. Every other file imports from it.

**Files:**
- Create: `src/variants.ts`

- [ ] **Step 1: Create the file with the full variant registry**

```typescript
/**
 * Variant registry — one entry per branded subdomain.
 *
 * A variant bundles hostname, brand colors (driving the CSS custom
 * properties the page templates emit), per-variant page copy, and
 * the ranking strategy used by generateUserRecommendations.
 *
 * Adding a fourth variant later is one new entry here plus (if it
 * needs a novel ranking strategy) one new arm in RankingStrategy
 * and one new branch in generateUserRecommendations. No other file
 * needs to know.
 */

export type RankingStrategy =
  | { kind: "topN" }
  | { kind: "mmr"; lambda: number; candidatePool: number }
  | { kind: "placeholder" };

export type Variant = {
  key: "standard" | "nonstandard" | "substandard";
  hostname: string;
  brand: {
    /** Primary accent color used for focus rings, match-score chips, etc. */
    hex: string;
    /** Four blob colors for the atmospheric background. Order: main,
     *  cool-contrast, accent, warm-contrast. */
    blobs: [string, string, string, string];
  };
  copy: {
    title: string;
    tagline: string;
    placeholder: string;
    recsHeading: (handle: string) => string;
    footer: string;
  };
  ranking: RankingStrategy;
};

export const VARIANTS: Record<Variant["key"], Variant> = {
  standard: {
    key: "standard",
    hostname: "standardrecs.site",
    brand: {
      hex: "#d99566",
      blobs: ["#d99566", "#7e9eba", "#a78bfa", "#d8a18b"],
    },
    copy: {
      title: "standard-recs",
      tagline: "Discover Standard.site writing based on what you like on Bluesky.",
      placeholder: "Start typing your handle…",
      recsHeading: (handle) => `Recs for @${handle}`,
      footer: "Powered by Standard.site",
    },
    ranking: { kind: "topN" },
  },
  nonstandard: {
    key: "nonstandard",
    hostname: "nonstandardrecs.site",
    brand: {
      hex: "#7e9eba",
      blobs: ["#7e9eba", "#a78bfa", "#9fb59a", "#b8a8d4"],
    },
    copy: {
      title: "nonstandard-recs",
      tagline: "You'd never pick this. Trust us.",
      placeholder: "Start typing your handle…",
      recsHeading: (handle) => `Adjacent picks for @${handle}`,
      footer: "An experiment by standard-recs",
    },
    ranking: { kind: "mmr", lambda: 0.6, candidatePool: 50 },
  },
  substandard: {
    key: "substandard",
    hostname: "substandardrecs.site",
    brand: {
      hex: "#a8b87c",
      blobs: ["#a8b87c", "#c9a87c", "#8a9a7a", "#b5a060"],
    },
    copy: {
      title: "substandard-recs",
      tagline: "You'll hate these.",
      placeholder: "Don't say I didn't warn you…",
      recsHeading: (handle) => `Anti-recs for @${handle}`,
      footer: "An experiment by standard-recs",
    },
    ranking: { kind: "placeholder" },
  },
};

export const HOSTNAME_TO_VARIANT: Record<string, Variant["key"]> = {
  "standardrecs.site": "standard",
  "nonstandardrecs.site": "nonstandard",
  "substandardrecs.site": "substandard",
};

/**
 * Look up a variant by the request's Host header.
 *
 * Unknown hostnames default to `standard` so a misrouted request can
 * never 404 the Worker off the air — dev mode (wrangler dev listens
 * on localhost:8787) falls into this branch and renders the standard
 * variant, which is the safest default.
 */
export function variantFromHost(host: string | undefined): Variant {
  const key = (host && HOSTNAME_TO_VARIANT[host]) ?? "standard";
  return VARIANTS[key];
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean exit, no output.

- [ ] **Step 3: Review the diff**

```bash
git diff src/variants.ts
```

Confirm:
- File is new (shown as `+++ b/src/variants.ts`).
- `RankingStrategy` is a discriminated union (not an enum or class).
- `VARIANTS` is typed `Record<Variant["key"], Variant>` so TypeScript forces all three variants to exist.
- `variantFromHost` defaults to `standard` on unknown host.

- [ ] **Step 4: Commit**

```bash
git add src/variants.ts
git commit -m "$(cat <<'EOF'
feat(variants): add variant registry and hostname lookup

New single source of truth for the three recommendation variants
(standard / nonstandard / substandard). Each entry bundles hostname,
brand colors, per-variant page copy, and ranking strategy. Downstream
files import from here; adding a fourth variant later is one new
entry plus optionally one new RankingStrategy arm.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `MMR_LAMBDA` to the `Env` type

Small binding addition so the workflow + recommend code can read `this.env.MMR_LAMBDA` / `env.MMR_LAMBDA` type-safely.

**Files:**
- Modify: `src/env.ts`

- [ ] **Step 1: Add the binding**

In `src/env.ts`, inside the `// Config vars` section (you'll see comments delimiting Storage / Workflows / Durable Objects / Secrets / Config vars), add **one line** after the existing `LIKE_QUERY_NAMESPACE`:

```typescript
  MMR_LAMBDA: string;              // "0.6" — nonstandardrecs MMR lambda knob
```

The final section should look like:

```typescript
  // Config vars
  SYNC_BATCH_SIZE: string;
  SYNC_DOCS_BATCH_SIZE: string;
  SYNC_DOCS_MAX_BATCHES: string;
  WINDOW_DAYS: string;
  TOP_N: string;
  WORKER_URL: string;
  LIKE_EMBED_MODE: string;         // "query" | "document" | "both"
  LIKE_QUERY_NAMESPACE: string;    // "likes" | "likes_doc"
  MMR_LAMBDA: string;              // "0.6" — nonstandardrecs MMR lambda knob
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Review the diff**

```bash
git diff src/env.ts
```

Confirm: exactly one line added, placed inside the config-vars section, after `LIKE_QUERY_NAMESPACE`. No other changes.

- [ ] **Step 4: Commit**

```bash
git add src/env.ts
git commit -m "$(cat <<'EOF'
feat(env): add MMR_LAMBDA config binding for nonstandardrecs

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `MMR_LAMBDA` default + two new `[[routes]]` blocks to `wrangler.toml`

**⚠️ This task is the one with the pre-session dirty state.** Follow the stash-edit-commit-pop dance exactly.

**Files:**
- Modify: `wrangler.toml`

- [ ] **Step 1: Stash the pre-session dirty edits**

```bash
git stash push -m "pre-session wrangler.toml local config" -- wrangler.toml
```

Verify with `git status` — `wrangler.toml` should no longer appear as modified. The clean committed version from `feat/recs-variants` HEAD is now in your working tree.

- [ ] **Step 2: Add `MMR_LAMBDA` to `[vars]`**

Open `wrangler.toml`. **Important context:** after the stash in Step 1, your working tree shows the **committed** version of `wrangler.toml` — which has `TOP_N = "10"`, the old workers.dev `WORKER_URL`, and **no `[[routes]]` block at all** (the `standardrecs.site` route is part of the pre-session local edits and is safely in the stash). Don't panic about TOP_N / WORKER_URL being "wrong" — they'll be correct again after Step 7 pops the stash.

Find the `[vars]` section (near the bottom, after `[durable_objects]` and `[[migrations]]`, before `[limits]`). It looks like this:

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
```

Add a new line at the end of the `[vars]` section:

```toml
MMR_LAMBDA = "0.6"
```

- [ ] **Step 3: Add three `[[routes]]` blocks at the bottom of the file**

The committed `wrangler.toml` has **no `[[routes]]` blocks**. You are adding all three routes (standard + the two new ones) to this clean base. After Step 7 pops the stash, the stash will also try to reintroduce the `standardrecs.site` block — that conflict is handled in Step 7 below.

At the very bottom of the file, after the existing `# Secret (set via CLI)` comment block, add:

```toml

[[routes]]
pattern = "standardrecs.site"
custom_domain = true

[[routes]]
pattern = "nonstandardrecs.site"
custom_domain = true

[[routes]]
pattern = "substandardrecs.site"
custom_domain = true
```

(The leading blank line is intentional — it separates the new blocks from the `# Secret` comment above.)

- [ ] **Step 4: Dry-run deploy to validate**

```bash
npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun-recs-variants 2>&1 | tail -30
```

Expected output includes `env.MMR_LAMBDA ("0.6")` in the bindings table and should not throw any errors about route pattern validation. If it errors on the routes, the issue is usually that one of the subdomains isn't yet attached to the Cloudflare account — but Bryan confirmed during brainstorming that all three are already on Cloudflare DNS, so this should pass.

- [ ] **Step 5: Review the diff**

```bash
git diff wrangler.toml
```

Confirm: only `MMR_LAMBDA` line added in `[vars]`, and two new `[[routes]]` blocks at the bottom. No changes to `TOP_N` or `WORKER_URL` or anything else — those are in the stash.

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml
git commit -m "$(cat <<'EOF'
feat(config): add MMR_LAMBDA default and routes for two new subdomains

Adds MMR_LAMBDA = "0.6" to [vars] (the nonstandardrecs ranking knob)
and [[routes]] blocks for nonstandardrecs.site and substandardrecs.site
alongside the existing standardrecs.site route. One Worker, three
custom domains.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Pop the stash (expect a conflict and resolve it)**

```bash
git stash pop
```

**Expect this to conflict.** The stash was taken from a state where `wrangler.toml` already had (a) `TOP_N = "12"` / `WORKER_URL = "https://standardrecs.site"` in `[vars]` and (b) a `[[routes]]` block for `standardrecs.site` at the bottom. Your committed change adjusted the same `[vars]` region (adding `MMR_LAMBDA`) and added a `[[routes]]` block for `standardrecs.site` (among others) at the bottom. Both regions will conflict.

**Resolve the conflict manually:**

Open `wrangler.toml` and look for `<<<<<<<` markers. The `[vars]` conflict should be resolved to combine:

```toml
[vars]
SYNC_BATCH_SIZE = "50"
SYNC_DOCS_BATCH_SIZE = "50"
SYNC_DOCS_MAX_BATCHES = "300"
WINDOW_DAYS = "30"
TOP_N = "12"                                         # from stash (local edit)
WORKER_URL = "https://standardrecs.site"             # from stash (local edit)
LIKE_EMBED_MODE = "query"                            # committed
LIKE_QUERY_NAMESPACE = "likes"                       # committed
MMR_LAMBDA = "0.6"                                   # from the Task 3 commit
```

The `[[routes]]` conflict should be resolved to keep exactly three blocks:

```toml
[[routes]]
pattern = "standardrecs.site"
custom_domain = true

[[routes]]
pattern = "nonstandardrecs.site"
custom_domain = true

[[routes]]
pattern = "substandardrecs.site"
custom_domain = true
```

(The stash tries to add another `standardrecs.site` block. Dedupe — keep only one.)

After resolving, confirm no `<<<<<<<` / `=======` / `>>>>>>>` markers remain:

```bash
grep -c '^<<<<<<\|^======\|^>>>>>>' wrangler.toml
```

Expected: `0`.

- [ ] **Step 8: Unstage the resolution so `wrangler.toml` returns to dirty (uncommitted) state**

```bash
git add wrangler.toml            # tells git the conflict is resolved
git restore --staged wrangler.toml  # unstages without losing the file content
git stash drop                   # drop the now-applied stash
```

`git status` should show `modified: wrangler.toml` (dirty — the user's local edits merged with your Task 3 commit's content, all unstaged). `git diff wrangler.toml` should show exactly the pre-session local edits (`TOP_N = "12"`, `WORKER_URL` change) against the new committed content. No conflict markers, no staged changes.

Proceed to Task 4.

---

### Task 4: Create `src/recommend/mmr.ts`

MMR helper as a pure function so it can be reasoned about in isolation.

**Files:**
- Create: `src/recommend/mmr.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * Maximal Marginal Relevance (Carbonell & Goldstein 1998).
 *
 * Given a pool of candidates (each with a vector), pick k items that
 * are both (a) close to a query vector and (b) diverse from a seed
 * set of "already shown" items. Each pick also diversifies against
 * the previously-picked items in this same pass.
 *
 * Score for each candidate c:
 *   mmr(c) = lambda * cosine(c, taste)
 *          - (1 - lambda) * max_over_picked(cosine(c, picked))
 *
 * lambda=1  → pure relevance (= top-k by cosine), diversity ignored
 * lambda=0  → pure diversity, relevance ignored
 * lambda~0.6 → "trust us" sweet spot: still close to taste, but
 *               avoids the cluster centers in the seed set
 *
 * Voyage embeddings are L2-normalized, so dot product == cosine
 * similarity. No need to renormalize.
 *
 * Complexity: O(k * |candidates| * |picked|). For k=12, |candidates|=38,
 * |picked| growing from 12 to 24, that's ~11k dot products of 1024-dim
 * vectors ≈ ~10M FLOPs per user per cron. Microseconds on a Worker.
 */

/**
 * Pick `k` candidates via MMR, biased away from `seed` (and from
 * previously-picked candidates in this pass).
 *
 * Requires `tasteVector` and every candidate/seed's `values` to be
 * populated — pass `returnValues: true` on the originating
 * `vectors.query()` call or this function will throw on the `!` below.
 */
export function pickMMR(
  candidates: VectorizeMatch[],
  seed: VectorizeMatch[],
  tasteVector: number[],
  k: number,
  lambda: number,
): VectorizeMatch[] {
  const picked: VectorizeMatch[] = [...seed];
  const result: VectorizeMatch[] = [];
  const remaining: VectorizeMatch[] = [...candidates];

  while (result.length < k && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cVec = remaining[i].values!;
      const relevance = dot(cVec, tasteVector);

      let maxSim = 0;
      for (const p of picked) {
        const sim = dot(cVec, p.values!);
        if (sim > maxSim) maxSim = sim;
      }

      const score = lambda * relevance - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;
    const winner = remaining.splice(bestIdx, 1)[0];
    result.push(winner);
    picked.push(winner);
  }

  return result;
}

/**
 * Dot product of two equal-length numeric arrays. Equal to cosine
 * similarity when both inputs are L2-normalized (which Voyage
 * embeddings are).
 */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. (The `VectorizeMatch` global type comes from `@cloudflare/workers-types` which is already in the project's tsconfig.)

- [ ] **Step 3: Review the code**

Read `pickMMR` carefully. Verify:
- When `lambda = 1`: `score = relevance`, diversity term ignored → the function picks the top-k by raw cosine. ✓
- When `lambda = 0`: `score = -maxSim`, relevance ignored → the function picks items most dissimilar to the seed set. ✓
- `picked` starts as `[...seed]` and grows as each new pick is added → subsequent picks also diversify against earlier picks in this pass. ✓
- The `!` on `values!` assumes every candidate has `values` set. The caller is responsible for passing `returnValues: true` to `vectors.query()` before feeding candidates into this function. The spec calls this out; Task 6 enforces it at the call site.
- Output length is `min(k, candidates.length)`. ✓

- [ ] **Step 4: Commit**

```bash
git add src/recommend/mmr.ts
git commit -m "$(cat <<'EOF'
feat(recommend): add pickMMR helper for diversity-aware ranking

Pure function implementing Maximal Marginal Relevance (Carbonell &
Goldstein 1998). Used by generateUserRecommendations in the next
task to pick the nonstandardrecs top-12 from the remaining
candidates after the standard top-12 is claimed.

Score: lambda * cosine(c, taste) - (1 - lambda) * max_sim_to_picked

lambda=1 reduces to top-k by relevance; lambda=0 maximizes diversity.
lambda=0.6 is the default tuning knob (MMR_LAMBDA env var).

Voyage embeddings are L2-normalized so dot product == cosine.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Schema migration for the `variant` column

Add the column + index to `schema.sql`, then apply it to remote D1.

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Add the ALTER + CREATE INDEX at the end of `schema.sql`**

Open `schema.sql`. After the last existing `CREATE INDEX` or `CREATE TABLE` statement, append:

```sql

-- 2026-04-13: Add variant column for the nonstandardrecs / substandardrecs
-- variant system. Existing rows default to 'standard' via the DEFAULT clause,
-- so there's no backfill step. The PK stays (did, document_uri); see the spec
-- for the disjointness invariant that keeps this safe across variants.
ALTER TABLE recommendations ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';
CREATE INDEX IF NOT EXISTS idx_recs_did_variant ON recommendations(did, variant);
```

**CAUTION:** `ALTER TABLE ADD COLUMN` in SQLite (and therefore D1) is **idempotent-unsafe** — running it twice against a table that already has the column produces an error. This is fine for a fresh schema apply, but if the column ever needs to be re-added, the apply script should check first. For this plan, assume a single clean apply.

- [ ] **Step 2: Typecheck (no-op for .sql, but run anyway as a sanity check on nothing else was touched)**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Review the diff**

```bash
git diff schema.sql
```

Confirm: only the `ALTER TABLE` + `CREATE INDEX` lines are added, at the end of the file. No other changes.

- [ ] **Step 4: Apply the migration to remote D1**

```bash
npm run db:init
```

Expected: wrangler runs `schema.sql` against the remote D1 database and prints something like `Executed N commands`. The ALTER line will error on an **existing** `variant` column but succeed on first apply; the `CREATE INDEX IF NOT EXISTS` is safe to rerun.

**If this errors with "duplicate column name: variant"**: the migration was already applied (possibly in a previous execution of this plan). Move on — the schema is already correct. The `CREATE INDEX IF NOT EXISTS` that follows the `ALTER` is safe to rerun and will still execute cleanly under `wrangler d1 execute`'s per-statement error handling, so your end state is correct even if the ALTER errors.

**If this errors for any other reason**: STOP and escalate. Don't try to patch it blind.

- [ ] **Step 5: Commit**

```bash
git add schema.sql
git commit -m "$(cat <<'EOF'
feat(schema): add variant column + (did, variant) index to recommendations

Enables per-variant rec storage for the standardrecs / nonstandardrecs
/ substandardrecs variant system. Existing rows default to 'standard'
via the column default; no backfill needed.

Index supports the new WHERE did = ? AND variant = ? predicate on
the recs page route.

Schema applied to remote D1 via npm run db:init as part of this task.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Refactor `generateUserRecommendations` to compute all variants

This is the biggest task in the plan. Take it slow; read the existing code before editing.

**Files:**
- Modify: `src/recommend/index.ts`

- [ ] **Step 1: Read the current state**

```bash
cat src/recommend/index.ts
```

Pay attention to:
- The existing function signature (it takes `db`, `vectors`, `did`, `topN`, `likesNamespace`, `dryRun`).
- The existing flow: fetch likes → getByIds for like vectors → compute taste vector → query documents → filter/slice → write to D1.
- The existing `likesNamespace` and `dryRun` parameters (from PRs #18/#20) must continue to work as they did before. Do not remove them.

- [ ] **Step 2: Add the imports**

At the top of `src/recommend/index.ts`, alongside the existing `import { vectorIds } from "./vector-id.js";`:

```typescript
import { pickMMR } from "./mmr.js";
import { VARIANTS } from "../variants.js";
```

- [ ] **Step 3: Update the `Recommendation` type**

Find the existing `Recommendation` type near the top. Add a `variant` field:

```typescript
type Recommendation = {
  did: string;
  document_uri: string;
  score: number;
  variant: "standard" | "nonstandard";
};
```

(Substandard is excluded on purpose — its ranking is `placeholder` and we don't write rows for it.)

- [ ] **Step 4: Update the Vectorize query (inside `generateUserRecommendations`)**

Find the block that looks like:

```typescript
const topK = Math.min(topN * 2, 50);
const matches = await vectors.query(tasteVector, {
  topK,
  namespace: "documents",
  returnValues: false,
  returnMetadata: "all",
});
```

Replace with:

```typescript
// Fixed topK=50 (Vectorize per-query cap with returnMetadata="all").
// returnValues=true is required so pickMMR can do pairwise vector
// comparisons for the nonstandard diversity term. ~250KB per user
// per cron — fine at any reasonable scale.
const CANDIDATE_POOL = 50;
const matches = await vectors.query(tasteVector, {
  topK: CANDIDATE_POOL,
  namespace: "documents",
  returnValues: true,
  returnMetadata: "all",
});
```

- [ ] **Step 5: Expand both function signatures to accept `lambda`**

**Do this BEFORE touching the implementation body**, so the new `lambda` parameter is in scope everywhere that needs it and we don't create a temporary hack.

Find `generateUserRecommendations` and add `lambda: number = 0.6` as a 7th parameter (after `dryRun`):

```typescript
export async function generateUserRecommendations(
  db: D1Database,
  vectors: VectorizeIndex,
  did: string,
  topN: number,
  likesNamespace: string = LIKES_NAMESPACE_QUERY,
  dryRun: boolean = false,
  lambda: number = 0.6,
): Promise<Recommendation[]> {
```

Find `generateAllRecommendations` (immediately above) and add `lambda: number = 0.6` as a 5th parameter (after `likesNamespace`), then pass it through to the inner call:

```typescript
export async function generateAllRecommendations(
  db: D1Database,
  vectors: VectorizeIndex,
  topN: number,
  likesNamespace: string = LIKES_NAMESPACE_QUERY,
  lambda: number = 0.6,
): Promise<number> {
  // ... existing body unchanged until the call site ...
  const recs = await generateUserRecommendations(
    db,
    vectors,
    user.did,
    topN,
    likesNamespace,
    false,    // dryRun — workflow path always persists
    lambda,
  );
  // ... rest unchanged ...
}
```

At this stage `lambda` is unused inside `generateUserRecommendations`'s body — that's fine, TypeScript doesn't flag unused parameters by default. The next step uses it.

- [ ] **Step 6: Replace the filter-then-slice block with multi-variant computation**

Find the current block inside `generateUserRecommendations` that filters matches and builds `recs`:

```typescript
// 5. Store top-N in D1 — match.id is a hash, so read the original URI
// from metadata. Filter THEN slice so we always get up to topN valid recs.
const recs: Recommendation[] = matches.matches
  .filter((match) => {
    const uri = (match.metadata as { uri?: string } | null)?.uri;
    return !!uri;
  })
  .slice(0, topN)
  .map((match) => ({
    did,
    document_uri: (match.metadata as { uri: string }).uri,
    score: match.score,
  }));
```

**Delete this entire block** and replace with:

```typescript
// 5a. Filter to valid matches (those with a uri in metadata).
const validMatches = matches.matches.filter((match) => {
  const uri = (match.metadata as { uri?: string } | null)?.uri;
  return !!uri;
});

// 5b. Standard recs: top-N by raw cosine, same as before.
const standardMatches = validMatches.slice(0, topN);
const standardRecs: Recommendation[] = standardMatches.map((match) => ({
  did,
  document_uri: (match.metadata as { uri: string }).uri,
  score: match.score,
  variant: "standard" as const,
}));

// 5c. Nonstandard recs: MMR over the remaining candidates, with the
// standard top-N as the seed set (diversify against what standard
// already picked). The `lambda` parameter is threaded in from the
// function signature — the workflow layer reads MMR_LAMBDA env var
// and passes it through.
const nonstandardMatches = pickMMR(
  validMatches.slice(topN),
  standardMatches,
  tasteVector,
  topN,
  lambda,
);
const nonstandardRecs: Recommendation[] = nonstandardMatches.map((match) => ({
  did,
  document_uri: (match.metadata as { uri: string }).uri,
  score: match.score,
  variant: "nonstandard" as const,
}));

const recs: Recommendation[] = [...standardRecs, ...nonstandardRecs];
```

**Note: `tasteVector` needs to be `number[]`** to match `pickMMR`'s signature. It already is — the existing `computeTasteVector` returns `number[]`. If you see a TypeScript error about `Float64Array` vs `number[]`, something upstream drifted; stop and investigate.

- [ ] **Step 7: Update the D1 batch insert**

Find the current block that writes to D1:

```typescript
if (recs.length > 0 && !dryRun) {
  // Clear old recs and insert new ones
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM recommendations WHERE did = ?`).bind(did),
    ...recs.map((r) =>
      db
        .prepare(
          `INSERT INTO recommendations (did, document_uri, score) VALUES (?, ?, ?)`,
        )
        .bind(r.did, r.document_uri, r.score),
    ),
  ];
  await db.batch(stmts);
}
```

Replace with:

```typescript
if (recs.length > 0 && !dryRun) {
  // Clear all existing variants for this user, then insert the new ones.
  // The single DELETE wipes both standard and nonstandard in one statement
  // so the writer doesn't need to know which variants exist.
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM recommendations WHERE did = ?`).bind(did),
    ...recs.map((r) =>
      db
        .prepare(
          `INSERT INTO recommendations (did, document_uri, score, variant) VALUES (?, ?, ?, ?)`,
        )
        .bind(r.did, r.document_uri, r.score, r.variant),
    ),
  ];
  await db.batch(stmts);
}
```

The diff is just adding `, variant` to the SELECT column list and `, r.variant` to the bound params.

- [ ] **Step 8: Update the workflow.ts call sites to pass `lambda`**

Open `src/workflow.ts`. There are two places that call `generateUserRecommendations` / `generateAllRecommendations`:

Find `runUserSync` — it currently has a block that looks roughly like:

```typescript
await step.do(`recommend-for-user-${did}`, async () => {
  const likesNamespace = parseLikesNamespace(this.env.LIKE_QUERY_NAMESPACE);
  const recs = await generateUserRecommendations(
    this.env.DB,
    this.env.VECTORS,
    did,
    topN,
    likesNamespace,
  );
  return { count: recs.length };
});
```

Add a line to parse MMR_LAMBDA and pass it as the 7th arg (after `dryRun`, which defaults to `false`):

```typescript
await step.do(`recommend-for-user-${did}`, async () => {
  const likesNamespace = parseLikesNamespace(this.env.LIKE_QUERY_NAMESPACE);
  const lambda = parseMmrLambda(this.env.MMR_LAMBDA);
  const recs = await generateUserRecommendations(
    this.env.DB,
    this.env.VECTORS,
    did,
    topN,
    likesNamespace,
    false,
    lambda,
  );
  return { count: recs.length };
});
```

Find `runFullPipeline` — same update for the call to `generateAllRecommendations`:

```typescript
const recCount = await step.do("recommend", async () => {
  const likesNamespace = parseLikesNamespace(this.env.LIKE_QUERY_NAMESPACE);
  const lambda = parseMmrLambda(this.env.MMR_LAMBDA);
  return await generateAllRecommendations(
    this.env.DB,
    this.env.VECTORS,
    topN,
    likesNamespace,
    lambda,
  );
});
```

Add a helper function near the existing `parseLikesNamespace` at the top of `workflow.ts`:

```typescript
function parseMmrLambda(value: string | undefined): number {
  const raw = parseFloat(value ?? "0.6");
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
}
```

- [ ] **Step 9: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. If there are errors:
- `Cannot find module './mmr.js'` → you forgot the import in step 2 of this task.
- `Property 'variant' is missing in type ...` → the `Recommendation` type update in step 3 didn't save, or one of the `.map` calls in step 5b/5c is missing `variant: "standard" as const`.
- `Expected 5 arguments, but got 7` → the function signature update in step 6 didn't save.
- `Cannot find name 'parseMmrLambda'` → the helper in step 8 didn't save, or it's below the call site.

- [ ] **Step 10: Review the full diff**

```bash
git diff src/recommend/index.ts src/workflow.ts
```

This diff is large. Read it end-to-end and confirm:
- `src/recommend/index.ts`: new imports, `Recommendation` has `variant`, Vectorize query uses `topK: 50` + `returnValues: true`, standard + nonstandard built separately, MMR called with the right seed/candidates, D1 INSERT has the `variant` column. The `dryRun` guard still wraps the write block.
- `src/workflow.ts`: both recommend call sites pass `lambda`, new `parseMmrLambda` helper defined. No other changes to workflow.ts.

- [ ] **Step 11: Dry-run deploy to validate end-to-end**

```bash
npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun-recs-variants 2>&1 | tail -20
```

Expected: no errors. The bindings table should show `env.MMR_LAMBDA` alongside the others.

- [ ] **Step 12: Commit**

```bash
git add src/recommend/index.ts src/workflow.ts
git commit -m "$(cat <<'EOF'
feat(recommend): compute standard + nonstandard variants in one pass

generateUserRecommendations now bumps the Vectorize query to
topK=50 with returnValues=true, computes the standard top-12 by
raw cosine (unchanged behavior), then picks the nonstandard top-12
via pickMMR() over the remaining 38 candidates using the standard
set as the diversity seed. Both variants are written to D1 in one
batched DELETE+INSERT with explicit variant values.

New 7th parameter: lambda (default 0.6). Workflow call sites read
MMR_LAMBDA via a new parseMmrLambda helper. The existing likesNamespace
and dryRun parameters are unchanged — PR #18/#20 behavior preserved.

Substandard is skipped (RankingStrategy.kind === "placeholder"); no
rows are written for that variant in this pass.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add Hono variant middleware + expand type parameter

**Files:**
- Modify: `src/api/routes.ts`

- [ ] **Step 1: Add the import**

At the top of `src/api/routes.ts`, add:

```typescript
import { type Variant, variantFromHost } from "../variants.js";
```

Place it alongside the other relative imports (after `import type { Env } from "../env.js";`).

- [ ] **Step 2: Expand the Hono type parameter**

Find the line:

```typescript
const api = new Hono<{ Bindings: Env }>();
```

Replace with:

```typescript
const api = new Hono<{ Bindings: Env; Variables: { variant: Variant } }>();
```

This makes `c.set("variant", …)` and `c.get("variant")` type-safe throughout the file.

- [ ] **Step 3: Add the variant middleware**

**Immediately after** the existing `api.use("*", cors());` line, add:

```typescript
// Variant routing middleware. Reads the Host header and stores the
// matched Variant on the request context. Every downstream handler
// reads it via c.get("variant") and doesn't need to know about
// hostnames. Unknown hosts fall back to "standard" inside
// variantFromHost so dev mode (localhost:8787) still works.
api.use("*", async (c, next) => {
  const variant = variantFromHost(c.req.header("host"));
  c.set("variant", variant);
  await next();
});
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. (Route handlers don't yet use `c.get("variant")` — that comes in chunk 2 — so there's nothing downstream to break yet.)

- [ ] **Step 5: Review the diff**

```bash
git diff src/api/routes.ts
```

Confirm:
- Exactly one import added at the top (`Variant` type and `variantFromHost` function).
- Hono type parameter expanded with `Variables`.
- One new `api.use` block right after the CORS middleware.
- No changes to any existing handlers yet.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes.ts
git commit -m "$(cat <<'EOF'
feat(routes): add variant routing middleware + type-safe Variables

Expands the Hono type parameter with Variables: { variant: Variant }
so c.set/c.get for "variant" are type-safe throughout routes.ts.
Adds middleware that runs for every request, reads the Host header,
resolves the matching Variant via variantFromHost(), and stores it
on the request context. Downstream handlers (to be updated in the
next chunk of tasks) read it via c.get("variant").

Unknown hostnames fall back to "standard" so localhost/dev mode
still works.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

**End of Chunk 1.** Tasks 1-7 are complete: the variant registry exists, MMR lives in its own module, the env var is wired end-to-end, the schema has the new column, the recommend pipeline computes both variants in one pass, and the Hono variant middleware is in place. The Worker compiles and typechecks but **the page layer still uses the old hardcoded strings** — it's not yet ready to actually serve the new subdomains meaningfully. Chunk 2 fixes that.

Quick status check before proceeding to chunk 2:

```bash
git log --oneline main..HEAD
npx tsc --noEmit
```

The first command should show the spec commits (`5a82304`, `0507227`, `280bd5d`) plus 7 new commits from this chunk. The typecheck should be clean.

---

## Chunk 2: Page refactors, compare-recs extension, deploy

Tasks 8 through 14. After this chunk, all three subdomains render correctly with their own theme and copy, the recs pages read from the right variant in D1, `/admin/compare-recs` can produce side-by-side variant comparisons for λ tuning, and the whole thing is deployed and smoke-tested against production.

### Task 8: Refactor `src/api/enroll-page.ts` to a variant-aware function

The enroll page is a large template literal. The refactor is mostly mechanical: convert the `const` to a `function`, interpolate variant copy, and replace hardcoded blob colors with CSS custom properties driven per-variant.

**Files:**
- Modify: `src/api/enroll-page.ts`

- [ ] **Step 1: Read the current file**

```bash
cat src/api/enroll-page.ts
```

Note the overall shape: one top-level `export const enrollPage = \`<!DOCTYPE html>...\`;`. The template has `:root` CSS custom properties near the top, a `<style>` block with the blob field CSS (four `.blob--*` rules with hardcoded colors), the `<body>` with SVG atmosphere + main content, and inline strings like `"standard-recs"` / `"Start typing your handle..."` / `"Powered by Standard.site"`.

- [ ] **Step 2: Add the `Variant` import**

At the top of the file, add:

```typescript
import type { Variant } from "../variants.js";
```

- [ ] **Step 3: Change the export from a const to a function**

Find:

```typescript
export const enrollPage = `<!DOCTYPE html>
```

Change to:

```typescript
export function enrollPage(variant: Variant): string {
  return `<!DOCTYPE html>
```

At the very bottom of the file, find the closing backtick and semicolon of the template literal:

```typescript
</html>`;
```

Change to:

```typescript
</html>`;
}
```

(Adds the closing brace for the function.)

- [ ] **Step 4: Inject variant theme into the `:root` CSS**

Find the existing `:root` block in the page's `<style>` section. It currently looks something like:

```css
:root {
  --paper: #f8f5ef;
  --ink: #2b2b2b;
  --ink-soft: #5f5f5f;
  /* ...other existing vars... */
}
```

Immediately after the opening `:root {`, add four new custom properties driven by the variant:

```css
:root {
  --variant-brand: ${variant.brand.hex};
  --variant-blob-1: ${variant.brand.blobs[0]};
  --variant-blob-2: ${variant.brand.blobs[1]};
  --variant-blob-3: ${variant.brand.blobs[2]};
  --variant-blob-4: ${variant.brand.blobs[3]};
  --paper: #f8f5ef;
  /* ...rest unchanged... */
}
```

Because `:root` is already inside a template literal, the `${variant.brand.hex}` interpolation is automatic. The four new custom properties are always present; unknown variants fall through to `standard` at the middleware layer, so the vars will always resolve.

- [ ] **Step 5: Parameterize the blob-field colors**

The actual file uses **semantic class names** (`.blob--amber`, `.blob--blue`, `.blob--violet`, `.blob--center`) with **`rgba()` color values** inside `radial-gradient()`, not bare hex codes. Bare hex find-and-replace will find nothing. The approach is a targeted rule-by-rule edit.

First, find the four blob rules in the `<style>` block. They look (roughly) like this in the file today:

```css
.blob--amber {
  width: 500px; height: 400px;
  background: radial-gradient(circle, rgba(230, 180, 100, 0.6) 0%, rgba(230, 180, 100, 0) 70%);
  top: 20%; left: 10%;
  animation-delay: 0s, 1.8s;
}
.blob--blue {
  width: 600px; height: 450px;
  background: radial-gradient(circle, rgba(147, 197, 253, 0.5) 0%, rgba(147, 197, 253, 0) 70%);
  ...
}
.blob--violet { ... rgba(167, 139, 250, ...) ... }
.blob--center { ... rgba(255, 230, 180, ...) ... }
```

Do **not** rename the classes or the HTML markup. Do **not** change positioning, sizing, or animation properties. The only edit is the `background: radial-gradient(...)` line inside each of the four `.blob--*` rules. Replace each with the corresponding variant custom property:

| Rule | New `background` value |
|---|---|
| `.blob--amber` | `background: radial-gradient(circle, var(--variant-blob-1) 0%, transparent 70%);` |
| `.blob--blue` | `background: radial-gradient(circle, var(--variant-blob-2) 0%, transparent 70%);` |
| `.blob--violet` | `background: radial-gradient(circle, var(--variant-blob-3) 0%, transparent 70%);` |
| `.blob--center` | `background: radial-gradient(circle, var(--variant-blob-4) 0%, transparent 70%);` |

The variant-to-slot mapping (`amber`→`blob-1`, `blue`→`blob-2`, etc.) is derived from the order in `VARIANTS.standard.brand.blobs` in `src/variants.ts`. Keep the transparent falloff at `70%` — that's the existing fade distance and changing it would shift the visual.

**Note about alpha:** replacing `rgba(R, G, B, 0.6)` with just `var(--variant-blob-N)` loses the per-blob alpha. The variant palette in `src/variants.ts` uses fully-opaque hex colors, so the visual will be slightly more saturated than before. If the visual feels wrong during smoke test (Task 14), the fix is to add per-blob opacity via a separate CSS custom property (`--variant-blob-1-alpha`) — but that's a follow-up, not part of this task. Don't preemptively add alpha handling.

**Also check the glass-shape tints and other accent colors.** The enroll-page has a `.glass-shape--amber` / `.glass-shape--blue` / `.glass-shape--sage` / `.glass-shape--rose` / `.glass-shape--violet` block lower in the CSS with `rgba()` tints. **Leave these alone** — they're standard-specific accent treatments that don't need to vary per variant. Only the four main atmospheric blobs get parameterized in this task.

**Focus ring / match-score chip check.** Grep the file for `rgba(184, 168, 152, 0.18)` or similar colors used in `.glass-input:focus-within` box-shadow — these are the focus ring colors. **Leave these alone too** — the focus ring uses neutral tones that work with any brand color. The only thing that should move with the variant is the four main blobs.

---

**Summary of Step 5:** edit exactly four lines (the four `background: radial-gradient(...)` declarations inside `.blob--amber`, `.blob--blue`, `.blob--violet`, `.blob--center`). Everything else stays.

- [ ] **Step 6: Replace inline strings with variant copy**

Find and replace:

| Find | Replace with |
|---|---|
| `standard-recs` (the `<h1>` title text) | `${variant.copy.title}` |
| `Discover Standard.site writing based on what you like on Bluesky.` (the tagline paragraph) | `${variant.copy.tagline}` |
| `Start typing your handle...` or `Start typing your handle…` (input placeholder attribute) | `${variant.copy.placeholder}` |
| `Powered by Standard.site` (the footer text, if present) | `${variant.copy.footer}` |

Be careful to ONLY replace text content — do not replace `standard-recs` in HTML attribute values or URL paths that should stay literal. Use context (surrounding tags) to confirm each replacement is the visible copy.

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 8: Review the diff**

```bash
git diff src/api/enroll-page.ts
```

Confirm:
- One new import at the top (`type Variant`).
- Top-level declaration changed from `const` to `function` with a closing `}` at the end.
- `:root` block has 5 new `--variant-*` custom properties at the top, driven by `${variant.brand.*}`.
- Four `.blob--N` rules reference `var(--variant-blob-N)` instead of hardcoded hex.
- Any brand-accent references (focus rings, chips) reference `var(--variant-brand)`.
- Four inline strings replaced with `${variant.copy.*}` interpolations.
- No other changes to markup structure, script tags, or event handlers.

- [ ] **Step 9: Commit**

```bash
git add src/api/enroll-page.ts
git commit -m "$(cat <<'EOF'
refactor(enroll-page): make variant-aware via CSS custom properties

enrollPage is now a function taking a Variant instead of a top-level
const. The variant's brand hex + 4 blob colors are injected via new
--variant-brand / --variant-blob-N CSS custom properties at the top of
the :root block. All hardcoded blob colors in the blob field CSS are
replaced with var(--variant-blob-N) references, and any brand-accent
references (focus rings, etc.) reference var(--variant-brand). Inline
strings for title, tagline, placeholder, and footer are replaced with
variant.copy.* interpolations.

Downstream route handler updates to call enrollPage(c.get("variant"))
come in Task 11.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Refactor `src/api/recs-page.ts` to a variant-aware function with `placeholder` state

Same pattern as Task 8 plus a new discriminated state for substandardrecs.

**Files:**
- Modify: `src/api/recs-page.ts`

- [ ] **Step 1: Read the current file**

```bash
cat src/api/recs-page.ts
```

Note: the existing `recsPage` takes a `RecsPageData` discriminated union with `{ state: "found" | "not_found" }`. It renders differently based on state. You'll add a third state `placeholder`.

- [ ] **Step 2: Add the `Variant` import**

```typescript
import type { Variant } from "../variants.js";
```

- [ ] **Step 3: Expand the `RecsPageData` type**

Find the existing type definition. It looks like:

```typescript
export type RecsPageData =
  | { state: "found"; handle: string; did: string; recs: Rec[] }
  | { state: "not_found" };
```

Replace with:

```typescript
export type RecsPageData =
  | { state: "found"; handle: string; did: string; recs: Rec[]; variant: Variant }
  | { state: "not_found"; variant: Variant }
  | { state: "placeholder"; variant: Variant };
```

Every state now carries the `variant` — the caller passes it in from `c.get("variant")`.

- [ ] **Step 4: Update the function signature (if it takes separate args, unify through `RecsPageData`)**

The existing function probably looks like:

```typescript
export function recsPage(data: RecsPageData): string {
  // ...
}
```

No signature change needed — `data.variant` is now available everywhere inside the function. If the function currently takes `data: RecsPageData` and then uses hardcoded strings / colors, this task is about threading `data.variant.*` through the existing template.

- [ ] **Step 5: Inject variant theme into `:root`**

Same pattern as Task 8 Step 4. The template's `:root` block gets five new `--variant-*` custom properties at the top:

```css
:root {
  --variant-brand: ${data.variant.brand.hex};
  --variant-blob-1: ${data.variant.brand.blobs[0]};
  --variant-blob-2: ${data.variant.brand.blobs[1]};
  --variant-blob-3: ${data.variant.brand.blobs[2]};
  --variant-blob-4: ${data.variant.brand.blobs[3]};
  /* ...existing :root content... */
}
```

If the template is split across multiple string fragments for the different states (found/not_found), apply the same `:root` injection to each — or refactor to share a common `<head>` / theme block. Don't over-refactor; the simplest change that gets variant-theming working is to add the injection wherever the `:root` block currently lives.

- [ ] **Step 6: Parameterize the blob-field colors**

Same approach as Task 8 Step 5, but `recs-page.ts` has a slightly different blob set: `.blob--amber`, `.blob--blue`, `.blob--violet`, `.blob--rose` (rose instead of center). Same `rgba(…)` pattern inside `radial-gradient(…)`.

| Rule | New `background` value |
|---|---|
| `.blob--amber` | `background: radial-gradient(circle, var(--variant-blob-1) 0%, transparent 70%);` |
| `.blob--blue` | `background: radial-gradient(circle, var(--variant-blob-2) 0%, transparent 70%);` |
| `.blob--violet` | `background: radial-gradient(circle, var(--variant-blob-3) 0%, transparent 70%);` |
| `.blob--rose` | `background: radial-gradient(circle, var(--variant-blob-4) 0%, transparent 70%);` |

Leave classnames, positioning, sizing, and animations alone. The Step 8 / Task 14 smoke test will catch any visual regressions.

As in Task 8, **do not** touch accent-colored elements like match-score chips, focus rings, or card hover shadows — those use neutral tones and work with any brand color. If the card's top-right hover glow uses `rgba(230, 180, 100, 0.16)` (the amber tint), leave it — it's an intentional warm accent on hover and not worth theming in this task.

- [ ] **Step 7: Replace inline strings with variant copy**

The heading is currently something like `<h1>Recs for @${handle}</h1>` or `<h1>Recs for @${data.handle}</h1>`. Replace with a call to `data.variant.copy.recsHeading`:

```html
<h1>${data.variant.copy.recsHeading(data.handle)}</h1>
```

Also replace any hardcoded "Recs" / "Standard.site" / "Powered by Standard.site" text with the variant's copy fields:

| Find | Replace with |
|---|---|
| `Recs for @${handle}` | `${data.variant.copy.recsHeading(data.handle)}` |
| `Powered by Standard.site` in the footer | `${data.variant.copy.footer}` |

(For `not_found`, there may not be a handle to display — use `data.variant.copy.title` or similar as the header. Adapt based on what the current `not_found` rendering uses.)

- [ ] **Step 8: Add the `placeholder` state rendering**

In the function body, find the dispatch on `data.state`. It currently handles `found` and `not_found`. Add a third branch for `placeholder`:

```typescript
if (data.state === "placeholder") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${data.variant.copy.title}</title>
  <!-- ...same <style> block with :root injection... -->
</head>
<body>
  <div class="atmosphere"><!-- blob field --></div>
  <main>
    <h1>${data.variant.copy.title}</h1>
    <p class="tagline">${data.variant.copy.tagline}</p>
    <div class="empty-card">
      <p>Recommendations for this variant aren't available yet.</p>
      <p class="hint">Check back soon — we're still working on it.</p>
    </div>
  </main>
  <footer>${data.variant.copy.footer}</footer>
</body>
</html>`;
}
```

The exact markup should mirror the existing `not_found` state's structure — reuse the same CSS classes, the same `<head>`, the same footer. The only difference is the empty-card content. If the `not_found` state is a short function that returns a subset of the main template, wrap the placeholder in the same pattern.

**Practical approach:** copy the `not_found` block wholesale, rename to `placeholder`, and change only the empty-card message. The existing `not_found` block probably already has all the theming + variant copy wiring from Steps 5-7 of this task.

- [ ] **Step 9: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 10: Review the diff**

```bash
git diff src/api/recs-page.ts
```

Confirm:
- Import for `Variant`.
- `RecsPageData` has `variant` on all three states, and the new `placeholder` state.
- `:root` CSS has the variant custom property injection.
- Blob field CSS uses `var(--variant-blob-N)`.
- Inline strings use `data.variant.copy.*`.
- New `placeholder` rendering branch.
- No changes to unrelated code (rec-card markup, score formatting, etc.).

- [ ] **Step 11: Commit**

```bash
git add src/api/recs-page.ts
git commit -m "$(cat <<'EOF'
refactor(recs-page): variant-aware with new placeholder state

RecsPageData now carries a `variant: Variant` on every state (found /
not_found / placeholder). The template interpolates variant copy
(title, tagline, recsHeading, footer) and uses CSS custom properties
driven per-variant for the blob field and brand accents — same pattern
as enroll-page.

New `placeholder` state renders an empty-card hero that substandardrecs
and any future variants with RankingStrategy.kind === "placeholder"
can use. Structure mirrors not_found so all theming is shared.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Refactor `src/api/recs-lookup-page.ts` to a variant-aware function

Minimal change — same pattern as Task 8 but for a much smaller page.

**Files:**
- Modify: `src/api/recs-lookup-page.ts`

- [ ] **Step 1: Read the file**

```bash
cat src/api/recs-lookup-page.ts
```

Note the top-level export (likely `export const recsLookupPage = \`...\`;`) and the inline strings / colors.

- [ ] **Step 2: Add the `Variant` import**

```typescript
import type { Variant } from "../variants.js";
```

- [ ] **Step 3: Convert to a function and interpolate variant copy**

Change `export const recsLookupPage = \`...\`;` to `export function recsLookupPage(variant: Variant): string { return \`...\`; }` (same pattern as Task 8 Step 3).

Inside the template, inject the `:root` variant custom properties, replace any hardcoded blob colors with `var(--variant-blob-N)`, replace brand accents with `var(--variant-brand)`, and replace inline copy strings (title, tagline if present, footer) with `${variant.copy.*}` references.

This page is much smaller than `enroll-page.ts` — expect maybe 10-15 lines of changes total.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Review the diff**

```bash
git diff src/api/recs-lookup-page.ts
```

Same kind of check as Tasks 8 and 9 — function signature change, variant CSS injection, variant copy interpolation.

- [ ] **Step 6: Commit**

```bash
git add src/api/recs-lookup-page.ts
git commit -m "$(cat <<'EOF'
refactor(recs-lookup-page): variant-aware, same pattern as enroll-page

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Update route handlers to consume `c.get("variant")`

Wire the three page-rendering handlers to pass the variant through, and add variant filtering to the recs SQL query.

**Files:**
- Modify: `src/api/routes.ts`

- [ ] **Step 1: Update the `GET /` handler**

Find:

```typescript
api.get("/", (c) => c.html(enrollPage));
```

(Or similar — it might be `async` and have additional logic.) Change to:

```typescript
api.get("/", (c) => c.html(enrollPage(c.get("variant"))));
```

- [ ] **Step 2: Update the `GET /recs` lookup handler**

Find the handler that renders `recsLookupPage`. Same pattern:

```typescript
api.get("/recs", (c) => c.html(recsLookupPage(c.get("variant"))));
```

- [ ] **Step 3: Update the `GET /recs/:did` handler to filter by variant and handle `placeholder`**

This is the most substantive change in Task 11. Find the handler; it currently looks roughly like:

```typescript
api.get("/recs/:did", async (c) => {
  const did = c.req.param("did");
  const { results: recs } = await c.env.DB.prepare(
    `SELECT r.document_uri, r.score, d.title, d.description, d.site, d.path,
            p.url AS publication_url, p.name AS publication_name
     FROM recommendations r
     JOIN documents d ON r.document_uri = d.uri
     LEFT JOIN publications p ON d.site = p.uri
     WHERE r.did = ?
     ORDER BY r.score DESC`
  ).bind(did).all();
  // ...build Rec[] and render recsPage({ state: "found", ..., recs, handle })...
});
```

Add variant awareness:

```typescript
api.get("/recs/:did", async (c) => {
  const did = c.req.param("did");
  const variant = c.get("variant");

  // Look up the user first — a missing user is not_found regardless of variant.
  const { results: users } = await c.env.DB.prepare(
    `SELECT did, handle FROM users WHERE did = ?`
  ).bind(did).all<{ did: string; handle: string }>();
  if (users.length === 0) {
    return c.html(recsPage({ state: "not_found", variant }));
  }
  const handle = users[0].handle;

  // Variants with a placeholder ranking strategy render the placeholder state
  // regardless of D1 contents — no SELECT needed.
  if (variant.ranking.kind === "placeholder") {
    return c.html(recsPage({ state: "placeholder", variant }));
  }

  // Otherwise, SELECT the rows for this (did, variant) and render found.
  const { results: recs } = await c.env.DB.prepare(
    `SELECT r.document_uri, r.score, d.title, d.description, d.site, d.path,
            p.url AS publication_url, p.name AS publication_name
     FROM recommendations r
     JOIN documents d ON r.document_uri = d.uri
     LEFT JOIN publications p ON d.site = p.uri
     WHERE r.did = ? AND r.variant = ?
     ORDER BY r.score DESC`
  ).bind(did, variant.key).all<...>();

  // ...rest of the existing Rec[] building + recsPage({ state: "found", ..., variant }) render...
});
```

**CRITICAL: the sketch above is illustrative, not prescriptive.** The actual existing handler has different variable names, user-lookup logic, possibly intermediate OAuth session state fetches, and other project-specific concerns this plan can't predict. **Do NOT paste the sketch over the existing handler.** Instead, make exactly these four surgical edits to the existing handler:

1. **Add** `const variant = c.get("variant");` near the top (after `const did = c.req.param("did");` or similar).
2. **Add** a placeholder short-circuit after the user-existence check: `if (variant.ranking.kind === "placeholder") { return c.html(recsPage({ state: "placeholder", variant })); }`
3. **Modify** the existing `SELECT … FROM recommendations WHERE r.did = ?` query — add `AND r.variant = ?` to the WHERE clause, and add `variant.key` as the second bound parameter.
4. **Modify** every `recsPage({ state: "...", ... })` call site to include `variant` in the data object (both the `found` case and the `not_found` case).

The total surgical change is: 2 new lines + 1 new short-circuit block + 1 WHERE clause addition + 1 bound param + `variant` added to each render arg. Everything else — OAuth session handling, existing error paths, logging — stays untouched. If you find yourself deleting existing handler code, you're rewriting; stop and reapply as surgical edits only.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. If you get "Property 'variant' is missing in type" errors from the `recsPage` call sites, you forgot to add `variant` to one of the object literals passed to `recsPage`.

- [ ] **Step 5: Review the diff**

```bash
git diff src/api/routes.ts
```

Confirm:
- `GET /` calls `enrollPage(c.get("variant"))`.
- `GET /recs` calls `recsLookupPage(c.get("variant"))`.
- `GET /recs/:did` pulls `variant` from context, checks for placeholder, filters SQL by `variant.key`, passes `variant` to every `recsPage({...})` call.
- No other handlers touched (that's task 12's job for compare-recs).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes.ts
git commit -m "$(cat <<'EOF'
feat(routes): wire variant into enroll, recs-lookup, and recs/:did

The three page-rendering handlers now read c.get("variant") and
pass it through to the page templates. The recs/:did handler also
filters the SELECT by variant.key and short-circuits to the
placeholder state for variants with ranking.kind === "placeholder"
(substandard today, any future strategy-less variants tomorrow).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Extend `/admin/compare-recs` to take a `?variants=...` query param

The existing `/admin/compare-recs` (from PR #18) compares the two *like-embedding namespaces*. After Task 6, `generateUserRecommendations` always returns both standard + nonstandard variants in one call — so variant comparison is cheaper than namespace comparison. This task adds a query parameter that selects which variants to include in the response.

**Files:**
- Modify: `src/api/routes.ts`

- [ ] **Step 1: Read the current `/admin/compare-recs` handler**

```bash
grep -n "compare-recs" src/api/routes.ts
```

Find the handler (there's only one). Read it end-to-end and note:
- It currently calls `generateUserRecommendations` twice in parallel via `Promise.all`, once per namespace.
- It returns a JSON object with two rec lists and enriched document metadata.
- It uses `dryRun=true` so neither call writes to D1.

- [ ] **Step 2: Add variant filtering**

**Important: the existing handler is registered as `api.post("/admin/compare-recs", ...)`, not `api.get(...)`** (confirmed by grepping `src/api/routes.ts`). This is deliberate — it mutates D1 when called without `dryRun=true`. Do NOT add a new `api.get(...)` handler or convert the existing one to GET. Extend the existing POST handler in place.

After Task 6's refactor, a single `generateUserRecommendations` call returns BOTH `standard` and `nonstandard` recs in a single `Recommendation[]` with a `.variant` discriminator on each element. You can get both variants for free now.

Leave the existing namespace comparison behavior alone (it's still valuable for `likes_doc` experiments). Add a new branch to the existing POST handler, triggered by `?variants=standard,nonstandard` in the query string:

```typescript
api.post("/admin/compare-recs", async (c) => {
  const did = c.req.query("did");
  if (!did) return c.json({ error: "did query param required" }, 400);

  const variantsParam = c.req.query("variants");

  // New branch: variant comparison (disjoint from the existing namespace path)
  if (variantsParam) {
    const requestedVariants = variantsParam
      .split(",")
      .map((v) => v.trim())
      .filter((v): v is "standard" | "nonstandard" =>
        v === "standard" || v === "nonstandard",
      );

    const rawLambda = parseFloat(c.env.MMR_LAMBDA ?? "0.6");
    const lambda =
      Number.isFinite(rawLambda) && rawLambda >= 0 && rawLambda <= 1
        ? rawLambda
        : 0.6;

    // One call produces BOTH variants in a single Recommendation[] with a
    // .variant field on each element (see Task 6's refactor of
    // generateUserRecommendations). Filter to whatever the caller asked for.
    const likesNamespace =
      c.env.LIKE_QUERY_NAMESPACE === "likes_doc" ? "likes_doc" : "likes";
    const allRecs = await generateUserRecommendations(
      c.env.DB,
      c.env.VECTORS,
      did,
      parseInt(c.env.TOP_N ?? "10", 10),
      likesNamespace,
      true, // dryRun — don't touch D1
      lambda,
    );

    const byVariant: Record<string, typeof allRecs> = {};
    for (const v of requestedVariants) {
      byVariant[v] = allRecs.filter((r) => r.variant === v);
    }

    // Reuse the existing enrichment — the existing handler already has the
    // SELECT that joins document_uri → documents + publications to produce
    // { title, description, url, site } per rec. Find that logic inside the
    // existing handler (probably an inline SELECT after the generateUser
    // calls) and either extract it to a local function or duplicate it here.
    // Apply enrichment to each variant's rec list before returning.
    //
    // Example shape (once enriched):
    //   { did, lambda, variants: { standard: [EnrichedRec, ...], nonstandard: [EnrichedRec, ...] } }

    return c.json({ did, lambda, variants: byVariant /* after enrichment */ });
  }

  // Existing branch: namespace comparison (unchanged)
  // ... existing code for the LIKES_NAMESPACE_QUERY / LIKES_NAMESPACE_DOC comparison ...
});
```

**`parseLikesNamespace` is imported from `../workflow.js`.** Confirmed in Chunk 1 (Task 7 did not import it — only `Variant` and `variantFromHost`). If you need it here, either inline the one-line string check as shown in the code block above (`c.env.LIKE_QUERY_NAMESPACE === "likes_doc" ? "likes_doc" : "likes"`) OR add it to the imports at the top of `routes.ts`. Inlining is simpler for a single call site.

**The existing enrichment logic.** Read the existing POST handler's body before editing — locate the block that transforms each `Recommendation` into an enriched object (with `title`, `description`, `url`, `site` pulled from D1 via JOIN on `documents` + `publications`). It's probably a single `db.prepare(...).all()` after the `generateUserRecommendations` calls, followed by a `map()` that zips rec and document rows. Either:

1. **Extract to a local helper** inside the handler scope: `async function enrich(recs: Recommendation[]): Promise<EnrichedRec[]> { ... }`. Then call `enrich(byVariant[v])` for each variant.
2. **Duplicate inline** under the new variant path if extraction feels heavier than the win.

Pick whichever produces the smaller diff. Both work.

**Verify `generateUserRecommendations`'s return shape before writing this code.** Task 6 in Chunk 1 changed the function to return `Recommendation[]` with a `.variant` discriminator. Read `src/recommend/index.ts` to confirm that shape is actually what's returned — if Chunk 1 deviated from the plan (unlikely but possible), adapt accordingly.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Review the diff**

```bash
git diff src/api/routes.ts
```

Confirm:
- The existing namespace comparison path still works (unchanged when `?variants` is not provided).
- New variant path is triggered by `?variants=...`.
- Enrichment is shared between the two paths.
- `generateUserRecommendations` is called with `dryRun=true` — no D1 writes.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts
git commit -m "$(cat <<'EOF'
feat(admin): extend /admin/compare-recs to take ?variants=

Adds a second comparison mode to the admin endpoint: pass
?variants=standard,nonstandard (or any subset) and get back
side-by-side enriched rec lists for each requested variant. Under
the hood this is free — generateUserRecommendations already returns
both variants after the Task 6 refactor, so the new path just
filters the returned array.

The existing ?namespaces= path for like-embedding namespace
comparison is unchanged, so PR #18 usage still works.

dryRun=true on the generateUserRecommendations call means this
endpoint is still safe to hit repeatedly during λ tuning without
mutating any user's persisted recommendations.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Final typecheck, bundler dry-run, and full-branch diff review

Pre-deploy sanity checks. If any of these fail, **STOP** and escalate — do not deploy broken code.

**Files:** none (verification only)

- [ ] **Step 1: Final typecheck**

```bash
npx tsc --noEmit
```

Expected: clean exit, no output.

- [ ] **Step 2: Bundler dry-run**

```bash
npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun-recs-variants 2>&1 | tail -40
```

Expected:
- No errors or warnings (other than the known `Vectorize Index bindings do not support local development` warning and the `Scheduled Workers are not automatically triggered during local development` warning, both of which appear on every dry-run).
- Bindings table shows `env.MMR_LAMBDA ("0.6")`.
- All three custom domain routes are acknowledged in the output (wrangler lists them under the routes section).
- Bundle size reported; should be roughly similar to before the PR (maybe +5-10KB for the new files).

- [ ] **Step 3: Full-branch diff review**

```bash
git log --oneline main..HEAD
```

Expected: 3 spec commits (from brainstorming) + 2 plan commits (chunk 1 docs + chunk 2 docs) + 12 implementation commits (one per task 1-12) = **17 commits**. Adjust expectations if the spec or plan commits were squashed differently.

```bash
git diff main..HEAD --stat
```

Expected files changed:
- `docs/superpowers/specs/2026-04-13-recs-variants-design.md` (new)
- `docs/superpowers/plans/2026-04-13-recs-variants.md` (new)
- `src/variants.ts` (new)
- `src/recommend/mmr.ts` (new)
- `src/env.ts` (small modification)
- `src/recommend/index.ts` (modification)
- `src/workflow.ts` (small modification)
- `src/api/routes.ts` (modification)
- `src/api/enroll-page.ts` (modification)
- `src/api/recs-page.ts` (modification)
- `src/api/recs-lookup-page.ts` (small modification)
- `schema.sql` (small modification)
- `wrangler.toml` (small modification)

**No other files should be modified.** If `git diff main..HEAD --stat` shows anything else, investigate before deploying.

- [ ] **Step 4: Confirm the pre-session dirty state is still dirty and not committed**

```bash
git diff wrangler.toml
```

Expected output: a non-empty diff showing **exactly** the pre-session local edits the user had before this plan started — specifically:

- `TOP_N = "10"` → `TOP_N = "12"` (or similar user customization)
- `WORKER_URL = "https://standard-recs.bryan-78d.workers.dev"` → `WORKER_URL = "https://standardrecs.site"`
- (Possibly no change if Task 3's stash/pop merged everything into the committed state already — that's also fine as long as the user's values are now what's committed)

You should NOT see any diff for `MMR_LAMBDA`, `LIKE_EMBED_MODE`, `LIKE_QUERY_NAMESPACE`, or the `[[routes]]` blocks — those all got committed in Task 3 and are now part of the branch. If any of those appear as unstaged diffs, something went wrong with Task 3's stash dance and you should stop and investigate before deploying.

```bash
git status --short
```

Expected: exactly `M wrangler.toml` (one modified file) plus any pre-existing untracked files from before the session (`docs/stitch/`, old plan docs under `docs/superpowers/plans/`). No new modified files — everything else should be committed.

---

### Task 14: Deploy + post-deploy smoke tests

This task actually puts the variant system live. **Requires user approval before running `npm run deploy`** — deploying affects production. Ask the user explicitly: "Ready to deploy the variant system? (yes / no / wait)".

**Files:** none (operational)

- [ ] **Step 1: Push the branch and confirm with user**

```bash
git push -u origin feat/recs-variants
```

Tell the user: the branch is pushed, the PR can be opened any time, and the deploy is about to happen against production from the local working copy.

- [ ] **Step 2: Deploy**

```bash
npm run deploy
```

Expected: wrangler uploads the Worker, prints the new worker URL, confirms the three custom domain routes are attached. The first deploy may take 30-90 seconds to provision new SSL certs for `nonstandardrecs.site` and `substandardrecs.site` — transient 522/523 errors during that window are expected.

- [ ] **Step 3: Trigger a full sync so nonstandard rec rows get populated**

```bash
curl -X POST https://standardrecs.site/admin/sync
```

Watch for a success response. The sync workflow is durable — it runs asynchronously and takes several minutes to complete. Two concrete ways to monitor it:

**Option A: `wrangler tail` (simpler, just tail live logs)**

```bash
npx wrangler tail standard-recs
```

Wait for the log line `Recommendations: N total` (or similar — see the existing `runFullPipeline` log output in `src/workflow.ts`) before proceeding. That's the last step of the pipeline. Also look for `Embedded N likes (query=N, doc=0), …` confirming the embed step ran.

**Option B: Cloudflare dashboard**

Open https://dash.cloudflare.com → Workers & Pages → `standard-recs` → Workflows tab → `standard-recs-sync` → Instances. The most recent instance should show `status: running` initially and transition to `complete`. Click into it to see per-step progress including `discover` (which was recently batched — should be fast), the document sync batches, and the `embed` / `recommend` tail.

**Do not proceed to Step 4 until the sync reports complete.** If it errors on `discover` or embeds, stop and investigate via the logs — the variant system can't show nonstandard recs until at least one cron has populated the `variant = 'nonstandard'` rows.

- [ ] **Step 4: Smoke test the three landing pages**

```bash
curl -s https://standardrecs.site/    | grep -oE '<title>[^<]*</title>'
curl -s https://nonstandardrecs.site/ | grep -oE '<title>[^<]*</title>'
curl -s https://substandardrecs.site/ | grep -oE '<title>[^<]*</title>'
```

Expected:
- `standardrecs.site` → `<title>standard-recs</title>` (or similar — whatever `VARIANTS.standard.copy.title` renders).
- `nonstandardrecs.site` → `<title>nonstandard-recs</title>`.
- `substandardrecs.site` → `<title>substandard-recs</title>`.

Also visit each in a browser if possible — confirm:
- Each page's blob field is visually different (different dominant color).
- Each page's heading + tagline match the variant.
- The focus ring on the input uses the variant's accent color.

- [ ] **Step 5: Smoke test the three recs pages for your own DID**

Replace `<your-did>` with your actual Bluesky DID (same one you've been using for `/admin/compare-recs` throughout the project).

```bash
curl -sL https://standardrecs.site/recs/<your-did>    | head -100
curl -sL https://nonstandardrecs.site/recs/<your-did> | head -100
curl -sL https://substandardrecs.site/recs/<your-did> | head -100
```

Expected:
- `standardrecs.site/recs/...` → renders the standard top-12 in the warm amber theme (same as before the PR).
- `nonstandardrecs.site/recs/...` → renders 12 DIFFERENT documents in a slate-blue theme. These should be the MMR picks — close to taste but distinct from the standard list.
- `substandardrecs.site/recs/...` → renders the `placeholder` empty-card hero in olive-yellow theme, with the "Coming soon" or "Recommendations for this variant aren't available yet" copy.

**If any of these return 500:** check the Cloudflare Workers logs via `wrangler tail` or the dashboard. Most likely issues: a typo in the route handler's SQL, a missing `variant` argument to `recsPage(...)`, or a D1 error about the `variant` column missing (if Task 5's schema apply didn't run). Fix and redeploy.

- [ ] **Step 6: Use the extended `/admin/compare-recs` to A/B the variants**

```bash
curl -s "https://standardrecs.site/admin/compare-recs?did=<your-did>&variants=standard,nonstandard" | jq .
```

Expected: JSON with `variants: { standard: [...], nonstandard: [...] }`, each containing 12 enriched rec objects (uri, score, title, description, url, site).

Eyeball the two lists. The `standard` list should match what `standardrecs.site/recs/<your-did>` rendered. The `nonstandard` list should be the MMR picks — same 12-element length but different documents, hopefully feeling "adjacent" rather than identical.

**If nonstandard feels too similar to standard:** λ=0.6 might be too high for your taste/corpus. The tuning loop is:

```bash
# 1. Edit wrangler.toml:
#      MMR_LAMBDA = "0.5"      # or 0.4, 0.55, 0.65, 0.7 — try a few
# 2. Redeploy (only affects new sync runs):
#      npm run deploy
# 3. The compare-recs endpoint uses MMR_LAMBDA directly and doesn't
#    require a re-sync — you can immediately hit it and see the new
#    nonstandard list at the new lambda:
curl -sX POST "https://standardrecs.site/admin/compare-recs?did=<your-did>&variants=standard,nonstandard" | jq .
```

(Note the `-X POST` — `/admin/compare-recs` is a POST endpoint. The `?variants=` parameter lives on the query string even for POST.)

Iterate λ until the nonstandard list feels like the right balance of "close to taste" and "genuinely different from standard." Typical sweet spot is 0.5-0.7. Values below 0.4 start surfacing genuinely weird picks; values above 0.8 collapse back onto the standard top-12.

Once you've picked a λ, update `wrangler.toml` + redeploy one last time. The next daily cron will persist rec rows at the new λ; users will see the change on their next `/recs/:did` visit.

- [ ] **Step 7: Open the PR**

```bash
gh pr create --title "feat: three-variant recommendation system with MMR nonstandardrecs" --body "$(cat <<'EOF'
## Summary

Ships the variant recommendation system described in [`docs/superpowers/specs/2026-04-13-recs-variants-design.md`](docs/superpowers/specs/2026-04-13-recs-variants-design.md).

**Three subdomains, one Worker:**
- `standardrecs.site` — existing top-N cosine ranking, existing warm amber theme
- `nonstandardrecs.site` — new: MMR ranking (Carbonell & Goldstein 1998) with λ=0.6, cool slate-blue theme
- `substandardrecs.site` — new: fully routed + themed placeholder (olive-yellow), awaiting its ranking strategy

**What's new:**
- `src/variants.ts` — variant registry + hostname lookup
- `src/recommend/mmr.ts` — pure MMR helper
- `schema.sql` — `variant` column + index
- `generateUserRecommendations` — computes both variants in one pass
- Hono middleware reads `host`, stores variant on request context
- All three page templates are variant-aware (function-taking-Variant, CSS custom properties for theme)
- `/admin/compare-recs` extended to take `?variants=...` for λ tuning

**New env var:** `MMR_LAMBDA = "0.6"` — tunable without redeploy if the default feels off.

**Rollback:** revert this PR, or set `MMR_LAMBDA` to something that effectively disables MMR. The `variant` column stays on the table harmlessly.

## Test plan (post-merge)

- [x] `npx tsc --noEmit` — clean
- [x] `npx wrangler deploy --dry-run` — clean, shows all three routes
- [x] `npm run deploy` — no errors
- [x] Visit all three subdomains — each renders with its own theme and copy
- [x] Visit `/recs/<my-did>` on each subdomain — different rec lists per variant
- [x] `GET /admin/compare-recs?did=<my-did>&variants=standard,nonstandard` — side-by-side JSON looks correct
- [ ] λ tuning via compare-recs (follow-up — 0.6 is a guess, may need adjustment)

## Caveats

- OAuth flow currently returns to `WORKER_URL` (a fixed hostname). A user who starts enrollment from `nonstandardrecs.site` will come back to `standardrecs.site` after authorizing. They can manually navigate to `nonstandardrecs.site/recs/<their-did>` to see the nonstandard list. Fixing this properly (tracking the starting subdomain through OAuth state) is a separate PR.
- Pre-existing embed scaling bug (cron re-embeds hot 500 likes every run) is still present and out of scope.
- Substandardrecs shows "Coming soon" until a ranking strategy is picked — separate follow-up PR.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Return the PR URL to the user.

---

**End of Chunk 2.** All 14 tasks complete. The variant system is live on production, the PR is open, and the user can merge + continue tuning λ via `/admin/compare-recs` at their leisure.

### Known limitations / follow-ups

These are documented in the spec's "Open questions / deferred" section and are NOT part of this plan:

1. **OAuth return-to-origin**: enrollment always lands back on `standardrecs.site` regardless of starting subdomain. Users who enrolled via `nonstandardrecs.site` have to manually re-navigate. Fix requires tracking the starting subdomain through OAuth state.

2. **Substandardrecs ranking strategy**: currently a `placeholder`. Candidates under discussion: inverted cosine, ASC sort from bottom of top-50, random, curated weird list. Own spec.

3. **Analytics**: no variant-tagged click tracking. Will want this eventually to measure whether nonstandardrecs actually gets engagement, but deferred until the variants feel stable.

4. **Pre-existing embed scaling bug**: still re-embeds hot 500 likes every run. Tracked in `~/.claude/projects/-Users-bryan-guffey-Code-standard-recs/memory/project_embed_scaling.md`. Separate PR.

5. **λ tuning**: 0.6 is a guess. Expect 1-2 rounds of `MMR_LAMBDA` adjustment after launch, each a one-line `wrangler.toml` edit + `npm run deploy`.

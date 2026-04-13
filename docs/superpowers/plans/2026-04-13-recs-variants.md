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

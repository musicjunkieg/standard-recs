# Recommendation Variants: Design

**Date:** 2026-04-13
**Status:** Approved for implementation
**Author:** Bryan Guffey (design), Claude (scribe)

## Motivation

`standardrecs.site` already recommends Standard.site writing based on Bluesky likes via a classic top-N cosine similarity pipeline. Two companion products are planned:

- **`nonstandardrecs.site`** — "You'd never pick this. Trust us." Deliberate serendipity — high cosine to taste but *not* the obvious nearest-neighbor picks. A curated "near miss" feel.
- **`substandardrecs.site`** — "You'll hate these." Intentionally bad recommendations, as a bit.

All three sites are served by **one Cloudflare Worker** (same pipeline, same embeddings, same Vectorize index, same D1 database) with the ranking strategy selected by hostname. The interesting technical problem is `nonstandardrecs`: what does "surprising but trustworthy" actually mean in a 1024-dimensional embedding space?

This spec covers the **variant infrastructure** plus **`nonstandardrecs`'s MMR ranking** as the first concrete non-standard strategy. It leaves a placeholder hook for `substandardrecs` so the subdomain can be routed and rendered end-to-end even before the anti-rec algorithm is picked.

## Scope

**In scope:**

- A variant abstraction (`Variant` type, `VARIANTS` registry, `HOSTNAME_TO_VARIANT` lookup).
- Hono middleware that reads `host` and stores the matched variant on the request context.
- Three `[[routes]]` blocks in `wrangler.toml` so one Worker serves all three subdomains as custom domains.
- Schema change: add `variant` and `rank` columns to the `recommendations` table as first-class columns on the CREATE TABLE statement, plus an index on `(did, variant)`. Historical ad-hoc ALTERs are preserved as commented migration history at the bottom of `schema.sql`.
- `generateUserRecommendations()` computes *all* enabled variants for a user in one pass and writes them in a single D1 batch. Each rec carries a `rank` value that preserves the original pick order (for MMR: the greedy selection sequence; for top-N: the cosine-descending order).
- **Nonstandard ranking via MMR (Maximal Marginal Relevance)** — Carbonell & Goldstein 1998. λ=0.6, tunable via new `MMR_LAMBDA` env var.
- Theme refactor: the existing enroll + recs page templates move from hardcoded colors to CSS custom properties driven per-variant at render time.
- Per-variant copy (title, tagline, input placeholder, recs heading, footer message) lives in `VARIANTS`.
- Substandardrecs variant is fully registered, routed, and renders a "Coming soon" placeholder. No ranking yet.

**Out of scope:**

- The actual substandardrecs ranking algorithm. Follow-up PR. Candidates discussed but not picked: inverted cosine, ASC sort from bottom of top-50, random selection, or a curated weird list.
- Per-variant analytics / click tracking. Useful for measuring the experiment, but a separate spec — drag it in only when the variants feel worth measuring.
- Full visual identity redesigns for the variants (different fonts, different layouts, different blob compositions beyond recoloring). The "string + accent color" approach is deliberately the cheaper path so the ranking work stays the star.
- Changes to the existing sync pipeline (likes ingest, publisher discovery, document embedding). Those are orthogonal.
- Fixing the pre-existing scaling bugs documented in `memory/project_embed_scaling.md`. Still scoped to their own future PR.

## Architecture

### Variant model

A variant is the tuple of everything that differs between the three sites:

```ts
// src/variants.ts

export type RankingStrategy =
  | { kind: "topN" }
  | { kind: "mmr" }
  | { kind: "placeholder" };
// Future: | { kind: "antiTopN" } | { kind: "random" } | etc.
//
// Note: the `mmr` arm does NOT carry `lambda` or `candidatePool`. See
// src/variants.ts for the authoritative type. MMR_LAMBDA comes from env
// (parsed by parseMmrLambda in workflow.ts); CANDIDATE_POOL is hardcoded
// at 50 in src/recommend/index.ts because it's pinned by Vectorize's
// per-query cap with returnMetadata="all". Adding those as per-variant
// knobs would require wiring them through the recommend flow with env
// fallback — deferred until a variant actually needs different values.

export type Variant = {
  key: "standard" | "nonstandard" | "substandard";
  hostname: string;
  brand: {
    hex: string;                          // primary accent color
    blobs: [string, string, string, string]; // 4 atmospheric blob colors
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
  standard: { /* existing look + top-N ranking */ },
  nonstandard: { /* slate-blue theme + MMR ranking */ },
  substandard: { /* olive-yellow theme + placeholder */ },
};

export const HOSTNAME_TO_VARIANT: Record<string, Variant["key"]> = {
  "standardrecs.site": "standard",
  "nonstandardrecs.site": "nonstandard",
  "substandardrecs.site": "substandard",
};

export function variantFromHost(host: string | undefined): Variant {
  const key = (host && HOSTNAME_TO_VARIANT[host]) ?? "standard";
  return VARIANTS[key];
}
```

Unknown hostnames default to `standard` so a misrouted request can't 404 the Worker off the air.

### Hostname routing via Hono middleware

`src/api/routes.ts` gains a middleware that runs before all downstream handlers:

```ts
api.use("*", async (c, next) => {
  const variant = variantFromHost(c.req.header("host"));
  c.set("variant", variant);
  await next();
});
```

**The existing Hono type parameter must be expanded** so `c.set("variant", ...)` and `c.get("variant")` are type-safe:

```ts
// today
const api = new Hono<{ Bindings: Env }>();

// after
const api = new Hono<{ Bindings: Env; Variables: { variant: Variant } }>();
```

Without the `Variables` map, TypeScript infers the variant context as `unknown` and the downstream handlers fail to typecheck on field access. Importing `Variant` from `../variants.js` into `routes.ts` is part of this task.

Downstream handlers read the variant via `c.get("variant")`:

```ts
api.get("/", (c) => c.html(enrollPage(c.get("variant"))));
api.get("/recs/:did", async (c) => { /* select where variant = c.get("variant").key */ });
```

The variant-awareness is concentrated in the middleware — the actual handlers only care about the variant at two points (which page template to call, which D1 rows to SELECT). Adding a fourth variant later doesn't require touching the handlers at all, only `variants.ts` and the wrangler routes.

### Cloudflare routing

`wrangler.toml` gets two new `[[routes]]` blocks alongside the existing `standardrecs.site` route:

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

All three subdomains are already on Cloudflare DNS under the same account as the Worker, so `custom_domain = true` auto-provisions certs and CNAME records on deploy. Single Worker script, three routed hostnames. The first deploy can take ~60 seconds to fully propagate the certs — transient 522s during that window are expected and self-heal.

### Schema change

`schema.sql` describes the `recommendations` table's **final shape** directly via `CREATE TABLE IF NOT EXISTS`. Fresh databases bootstrapped via `npm run db:init` get the final columns on first run with no ALTERs required:

```sql
-- schema.sql

CREATE TABLE IF NOT EXISTS recommendations (
  did TEXT NOT NULL,
  document_uri TEXT NOT NULL,
  score REAL NOT NULL,
  variant TEXT NOT NULL DEFAULT 'standard',
  rank INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (did, document_uri),
  FOREIGN KEY (did) REFERENCES users(did),
  FOREIGN KEY (document_uri) REFERENCES documents(uri)
);

CREATE INDEX IF NOT EXISTS idx_recs_did_variant ON recommendations(did, variant);
```

**`variant`** is the discriminator used by the route handler's `WHERE r.variant = ?` predicate and by the SQL filter at read time. **`rank`** is a zero-indexed position within each variant that preserves the algorithm's original pick order — for standard this is top-N by cosine, for nonstandard it's the MMR greedy selection sequence (pick 0 = first pick, pick N-1 = biggest "trust us" stretch). Sorting by `r.score DESC` at read time would scramble the nonstandard list back into a cosine ordering, discarding the information MMR encoded in pick order, so the SELECT uses `ORDER BY r.rank ASC`.

**For the existing production database**, the two columns were applied ad-hoc during PR development:

```sql
-- applied 2026-04-13 via wrangler d1 execute --remote --command=...
ALTER TABLE recommendations ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE recommendations ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
```

These live as comments at the bottom of `schema.sql` under a "Migration history" section. SQLite's `ALTER TABLE ADD COLUMN` is idempotent-unsafe (errors on duplicate column), so the executable SQL in `schema.sql` is now a single `CREATE TABLE` that describes the final shape, and re-running `schema.sql` is safe on both fresh and already-migrated databases. No migration system: this project has a single production DB and a low schema-change cadence; if that changes, move the history to a real `migrations/` directory with timestamped files and a tracking table.

Existing pre-migration rows (all standard by definition) picked up `variant = 'standard'` and `rank = 0` via the column defaults. The next cron run's `generateUserRecommendations` rewrites every row with proper rank values, so the default-0 state is transient.

The PK stays `(did, document_uri)` without a `variant` column — **but this is load-bearing on an invariant every future ranking strategy must respect**:

- MMR explicitly excludes the standard top-12 from the nonstandard candidate pool (via `candidates.slice(topN)` in `generateUserRecommendations`, where `topN = parseInt(env.TOP_N, 10)` — the same value that sizes the standard rec list), so no document appears in both standard and nonstandard for the same user in the same run.
- Anti-recs will draw from the tail of the cosine ranking, disjoint from the top-12.
- **If a future `RankingStrategy` ever produces a document already in another variant for the same user, the INSERT will hit a PK conflict and fail.** The strategy author must guarantee disjointness, or this spec's PK decision must be revisited first (bump PK to `(did, document_uri, variant)`).
- YAGNI says don't bump the PK preemptively, but any reviewer of a new strategy should check this invariant.

The `idx_recs_did_variant` index makes `SELECT ... WHERE did = ? AND variant = ?` cheap. Without it, every recs request would scan the user's whole rec history across all variants.

### Data flow (request time)

1. Request arrives at Worker via one of the three routed hostnames.
2. Hono middleware reads `host`, looks up the matching `Variant`, stores it on the request context.
3. Route handler (`/`, `/recs/:did`, `/enroll`) reads `c.get("variant")`.
4. For `/recs/:did`:
   - If the user doesn't exist → `not_found` state. (unchanged behavior)
   - Else if `variant.ranking.kind === "placeholder"` → `placeholder` state, skip the D1 SELECT entirely. (This is the substandardrecs case — there are no rows to fetch, and the page should render the placeholder-themed empty hero.)
   - Else → SQL adds `WHERE r.variant = ?` bound to `variant.key`, and the result goes into `found` state. (If the SELECT returns zero rows, the recs page falls back to its existing "syncing, refresh in 30s" empty state — that's the pre-sync-complete case and is distinct from the `placeholder` case.)
5. Page renderer (`enrollPage(variant)` or `recsPage({ ..., variant })`) interpolates variant copy and emits a `<style>:root { --variant-brand: …; --variant-blob-1: …; … }</style>` block so the theme applies.

### Data flow (cron time)

1. Existing sync → embed → recommend pipeline runs.
2. `generateUserRecommendations(user)` fetches taste vector (unchanged).
3. Vectorize query — **changes**: `topK: 50` (was `Math.min(topN * 2, 50)`) and `returnValues: true` (was `false`). **`returnMetadata: "all"` stays as-is** — it's already set in the current code and must remain set, because both the standard ranking and the enrichment step depend on `match.metadata.uri` being populated. The extra payload is needed because MMR's pairwise similarity check needs the candidate vectors. Combined response size with `returnMetadata: "all"` + `returnValues: true` at `topK=50`: roughly 200KB of vector data (50 × 1024 × 4 bytes) + maybe 50KB of document metadata ≈ **~250KB total**. Vectorize is a binding, not a subrequest, so the response lives in Worker memory (128MB default) — 250KB is rounding error. Still, **pre-deploy verification should explicitly assert the Vectorize response isn't truncated** by running the new query once against prod and confirming the returned array length is 50 and every match has `values` populated.
4. Standard top-12 = first 12 valid matches by raw cosine (current behavior, just at the top of the 50-element list).
5. Nonstandard top-12 = `pickMMR(candidates[12:], seed=standard[0:12], taste, k=12, lambda=0.6)`.
6. Substandard: skipped (ranking strategy is `placeholder`).
7. D1 batch: one `DELETE WHERE did = ?` wipes both variants, then `INSERT` rows for standard and nonstandard with explicit `variant` values. **Atomicity note:** if any step between the DELETE and the final batch commit throws, the user ends up with zero recs across both variants until the next cron. This is the same fragility the existing single-variant code already has, and we're not trying to fix it here — just noting it so a future planner doesn't accidentally "fix" the atomicity by restructuring the batch.
8. Returns `{ standard: 12, nonstandard: 12 }`.

## MMR ranking

New helper in `src/recommend/mmr.ts`, single pure function:

```ts
/**
 * Pick k items from candidates using Maximal Marginal Relevance.
 *
 * mmr_score(c) = lambda * cosine(c, taste)
 *              - (1 - lambda) * max_over_picked(cosine(c, picked))
 *
 * lambda=1 → ignore diversity (= top-k by relevance).
 * lambda=0 → maximize diversity from picked, ignore relevance.
 * lambda~0.6 → "trust us" sweet spot: still close to taste, but
 *              avoids the cluster centers already shown in `seed`.
 *
 * The `picked` set grows as each new pick is added, so the returned
 * items are also diverse from each other — not just from the seed.
 */
export function pickMMR(
  candidates: VectorizeMatch[],
  seed: VectorizeMatch[],
  tasteVector: number[],
  k: number,
  lambda: number,
): VectorizeMatch[] {
  const picked = [...seed];
  const result: VectorizeMatch[] = [];
  const remaining = [...candidates];

  while (result.length < k && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cVec = remaining[i].values!;
      const relevance = dot(cVec, tasteVector);
      // When picked is empty (only possible if seed was also empty),
      // collapse to pure relevance. Otherwise seed maxSim to -Infinity
      // so negative cosines (semantically opposed items) still count
      // toward the diversity penalty as required by the published
      // MMR formula. Clamping to 0 would silently mute the bonus for
      // anti-correlated items.
      let maxSim = picked.length > 0 ? -Infinity : 0;
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

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
```

**Why `dot` and not a full cosine formula:** Voyage embeddings are already L2-normalized, so `dot(a, b) === cosine(a, b)`. No need to renormalize per call.

**Complexity:** O(k × |candidates| × |picked|) ≈ 12 × 38 × 24 ≈ 11k dot products of 1024-dim vectors ≈ ~10M FLOPs per user per cron. Microseconds on a Worker.

**Score stored in D1:** the raw cosine (`dot(c, tasteVector)` for each picked candidate), *not* the MMR score. The MMR score is a transient picking metric — only meaningful relative to other candidates in the same pass. The raw cosine is what's meaningful at display time (the "87% match" chip on the recs card).

**λ selection:** default `0.6`. Configurable via a new env var `MMR_LAMBDA` so tuning doesn't require a redeploy. Parsed with a safe fallback:

```ts
const raw = parseFloat(env.MMR_LAMBDA ?? "0.6");
const lambda = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
```

**`topK: 50` coupling note.** The candidate pool size is hardcoded at 50 (the Vectorize per-query cap with `returnMetadata: "all"`). This implicitly assumes `TOP_N ≤ ~25` — today `TOP_N = 12`, leaving 38 candidates for the MMR pool, which is generous. If `TOP_N` is ever bumped above ~25, the MMR pool starves. Not a bug today, but worth a `topN * 2 <= 50` sanity check at pipeline-start and a note for anyone who touches `TOP_N` later.

## Theming

The existing templates use CSS custom properties for text colors (`--paper`, `--ink`, etc.) but hardcode the blob palette inline. Refactor:

```css
:root {
  --variant-brand: #d99566;
  --variant-blob-1: #d99566;
  --variant-blob-2: #7e9eba;
  --variant-blob-3: #a78bfa;
  --variant-blob-4: #d8a18b;
}
```

The default values in `:root` match the existing standard palette — a misrouted request still renders correctly. At render time, the page function injects a `<style>:root { /* variant overrides */ }</style>` block derived from `variant.brand`.

Inline `fill="#d99566"` attributes in the SVG blob field become `fill="var(--variant-blob-1)"`. About 30 minutes of mechanical refactor, split roughly evenly between `enroll-page.ts` and `recs-page.ts`.

**Placeholder blob palettes** (exact hexes to be tuned at implementation time):

| Variant | Brand hex | Mood |
|---|---|---|
| standard | `#d99566` (warm amber) | Existing — don't change |
| nonstandard | `#7e9eba` (slate-blue) | Cool, contemplative, "trust us" |
| substandard | `#a8b87c` (olive-yellow) | Sickly, off, "you've been warned" |

## Page templates become functions

Today both templates are top-level string constants. After the refactor:

```ts
// enroll-page.ts
export function enrollPage(variant: Variant): string {
  return `<!DOCTYPE html>...${variant.copy.title}...`;
}

// recs-page.ts
export type RecsPageData =
  | { state: "found"; handle: string; did: string; recs: Rec[]; variant: Variant }
  | { state: "not_found"; variant: Variant }
  | { state: "placeholder"; variant: Variant };

export function recsPage(data: RecsPageData): string {
  // dispatch on state, render with data.variant for theme + copy
}
```

The route handlers pass `c.get("variant")` into these functions. Interpolated string templates cost microseconds — no meaningful overhead vs. a constant.

## Per-variant copy

Lives entirely in `VARIANTS`:

| Field | standard | nonstandard | substandard |
|---|---|---|---|
| `title` | `standard-recs` | `nonstandard-recs` | `substandard-recs` |
| `tagline` | "Discover Standard.site writing based on what you like on Bluesky." | "You'd never pick this. Trust us." | "You'll hate these." |
| `placeholder` | "Start typing your handle…" | "Start typing your handle…" | "Don't say I didn't warn you…" |
| `recsHeading` | `Recs for @${h}` | `Adjacent picks for @${h}` | `Anti-recs for @${h}` |
| `footer` | "Powered by Standard.site" | "An experiment by standard-recs" | "An experiment by standard-recs" |

Final copy is locked at implementation time. These are the working strings.

## Substandardrecs: placeholder state

Substandardrecs is **fully registered** in `VARIANTS`, routed via `wrangler.toml`, and rendered with its own brand colors and copy. The ranking strategy is `{ kind: "placeholder" }` and `generateUserRecommendations()` skips substandard — no rows are written.

The recs page handles the empty case (zero rows returned from the variant SELECT) with a third discriminated state, `placeholder`, that renders an empty-card hero with the variant's tagline + a "check back soon" line, styled like the existing not-found card but with substandard's colors. Visiting `substandardrecs.site/` shows the landing page with its "You'll hate these" tagline. Visiting `substandardrecs.site/recs/<did>` shows the placeholder.

When the real ranking strategy is picked (follow-up spec), the change is:

1. One new arm in the `RankingStrategy` union (e.g., `{ kind: "antiTopN" }` or `{ kind: "random" }`).
2. One new branch in `generateUserRecommendations()` that generates substandard rows.
3. One field flip in `VARIANTS.substandard.ranking`.

No changes to the middleware, the routing, the schema, the page templates, or the theming. That's the payoff of designing the infrastructure as a cohesive variant system instead of bolting on nonstandardrecs alone.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/variants.ts` | **new** | `Variant` type, `RankingStrategy` union, `VARIANTS` registry, `HOSTNAME_TO_VARIANT`, `variantFromHost()` helper |
| `src/recommend/mmr.ts` | **new** | `pickMMR()` pure function plus `dot()` helper |
| `src/recommend/index.ts` | modify | `generateUserRecommendations()` computes all enabled variants in one pass, bumps Vectorize query to `topK: 50` and `returnValues: true`, batches all variant inserts |
| `src/api/routes.ts` | modify | New variant middleware, `/recs/:did` SQL gains `WHERE variant = ?`, enroll and recs handlers call page renderers with `c.get("variant")` |
| `src/api/enroll-page.ts` | modify | `enrollPage` becomes a function taking `Variant`, CSS refactor to use `--variant-*` custom properties, variant copy interpolated into template |
| `src/api/recs-page.ts` | modify | `recsPage` becomes a function taking `Variant` via `RecsPageData`, new `placeholder` state, CSS refactor matching enroll-page |
| `src/api/recs-lookup-page.ts` | modify | Accept `Variant` parameter. **Only `variant.copy.*` threads through** — the h1 title, input placeholder, and footer text change per variant, but the palette, borders, focus states, and overall styling stay on the older warm-cream + Newsreader aesthetic. The `variant.brand` palette/blob colors are **intentionally deferred**: the file has no `:root` block or blob field, and bolting on a partial brand-color treatment would be a half-measure. A proper variant visual identity for this page is a separate spec / follow-up PR that redesigns it to match the glass aesthetic of enroll-page and recs-page. |
| `src/env.ts` | modify | New `MMR_LAMBDA: string` binding |
| `schema.sql` | modify | `CREATE TABLE recommendations` gains `variant TEXT NOT NULL DEFAULT 'standard'` and `rank INTEGER NOT NULL DEFAULT 0` as first-class columns + new `idx_recs_did_variant` index. Historical ad-hoc ALTERs preserved as commented migration history. |
| `wrangler.toml` | modify | Two new `[[routes]]` blocks, one new var `MMR_LAMBDA = "0.6"` |

Net: two new files, seven modified files, one schema migration.

## Configuration reference

**New env var:**

```toml
MMR_LAMBDA = "0.6"
```

Range: `[0, 1]`. Parsed with fallback to `0.6` if missing or invalid. Post-launch tuning doesn't require a redeploy — flip the var in wrangler.toml and run `npm run deploy`, or set via `wrangler deploy` flags.

**New routes:**

```toml
[[routes]]
pattern = "nonstandardrecs.site"
custom_domain = true

[[routes]]
pattern = "substandardrecs.site"
custom_domain = true
```

**Schema state** — the `recommendations` table gains two new columns (`variant` and `rank`) and one new index (`idx_recs_did_variant`). `schema.sql` describes the final table shape directly in the `CREATE TABLE IF NOT EXISTS recommendations` statement, so a fresh database bootstrap via `npm run db:init` gets the columns without any ALTERs:

```sql
CREATE TABLE IF NOT EXISTS recommendations (
  did TEXT NOT NULL,
  document_uri TEXT NOT NULL,
  score REAL NOT NULL,
  variant TEXT NOT NULL DEFAULT 'standard',
  rank INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (did, document_uri),
  FOREIGN KEY (did) REFERENCES users(did),
  FOREIGN KEY (document_uri) REFERENCES documents(uri)
);

CREATE INDEX IF NOT EXISTS idx_recs_did_variant ON recommendations(did, variant);
```

**For the existing production database**, the two columns were applied ad-hoc during PR development via:

```sql
-- applied 2026-04-13 via wrangler d1 execute --remote --command=...
ALTER TABLE recommendations ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE recommendations ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
```

SQLite's `ALTER TABLE ADD COLUMN` is idempotent-unsafe — running it twice fails fast — so schema.sql doesn't try to re-apply them. A historical record of the migrations lives as comments at the bottom of schema.sql. No migration system: this project has a single production DB and infrequent schema changes. If that ever changes, move the history comments to a real `migrations/` directory with timestamped files and a tracking table.

**Disjointness invariant** — the PK stays `(did, document_uri)` without a `variant` column. The nonstandard variant's MMR candidate pool is `validMatches.slice(topN)`, guaranteed disjoint from the standard top-N, so the two variants never produce the same `document_uri` for the same user. See the spec's Data Flow section and the load-bearing comment in `src/recommend/index.ts` for details.

## Testing and verification

No test runner is configured for this project. Verification relies on typechecking, bundling, and manual post-deploy smoke testing.

**Pre-deploy checks:**

1. `npx tsc --noEmit` — typecheck clean.
2. `npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun` — validates the bundle, bindings, and routes without actually deploying. Confirms all three `[[routes]]` entries parse and the new `MMR_LAMBDA` var shows up in the bindings table.

**Deploy sequence:**

1. Apply schema: `npm run db:init`.
2. Deploy: `npm run deploy`.
3. Trigger a full sync so the new variant rows get written: `curl -X POST https://standardrecs.site/admin/sync`.

**Post-deploy smoke tests:**

```bash
# Each landing page should return the right title + tagline:
curl -s https://standardrecs.site/    | grep -oE '<title>[^<]*</title>'
curl -s https://nonstandardrecs.site/ | grep -oE '<title>[^<]*</title>'
curl -s https://substandardrecs.site/ | grep -oE '<title>[^<]*</title>'

# After sync completes, each recs page should return rows (substandard shows placeholder):
curl -sL https://standardrecs.site/recs/<your-did>
curl -sL https://nonstandardrecs.site/recs/<your-did>
curl -sL https://substandardrecs.site/recs/<your-did>
```

Eyeball-compare the standard and nonstandard rec lists. The nonstandard list should:

- Contain *different* documents than the standard list (MMR explicitly excludes the top-12).
- Still feel plausibly connected to your taste (since λ=0.6 keeps relevance weighted).
- Feel more spread-out across topics than the standard list (the whole point of MMR's diversity term).

**Variant comparison (implemented, not a follow-up):** `/admin/compare-recs` now accepts `?variants=standard,nonstandard` (Task 12 in the plan / commit `9d7eb69`). The handler calls `generateUserRecommendations` once with `dryRun=true`, filters the returned array by each requested variant, and returns enriched side-by-side JSON. The existing `?namespaces=query,document` path is unchanged. The `MMR_LAMBDA = 0.6` default is a guess — the immediate next step after deploy is to compare rec lists at λ = 0.4, 0.5, 0.6, 0.7 against your own DID via `curl -sX POST "https://standardrecs.site/admin/compare-recs?did=<did>&variants=standard,nonstandard"` and pick the vibe. Because the endpoint reads `MMR_LAMBDA` from env per-request, each comparison run at a new λ needs a redeploy (one-line wrangler.toml edit + `npm run deploy`) — there's no way to parameterize λ via query string without making the endpoint mutate D1.

**Rollback:**

1. Revert the PR. Worker reverts to pre-variant code on next deploy.
2. The `variant` column stays on the table (harmless — it defaults to `'standard'`). If cleanup is desired, `ALTER TABLE recommendations DROP COLUMN variant` is supported in D1 (SQLite 3.35+).
3. The two extra `[[routes]]` blocks remain in `wrangler.toml` history but the Worker no longer matches the variant. Removing them is a one-line revert.

## Open questions / deferred

- **Substandardrecs ranking algorithm.** Three serious candidates: (a) negate the taste vector and re-query Vectorize for nearest, (b) sort the full topK=50 ASC and take the bottom, (c) literal `SELECT ... ORDER BY random() LIMIT 12`. Each has a different "feel." Worth prototyping all three via the extended compare-recs endpoint before picking. Own spec.
- **Per-variant analytics.** Are nonstandard recs actually getting clicked? Would want variant-tagged click events. Not part of this spec — revisit once there's a sense of whether the nonstandard list *feels* right.
- **Does `MMR_LAMBDA = 0.6` actually produce the right vibe?** Only way to know is to run it and look. Tuning post-launch via the env var is the expected path. If 0.5 or 0.7 turn out to be better, the env var flip is a one-line commit.
- **Should the nonstandardrecs page explain what it's doing?** Right now the plan is to just show the recs with a distinct tagline and let the user figure it out. An inline "About this list" footer link could explain MMR/diversity in plain English if the mystery gets annoying.
- **Publisher diversity as a secondary signal.** MMR currently only penalizes by embedding similarity. A more sophisticated version could also penalize against "same publisher as an already-picked doc," which would force cross-publisher variety even when two different publishers happen to write about the same topic. Interesting but not obviously worth it — deferred.

## Not in this spec

- **Fixing the pre-existing embed scaling bug** (caps at 500 likes per run, re-embeds hot rows every cron). Tracked in `memory/project_embed_scaling.md`, will be its own PR after the variant system ships.
- **Changing Voyage model or dimensionality.** The current `voyage-3.5-lite` + 1024 dims is fine for the existing pipeline and MMR works on whatever embedding space the documents already live in.
- **Cleanup of the `likes_doc` namespace and the dormant document-embedding plumbing from PR #18.** Intentionally left in place so future ranking experiments (including but not limited to this one) can reuse the infrastructure. Not part of this spec.

---

## Approval trail

- **Bryan** approved the system shape (variant abstraction, Hono middleware routing, schema change as one-shot `ALTER TABLE`, `RankingStrategy` discriminated union) on 2026-04-13.
- **Bryan** approved the ranking pipeline (MMR with λ=0.6 env var, `returnValues: true` on the Vectorize query, substandard ships as a placeholder) on 2026-04-13.
- **Bryan** approved the presentation and config (brand-color theming via CSS custom properties, page templates become functions, three `[[routes]]` entries in `wrangler.toml`, all on the same Worker) on 2026-04-13.

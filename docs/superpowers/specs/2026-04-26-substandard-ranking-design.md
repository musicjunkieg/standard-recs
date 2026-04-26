# Substandardrecs Ranking Algorithm — Design

**Date:** 2026-04-26
**Status:** Approved for implementation
**Related:** Builds on the three-variant infrastructure shipped in PR #21 (variant registry, hostname routing, MMR for nonstandard) and the redesign in PR #25. Replaces the `{ kind: "placeholder" }` ranking strategy on the substandard variant with a real algorithm.

## Problem

The substandard variant (`substandardrecs.site`) has shipped infrastructure-complete since PR #21: hostname routing, brand styling (olive green, dashed borders), variant copy ("You'll hate these.", "Anti-recs for @handle"). But its `ranking` strategy in `src/variants.ts` is `{ kind: "placeholder" }` — meaning `generateUserRecommendations` produces zero substandard rows, and the page renders empty.

The product promise is "you'll hate these" — recommendations a user can recognize as pointedly off-key relative to their taste, not boring/random/vacuous. We need an algorithm that delivers on that.

## Goal

Implement a substandard ranking algorithm that:

1. Produces results the user can recognize as "the opposite of what I like" — not absence of taste, but active opposition.
2. Returns variety, not a single-cluster joke. (E.g., not "12 manga reviews" if the user likes software essays — instead a mix of manga, fishing forums, recipes, etc.)
3. Stays disjoint from the standard and nonstandard rec sets for the same user, so the existing `(did, document_uri)` PK on the `recommendations` table holds without a schema change.
4. Reuses the existing recommendation infrastructure (Vectorize query, MMR, `recommendations` writes) — no new dependencies, no new env vars, no schema migration.

Out of scope for this change:

- Per-variant `MMR_LAMBDA` tuning. If the substandard recs feel wrong post-launch, we can add a `SUBSTANDARD_MMR_LAMBDA` env var as a one-line follow-up. Don't add the knob until there's evidence it's needed.
- UI changes that surface "this is anti-relevance" beyond what the existing variant copy already does (the page heading is "Anti-recs for @handle" and the tagline is "You'll hate these." — the framing is already in place).
- An A/B comparison endpoint analogous to `/admin/compare-recs` for substandard. Could be a follow-up if we want to compare algorithm variants empirically.
- Score interpretation in the read path. Substandard's `score` is "cosine to negated taste" — interpretable as "anti-relevance, higher = more anti." The existing `/recs/:did` template just renders `score.toFixed(2)` which is fine for now.
- Backfill of existing users' substandard recs. The next regular cron will populate them naturally.
- Replacing the `{ kind: "placeholder" }` arm in the `RankingStrategy` discriminated union. Keep `placeholder` available for future fourth-variant experiments.

## Approach

Three changes layered on top of the existing recommendation pipeline:

1. **Add a `{ kind: "antiMmr" }` arm** to `RankingStrategy` in `src/variants.ts`, and flip `substandard.ranking` from `placeholder` to `antiMmr`. Documentation/intent only — `generateUserRecommendations` doesn't currently dispatch on `variant.ranking`, it hardcodes the variant logic. Runtime dispatch can come later if/when there's a fourth variant.
2. **Issue a second Vectorize query** in `generateUserRecommendations` against the *negated* taste vector. This returns the top-50 documents in embedding space that are most opposed to the user's taste — content that's actively anti-correlated, not just unrelated.
3. **Run MMR over those results** with empty seed and the existing `MMR_LAMBDA = 0.6`. Filter against the standard/nonstandard candidate pool's URI set first to enforce disjointness.

The "negated taste" approach is the simplest semantic story for "you'll hate this": instead of asking "what's most similar to your taste," we ask "what's most similar to the *opposite* of your taste." The user can recognize the result as recognizably wrong-vibe rather than vacuously distant.

### Why negated taste, not other approaches

Considered:

- **Pure anti-cosine** (rank by *lowest* cosine to original taste): often returns boring/vacuous results, because low-quality content tends to be furthest from any well-defined taste — it has no signal at all.
- **Adversarial popular** (popular content far from taste): we don't have a popularity signal in the corpus. Could synthesize one from aggregated likes across all enrolled users, but that's its own design and we have only 3 enrolled users today.
- **Random**: unpredictable, usually boring. Most random docs aren't recognizably anything.
- **Furthest-from-MMR** (mirror nonstandard's algorithm with negated relevance): the diversity term doesn't do useful work when the relevance term is already pulling toward the opposite end of space. Same shape as the chosen approach but messier semantics.

Negated taste was the choice in brainstorming because it produces results the user can react to as "yes, this is *not* my thing" — the recognizability is the joke.

### Why MMR (not pure top-N) for substandard

Pure top-N by anti-cosine could cluster: if a user's taste is dominantly "essays about software," the negated taste might cluster around "manga reviews" and we return 12 manga reviews. That's a one-note joke. MMR diversifies the picks across topic space — manga, fishing, recipes, crypto charts — which makes substandard structurally distinct from standard (clustered relevance) and nonstandard (diversified at the relevance margins).

### Disjointness via URI filter, not schema change

The `recommendations` table PK is `(did, document_uri)` with no `variant` column. The same doc can't appear in two variants for the same user — the INSERT would fail and break that user's whole rec set for the cron run.

For substandard, anti-cosine pulls from the opposite end of embedding space, so collisions with standard/nonstandard are *probabilistically* rare. But "rare" is not "impossible." We enforce disjointness explicitly: build a `Set<string>` of URIs from the standard/nonstandard candidate pool (`validMatches`, the existing 50-doc pool), then filter substandard's anti-matches to exclude any URI already in that set. O(50) lookup per anti-match, trivial cost.

This guarantees the disjointness invariant without a schema migration.

### Why empty seed for substandard MMR

Nonstandard MMR uses standard's picks as the seed — "be different from what standard already showed you" — because nonstandard pulls from the same 50-doc relevance pool as standard. Diversity against the seed is meaningful in that shared space.

For substandard, the candidate pool is structurally separate (negated-taste query + URI filter against the standard pool). Forcing diversity against standard/nonstandard picks would mean penalizing items based on their similarity to vectors at the *opposite* end of embedding space — which would *reward* the most-anti picks, flipping the desired diversity behavior.

Empty seed = clean internal MMR. The MMR pass diversifies within the anti-relevant pool itself.

## Schema

No schema change. The existing `recommendations` table accepts `variant` as a free-form string column (per PR #21), and `substandard` is already a valid value alongside `standard` and `nonstandard`.

No new env vars. No new secrets.

## Signatures

### Changed: `src/variants.ts`

```ts
export type RankingStrategy =
  | { kind: "topN" }
  | { kind: "mmr" }
  | { kind: "antiMmr" }     // NEW
  | { kind: "placeholder" };

export const VARIANTS: Record<Variant["key"], Variant> = {
  // ... standard, nonstandard unchanged ...
  substandard: {
    // ... key, hostname, brand, copy unchanged ...
    ranking: { kind: "antiMmr" },  // was: { kind: "placeholder" }
  },
};
```

### Changed: `src/recommend/index.ts`

`generateUserRecommendations` gains a substandard step after the existing nonstandard step. No changes to function signature; the returned `recs` array now includes substandard rows alongside standard and nonstandard.

No changes to `src/recommend/mmr.ts` (the existing `pickMMR` is reused as-is). No changes to `src/recommend/embed.ts` or anywhere else.

## Control flow inside `generateUserRecommendations`

After the existing nonstandard MMR pass (around line 217):

1. **Construct anti-taste vector.**
   ```ts
   const antiTaste = tasteVector.map((x) => -x);
   const antiTasteNormalized = normalizeL2(antiTaste);
   ```
   `antiTaste` is for the Vectorize query (Vectorize handles its own scaling for cosine ordering). `antiTasteNormalized` is for `pickMMR`'s relevance term, which needs the input on the same `[-1, 1]` cosine scale as the diversity term — same reason the existing nonstandard call normalizes.

2. **Issue substandard Vectorize query, wrapped in try/catch.**
   ```ts
   let antiMatches: VectorizeMatches;
   try {
     antiMatches = await vectors.query(antiTaste, {
       topK: CANDIDATE_POOL,           // 50 — same cap, same returnMetadata constraint
       namespace: "documents",
       returnValues: true,             // required by pickMMR's diversity term
       returnMetadata: "all",
     });
   } catch (err) {
     console.warn(`generateUserRecommendations: substandard query failed for ${did}:`, err);
     antiMatches = { matches: [], count: 0 };  // degrade to empty substandard, keep std+nonstd
   }
   ```
   Wrapping the substandard query in try/catch isolates a Vectorize hiccup on the second query — standard and nonstandard are already populated by this point, so a substandard failure should not take down the whole user.

3. **Build disjointness Set and filter anti-matches.**
   ```ts
   const standardNonstandardUris = new Set(
     validMatches.map((m) => (m.metadata as { uri: string }).uri),
   );
   const validAntiMatches = antiMatches.matches.filter((match) => {
     const uri = (match.metadata as { uri?: string } | null)?.uri;
     return !!uri && !standardNonstandardUris.has(uri);
   });
   ```
   The `validMatches` array already exists (it's the standard/nonstandard candidate pool). The Set is built once per user per cron — O(50) construction, O(1) per filter check.

4. **Run MMR over the filtered anti-pool.**
   ```ts
   const substandardMatches = pickMMR(
     validAntiMatches,         // pool: anti-relevant, disjoint from std+nonstd
     [],                       // empty seed — internal diversity only
     antiTasteNormalized,      // relevance vector: "how anti-taste"
     topN,
     lambda,                   // same MMR_LAMBDA as nonstandard
   );
   ```

5. **Map to `Recommendation[]` and append.**
   ```ts
   const substandardRecs: Recommendation[] = substandardMatches.map((match, i) => ({
     did,
     document_uri: (match.metadata as { uri: string }).uri,
     score: match.score,            // cosine to anti-taste; higher = more anti
     variant: "substandard" as const,
     rank: i,
   }));

   const recs: Recommendation[] = [...standardRecs, ...nonstandardRecs, ...substandardRecs];
   ```

6. **Underfill warning.** Mirror the existing nonstandard underfill warning at line 241:
   ```ts
   if (substandardRecs.length < topN) {
     console.warn(
       `  ${did}: substandard recs short (${substandardRecs.length}/${topN}) — ` +
       `validAntiMatches=${validAntiMatches.length}, CANDIDATE_POOL=${CANDIDATE_POOL}`,
     );
   }
   ```

7. **Existing log line gets updated** to include substandard count:
   ```ts
   console.log(
     `  ${did}: ${standardRecs.length} standard + ${nonstandardRecs.length} nonstandard + ${substandardRecs.length} substandard recommendations generated`,
   );
   ```

The existing batch DELETE-then-INSERT flow at line 221 handles the new substandard rows transparently — single DELETE wipes all variants for the user, single batch INSERTs all three.

## Failure modes and recovery

- **Substandard Vectorize query fails (network, quota, etc.).** Try/catch sets `antiMatches` to empty; substandard recs are skipped this cron, standard and nonstandard still land. The next cron retries.
- **Disjointness filter empties the pool.** Unlikely (would require all 50 anti-matches to also be in the standard pool of 50), but `pickMMR` handles empty input by returning `[]`. Underfill warning fires. Substandard page renders empty for that user. Next cron retries.
- **Existing PK collision somehow occurs anyway.** Would mean disjointness logic has a bug. The batch INSERT fails, that user has no recs that cron run, and the operator sees a D1 error in logs. Recovery: investigate the bug; the next cron's DELETE-then-INSERT cycle clears stale state if the bug is fixed.
- **`tasteVector` is degenerate (all zeros).** `normalizeL2` returns the original vector unchanged in this case. Vectorize query with a zero vector is undefined behavior — likely returns matches in arbitrary order. Practically impossible because `computeTasteVector` rejects vectors with zero total weight, but defensive: even if it happens, the worst case is meaningless substandard results, which is consistent with meaningless standard/nonstandard results in the same scenario.
- **Vectorize returns fewer than 50 anti-matches** (small corpus, or namespace partially populated). `pickMMR` works with whatever's in the pool, returns up to `min(pool, topN)`. Underfill warning fires.

## Verification plan

Post-deploy, in order:

1. **Substandard rows land on next cron.**
   ```bash
   npx wrangler d1 execute standard-recs-db --remote \
     --command="SELECT did, COUNT(*) AS n FROM recommendations WHERE variant = 'substandard' GROUP BY did;"
   ```
   Should return one row per enrolled user with `n = TOP_N` (default 12). If `n` is less than 12 for any user, check logs for the underfill warning.

2. **Disjointness invariant holds.** No PK collision errors in the cron logs. Sanity check:
   ```bash
   npx wrangler d1 execute standard-recs-db --remote \
     --command="SELECT did, document_uri, COUNT(*) AS variants_per_doc FROM recommendations GROUP BY did, document_uri HAVING variants_per_doc > 1;"
   ```
   Should return zero rows. Any row would indicate the disjointness filter has a bug.

3. **Substandard page renders.** Visit `https://substandardrecs.site/recs/<did>` for an enrolled user. Should show 12 recs with the substandard branding (olive green, dashed borders, "Anti-recs for @handle" heading, "You'll hate these." tagline).

4. **Vibe check.** Pick a user whose taste you can characterize (e.g., "they like software essays"). Read their substandard recs. They should be recognizably wrong-vibe — not boring/random. If the recs feel vacuous, the negated-taste approach isn't producing the desired effect and we should revisit (rare but possible if the corpus is too narrow or the user's taste is too diffuse).

5. **Cron log line shows three counts.**
   ```
   did:plc:abc...: 12 standard + 12 nonstandard + 12 substandard recommendations generated
   ```

## Files touched

| File | Change |
|---|---|
| `src/variants.ts` | Add `{ kind: "antiMmr" }` arm to `RankingStrategy`. Flip `substandard.ranking` to `antiMmr`. |
| `src/recommend/index.ts` | Add substandard step in `generateUserRecommendations`: anti-taste construction, Vectorize query (try/catch), disjointness filter, MMR pass, mapping, underfill warning. Update log line to include substandard count. Update the top-of-file documentation comment to mention three variants. |
| `docs/superpowers/specs/2026-04-26-substandard-ranking-design.md` | This file. |
| `docs/superpowers/plans/2026-04-26-substandard-ranking.md` | Implementation plan (next step). |

No changes to `src/recommend/mmr.ts`, `src/recommend/embed.ts`, the Workflow, the read path, the page templates, the schema, the env bindings, `wrangler.toml`, or any other file.

Net diff size estimate: ~50 lines added, ~5 modified, all in `generateUserRecommendations` plus the small variants.ts type/registry change.

## Non-goals (explicit, to prevent scope creep in review)

- **Not** runtime dispatching on `variant.ranking`. The existing code hardcodes the variant logic; converting to a registry-driven dispatch is a separate refactor that doesn't serve this PR's goal.
- **Not** adding `SUBSTANDARD_MMR_LAMBDA` env var. Reuse `MMR_LAMBDA`.
- **Not** changing how substandard's `score` is interpreted in the UI.
- **Not** building an A/B comparison endpoint for substandard.
- **Not** backfilling existing users' substandard recs in a one-shot job — the next cron handles it.
- **Not** removing the `{ kind: "placeholder" }` arm from the union. Keep it for future variant experiments.
- **Not** parallelising the standard, nonstandard, and substandard steps. They run sequentially today; making them concurrent inside `Promise.all` is possible but adds complexity for a per-user step that already takes maybe 2-3 seconds end-to-end.
- **Not** adding a separate Vectorize query budget cap for substandard. The existing per-cron subrequest budget covers it.

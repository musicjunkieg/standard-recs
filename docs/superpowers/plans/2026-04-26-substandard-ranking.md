# Substandardrecs Ranking Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `{ kind: "placeholder" }` ranking strategy on the substandard variant with a real algorithm: query Vectorize for the top-50 documents most opposed to the user's taste (negated taste vector), filter out anything already in the standard/nonstandard candidate pool, run MMR for diversity, return top-N.

**Architecture:** ~50 line net change confined to two files. `src/variants.ts` gets a new `antiMmr` arm in the `RankingStrategy` union and `substandard.ranking` flips from `placeholder` to `antiMmr`. `src/recommend/index.ts` widens the `Recommendation` type's variant union and adds a substandard step in `generateUserRecommendations` after the existing nonstandard MMR call. No schema change, no new env vars, no new dependencies.

**Tech Stack:** TypeScript, Cloudflare Workers, Vectorize (existing `vectors.query()`), the existing `pickMMR` helper, the existing private `normalizeL2` helper. No new technologies.

**Spec:** `docs/superpowers/specs/2026-04-26-substandard-ranking-design.md` (on branch `feat/substandard-ranking`)

**Branch:** `feat/substandard-ranking` (already created off `main` by the controller, with the spec already committed)

**Pre-session state notes for the implementer:**
- `wrangler.toml` has unstaged local edits (`TOP_N = "12"`, `WORKER_URL = "https://standardrecs.site"`) that must NOT be committed. They are long-lived dev-box overrides. This plan does NOT touch `wrangler.toml`, so the dirty state should pass through untouched.
- Other untracked paths (`docs/stitch/` and two plan files under `docs/superpowers/plans/`) are not part of this PR and must not be staged.
- No test runner is configured per `CLAUDE.md`. Validation is exclusively `npx tsc --noEmit` and `npx wrangler deploy --dry-run`.

---

## Chunk 1: Implementation

### Task 1: Add `antiMmr` arm to `RankingStrategy` and flip `substandard.ranking`

**Why:** Pure type plumbing + a one-line config change. Makes the variant registry reflect the new algorithm intent. The actual `generateUserRecommendations` function doesn't currently dispatch on `variant.ranking` (it hardcodes the variant logic), so this change is documentation-of-intent rather than runtime-impact. Doing it first as its own commit keeps the diff readable and makes Task 2's diff focused on the actual algorithm.

**Files:**
- Modify: `src/variants.ts` (the `RankingStrategy` union near line 14, the `substandard` entry in `VARIANTS` near line 80)

**Steps:**

- [ ] **Step 1: Read `src/variants.ts`** to confirm shape

  You should find a `RankingStrategy` discriminated union with three arms:
  ```ts
  export type RankingStrategy =
    | { kind: "topN" }
    | { kind: "mmr" }
    | { kind: "placeholder" };
  ```

  And a `substandard` entry in `VARIANTS` whose `ranking` field is `{ kind: "placeholder" }`.

- [ ] **Step 2: Add the `antiMmr` arm to the union**

  Find:
  ```ts
  export type RankingStrategy =
    | { kind: "topN" }
    | { kind: "mmr" }
    | { kind: "placeholder" };
  ```

  Replace with:
  ```ts
  export type RankingStrategy =
    | { kind: "topN" }
    | { kind: "mmr" }
    | { kind: "antiMmr" }
    | { kind: "placeholder" };
  ```

  Place `antiMmr` BEFORE `placeholder`. Keep `placeholder` in the union — it remains available for future fourth-variant experiments, per the spec's non-goals.

- [ ] **Step 3: Flip `substandard.ranking` from `placeholder` to `antiMmr`**

  Find the `substandard:` entry in `VARIANTS` (around line 80). Its `ranking` field reads:
  ```ts
  ranking: { kind: "placeholder" },
  ```

  Change to:
  ```ts
  ranking: { kind: "antiMmr" },
  ```

  Do NOT modify any other field in the substandard entry. Do NOT touch the standard or nonstandard entries.

- [ ] **Step 4: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean. The new `antiMmr` arm is purely additive and `substandard.ranking` is still a valid `RankingStrategy`.

- [ ] **Step 5: Sanity sweep**

  Run: `grep -rn "antiMmr\|placeholder" src/`

  Expected: TWO occurrences of `antiMmr` (the union arm and the substandard.ranking value), and ONE occurrence of `placeholder` (the union arm — no longer used by any variant entry, but kept available).

- [ ] **Step 6: Commit**

  ```bash
  git add src/variants.ts
  git commit -m "$(cat <<'EOF'
  feat(variants): add antiMmr ranking arm + flip substandard

  Adds a new { kind: "antiMmr" } arm to the RankingStrategy
  discriminated union and flips substandard.ranking from
  placeholder to antiMmr. The actual algorithm logic in
  generateUserRecommendations is the next commit; this is just
  registry/type plumbing so the diff stays readable.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 7: Verify commit**

  Run: `git show HEAD --stat`
  Expected: only `src/variants.ts` changed, very small diff (1 line added to union, 1 line modified for substandard.ranking).

  Run: `git status --short`
  Expected: only the pre-session dirty state (`M wrangler.toml`, three `??` paths). No other `M` lines.

**Self-review questions:**
- Did you touch any file other than `src/variants.ts`?
- Is `placeholder` still in the union (not removed)?
- Is `substandard.ranking` the only registry entry that changed?

---

### Task 2: Add substandard step in `generateUserRecommendations`

**Why:** This is the actual algorithm. Widens the `Recommendation` type's variant union (without this, the substandard mapping below would be a TypeScript error), then issues a second Vectorize query against the negated taste vector, filters against the standard/nonstandard candidate pool URIs, runs MMR, and appends to the recs array. Atomic commit because the type widening, the new step, and the concatenation update all need to land together to compile.

**Files:**
- Modify: `src/recommend/index.ts` (`Recommendation` type around line 19, body of `generateUserRecommendations` after the nonstandard MMR call around line 217)

**Steps:**

- [ ] **Step 1: Read the current shape of `src/recommend/index.ts`**

  Note these critical locations:
  - `Recommendation` type around line 19 — `variant: "standard" | "nonstandard"` at line 23 (must be widened)
  - `generateUserRecommendations` function definition around line 74
  - `validMatches` declaration around line 158 (the standard/nonstandard candidate pool — used both for standard's slice and as the source of nonstandard's tail)
  - `tasteVector` available in scope from around line 127
  - Existing `nonstandardRecs` mapping ends around line 217
  - `const recs: Recommendation[] = [...standardRecs, ...nonstandardRecs];` at line 219 (the concatenation that must be updated to include substandardRecs)
  - Existing log line around line 238 with `standardRecs.length` and `nonstandardRecs.length`
  - Existing nonstandard underfill warning around line 241
  - `normalizeL2` private helper at line 306
  - `CANDIDATE_POOL = 50` constant at line 134
  - `pickMMR` import at the top of the file

- [ ] **Step 2: Widen the `Recommendation` type's variant union**

  Find (around line 23):
  ```ts
    variant: "standard" | "nonstandard";
  ```

  Replace with:
  ```ts
    variant: "standard" | "nonstandard" | "substandard";
  ```

  This is required before Task 2's Step 6 (the substandard mapping) typechecks.

- [ ] **Step 3: Update the top-of-file JSDoc comment**

  Find the existing JSDoc near line 27-32 that explains the `rank` field for "standard" and "nonstandard". Extend it with a sentence explaining substandard's rank:

  Find:
  ```ts
    /**
     * Zero-indexed position within this variant's list, preserving the
     * algorithm's original pick order. For standard this is just top-N by
     * raw cosine. For nonstandard this is the MMR greedy pick order:
     * rank 0 = first pick (no diversity penalty), rank k = pick after
     * penalizing for similarity to picks 0..k-1. Sorting by score DESC
     * would scramble the nonstandard order into a different ranking.
     */
  ```

  Replace with:
  ```ts
    /**
     * Zero-indexed position within this variant's list, preserving the
     * algorithm's original pick order. For standard this is just top-N by
     * raw cosine. For nonstandard this is the MMR greedy pick order:
     * rank 0 = first pick (no diversity penalty), rank k = pick after
     * penalizing for similarity to picks 0..k-1. For substandard this
     * is also MMR pick order, but over a separate candidate pool from
     * a Vectorize query against the negated taste vector. Sorting by
     * score DESC would scramble the MMR order into a different ranking.
     */
  ```

- [ ] **Step 4: Insert the substandard step before the recs concatenation**

  Find (around line 217-219):
  ```ts
    const nonstandardRecs: Recommendation[] = nonstandardMatches.map((match, i) => ({
      did,
      document_uri: (match.metadata as { uri: string }).uri,
      score: match.score,
      variant: "nonstandard" as const,
      rank: i,
    }));

    const recs: Recommendation[] = [...standardRecs, ...nonstandardRecs];
  ```

  Insert this new block between the closing `}));` of `nonstandardRecs` and the `const recs = ...` line, then update the concatenation. Final shape:

  ```ts
    const nonstandardRecs: Recommendation[] = nonstandardMatches.map((match, i) => ({
      did,
      document_uri: (match.metadata as { uri: string }).uri,
      score: match.score,
      variant: "nonstandard" as const,
      rank: i,
    }));

    // 5d. Substandard recs: anti-taste cosine + MMR diversity, disjoint
    // from standard/nonstandard via URI filter against validMatches.
    //
    // Issue a SEPARATE Vectorize query against the negated taste vector
    // to pull the top-50 docs most opposed to the user's taste. This is
    // not "absence of taste" — it's content actively in the opposite
    // direction, the strongest "you'll hate this" signal. Wrapped in
    // try/catch so a Vectorize hiccup on this query doesn't take down
    // the standard+nonstandard recs that are already constructed above.
    //
    // The disjointness filter (URI Set built from validMatches) honors
    // the recommendations table's (did, document_uri) PK constraint
    // without a schema change. Anti-cosine + cosine pull from opposite
    // ends of embedding space, so collisions are probabilistically
    // rare, but the filter makes them impossible.
    //
    // Empty seed for the MMR call — substandard's pool is structurally
    // separate from standard/nonstandard, so seeding with their picks
    // would force diversity against vectors at the opposite end of
    // space, which would *reward* the most-anti picks (the diversity
    // term `dot(cVec, p.values!)` would be most negative for the most
    // anti-aligned items, and MMR subtracts that term). Empty seed
    // lets internal MMR diversity do clean work within the anti-pool.
    //
    // Same MMR_LAMBDA as nonstandard. See the spec's "Why negated
    // taste" and "Why MMR" sections for the full rationale.
    let antiMatches: VectorizeMatches;
    try {
      antiMatches = await vectors.query(antiTaste, {
        topK: CANDIDATE_POOL,
        namespace: "documents",
        returnValues: true,
        returnMetadata: "all",
      });
    } catch (err) {
      console.warn(
        `generateUserRecommendations: substandard query failed for ${did}:`,
        err,
      );
      antiMatches = { matches: [], count: 0 };
    }

    const standardNonstandardUris = new Set(
      validMatches.map((m) => (m.metadata as { uri: string }).uri),
    );
    const validAntiMatches = antiMatches.matches.filter((match) => {
      const uri = (match.metadata as { uri?: string } | null)?.uri;
      return !!uri && !standardNonstandardUris.has(uri);
    });

    const substandardMatches = pickMMR(
      validAntiMatches,
      [],
      antiTasteNormalized,
      topN,
      lambda,
    );

    const substandardRecs: Recommendation[] = substandardMatches.map(
      (match, i) => ({
        did,
        document_uri: (match.metadata as { uri: string }).uri,
        score: match.score,
        variant: "substandard" as const,
        rank: i,
      }),
    );

    const recs: Recommendation[] = [
      ...standardRecs,
      ...nonstandardRecs,
      ...substandardRecs,
    ];
  ```

  Note: the new block references `antiTaste` and `antiTasteNormalized` which don't exist yet. Step 5 adds them.

- [ ] **Step 5: Construct `antiTaste` and `antiTasteNormalized` BEFORE the substandard query**

  The substandard step needs `antiTaste` (raw negated taste, for the Vectorize query) and `antiTasteNormalized` (unit-length, for `pickMMR`'s relevance term).

  Find the existing `tasteVectorNormalized` line (around line 199, just before the existing nonstandard `pickMMR` call):
  ```ts
    const tasteVectorNormalized = normalizeL2(tasteVector);
    const nonstandardMatches = pickMMR(
      validMatches.slice(topN),
      standardMatches,
      tasteVectorNormalized,
      topN,
      lambda,
    );
  ```

  Add two new lines BELOW `const tasteVectorNormalized = normalizeL2(tasteVector);` (and above the `pickMMR` call), so the variables are constructed once and reused:

  ```ts
    const tasteVectorNormalized = normalizeL2(tasteVector);
    // Negated taste for substandard: pull docs at the opposite end of
    // embedding space. antiTaste is for the Vectorize query (Vectorize
    // handles its own scaling for cosine ordering); antiTasteNormalized
    // is for pickMMR's relevance term, which needs the input on the
    // same [-1, 1] cosine scale as the diversity term.
    const antiTaste = tasteVector.map((x) => -x);
    const antiTasteNormalized = normalizeL2(antiTaste);
    const nonstandardMatches = pickMMR(
      validMatches.slice(topN),
      standardMatches,
      tasteVectorNormalized,
      topN,
      lambda,
    );
  ```

- [ ] **Step 6: Update the existing log line to include substandard count**

  Find (around line 238):
  ```ts
    console.log(
      `  ${did}: ${standardRecs.length} standard + ${nonstandardRecs.length} nonstandard recommendations generated`,
    );
  ```

  Replace with:
  ```ts
    console.log(
      `  ${did}: ${standardRecs.length} standard + ${nonstandardRecs.length} nonstandard + ${substandardRecs.length} substandard recommendations generated`,
    );
  ```

- [ ] **Step 7: Add the substandard underfill warning**

  Find the existing nonstandard underfill warning (around line 241):
  ```ts
    if (nonstandardRecs.length < topN) {
      console.warn(
        `  ${did}: nonstandard recs short (${nonstandardRecs.length}/${topN}) — ` +
        `validMatches=${validMatches.length}, CANDIDATE_POOL=${CANDIDATE_POOL}`,
      );
    }
  ```

  Add a parallel warning for substandard immediately after that block:
  ```ts
    if (nonstandardRecs.length < topN) {
      console.warn(
        `  ${did}: nonstandard recs short (${nonstandardRecs.length}/${topN}) — ` +
        `validMatches=${validMatches.length}, CANDIDATE_POOL=${CANDIDATE_POOL}`,
      );
    }
    if (substandardRecs.length < topN) {
      console.warn(
        `  ${did}: substandard recs short (${substandardRecs.length}/${topN}) — ` +
        `validAntiMatches=${validAntiMatches.length}, CANDIDATE_POOL=${CANDIDATE_POOL}`,
      );
    }
  ```

- [ ] **Step 8: Typecheck**

  Run: `npx tsc --noEmit`

  Expected: clean. If you get errors:
  - `Type '"substandard"' is not assignable to type '"standard" | "nonstandard"'`: you forgot Step 2 (widening the union).
  - `Cannot find name 'antiTaste'` or `Cannot find name 'antiTasteNormalized'`: you forgot Step 5 (or placed it after the substandard step instead of before).
  - `Cannot find name 'VectorizeMatches'`: this is a Cloudflare Workers global type. It should be available without import. If TypeScript complains, double-check that the file already uses other Vectorize types without explicit imports (it does — see the existing `validMatches` typed implicitly from `vectors.query()`'s return type).
  - `Cannot find name 'validAntiMatches'` in the underfill warning: you skipped Step 7 ordering — the warning at Step 7 references `validAntiMatches` which is declared inside the substandard block from Step 4. The warning must come AFTER the substandard block runs. Both should be inside the function body, and the warning at Step 7 must come after Step 4's insertion.

- [ ] **Step 9: Dry-run deploy**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -30`

  Expected: a successful dry-run with the usual bindings table. Total Upload size may grow slightly (a few hundred bytes). You may see a sandbox EPERM warning about `~/Library/Preferences`; ignore it, the dry-run still completes.

- [ ] **Step 10: Sanity sweep**

  Run: `grep -n "substandard" src/recommend/index.ts`

  Expected matches:
  - The widened type union at line ~23
  - The JSDoc mention at line ~30
  - The substandard block (multiple lines including comments, the try/catch, the filter, the pickMMR call, the mapping)
  - The recs concatenation
  - The log line
  - The underfill warning

  Roughly 10-15 matches total. Zero matches would mean Step 4 didn't apply.

- [ ] **Step 11: Scope check**

  Run: `git status --short`

  Expected: ONLY `M src/recommend/index.ts` plus the pre-session dirty state. NO other `M` lines. If you see `src/variants.ts` modified again, you accidentally re-edited it — that file was committed in Task 1.

- [ ] **Step 12: Commit**

  ```bash
  git add src/recommend/index.ts
  git commit -m "$(cat <<'EOF'
  feat(recommend): add substandard ranking with negated taste + MMR

  Replaces the empty placeholder rec set for substandardrecs.site
  with a real algorithm. Steps:

  1. Widen the Recommendation type's variant union to include
     "substandard" so the new mapping step typechecks.
  2. Construct antiTaste (raw negated taste vector) and
     antiTasteNormalized (unit-length, for MMR's relevance term)
     once, alongside the existing tasteVectorNormalized.
  3. Issue a SEPARATE Vectorize query against antiTaste for top-50
     anti-relevant docs. Wrapped in try/catch so a failure on this
     query doesn't take down the standard+nonstandard recs that are
     already constructed by this point.
  4. Build a Set of standard+nonstandard candidate pool URIs and
     filter the anti-matches against it. This honors the existing
     (did, document_uri) PK on the recommendations table without
     a schema change — anti-cosine + cosine pull from opposite ends
     of embedding space so collisions are rare, but the filter
     makes them impossible.
  5. Run pickMMR over the filtered pool with EMPTY seed (internal
     diversity only — see spec for why standard's picks are not a
     useful seed when the pool is already structurally separated)
     and the same MMR_LAMBDA as nonstandard.
  6. Map to Recommendation rows and append to the recs array. The
     existing batch DELETE-then-INSERT flow handles the new variant
     transparently.
  7. Update the cron log line to surface all three counts; add a
     substandard underfill warning mirroring nonstandard's.

  See docs/superpowers/specs/2026-04-26-substandard-ranking-design.md
  for the full algorithm rationale, including why "negated taste"
  was chosen over pure anti-cosine, adversarial-popular, random,
  or anti-MMR.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 13: Verify commit**

  Run: `git show HEAD --stat`
  Expected: only `src/recommend/index.ts` changed, ~50-70 line additions, ~3-5 modifications.

  Run: `git status --short`
  Expected: only pre-session dirty state.

**Self-review questions:**
- Did you touch any file other than `src/recommend/index.ts`?
- Is the `Recommendation` type's variant union now `"standard" | "nonstandard" | "substandard"`?
- Are `antiTaste` and `antiTasteNormalized` declared BEFORE the substandard step that uses them?
- Is the substandard Vectorize query wrapped in try/catch?
- Does the disjointness filter use a `Set` for O(1) URI lookup?
- Is the MMR call's seed an empty array `[]`?
- Does the recs concatenation include all three: `[...standardRecs, ...nonstandardRecs, ...substandardRecs]`?
- Does the log line include all three counts?
- Is there a substandard underfill warning, structured like the existing nonstandard one?
- Does typecheck pass? Does dry-run succeed?

---

## Chunk 2: Verification and shipping

### Task 3: Final verification, push, and PR

**Why:** No code changes — pure verification + GitHub. Confirm typecheck is clean across the whole branch, dirty state is preserved, then push and open the PR. The deploy/migrate/smoke step is user-gated and happens after the controller hands back to you.

**Files:** None modified.

**Steps:**

- [ ] **Step 1: Verify the working tree**

  Run: `git status --short`

  Expected:
  ```text
   M wrangler.toml
  ?? docs/stitch/
  ?? docs/superpowers/plans/2026-04-08-oauth-likes-implementation.md
  ?? docs/superpowers/plans/2026-04-12-likes-doc-embedding-experiment.md
  ```

  The `M wrangler.toml` is the pre-session dirty state and must remain. If you see `M` on any file beyond `wrangler.toml`, stop and investigate.

  Run: `git diff wrangler.toml`
  Expected: only the two pre-session lines — `TOP_N` from `"10"` to `"12"`, `WORKER_URL` from the long `workers.dev` URL to `https://standardrecs.site`. Nothing else.

- [ ] **Step 2: Verify the branch commit list**

  Run: `git log --oneline main..HEAD`

  Expected (top to bottom, most recent first):
  ```text
  <task-2-sha> feat(recommend): add substandard ranking with negated taste + MMR
  <task-1-sha> feat(variants): add antiMmr ranking arm + flip substandard
  <spec-r1-sha> docs(spec): address spec review round 1
  <spec-sha> docs(spec): substandardrecs ranking algorithm
  ```

  Four commits total. If you see more or fewer, stop and check with the controller.

- [ ] **Step 3: Final typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean.

- [ ] **Step 4: Final dry-run**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -20`
  Expected: successful dry-run.

- [ ] **Step 5: Push the branch**

  Run: `git push -u origin feat/substandard-ranking`

  If push fails with `sign_and_send_pubkey: signing failed for ED25519`, the SSH agent has hiccuped (known transient on this Mac). Retry with `git push` once and it should work. If it doesn't, escalate to the controller (Bryan can usually fix with `ssh-add ~/.ssh/github_ed25519`).

- [ ] **Step 6: Open the PR**

  ```bash
  gh pr create --title "feat(recommend): substandardrecs ranking — negated taste + MMR" --body "$(cat <<'EOF'
  ## Summary

  Replaces the `{ kind: "placeholder" }` ranking strategy on the substandard variant with a real algorithm. Substandardrecs.site now produces 12 recommendations per enrolled user, structured as the most-anti-relevant content in embedding space, diversified across topic clusters via MMR.

  - **`src/variants.ts`**: new `{ kind: "antiMmr" }` arm in `RankingStrategy`, `substandard.ranking` flipped from `placeholder` to `antiMmr`.
  - **`src/recommend/index.ts`**: `Recommendation` type's variant union widened to include `"substandard"`. New step in `generateUserRecommendations` after the nonstandard MMR call: construct negated taste vector, issue a separate Vectorize query for top-50 anti-relevant docs, filter against the standard/nonstandard candidate pool URIs (disjointness invariant for the existing `(did, document_uri)` PK), run MMR with empty seed and the existing `MMR_LAMBDA = 0.6`, map to recs, append.

  No schema change. No new env vars. No new secrets. The existing batch DELETE-then-INSERT flow handles the new variant transparently.

  Spec: \`docs/superpowers/specs/2026-04-26-substandard-ranking-design.md\`
  Plan: \`docs/superpowers/plans/2026-04-26-substandard-ranking.md\`

  ## Algorithm rationale (short version)

  - **Why negated taste?** Returns content actively in the opposite direction of the user's taste — recognizable as wrong-vibe rather than vacuously distant. Pure anti-cosine returns boring/random content; negated taste returns "yes, this is *not* my thing."
  - **Why MMR?** Diversifies the anti-recs across topic space — not "12 manga reviews" but a mix.
  - **Why empty seed for MMR?** Standard/nonstandard come from a pool at the OPPOSITE end of embedding space from substandard's pool. Seeding substandard's MMR with their picks would reward the most-anti picks (because they'd be furthest from the seed), inverting the desired diversity behavior.
  - **Why a separate Vectorize query?** Anti-relevant content isn't in the top-50 cosine matches against the original taste — we need a fresh query against the negated vector.

  Full rationale (including alternatives considered) in the spec.

  ## Test plan

  - [ ] Merge + \`npm run deploy\`
  - [ ] Trigger a sync: \`curl -X POST -H \"Authorization: Bearer \$ADMIN_TOKEN\" https://standardrecs.site/admin/sync\`
  - [ ] Wait for cron to complete (or watch \`npx wrangler tail\`)
  - [ ] Verify substandard rows landed for each enrolled user:
    \`\`\`bash
    npx wrangler d1 execute standard-recs-db --remote \\
      --command=\"SELECT did, COUNT(*) AS n FROM recommendations WHERE variant = 'substandard' GROUP BY did;\"
    \`\`\`
    Expected: one row per enrolled user with \`n = TOP_N\` (12 by default).
  - [ ] Verify disjointness invariant holds:
    \`\`\`bash
    npx wrangler d1 execute standard-recs-db --remote \\
      --command=\"SELECT did, document_uri, COUNT(*) AS variants_per_doc FROM recommendations GROUP BY did, document_uri HAVING variants_per_doc > 1;\"
    \`\`\`
    Expected: zero rows. Any row would mean the disjointness filter has a bug.
  - [ ] Visit https://substandardrecs.site/recs/<did> for an enrolled user. Should render 12 recs with the substandard branding (olive green, dashed borders, "Anti-recs for @handle" heading, "You'll hate these." tagline).
  - [ ] **Vibe check.** Pick a user whose taste you can characterize (e.g., "they like software essays"). Read their substandard recs. Should be recognizably wrong-vibe — not boring/random. If the recs feel vacuous, the algorithm isn't producing the desired effect and we need to revisit (rare but possible if the corpus is too narrow or the user's taste is too diffuse).

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Return the PR URL in your summary so the controller can link it.

- [ ] **Step 7: Handoff**

  Do NOT merge. Do NOT deploy. Do NOT trigger a sync yourself. These are user-gated actions per `CLAUDE.md` and the subagent-driven-development skill. Return control to the controller with a DONE status and the PR URL.

---

## Deferred follow-ups (not part of this plan)

- **Per-variant `MMR_LAMBDA` tuning** — if substandard recs feel wrong post-launch, add a `SUBSTANDARD_MMR_LAMBDA` env var as a one-line follow-up. Don't add the knob until evidence is needed.
- **Runtime dispatch on `variant.ranking`** — currently the algorithm logic is hardcoded in `generateUserRecommendations`. Converting to registry-driven dispatch is a separate refactor that doesn't serve this PR's goal.
- **A/B comparison endpoint for substandard** — analogous to `/admin/compare-recs` for the likes-doc experiment. Could add a `?variants=substandard` arm later.
- **UI changes that surface "this is anti-relevance"** beyond what the existing variant copy already does. The page heading is "Anti-recs for @handle" and the tagline is "You'll hate these." — the framing is in place.
- **Parallelising the standard/nonstandard/substandard steps** — they run sequentially today. `Promise.all` would be possible but adds complexity for a per-user step that already takes maybe 2-3 seconds end-to-end.

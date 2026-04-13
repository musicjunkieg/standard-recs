/**
 * Recommendation engine.
 *
 * For each user:
 *   1. Fetch their like vectors from Vectorize
 *   2. Compute a recency-weighted average → "taste vector"
 *   3. Query Vectorize for nearest documents
 *   4. Store top-N in D1
 */

import { vectorIds } from "./vector-id.js";
import {
  LIKES_NAMESPACE_QUERY,
  LIKES_NAMESPACE_DOC,
  LIKES_DOC_ID_PREFIX,
} from "./embed.js";
import { pickMMR } from "./mmr.js";

type Recommendation = {
  did: string;
  document_uri: string;
  score: number;
  variant: "standard" | "nonstandard";
  /**
   * Zero-indexed position within this variant's list, preserving the
   * algorithm's original pick order. For standard this is just top-N by
   * raw cosine. For nonstandard this is the MMR greedy pick order:
   * rank 0 = first pick (no diversity penalty), rank k = pick after
   * penalizing for similarity to picks 0..k-1. Sorting by score DESC
   * would scramble the nonstandard order into a different ranking.
   */
  rank: number;
};

/**
 * Generate recommendations for all enrolled users.
 */
export async function generateAllRecommendations(
  db: D1Database,
  vectors: VectorizeIndex,
  topN: number,
  likesNamespace: string = LIKES_NAMESPACE_QUERY,
  lambda: number = 0.6,
): Promise<number> {
  const { results: users } = await db
    .prepare(`SELECT did FROM users`)
    .all<{ did: string }>();

  let totalRecs = 0;

  for (const user of users) {
    try {
      const recs = await generateUserRecommendations(
        db,
        vectors,
        user.did,
        topN,
        likesNamespace,
        false,    // dryRun — workflow path always persists
        lambda,
      );
      totalRecs += recs.length;
    } catch (err) {
      console.error(`Recs failed for ${user.did}:`, err);
    }
  }

  return totalRecs;
}

/**
 * Generate recommendations for a single user.
 */
export async function generateUserRecommendations(
  db: D1Database,
  vectors: VectorizeIndex,
  did: string,
  topN: number,
  likesNamespace: string = LIKES_NAMESPACE_QUERY,
  dryRun: boolean = false,
  lambda: number = 0.6,
): Promise<Recommendation[]> {
  // 1. Get this user's like URIs from D1 (ordered by recency)
  const { results: likes } = await db
    .prepare(
      `SELECT uri, liked_at FROM likes
       WHERE did = ? AND liked_post_text IS NOT NULL
       ORDER BY liked_at DESC
       LIMIT 200`,
    )
    .bind(did)
    .all<{ uri: string; liked_at: string | null }>();

  if (likes.length === 0) {
    console.log(`  ${did}: no likes to build taste from`);
    return [];
  }

  const idPrefix =
    likesNamespace === LIKES_NAMESPACE_DOC ? LIKES_DOC_ID_PREFIX : "";

  // 2. Fetch their like vectors from Vectorize (IDs are hashed).
  // getByIds has a max of 20 IDs per call, so chunk the requests.
  const baseHashes = await vectorIds(likes.map((l) => l.uri));
  const likeHashes = baseHashes.map((h) => idPrefix + h);
  const likeVectors: VectorizeVector[] = [];
  for (let i = 0; i < likeHashes.length; i += 20) {
    const batch = await vectors.getByIds(likeHashes.slice(i, i + 20));
    likeVectors.push(...batch);
  }

  if (likeVectors.length === 0) {
    console.log(`  ${did}: no embedded likes yet`);
    return [];
  }

  // 3. Compute recency-weighted average (exponential decay)
  // Build hash→timestamp map for the taste vector computation
  const now = Date.now();
  const likeHashToTimestamp = new Map<string, number>();
  for (let i = 0; i < likes.length; i++) {
    likeHashToTimestamp.set(
      likeHashes[i],
      likes[i].liked_at ? new Date(likes[i].liked_at!).getTime() : now,
    );
  }
  const tasteVector = computeTasteVector(likeVectors, likeHashToTimestamp);

  // 4. Query Vectorize for nearest documents.
  // Fixed topK=50 (Vectorize per-query cap with returnMetadata="all").
  // returnValues=true is required so pickMMR can do pairwise vector
  // comparisons for the nonstandard diversity term. ~250KB per user
  // per cron — fine at any reasonable scale.
  const CANDIDATE_POOL = 50;

  // Sanity check: the nonstandard MMR pool is whatever's left after
  // the standard top-N is claimed, i.e., CANDIDATE_POOL - topN. If
  // someone bumps TOP_N above CANDIDATE_POOL / 2, the nonstandard
  // list silently underfills. Today TOP_N defaults to 12, leaving 38
  // slots — generous. Warn loudly if the ratio inverts so the
  // operator knows why nonstandard recs are short.
  if (topN * 2 > CANDIDATE_POOL) {
    console.warn(
      `generateUserRecommendations: TOP_N=${topN} leaves only ${CANDIDATE_POOL - topN} ` +
        `candidates for nonstandard MMR (pool=${CANDIDATE_POOL}). Bump CANDIDATE_POOL ` +
        `or drop TOP_N for richer nonstandard recs.`,
    );
  }

  const matches = await vectors.query(tasteVector, {
    topK: CANDIDATE_POOL,
    namespace: "documents",
    returnValues: true,
    returnMetadata: "all",
  });

  // 5a. Filter to valid matches (those with a uri in metadata).
  const validMatches = matches.matches.filter((match) => {
    const uri = (match.metadata as { uri?: string } | null)?.uri;
    return !!uri;
  });

  // 5b. Standard recs: top-N by raw cosine, same as before.
  const standardMatches = validMatches.slice(0, topN);
  const standardRecs: Recommendation[] = standardMatches.map((match, i) => ({
    did,
    document_uri: (match.metadata as { uri: string }).uri,
    score: match.score,
    variant: "standard" as const,
    rank: i,
  }));

  // 5c. Nonstandard recs: MMR over the tail of the candidate pool
  // (indices topN onward), with the standard top-N as the seed set
  // (diversify against what standard already picked).
  //
  // LOAD-BEARING: The `validMatches.slice(topN)` split ensures
  // standard and nonstandard variants for the same user NEVER share
  // a document_uri. This is required because the `recommendations`
  // PK is (did, document_uri) without a `variant` column — if the
  // two variants ever produced the same doc, the D1 INSERT would
  // fail with a UNIQUE constraint violation. Any future variant that
  // re-ranks over the full validMatches must either (a) preserve this
  // disjointness invariant or (b) update the schema PK first.
  // See: docs/superpowers/specs/2026-04-13-recs-variants-design.md
  //
  // L2-normalize the taste vector before feeding it to MMR: the
  // Voyage embeddings in `validMatches` are already unit vectors, so
  // pickMMR's diversity term `dot(cVec, p.values!)` produces true
  // cosines in [-1, 1]. But `computeTasteVector` returns a weighted
  // *average* (not a unit vector), so `dot(cVec, tasteVector)` would
  // be scaled by |tasteVector| — typically 0.5-0.9 for likes spanning
  // multiple topics. That scale mismatch compresses the relevance
  // term relative to the diversity penalty, skewing MMR's balance
  // away from the intended lambda. Normalize here so both terms live
  // on the same [-1, 1] cosine scale. (Vectorize's own query() call
  // above doesn't need this because Cloudflare handles the scaling
  // internally for cosine similarity ordering.)
  const tasteVectorNormalized = normalizeL2(tasteVector);
  const nonstandardMatches = pickMMR(
    validMatches.slice(topN),
    standardMatches,
    tasteVectorNormalized,
    topN,
    lambda,
  );
  // The .map index IS the MMR pick order because pickMMR returns
  // winners in selection order (first pick = rank 0, second pick =
  // rank 1, etc.). Persist this as the `rank` column so the read path
  // can ORDER BY rank ASC and preserve MMR's greedy decisions.
  const nonstandardRecs: Recommendation[] = nonstandardMatches.map((match, i) => ({
    did,
    document_uri: (match.metadata as { uri: string }).uri,
    score: match.score,
    variant: "nonstandard" as const,
    rank: i,
  }));

  const recs: Recommendation[] = [...standardRecs, ...nonstandardRecs];

  if (recs.length > 0 && !dryRun) {
    // Clear all existing variants for this user, then insert the new ones.
    // The single DELETE wipes both standard and nonstandard in one statement
    // so the writer doesn't need to know which variants exist.
    const stmts: D1PreparedStatement[] = [
      db.prepare(`DELETE FROM recommendations WHERE did = ?`).bind(did),
      ...recs.map((r) =>
        db
          .prepare(
            `INSERT INTO recommendations (did, document_uri, score, variant, rank) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(r.did, r.document_uri, r.score, r.variant, r.rank),
      ),
    ];
    await db.batch(stmts);
  }

  console.log(
    `  ${did}: ${standardRecs.length} standard + ${nonstandardRecs.length} nonstandard recommendations generated`,
  );
  if (nonstandardRecs.length < topN) {
    console.warn(
      `  ${did}: nonstandard recs short (${nonstandardRecs.length}/${topN}) — ` +
      `validMatches=${validMatches.length}, CANDIDATE_POOL=${CANDIDATE_POOL}`,
    );
  }
  return recs;
}

/**
 * Compute a recency-weighted average of like vectors.
 *
 * More recent likes get higher weight via exponential decay.
 * Half-life of ~7 days: a like from 7 days ago has half the weight of today's.
 */
function computeTasteVector(
  likeVectors: VectorizeVector[],
  likeHashToTimestamp: Map<string, number>,
): number[] {
  const now = Date.now();
  const halfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const ln2 = Math.LN2;

  // likeHashToTimestamp maps hash ID → liked_at timestamp
  const likedAtMap = likeHashToTimestamp;

  // Determine vector dimensionality from first vector
  const dim = likeVectors[0].values!.length;
  const sum = new Float64Array(dim);
  let totalWeight = 0;

  for (const vec of likeVectors) {
    if (!vec.values) continue;

    const likedAt = likedAtMap.get(vec.id) ?? now;
    const ageMs = now - likedAt;
    const weight = Math.exp((-ln2 * ageMs) / halfLifeMs);

    for (let i = 0; i < dim; i++) {
      sum[i] += vec.values[i] * weight;
    }
    totalWeight += weight;
  }

  // Normalize
  if (totalWeight > 0) {
    for (let i = 0; i < dim; i++) {
      sum[i] /= totalWeight;
    }
  }

  return Array.from(sum);
}

/**
 * L2-normalize a vector to unit length. Returns the original vector
 * unchanged if its norm is zero (degenerate case — shouldn't happen
 * in practice because `computeTasteVector` rejects vectors with zero
 * total weight, but defensive).
 *
 * Used before passing the taste vector into MMR, so the relevance
 * term `dot(cVec, taste)` produces true cosines matching the
 * diversity term's `dot(cVec, picked)` scale. See the call site in
 * `generateUserRecommendations` for the full rationale.
 */
function normalizeL2(v: number[]): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

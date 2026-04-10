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

type Recommendation = {
  did: string;
  document_uri: string;
  score: number;
};

/**
 * Generate recommendations for all enrolled users.
 */
export async function generateAllRecommendations(
  db: D1Database,
  vectors: VectorizeIndex,
  topN: number,
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

  // 2. Fetch their like vectors from Vectorize (IDs are hashed).
  // getByIds has a max of 20 IDs per call, so chunk the requests.
  const likeHashes = await vectorIds(likes.map((l) => l.uri));
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
  // returnMetadata must be "all" (not "indexed") because the uri field
  // is stored in metadata but not registered as a metadata index.
  // "all" limits topK to 50 per Cloudflare docs. Clamp to stay under.
  const topK = Math.min(topN * 2, 50);
  const matches = await vectors.query(tasteVector, {
    topK,
    namespace: "documents",
    returnValues: false,
    returnMetadata: "all",
  });

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

  if (recs.length > 0) {
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

  console.log(`  ${did}: ${recs.length} recommendations generated`);
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

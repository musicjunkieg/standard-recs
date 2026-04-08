/**
 * Recommendation engine.
 *
 * For each user:
 *   1. Fetch their like vectors from Vectorize
 *   2. Compute a recency-weighted average → "taste vector"
 *   3. Query Vectorize for nearest documents
 *   4. Store top-N in D1
 */

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

  // 2. Fetch their like vectors from Vectorize
  const likeIds = likes.map((l) => l.uri);
  const likeVectors = await vectors.getByIds(likeIds);

  if (likeVectors.length === 0) {
    console.log(`  ${did}: no embedded likes yet`);
    return [];
  }

  // 3. Compute recency-weighted average (exponential decay)
  const tasteVector = computeTasteVector(likeVectors, likes);

  // 4. Query Vectorize for nearest documents
  const matches = await vectors.query(tasteVector, {
    topK: topN * 2, // Fetch extra for filtering
    namespace: "documents",
    returnValues: false,
    returnMetadata: "indexed",
  });

  // 5. Store top-N in D1
  const recs: Recommendation[] = matches.matches
    .slice(0, topN)
    .map((match) => ({
      did,
      document_uri: match.id,
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
  likes: Array<{ uri: string; liked_at: string | null }>,
): number[] {
  const now = Date.now();
  const halfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const ln2 = Math.LN2;

  // Map URI → liked_at for weight calculation
  const likedAtMap = new Map(
    likes.map((l) => [l.uri, l.liked_at ? new Date(l.liked_at).getTime() : now]),
  );

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

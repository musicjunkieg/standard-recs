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
 * `vectors.query()` call. The function fails fast with a clear error
 * message if any input is missing its values vector.
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

  // Defensive guard — the caller must pass returnValues: true on the
  // originating vectors.query() call. Without values, dot() would crash
  // with a cryptic TypeError inside the loop. Fail fast and clearly instead.
  for (const c of candidates) {
    if (!c.values) throw new Error("pickMMR: candidate missing values — caller must set returnValues: true");
  }
  for (const s of seed) {
    if (!s.values) throw new Error("pickMMR: seed missing values — caller must set returnValues: true");
  }

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
 * Dot product of two equal-length numeric arrays or TypedArrays.
 * Equal to cosine similarity when both inputs are L2-normalized
 * (which Voyage embeddings are).
 */
function dot(
  a: number[] | Float32Array | Float64Array,
  b: number[] | Float32Array | Float64Array,
): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

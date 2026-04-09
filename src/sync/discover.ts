/**
 * Publisher discovery — find DIDs that publish site.standard.document records.
 *
 * Three methods, all running on Cloudflare Workers:
 *
 * 1. SEED: Bootstrap with known Standard.site platform DIDs.
 *    Runs once on first cron, inserts any missing seeds.
 *
 * 2. SOCIAL GRAPH: Check if authors of liked posts also
 *    publish documents. Runs every cron cycle.
 *
 * 3. JETSTREAM SCAN: Brief WebSocket connection to Jetstream
 *    filtered to site.standard.document creates. Catches
 *    active publishers in real time. Triggered via admin endpoint.
 */

import { AtpAgent } from "@atproto/api";

const agent = new AtpAgent({ service: "https://public.api.bsky.app" });
const PUBLICATION_COLLECTION = "site.standard.publication";

/**
 * Check whether a DID has at least one site.standard.publication record.
 * Used to filter out brid.gy bridged accounts that have documents but no
 * actual Standard.site publication.
 *
 * Returns:
 *   true  — definitively has a publication
 *   false — definitively has none
 *   null  — lookup failed (transient error, treat as "unknown — skip for now")
 */
export async function hasValidPublication(
  did: string,
): Promise<boolean | null> {
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: PUBLICATION_COLLECTION,
      limit: 1,
    });
    return res.data.records.length > 0;
  } catch (err) {
    console.error(`hasValidPublication lookup failed for ${did}:`, err);
    return null;
  }
}

/**
 * Known Standard.site publisher DIDs to seed the database.
 * These are either platform accounts or known active publishers.
 * Add more as the ecosystem grows.
 *
 * Find these from:
 *   - https://standard.site/docs/implementations/
 *   - The Standard.site community
 *   - pdsls.dev searches for site.standard.document
 */
const SEED_PUBLISHERS: Array<{ did: string; label: string }> = [
  // Add known publisher DIDs here, e.g.:
  // { did: "did:plc:abc123", label: "seed:leaflet-blog" },
];

/**
 * Insert seed publishers that aren't already in the database.
 * Idempotent — safe to call every cron run.
 */
export async function seedPublishers(db: D1Database): Promise<number> {
  if (SEED_PUBLISHERS.length === 0) return 0;

  const stmts = SEED_PUBLISHERS.map((p) =>
    db
      .prepare(`INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`)
      .bind(p.did, p.label),
  );

  await db.batch(stmts);

  // Count how many were actually new
  const { results } = await db
    .prepare(
      `SELECT COUNT(*) as n FROM publishers WHERE label LIKE 'seed:%'`,
    )
    .all<{ n: number }>();

  return results[0]?.n ?? 0;
}

/**
 * Discover publishers from users' social graphs.
 * Checks if authors of liked posts also publish documents.
 */
export async function discoverFromSocialGraph(
  db: D1Database,
): Promise<number> {
  const { results: candidates } = await db
    .prepare(
      `SELECT DISTINCT
         SUBSTR(liked_post_uri, 6, INSTR(SUBSTR(liked_post_uri, 6), '/') - 1) as did
       FROM likes
       WHERE SUBSTR(liked_post_uri, 6, INSTR(SUBSTR(liked_post_uri, 6), '/') - 1)
         NOT IN (SELECT did FROM publishers)
       LIMIT 50`,
    )
    .all<{ did: string }>();

  let discovered = 0;

  for (const candidate of candidates) {
    if (!candidate.did?.startsWith("did:")) continue;

    // Only register on a definitive true. false or null (lookup failed) → skip,
    // we'll retry on the next cron cycle.
    if ((await hasValidPublication(candidate.did)) === true) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`,
        )
        .bind(candidate.did, "auto:social-graph")
        .run();
      discovered++;
    }

    await sleep(100);
  }

  return discovered;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk all publishers and remove any that no longer have a valid
 * site.standard.publication record. Cascades deletion to documents,
 * recommendations referencing those documents, and vectors.
 */
export async function pruneInvalidPublishers(
  db: D1Database,
  vectors: VectorizeIndex,
): Promise<{ checked: number; removed: number; skipped: number }> {
  const { results: publishers } = await db
    .prepare(`SELECT did FROM publishers`)
    .all<{ did: string }>();

  let removed = 0;
  let skipped = 0;

  for (const pub of publishers) {
    const valid = await hasValidPublication(pub.did);
    // Only delete on a definitive false. null (lookup failed) → skip and
    // retry on the next cron — never delete data on a transient error.
    if (valid === true) {
      await sleep(100);
      continue;
    }
    if (valid === null) {
      skipped++;
      console.log(`    skipping ${pub.did}: publication lookup failed, will retry`);
      await sleep(100);
      continue;
    }

    // Collect document URIs so we can delete their vectors
    const { results: docs } = await db
      .prepare(`SELECT uri FROM documents WHERE did = ?`)
      .bind(pub.did)
      .all<{ uri: string }>();

    // Delete vectors first. If any chunk fails after retry, skip this
    // publisher entirely to avoid orphaning vectors with no D1 row.
    if (docs.length > 0) {
      const uris = docs.map((d) => d.uri);
      const ok = await deleteVectorsChunked(vectors, uris);
      if (!ok) {
        skipped++;
        console.error(
          `    skipping ${pub.did}: vector delete failed, will retry next cron`,
        );
        await sleep(100);
        continue;
      }
    }

    await db.batch([
      db
        .prepare(
          `DELETE FROM recommendations WHERE document_uri IN
             (SELECT uri FROM documents WHERE did = ?)`,
        )
        .bind(pub.did),
      db.prepare(`DELETE FROM documents WHERE did = ?`).bind(pub.did),
      db.prepare(`DELETE FROM publishers WHERE did = ?`).bind(pub.did),
    ]);

    removed++;
    console.log(`    pruned invalid publisher: ${pub.did} (${docs.length} docs)`);
    await sleep(100);
  }

  return { checked: publishers.length, removed, skipped };
}

/**
 * Delete vectors in chunks with one retry per chunk. Returns true on full
 * success, false if any chunk failed both attempts.
 */
async function deleteVectorsChunked(
  vectors: VectorizeIndex,
  ids: string[],
): Promise<boolean> {
  const CHUNK_SIZE = 100;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    try {
      await vectors.deleteByIds(chunk);
    } catch (err) {
      console.warn(`    Vectorize delete chunk failed, retrying:`, err);
      await sleep(500);
      try {
        await vectors.deleteByIds(chunk);
      } catch (retryErr) {
        console.error(`    Vectorize delete chunk failed after retry:`, retryErr);
        return false;
      }
    }
  }
  return true;
}

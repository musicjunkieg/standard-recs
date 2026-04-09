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
 */
export async function hasValidPublication(did: string): Promise<boolean> {
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: PUBLICATION_COLLECTION,
      limit: 1,
    });
    return res.data.records.length > 0;
  } catch {
    return false;
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

    if (await hasValidPublication(candidate.did)) {
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
): Promise<{ checked: number; removed: number }> {
  const { results: publishers } = await db
    .prepare(`SELECT did FROM publishers`)
    .all<{ did: string }>();

  let removed = 0;

  for (const pub of publishers) {
    if (await hasValidPublication(pub.did)) {
      await sleep(100);
      continue;
    }

    // Collect document URIs so we can delete their vectors
    const { results: docs } = await db
      .prepare(`SELECT uri FROM documents WHERE did = ?`)
      .bind(pub.did)
      .all<{ uri: string }>();

    if (docs.length > 0) {
      try {
        await vectors.deleteByIds(docs.map((d) => d.uri));
      } catch (err) {
        console.error(`    Vectorize delete failed for ${pub.did}:`, err);
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

  return { checked: publishers.length, removed };
}

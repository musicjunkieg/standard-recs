/**
 * Publisher discovery — find DIDs that publish site.standard.publication records.
 *
 * Three methods, all running on Cloudflare Workers:
 *
 * 1. SEED: Bootstrap with known Standard.site platform DIDs.
 *    Runs once on first cron, inserts any missing seeds.
 *
 * 2. LIGHTRAIL: Query lightrail.microcosm.blue for every DID in the atmosphere
 *    that has at least one site.standard.publication record. This is the primary
 *    discovery path — it replaces the old social-graph-based approach which only
 *    found publishers we happened to see in users' likes.
 *
 * 3. JETSTREAM SCAN: Brief WebSocket connection to Jetstream filtered to
 *    site.standard.publication + site.standard.document creates. Runs in a
 *    Durable Object for real-time publisher + document updates between cron runs.
 */

import { resolvePds } from "./pds-resolver.js";
import { listReposByCollection } from "./lightrail.js";
import { friendlyFetch } from "./fetch-helper.js";

const PUBLICATION_COLLECTION = "site.standard.publication";

/**
 * Query a specific PDS for records in a given collection using com.atproto.repo.listRecords.
 *
 * @param pds - Base URL of the PDS (e.g., `https://pds.example.com`)
 * @param did - Repository DID to query (the `repo` parameter)
 * @param collection - Collection name to list (the `collection` parameter)
 * @param limit - Maximum number of records to return (default: 100)
 * @param cursor - Optional pagination cursor
 * @returns The parsed response `{ records: [{ uri, cid, value }...], cursor? }`, or `null` when the HTTP response is not OK
 *
 * Note: network or JSON parsing errors are not caught here and will propagate to the caller.
 */
async function listRecordsFromPds<T = unknown>(
  pds: string,
  did: string,
  collection: string,
  limit = 100,
  cursor?: string,
): Promise<{ records: Array<{ uri: string; cid: string; value: T }>; cursor?: string } | null> {
  const url = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await friendlyFetch(url.toString());
  if (!res.ok) return null;
  return (await res.json()) as {
    records: Array<{ uri: string; cid: string; value: T }>;
    cursor?: string;
  };
}

export { listRecordsFromPds };

/**
 * Determine whether a DID has at least one site.standard.publication record.
 *
 * @returns `true` if at least one publication record exists for the DID, `false` if the PDS was reachable and no records were found, `null` if the lookup failed or the DID's PDS could not be resolved.
 */
export async function hasValidPublication(
  did: string,
): Promise<boolean | null> {
  const pds = await resolvePds(did);
  if (!pds) return null;

  try {
    const body = await listRecordsFromPds(pds, did, PUBLICATION_COLLECTION, 1);
    if (body === null) return null;
    return body.records.length > 0;
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
 *   - pdsls.dev searches for site.standard.publication
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
 * Discover publisher DIDs indexed by lightrail that have at least one site.standard.publication record.
 *
 * @returns The number of publisher DIDs that were newly inserted into the `publishers` table during this run
 */
export async function discoverViaLightrail(db: D1Database): Promise<number> {
  let discovered = 0;

  try {
    for await (const did of listReposByCollection(PUBLICATION_COLLECTION)) {
      // Per-iteration try/catch: a single failed insert must not abort the
      // whole lightrail stream. Keep the outer try around the iterator only.
      try {
        const result = await db
          .prepare(
            `INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`,
          )
          .bind(did, "auto:lightrail")
          .run();
        if ((result.meta.changes ?? 0) > 0) discovered++;
      } catch (insertErr) {
        console.error(`discoverViaLightrail insert failed for ${did}:`, insertErr);
        continue;
      }
    }
  } catch (err) {
    console.error("discoverViaLightrail stream failed:", err);
  }

  return discovered;
}

/**
 * Discover publisher DIDs by inspecting authors of liked posts and verifying they publish a site.standard.publication.
 *
 * Queries up to 50 candidate DIDs derived from the `likes` table, verifies each candidate with `hasValidPublication`, and inserts verified DIDs into `publishers` with the label `auto:social-graph`.
 *
 * @returns The number of DIDs inserted into `publishers` during this run
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

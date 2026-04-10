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

// pruneInvalidPublishers used to walk every publisher and call
// hasValidPublication on each to remove stale ones. That approach blew the
// per-invocation subrequest limit (6500+ publishers × PDS resolve + listRecords
// per publisher, all in one Workflow step). The cleanup job it performed is
// now handled inline during syncDocumentsFromRepo: any publisher whose PDS
// resolves to a bridged host gets its docs, vectors, and row deleted on the
// spot. Dropped publications (legit publishers who deleted their publication)
// are rare enough that we can address them with a dedicated admin endpoint
// later if needed, rather than walking the full table every cron.

/**
 * Run publisher discovery (seed, lightrail, social graph) and return counts.
 *
 * Discovery does NOT fetch documents — it just populates the `publishers`
 * table. Document fetching is handled by `syncDocumentsBatch` in documents.ts.
 *
 * Kept as its own Workflow step so its subrequest budget is separate
 * from the sync batches.
 */
export async function runDiscovery(
  db: D1Database,
): Promise<{ discovered: number; errors: number }> {
  await seedPublishers(db);

  let discoveryErrors = 0;

  console.log("  Discovering publishers via lightrail...");
  let fromLightrail = 0;
  try {
    fromLightrail = await discoverViaLightrail(db);
  } catch (err) {
    discoveryErrors++;
    console.error("  discoverViaLightrail threw:", err);
  }
  console.log(`    ${fromLightrail} new publishers from lightrail`);

  console.log("  Discovering publishers from social graph...");
  let fromSocialGraph = 0;
  try {
    fromSocialGraph = await discoverFromSocialGraph(db);
  } catch (err) {
    discoveryErrors++;
    console.error("  discoverFromSocialGraph threw:", err);
  }
  console.log(`    ${fromSocialGraph} new publishers from social graph`);

  return {
    discovered: fromLightrail + fromSocialGraph,
    errors: discoveryErrors,
  };
}

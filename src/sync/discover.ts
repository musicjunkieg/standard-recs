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
import { listRecordsFromPds } from "./pds-fetch.js";

const PUBLICATION_COLLECTION = "site.standard.publication";

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
  // Buffer DIDs and flush via db.batch() — a per-row INSERT was the dominant
  // cost of this step (one D1 round-trip per row × ~20k rows blew the
  // default 10-minute Workflow step timeout). Batching collapses that to one
  // round-trip per BATCH_SIZE rows.
  const BATCH_SIZE = 100;
  let discovered = 0;
  const buffer: string[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const stmts = buffer.map((did) =>
      db
        .prepare(`INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`)
        .bind(did, "auto:lightrail"),
    );
    // Let errors propagate. INSERT OR IGNORE makes batch retries idempotent,
    // and the discover step has an explicit retry policy in workflow.ts that
    // will handle transient D1 issues. Swallowing here would hide failures
    // from the workflow framework and prevent the retry from running.
    const results = await db.batch(stmts);
    for (const r of results) {
      if ((r.meta?.changes ?? 0) > 0) discovered++;
    }
    // Only clear the buffer after the batch lands. On failure the next
    // retry restarts from a fresh iterator anyway, but keeping the invariant
    // "buffer reflects rows not yet committed" is the cleaner contract.
    buffer.length = 0;
  };

  try {
    for await (const did of listReposByCollection(PUBLICATION_COLLECTION)) {
      buffer.push(did);
      if (buffer.length >= BATCH_SIZE) {
        await flush();
      }
    }
    await flush();
  } catch (err) {
    console.error("discoverViaLightrail failed:", err);
    throw err;
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

  // Lightrail is the primary discovery path. Let its errors propagate so the
  // workflow step's retry policy sees them — swallowing here would silently
  // turn transient D1/HTTP failures into "successful" runs with partial data.
  console.log("  Discovering publishers via lightrail...");
  const fromLightrail = await discoverViaLightrail(db);
  console.log(`    ${fromLightrail} new publishers from lightrail`);

  // Social graph is bounded at 50 candidates and the per-candidate failure
  // mode (PDS unreachable, etc.) is genuinely "skip and continue". Keep the
  // resilience here — a flaky PDS shouldn't block the rest of discovery.
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

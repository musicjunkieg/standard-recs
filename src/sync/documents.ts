/**
 * Sync site.standard.document records into D1.
 * Publisher discovery is handled by discover.ts.
 */

import {
  seedPublishers,
  discoverFromSocialGraph,
  discoverViaLightrail,
  listRecordsFromPds,
} from "./discover.js";
import { resolvePdsCached, isBridgedPds } from "./pds-resolver.js";

const COLLECTION = "site.standard.document";

export type DocSyncResult = {
  discovered: number;
  fetched: number;
  stored: number;
  errors: number;
};

/**
 * Synchronizes `site.standard.document` records from discovered publishers into the local `documents` table and returns aggregated counters.
 *
 * Performs publisher seeding and discovery, fetches records from each publisher's repository, upserts documents into the database, and accumulates totals.
 *
 * @returns An object with counters:
 *  - `discovered`: the number of new publishers discovered,
 *  - `fetched`: the total number of records fetched from publishers,
 *  - `stored`: the total number of documents successfully upserted,
 *  - `errors`: the total number of errors encountered during the run
 */
/**
 * Run publisher discovery (seed, lightrail, social graph) and return counts.
 *
 * Discovery does NOT fetch documents — it just populates the `publishers`
 * table. Document fetching is handled by `syncDocumentsBatch` which is
 * called multiple times (once per batch) by the workflow orchestrator.
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

/**
 * Sync documents for a single batch of publishers.
 *
 * Selects the `limit` least-recently-synced publishers, iterates them
 * sequentially, and stamps `last_synced_at` after each one (success or
 * failure). Designed to fit within a single Worker invocation's subrequest
 * budget — the caller is expected to invoke this function repeatedly
 * (one invocation per Workflow step) until `processed` comes back 0.
 *
 * @returns processed: number of publisher rows selected this call
 *          (0 means there's nothing left to sync)
 */
export async function syncDocumentsBatch(
  db: D1Database,
  vectors: VectorizeIndex,
  limit: number,
): Promise<{
  processed: number;
  fetched: number;
  stored: number;
  errors: number;
  bridged: number;
}> {
  // Take publishers that have never been synced OR were synced more than
  // 23 hours ago. The 23h window lets us re-sync daily via the cron while
  // keeping the loop converging toward "done" inside a single run.
  const { results: publishers } = await db
    .prepare(
      `SELECT did, label FROM publishers
        WHERE last_synced_at IS NULL
           OR last_synced_at < datetime('now', '-23 hours')
        ORDER BY last_synced_at ASC NULLS FIRST
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ did: string; label: string | null }>();

  if (publishers.length === 0) {
    return { processed: 0, fetched: 0, stored: 0, errors: 0, bridged: 0 };
  }

  let fetched = 0;
  let stored = 0;
  let errors = 0;
  let bridged = 0;

  for (const pub of publishers) {
    let result:
      | Awaited<ReturnType<typeof syncDocumentsFromRepo>>
      | null = null;
    try {
      result = await syncDocumentsFromRepo(db, vectors, pub.did);
      fetched += result.fetched;
      stored += result.stored;
      errors += result.errors;
      if (result.bridged) bridged++;
      if (result.stored > 0) {
        console.log(`    ${pub.label ?? pub.did}: ${result.stored} docs`);
      }
    } catch (err) {
      errors++;
      console.error(`    Failed: ${pub.did}`, err);
    }

    // Stamp the publisher as synced unless it was a bridged cleanup (in
    // which case the row has already been deleted). Stamping always
    // prevents a single bad publisher from blocking the queue.
    if (!result?.bridged) {
      try {
        await db
          .prepare(
            `UPDATE publishers SET last_synced_at = datetime('now') WHERE did = ?`,
          )
          .bind(pub.did)
          .run();
      } catch (err) {
        console.error(`    Failed to stamp last_synced_at for ${pub.did}:`, err);
      }
    }
  }

  return {
    processed: publishers.length,
    fetched,
    stored,
    errors,
    bridged,
  };
}

/**
 * Delete a bridged publisher's documents, vectors, recommendations, and
 * the publisher row itself. Called inline during sync whenever a publisher
 * is detected to live on a bridged PDS (e.g., brid.gy).
 */
async function cleanupBridgedPublisher(
  db: D1Database,
  vectors: VectorizeIndex,
  did: string,
): Promise<void> {
  // Collect document URIs for vector deletion
  const { results: docs } = await db
    .prepare(`SELECT uri FROM documents WHERE did = ?`)
    .bind(did)
    .all<{ uri: string }>();

  if (docs.length > 0) {
    const ids = docs.map((d) => d.uri);
    // Chunk to stay under Vectorize batch limits (1000/batch is safe)
    const CHUNK_SIZE = 500;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      try {
        await vectors.deleteByIds(ids.slice(i, i + CHUNK_SIZE));
      } catch (err) {
        console.error(`  cleanupBridgedPublisher: vector delete failed for ${did}:`, err);
        // Don't bail — proceed with D1 cleanup so we don't keep re-encountering this publisher
      }
    }
  }

  try {
    await db.batch([
      db
        .prepare(
          `DELETE FROM recommendations WHERE document_uri IN
             (SELECT uri FROM documents WHERE did = ?)`,
        )
        .bind(did),
      db.prepare(`DELETE FROM documents WHERE did = ?`).bind(did),
      db.prepare(`DELETE FROM publishers WHERE did = ?`).bind(did),
    ]);
  } catch (err) {
    console.error(`  cleanupBridgedPublisher: D1 cleanup failed for ${did}:`, err);
  }
}

/**
 * Synchronizes `site.standard.document` records from a publisher's PDS into the local `documents` table.
 *
 * The function resolves the publisher's PDS, pages through the collection, prepares upsert statements for each
 * record, executes them in batches, and accumulates counters for processed records and errors. It returns early
 * if PDS resolution fails or a PDS listing call fails.
 *
 * @param did - The publisher's decentralized identifier (DID) whose documents should be synchronized
 * @returns An object with counters:
 * - `fetched`: number of records read from the PDS
 * - `stored`: number of records successfully prepared/applied to the database
 * - `errors`: number of record- or operation-level failures encountered during the run
 */
export async function syncDocumentsFromRepo(
  db: D1Database,
  vectors: VectorizeIndex,
  did: string,
): Promise<{ fetched: number; stored: number; errors: number; bridged: boolean }> {
  const pds = await resolvePdsCached(db, did);
  if (!pds) {
    console.error(`  syncDocumentsFromRepo: cannot resolve PDS for ${did}`);
    return { fetched: 0, stored: 0, errors: 1, bridged: false };
  }

  // Bridged PDSes (e.g., brid.gy) create site.standard.publication records
  // for every bridged account, so the "has a publication" filter doesn't
  // exclude them. Remove any existing content from this publisher and drop
  // the publisher row so we never sync from them again.
  if (isBridgedPds(pds)) {
    console.log(`  skipping bridged publisher ${did} (${pds}) — cleaning up`);
    await cleanupBridgedPublisher(db, vectors, did);
    return { fetched: 0, stored: 0, errors: 0, bridged: true };
  }

  let cursor: string | undefined;
  let fetched = 0;
  let stored = 0;
  let errors = 0;

  while (true) {
    let body: Awaited<ReturnType<typeof listRecordsFromPds<StandardDocument>>>;
    try {
      body = await listRecordsFromPds<StandardDocument>(
        pds,
        did,
        COLLECTION,
        100,
        cursor,
      );
    } catch (err) {
      // Network/JSON error — record and return partial progress.
      console.error(`  listRecordsFromPds threw for ${did}:`, err);
      return { fetched, stored, errors: errors + 1, bridged: false };
    }

    if (body === null) {
      // PDS returned a non-2xx — surface as an error, keep partial totals
      return { fetched, stored, errors: errors + 1, bridged: false };
    }

    const { records, cursor: nextCursor } = body;
    if (!records.length) break;

    const stmts: D1PreparedStatement[] = [];

    for (const record of records) {
      fetched++;
      try {
        stmts.push(upsertDocumentStmt(db, record.uri, did, record.value));
      } catch (err) {
        errors++;
        console.error(`Failed to parse document ${record.uri}:`, err);
      }
    }

    if (stmts.length > 0) {
      try {
        await db.batch(stmts);
        // Only increment stored after the batch actually persisted
        stored += stmts.length;
      } catch (err) {
        errors += stmts.length;
        console.error(`Batch insert failed for ${did}:`, err);
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;
    await sleep(250);
  }

  return { fetched, stored, errors, bridged: false };
}

export type StandardDocument = {
  $type: "site.standard.document";
  site: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  textContent?: string;
  content?: unknown;
  tags?: string[];
  updatedAt?: string;
  coverImage?: unknown;
  bskyPostRef?: unknown;
};

/**
 * Upsert a single Standard.site document into D1.
 * Used by both the cron pipeline and the Jetstream listener.
 */
export function upsertDocumentStmt(
  db: D1Database,
  uri: string,
  did: string,
  doc: StandardDocument,
): D1PreparedStatement {
  const textContent =
    doc.textContent?.trim() || doc.description?.trim() || doc.title || null;
  return db
    .prepare(
      `INSERT OR REPLACE INTO documents
        (uri, did, site, title, path, description, text_content, tags, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uri,
      did,
      doc.site ?? null,
      doc.title,
      doc.path ?? null,
      doc.description ?? null,
      textContent,
      doc.tags ? JSON.stringify(doc.tags) : null,
      doc.publishedAt ?? null,
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

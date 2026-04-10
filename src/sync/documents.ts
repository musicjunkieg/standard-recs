/**
 * Sync site.standard.document records into D1.
 * Publisher discovery is handled by discover.ts.
 */

import { listRecordsFromPds } from "./pds-fetch.js";
import { resolvePdsCached, isBridgedPds } from "./pds-resolver.js";

const COLLECTION = "site.standard.document";

export type DocSyncResult = {
  discovered: number;
  fetched: number;
  stored: number;
  errors: number;
};

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
  let processed = 0;
  let fetched = 0;
  let stored = 0;
  let errors = 0;
  let bridged = 0;

  // Claim one publisher at a time via UPDATE ... RETURNING. The subquery
  // inside the UPDATE sees the state after any concurrent UPDATE commits,
  // and D1 serializes writes, so two workflows running this loop in parallel
  // can't claim the same row. This replaces a SELECT LIMIT N + loop pattern
  // which was race-prone across concurrent workflow instances.
  //
  // Side effect: last_synced_at is stamped BEFORE processing, not after.
  // If sync crashes mid-publisher, the row won't retry until the next 23h
  // window. That tradeoff is acceptable — we'd rather waste one publisher
  // per crash than do duplicate work across every concurrent workflow run.
  for (let i = 0; i < limit; i++) {
    const claimed = await db
      .prepare(
        `UPDATE publishers
            SET last_synced_at = datetime('now')
          WHERE did = (
            SELECT did FROM publishers
             WHERE last_synced_at IS NULL
                OR last_synced_at < datetime('now', '-23 hours')
             ORDER BY last_synced_at ASC NULLS FIRST
             LIMIT 1
          )
          RETURNING did, label`,
      )
      .first<{ did: string; label: string | null }>();

    if (!claimed) break; // nothing left to sync

    processed++;

    try {
      const result = await syncDocumentsFromRepo(db, vectors, claimed.did);
      fetched += result.fetched;
      stored += result.stored;
      errors += result.errors;
      if (result.bridged) bridged++;
      if (result.stored > 0) {
        console.log(`    ${claimed.label ?? claimed.did}: ${result.stored} docs`);
      }
    } catch (err) {
      errors++;
      console.error(`    Failed: ${claimed.did}`, err);
    }
  }

  if (processed === 0) {
    return { processed: 0, fetched: 0, stored: 0, errors: 0, bridged: 0 };
  }

  return { processed, fetched, stored, errors, bridged };
}

/**
 * Delete a bridged publisher's documents, vectors, recommendations, and
 * the publisher row itself. Called inline during sync whenever a publisher
 * is detected to live on a bridged PDS (e.g., brid.gy).
 *
 * Returns true on full success, false if any Vectorize chunk deletion
 * failed. On failure, the D1 rows are NOT deleted — losing them would
 * drop the URI→vector mappings needed to ever clean up the orphaned
 * vectors. The publisher's last_synced_at was stamped by the caller
 * before this ran, so natural 23h retry will kick in on the next cron.
 */
async function cleanupBridgedPublisher(
  db: D1Database,
  vectors: VectorizeIndex,
  did: string,
): Promise<boolean> {
  // Collect document URIs for vector deletion
  const { results: docs } = await db
    .prepare(`SELECT uri FROM documents WHERE did = ?`)
    .bind(did)
    .all<{ uri: string }>();

  let vectorDeleteFailed = false;

  if (docs.length > 0) {
    const ids = docs.map((d) => d.uri);
    // Chunk to stay under Vectorize batch limits (1000/batch is safe)
    const CHUNK_SIZE = 500;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      try {
        await vectors.deleteByIds(ids.slice(i, i + CHUNK_SIZE));
      } catch (err) {
        console.error(
          `  cleanupBridgedPublisher: vector delete failed for ${did}:`,
          err,
        );
        vectorDeleteFailed = true;
        break;
      }
    }
  }

  if (vectorDeleteFailed) {
    // Abort D1 cleanup. Leaving the documents rows in place preserves the
    // URI list needed to retry vector deletion on the next pass.
    return false;
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
    return true;
  } catch (err) {
    console.error(`  cleanupBridgedPublisher: D1 cleanup failed for ${did}:`, err);
    return false;
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
    const cleaned = await cleanupBridgedPublisher(db, vectors, did);
    if (!cleaned) {
      // Cleanup failed partway through (likely Vectorize). Don't mark as
      // bridged — leave the publisher in place so the 23h retry window
      // will attempt again. Surface as an error for visibility.
      return { fetched: 0, stored: 0, errors: 1, bridged: false };
    }
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

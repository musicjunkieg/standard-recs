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
import { resolvePds } from "./pds-resolver.js";

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
export async function syncAllDocuments(db: D1Database): Promise<DocSyncResult> {
  await seedPublishers(db);

  // Defensive wrappers so a discovery failure never aborts the whole
  // syncAllDocuments run. discoverViaLightrail already catches internally,
  // but discoverFromSocialGraph does not — keep the pattern uniform and
  // surface any failure in totalErrors so the caller can see it.
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

  const discovered = fromLightrail + fromSocialGraph;

  const { results: publishers } = await db
    .prepare(`SELECT did, label FROM publishers`)
    .all<{ did: string; label: string | null }>();

  console.log(`  Fetching documents from ${publishers.length} publishers...`);

  let totalFetched = 0;
  let totalStored = 0;
  let totalErrors = discoveryErrors;

  for (const pub of publishers) {
    try {
      const result = await syncDocumentsFromRepo(db, pub.did);
      totalFetched += result.fetched;
      totalStored += result.stored;
      totalErrors += result.errors;
      if (result.stored > 0) {
        console.log(`    ${pub.label ?? pub.did}: ${result.stored} docs`);
      }
    } catch (err) {
      totalErrors++;
      console.error(`    Failed: ${pub.did}`, err);
    }
  }

  return { discovered, fetched: totalFetched, stored: totalStored, errors: totalErrors };
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
  did: string,
): Promise<{ fetched: number; stored: number; errors: number }> {
  const pds = await resolvePds(did);
  if (!pds) {
    console.error(`  syncDocumentsFromRepo: cannot resolve PDS for ${did}`);
    return { fetched: 0, stored: 0, errors: 1 };
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
      return { fetched, stored, errors: errors + 1 };
    }

    if (body === null) {
      // PDS returned a non-2xx — surface as an error, keep partial totals
      return { fetched, stored, errors: errors + 1 };
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

  return { fetched, stored, errors };
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

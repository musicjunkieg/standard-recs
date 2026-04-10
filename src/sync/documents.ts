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

export async function syncAllDocuments(db: D1Database): Promise<DocSyncResult> {
  await seedPublishers(db);

  console.log("  Discovering publishers via lightrail...");
  const fromLightrail = await discoverViaLightrail(db);
  console.log(`    ${fromLightrail} new publishers from lightrail`);

  console.log("  Discovering publishers from social graph...");
  const fromSocialGraph = await discoverFromSocialGraph(db);
  console.log(`    ${fromSocialGraph} new publishers from social graph`);

  const discovered = fromLightrail + fromSocialGraph;

  const { results: publishers } = await db
    .prepare(`SELECT did, label FROM publishers`)
    .all<{ did: string; label: string | null }>();

  console.log(`  Fetching documents from ${publishers.length} publishers...`);

  let totalFetched = 0;
  let totalStored = 0;
  let totalErrors = 0;

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
    const body = await listRecordsFromPds<StandardDocument>(
      pds,
      did,
      COLLECTION,
      100,
      cursor,
    );

    if (body === null) {
      // PDS call failed — surface as an error so the caller knows something went wrong
      return { fetched, stored, errors: errors + 1 };
    }

    const { records, cursor: nextCursor } = body;
    if (!records.length) break;

    const stmts: D1PreparedStatement[] = [];

    for (const record of records) {
      fetched++;
      try {
        stmts.push(upsertDocumentStmt(db, record.uri, did, record.value));
        stored++;
      } catch (err) {
        errors++;
        console.error(`Failed to parse document ${record.uri}:`, err);
      }
    }

    if (stmts.length > 0) {
      try { await db.batch(stmts); } catch (err) {
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

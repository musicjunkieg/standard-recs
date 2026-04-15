/**
 * Low-level PDS fetch helpers shared between publisher discovery and
 * document sync. Keeping this in its own module prevents documents.ts
 * from depending on discover.ts just for a network primitive.
 */

import { friendlyFetch } from "./fetch-helper.js";

/**
 * Query a specific PDS for records in a given collection using
 * com.atproto.repo.listRecords.
 *
 * @param pds - Base URL of the PDS (e.g., `https://pds.example.com`)
 * @param did - Repository DID to query (the `repo` parameter)
 * @param collection - Collection name to list (the `collection` parameter)
 * @param limit - Maximum number of records to return (default: 100)
 * @param cursor - Optional pagination cursor
 * @returns The parsed response or `null` when the HTTP response is not OK.
 *
 * Note: network or JSON parsing errors are not caught here and will
 * propagate to the caller.
 */
export async function listRecordsFromPds<T = unknown>(
  pds: string,
  did: string,
  collection: string,
  limit = 100,
  cursor?: string,
): Promise<{
  records: Array<{ uri: string; cid: string; value: T }>;
  cursor?: string;
} | null> {
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

/**
 * Query a PDS for the current repo revision via
 * com.atproto.sync.getLatestCommit.
 *
 * Returns just the `rev` (a TID), which is the repo's logical clock.
 * This is the high-order bit for incremental sync: if the stored `rev`
 * matches the returned one, nothing in the repository has changed
 * since we last looked, and the caller can skip a full listRecords
 * walk. `rev` is repo-wide (bumps on any commit to any collection),
 * so chatty-Bluesky publishers will still show as "changed" even when
 * they haven't touched our collection — that's an accepted tradeoff;
 * the rev check is cheap and the degraded case is still no worse
 * than the current full-sync-every-cron behavior.
 *
 * @param pds - Base URL of the PDS (e.g., `https://pds.example.com`)
 * @param did - Repository DID to query
 * @returns The `rev` string on success, or `null` when the HTTP
 *          response is not OK or the body is malformed. Network
 *          or JSON parsing errors propagate to the caller.
 */
export async function getLatestCommitRev(
  pds: string,
  did: string,
): Promise<string | null> {
  const url = new URL(`${pds}/xrpc/com.atproto.sync.getLatestCommit`);
  url.searchParams.set("did", did);

  const res = await friendlyFetch(url.toString());
  if (!res.ok) return null;

  const body = (await res.json()) as { cid?: string; rev?: string };
  return typeof body.rev === "string" ? body.rev : null;
}

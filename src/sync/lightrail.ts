/**
 * Lightrail client — discover DIDs that have records in a given collection.
 *
 * Lightrail (https://lightrail.microcosm.blue) indexes the firehose to maintain
 * a map of collection → repos. A single call to listReposByCollection returns
 * every DID in the atmosphere that has at least one record in the target
 * collection. This replaces our previous Jetstream DO + social-graph
 * discovery path for publisher bootstrap.
 *
 * Endpoint: GET /xrpc/com.atproto.sync.listReposByCollection
 */

import { friendlyFetch } from "./fetch-helper.js";

const LIGHTRAIL_BASE = "https://lightrail.microcosm.blue";
const PAGE_SIZE = 500;
const MAX_PAGES = 40; // hard cap at ~20k DIDs per run

type ListReposResponse = {
  cursor?: string;
  repos: Array<{ did: string }>;
};

/**
 * Stream every DID that has at least one record in the given collection.
 * Paginates until lightrail stops returning a cursor or MAX_PAGES is hit.
 */
export async function* listReposByCollection(
  collection: string,
): AsyncGenerator<string, void, unknown> {
  let cursor: string | undefined;
  let page = 0;

  while (page < MAX_PAGES) {
    const url = new URL(`${LIGHTRAIL_BASE}/xrpc/com.atproto.sync.listReposByCollection`);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await friendlyFetch(url.toString());
    if (!res.ok) {
      throw new Error(
        `lightrail listReposByCollection failed: ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as ListReposResponse;
    for (const repo of body.repos) {
      yield repo.did;
    }

    if (!body.cursor || body.repos.length === 0) return;
    cursor = body.cursor;
    page++;
  }
}

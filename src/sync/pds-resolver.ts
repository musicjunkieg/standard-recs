/**
 * Resolve a DID to its PDS URL.
 *
 * The appview (public.api.bsky.app) does NOT implement com.atproto.repo.listRecords —
 * that's a PDS method. To fetch records from a specific repo we must call listRecords
 * against the DID's actual PDS, which we look up in the DID document.
 *
 * - did:plc  → fetch from plc.directory
 * - did:web  → fetch .well-known/did.json from the host
 *
 * Results are cached in-module for the lifetime of the Worker instance.
 */

import { friendlyFetch } from "./fetch-helper.js";

// Successful lookups are cached for the lifetime of the worker instance.
// Negative lookups (null) expire after NEGATIVE_TTL_MS so a transient
// plc.directory outage or network hiccup can't poison a DID permanently.
type CacheEntry = { endpoint: string | null; expiresAt: number };
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

type DidDocument = {
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
};

/**
 * Resolve a DID's AT Protocol Personal Data Server (PDS) endpoint and cache the result.
 *
 * Attempts to fetch and parse the DID document for `did`, extract the matching PDS service
 * entry, and return its `serviceEndpoint`. Results are stored in-module for the lifetime
 * of the worker to speed subsequent lookups.
 *
 * @param did - The DID to resolve (for example `did:web:example.com` or `did:plc:...`)
 * @returns The resolved PDS endpoint URL, or `null` if no PDS endpoint could be found or resolution failed
 */
export async function resolvePds(did: string): Promise<string | null> {
  const cached = cache.get(did);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.endpoint;
  }

  let endpoint: string | null = null;
  try {
    const doc = await fetchDidDocument(did);
    if (doc) {
      const pds = doc.service?.find(
        (s) =>
          s.type === "AtprotoPersonalDataServer" ||
          s.id === "#atproto_pds" ||
          s.id.endsWith("#atproto_pds"),
      );
      endpoint = pds?.serviceEndpoint ?? null;
    }
  } catch (err) {
    console.error(`resolvePds failed for ${did}:`, err);
  }

  cache.set(did, {
    endpoint,
    // Successful entries never expire; negative entries expire soon so
    // transient failures don't become permanent.
    expiresAt: endpoint ? Number.POSITIVE_INFINITY : Date.now() + NEGATIVE_TTL_MS,
  });
  return endpoint;
}

/**
 * Resolve a DID's PDS, preferring a cached value stored in the `publishers`
 * table over a network lookup. On a successful fresh resolve, the result is
 * written back to D1 so subsequent runs (or other worker instances) can
 * skip the plc.directory / did:web fetch.
 *
 * This is the cheap path for the sync pipeline: most publishers are resolved
 * once, cached in D1, and never hit the network again.
 */
export async function resolvePdsCached(
  db: D1Database,
  did: string,
): Promise<string | null> {
  // Check D1 first
  const row = await db
    .prepare(`SELECT pds_url FROM publishers WHERE did = ?`)
    .bind(did)
    .first<{ pds_url: string | null }>();
  if (row?.pds_url) return row.pds_url;

  // Not cached — do a fresh resolve
  const endpoint = await resolvePds(did);
  if (endpoint) {
    try {
      await db
        .prepare(`UPDATE publishers SET pds_url = ? WHERE did = ?`)
        .bind(endpoint, did)
        .run();
    } catch (err) {
      console.error(`resolvePdsCached: failed to cache pds_url for ${did}:`, err);
    }
  }
  return endpoint;
}

/**
 * Hostnames of PDS endpoints that bridge non-atproto content (RSS feeds,
 * fediverse posts) into atproto repos. We exclude content from these
 * bridges because it's not genuine Standard.site publishing — it's a side
 * effect of a generic bridge creating atproto records from external feeds.
 *
 * brid.gy specifically creates site.standard.publication records for every
 * bridged account, so a "has a publication" filter alone doesn't exclude
 * them. We have to match by PDS hostname.
 */
const BRIDGED_PDS_HOSTS = new Set<string>(["atproto.brid.gy"]);

export function isBridgedPds(pdsUrl: string | null | undefined): boolean {
  if (!pdsUrl) return false;
  try {
    const host = new URL(pdsUrl).hostname.toLowerCase();
    return BRIDGED_PDS_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Fetches the DID document for supported DID methods.
 *
 * @param did - The DID to resolve (supported formats include `did:plc:` and `did:web:`)
 * @returns `DidDocument` if the document was fetched and parsed successfully, `null` otherwise
 */
async function fetchDidDocument(did: string): Promise<DidDocument | null> {
  if (did.startsWith("did:plc:")) {
    const res = await friendlyFetch(`https://plc.directory/${did}`);
    if (!res.ok) return null;
    return (await res.json()) as DidDocument;
  }

  if (did.startsWith("did:web:")) {
    // did:web:example.com         → https://example.com/.well-known/did.json
    // did:web:example.com:path    → https://example.com/path/did.json
    const identifier = did.slice("did:web:".length);
    const [host, ...pathParts] = identifier.split(":");
    const decodedHost = decodeURIComponent(host);
    const url =
      pathParts.length === 0
        ? `https://${decodedHost}/.well-known/did.json`
        : `https://${decodedHost}/${pathParts.map(decodeURIComponent).join("/")}/did.json`;
    const res = await friendlyFetch(url);
    if (!res.ok) return null;
    return (await res.json()) as DidDocument;
  }

  return null;
}

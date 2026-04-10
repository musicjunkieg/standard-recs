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

const cache = new Map<string, string | null>();

type DidDocument = {
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
};

export async function resolvePds(did: string): Promise<string | null> {
  if (cache.has(did)) return cache.get(did)!;

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

  cache.set(did, endpoint);
  return endpoint;
}

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

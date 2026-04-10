/**
 * Vectorize has a 64-byte ID limit. AT Protocol URIs (like
 * "at://did:plc:abc123/site.standard.document/3mix2fjcd2623") are
 * typically 80-140 bytes — too long.
 *
 * Hash the URI to a 40-char hex string (160 bits of SHA-256). This is
 * deterministic, collision-resistant for any corpus we'll ever have,
 * and well under the 64-byte limit.
 */

/**
 * Hash a single URI to a Vectorize-safe ID.
 */
export async function vectorId(uri: string): Promise<string> {
  const data = new TextEncoder().encode(uri);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

/**
 * Hash multiple URIs in parallel.
 */
export async function vectorIds(uris: string[]): Promise<string[]> {
  return Promise.all(uris.map(vectorId));
}

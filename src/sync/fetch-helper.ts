/**
 * Outbound fetch helper that attaches a descriptive User-Agent.
 *
 * Community AT Protocol infrastructure (plc.directory, lightrail, random PDSes)
 * is run by volunteers — a recognizable User-Agent helps operators reach out
 * if we start misbehaving.
 */

const USER_AGENT =
  "standard-recs (+https://standard-recs.bryan-78d.workers.dev; @chaosgreml.in)";

/**
 * Perform a fetch request while ensuring a recognizable `User-Agent` header is present when one is not provided.
 *
 * @param input - The request target as a URL string or `URL` object.
 * @param init - Optional `RequestInit` to merge with the request; provided headers are preserved and only supplemented with `User-Agent` if missing.
 * @returns The `Response` returned by `fetch`.
 */
export function friendlyFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent") && !headers.has("User-Agent")) {
    headers.set("User-Agent", USER_AGENT);
  }
  return fetch(input, { ...init, headers });
}

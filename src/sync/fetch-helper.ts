/**
 * Outbound fetch helper that attaches a descriptive User-Agent.
 *
 * Community AT Protocol infrastructure (plc.directory, lightrail, random PDSes)
 * is run by volunteers — a recognizable User-Agent helps operators reach out
 * if we start misbehaving.
 */

const USER_AGENT =
  "standard-recs (+https://standard-recs.bryan-78d.workers.dev; @chaosgreml.in)";

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

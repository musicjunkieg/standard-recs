/**
 * Factory for creating a WorkersOAuthClient configured with D1 stores.
 *
 * Lightweight — safe to call per-request or per-Workflow-step.
 */

import { WorkersOAuthClient } from "atproto-oauth-client-cloudflare-workers";
import { JoseKey } from "@atproto/jwk-jose";
import type { Env } from "../env.js";
import { createStateStore, createSessionStore } from "./stores.js";

const ALL_REDIRECT_URIS = [
  "https://standardrecs.site/oauth/callback",
  "https://nonstandardrecs.site/oauth/callback",
  "https://substandardrecs.site/oauth/callback",
] as const;

/**
 * Build the OAuth client metadata document.
 *
 * The PUBLISHED form (served at `/oauth/client-metadata.json`) lists all
 * three variant callback URLs. PDS fetches that document and validates
 * incoming `redirect_uri` values against it, so any of the three variants
 * is a valid landing target.
 *
 * The RUNTIME form (used to construct the in-memory `WorkersOAuthClient`
 * for a specific request) lists ONLY the current variant's callback URL.
 * The reason is non-obvious: the underlying AT Proto OAuth library
 * hardcodes `redirect_uri: this.clientMetadata.redirect_uris[0]` in its
 * token-exchange request (see `oauth-server-agent.js:99` in the installed
 * library). It does NOT persist the per-authorize redirect_uri in state.
 * If we configured the runtime client with all three URIs, the library
 * would always send `redirect_uris[0]` (standardrecs.site) at token
 * exchange — which would mismatch the variant-specific URL recorded by
 * PDS at authorize time, and PDS would reject with `invalid_grant:
 * redirect_uri mismatch`.
 *
 * Workaround: per-request, build a runtime client whose `redirect_uris`
 * contains ONLY the current variant's URL. Then `redirect_uris[0]` at
 * authorize and at token exchange both resolve to the same value,
 * matching what PDS recorded. This is invisible to PDS — it only ever
 * sees the published metadata file (all three URLs) when validating.
 *
 * @param workerUrl - canonical app URL, used for client_id / jwks_uri
 * @param options.variantHostname - if provided, the runtime form returns
 *   only this variant's callback URL. If omitted, returns all three (for
 *   the `/oauth/client-metadata.json` route).
 */
function buildClientMetadata(
  workerUrl: string,
  options?: { variantHostname?: string },
) {
  const base = workerUrl.replace(/\/$/, "");
  const redirectUris: [string, ...string[]] = options?.variantHostname
    ? [`https://${options.variantHostname}/oauth/callback`]
    : [...ALL_REDIRECT_URIS];
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: "standard-recs",
    client_uri: base,
    redirect_uris: redirectUris,
    scope: "atproto rpc:app.bsky.feed.getActorLikes?aud=* transition:generic",
    grant_types: [
      "authorization_code",
      "refresh_token",
    ] as ["authorization_code" | "refresh_token", ...("authorization_code" | "refresh_token")[]],
    response_types: [
      "code",
    ] as ["code" | "none" | "token", ...("code" | "none" | "token")[]],
    application_type: "web" as "web" | "native",
    token_endpoint_auth_method: "private_key_jwt" as "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/oauth/jwks.json`,
  };
}

export { buildClientMetadata };

export async function createOAuthClient(
  env: Env,
  variantHostname?: string,
): Promise<WorkersOAuthClient> {
  if (!env.WORKER_URL) {
    throw new Error("WORKER_URL config var is required for OAuth client metadata");
  }

  const key = await JoseKey.fromImportable(env.OAUTH_PRIVATE_KEY, "key-1");

  return new WorkersOAuthClient({
    clientMetadata: buildClientMetadata(env.WORKER_URL, { variantHostname }),
    keyset: [key],
    stateStore: createStateStore(env.DB),
    sessionStore: createSessionStore(env.DB),
  });
}

/**
 * Factory for creating a WorkersOAuthClient configured with D1 stores.
 *
 * Lightweight — safe to call per-request or per-Workflow-step.
 */

import { WorkersOAuthClient } from "atproto-oauth-client-cloudflare-workers";
import { JoseKey } from "@atproto/jwk-jose";
import type { Env } from "../env.js";
import { createStateStore, createSessionStore } from "./stores.js";

const WORKER_URL = "https://standard-recs.bryan-78d.workers.dev";

// Inline type casts are required because TypeScript widens array literals to
// string[] when extracted from an `as const` object, but the library's
// OAuthClientMetadataInput expects specific literal-union tuples.
const CLIENT_METADATA = {
  client_id: `${WORKER_URL}/oauth/client-metadata.json`,
  client_name: "standard-recs",
  client_uri: WORKER_URL,
  redirect_uris: [`${WORKER_URL}/oauth/callback`] as [string, ...string[]],
  scope: "atproto rpc:app.bsky.feed.getActorLikes?aud=*",
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
  jwks_uri: `${WORKER_URL}/oauth/jwks.json`,
};

export { CLIENT_METADATA };

export async function createOAuthClient(env: Env): Promise<WorkersOAuthClient> {
  const key = await JoseKey.fromImportable(env.OAUTH_PRIVATE_KEY, "key-1");

  return new WorkersOAuthClient({
    clientMetadata: CLIENT_METADATA,
    keyset: [key],
    stateStore: createStateStore(env.DB),
    sessionStore: createSessionStore(env.DB),
  });
}

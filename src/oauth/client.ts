/**
 * Factory for creating a WorkersOAuthClient configured with D1 stores.
 *
 * Lightweight — safe to call per-request or per-Workflow-step.
 */

import { WorkersOAuthClient } from "atproto-oauth-client-cloudflare-workers";
import { JoseKey } from "@atproto/jwk-jose";
import type { Env } from "../env.js";
import { createStateStore, createSessionStore } from "./stores.js";

function buildClientMetadata(workerUrl: string) {
  const base = workerUrl.replace(/\/$/, "");
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: "standard-recs",
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`] as [string, ...string[]],
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

export async function createOAuthClient(env: Env): Promise<WorkersOAuthClient> {
  if (!env.WORKER_URL) {
    throw new Error("WORKER_URL config var is required for OAuth client metadata");
  }

  const key = await JoseKey.fromImportable(env.OAUTH_PRIVATE_KEY, "key-1");

  return new WorkersOAuthClient({
    clientMetadata: buildClientMetadata(env.WORKER_URL),
    keyset: [key],
    stateStore: createStateStore(env.DB),
    sessionStore: createSessionStore(env.DB),
  });
}

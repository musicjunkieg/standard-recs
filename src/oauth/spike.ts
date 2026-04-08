/**
 * OAuth spike — test that atproto-oauth-client-cloudflare-workers works on Workers.
 * Temporary — will be removed after validation.
 */

import { WorkersOAuthClient, type WorkersSavedState, type WorkersSavedSession } from "atproto-oauth-client-cloudflare-workers";
import { JoseKey } from "@atproto/jwk-jose";
import type { Env } from "../env.js";

const WORKER_URL = "https://standard-recs.bryan-78d.workers.dev";

/** In-memory stores (spike only — real impl uses D1) */
const stateMap = new Map<string, WorkersSavedState>();
const sessionMap = new Map<string, WorkersSavedSession>();

export async function spikeTest(env: Env): Promise<Record<string, unknown>> {
  // Step 1: Generate a signing key
  let key: JoseKey;
  try {
    key = await JoseKey.generate(["ES256"], "key-1");
  } catch (err) {
    return { step: "generate-key", success: false, error: String(err) };
  }

  // Step 2: Create the WorkersOAuthClient
  let client: WorkersOAuthClient;
  try {
    client = new WorkersOAuthClient({
      clientMetadata: {
        client_id: `${WORKER_URL}/oauth/client-metadata.json`,
        client_name: "standard-recs",
        client_uri: WORKER_URL,
        redirect_uris: [`${WORKER_URL}/oauth/callback`],
        scope: "atproto transition:generic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_signing_alg: "ES256",
        dpop_bound_access_tokens: true,
        jwks_uri: `${WORKER_URL}/oauth/jwks.json`,
      },
      keyset: [key],
      stateStore: {
        async set(key: string, val: WorkersSavedState) { stateMap.set(key, val); },
        async get(key: string) { return stateMap.get(key); },
        async del(key: string) { stateMap.delete(key); },
      },
      sessionStore: {
        async set(sub: string, val: WorkersSavedSession) { sessionMap.set(sub, val); },
        async get(sub: string) { return sessionMap.get(sub); },
        async del(sub: string) { sessionMap.delete(sub); },
      },
    });
  } catch (err) {
    return { step: "create-client", success: false, error: String(err) };
  }

  // Step 3: Try to call authorize
  try {
    const url = await client.authorize("chaosgreml.in", {
      scope: "atproto transition:generic",
    });

    return {
      step: "authorize",
      success: true,
      authUrl: url.toString().slice(0, 200) + "...",
    };
  } catch (err) {
    return { step: "authorize", success: false, error: String(err) };
  }
}

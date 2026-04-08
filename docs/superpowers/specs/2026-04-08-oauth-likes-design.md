# AT Protocol OAuth for Authenticated Likes Access

## Summary

Replace the unauthenticated `getActorLikes` call (which fails because Bluesky made likes private by default) with an AT Protocol OAuth flow. Users authorize standard-recs to read their likes during enrollment. The backend stores OAuth sessions in D1 and uses them for both the initial sync and daily cron refreshes.

## Decisions

- **Confidential client** (backend-hosted, server-side tokens) — required because the cron pipeline fetches likes while the user is away
- **Client metadata served from the worker** at `/oauth/client-metadata.json` — no custom domain needed
- **Granular scope:** `atproto rpc:app.bsky.feed.getActorLikes?aud=*` — read likes only, works with any PDS/appview
- **Session storage in D1** — new `oauth_state` and `oauth_sessions` tables
- **`atproto-oauth-client-cloudflare-workers`** (`WorkersOAuthClient`) — a Workers-compatible fork of the AT Protocol OAuth client. Patches two fetch incompatibilities (`request.cache` and `request.redirect`) that prevent the standard SDK from working on the edge runtime. Uses `@atproto/jwk-jose` for key handling. Validated in a spike: client creation and `authorize()` succeed on deployed Workers. Requires `nodejs_compat` for DNS-based handle resolution.
- **Scope fallback:** If `rpc:app.bsky.feed.getActorLikes?aud=*` is not accepted by the target PDS, fall back to `atproto transition:generic`. Document this as a known constraint — narrow scope when granular scopes are widely adopted.

## OAuth Flow

1. User enters handle on enrollment page, selects from typeahead
2. Page navigates to `GET /enroll?handle=chaosgreml.in` (no longer an AJAX POST)
3. Server creates a `WorkersOAuthClient`, calls `client.authorize(handle)` which resolves the user's PDS and returns an auth URL
4. Server redirects user to the auth URL (their PDS's authorization page)
5. User sees "standard-recs wants to read your likes", approves
6. PDS redirects to `GET /oauth/callback?code=...&state=...&iss=...`
7. Server calls `client.callback(params)` to exchange code for tokens
8. Server stores the OAuth session in D1 (`oauth_sessions` table)
9. Server creates/updates the user in the `users` table
10. Server kicks off a user-mode Workflow for the initial likes sync
11. Server redirects to `/recs/:did` (which shows the auto-refresh empty state)

## New Endpoints

### GET /oauth/client-metadata.json

Serves the client metadata document. This URL is the `client_id`.

```json
{
  "client_id": "https://standard-recs.bryan-78d.workers.dev/oauth/client-metadata.json",
  "client_name": "standard-recs",
  "client_uri": "https://standard-recs.bryan-78d.workers.dev",
  "redirect_uris": ["https://standard-recs.bryan-78d.workers.dev/oauth/callback"],
  "scope": "atproto rpc:app.bsky.feed.getActorLikes?aud=*",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "application_type": "web",
  "token_endpoint_auth_method": "private_key_jwt",
  "token_endpoint_auth_signing_alg": "ES256",
  "dpop_bound_access_tokens": true,
  "jwks_uri": "https://standard-recs.bryan-78d.workers.dev/oauth/jwks.json"
}
```

### GET /oauth/jwks.json

Serves the public key set for confidential client authentication. The private key is stored as a wrangler secret (`OAUTH_PRIVATE_KEY`).

### GET /oauth/callback

Handles the OAuth redirect. Exchanges the authorization code for tokens, stores the session, creates/updates the user, triggers the sync Workflow, and redirects to the recs page. If `client.callback(params)` fails (user denied consent, CSRF mismatch, PDS error), redirects to `/?error=auth_failed`.

## Changed Endpoints

### GET /enroll?handle=...

Replaces `POST /enroll`. Accepts a `handle` query parameter, initiates the OAuth flow, and redirects the user to their PDS. No longer returns JSON.

The old `POST /enroll` JSON endpoint is removed since the enrollment page now navigates directly instead of using AJAX.

If `client.authorize(handle)` fails (bad handle, PDS unreachable), redirect back to `/?error=resolve_failed` and show an error message on the enrollment page.

## New D1 Tables

### oauth_state

Stores authorization state during the OAuth flow. Short-lived (cleared after callback or expiry).

```sql
CREATE TABLE IF NOT EXISTS oauth_state (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### oauth_sessions

Stores authenticated session data (tokens, DPoP keys) per user DID. Used by the cron pipeline to restore sessions and fetch likes.

```sql
CREATE TABLE IF NOT EXISTS oauth_sessions (
  did TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The `session` column stores the serialized session object from the SDK's `sessionStore.set()` callback.

**Cleanup:** The daily cron pipeline deletes `oauth_state` rows older than 15 minutes to clean up abandoned authorization flows.

## New Secrets

### OAUTH_PRIVATE_KEY

An ES256 private key for confidential client assertions. Generated once:

```bash
npx @atproto/jwk-cli generate --alg ES256
```

Set via `wrangler secret put OAUTH_PRIVATE_KEY` (or Cloudflare API).

## New Dependencies

- `atproto-oauth-client-cloudflare-workers` — Workers-compatible AT Protocol OAuth client (drop-in replacement for `NodeOAuthClient`). Includes `@atproto/jwk-jose` for key handling.

The `@atproto/oauth-client` and `@atproto/jwk-webcrypto` packages from the spike can be removed — the Workers-specific package bundles everything needed.

## WorkersOAuthClient Configuration

The `WorkersOAuthClient` from `atproto-oauth-client-cloudflare-workers` handles `runtimeImplementation` automatically (including DPoP key generation, random values, digest, and handle resolution via DNS with `nodejs_compat`). Constructor parameters:

- **`clientMetadata`** — the client metadata object (same as served at `/oauth/client-metadata.json`)
- **`keyset`** — array containing the private signing key loaded from `OAUTH_PRIVATE_KEY` secret via `JoseKey.fromImportable()` from `@atproto/jwk-jose`
- **`stateStore`** — D1-backed implementation of `WorkersSavedStateStore` (implements `set`, `get`, `del`)
- **`sessionStore`** — D1-backed implementation of `WorkersSavedSessionStore` (implements `set`, `get`, `del`)

### Scope Strategy

The primary scope is `atproto rpc:app.bsky.feed.getActorLikes?aud=*` (granular, read-likes-only). This format is documented in the [August 2025 Auth Scopes update](https://github.com/bluesky-social/atproto/discussions/4118) and is live on `bsky.social`. If a PDS does not accept granular scopes, the implementation should detect the failure and retry with `atproto transition:generic` as a fallback. The client metadata `scope` field should list the granular scope; the fallback is only used at authorize-time if needed.

## Changes to Likes Sync

### src/sync/likes.ts

Currently creates a module-level unauthenticated `AtpAgent` against `public.api.bsky.app`. Changes:

- Remove the module-level `AtpAgent`
- `syncUserLikes` accepts an `Agent` parameter (authenticated, from restored OAuth session)
- `syncAllLikes` restores each user's OAuth session from D1, constructs an authenticated `Agent`, and passes it to `syncUserLikes`
- If a session can't be restored (revoked, expired beyond refresh), log the error and skip that user

### src/workflow.ts

The Workflow steps that call `syncUserLikes` and `syncAllLikes` need to pass D1 and construct an OAuth client to restore sessions. A new OAuth client instance must be created within each Workflow step that needs authenticated access — Workflow steps are individually retried and memoized, so objects do not survive across step boundaries. The client is lightweight to construct (it's just configuration + store references), so per-step instantiation is acceptable.

## New Files

| File | Purpose |
|------|---------|
| `src/oauth/client.ts` | Factory function to create `WorkersOAuthClient` with D1-backed stores and keyset from env |
| `src/oauth/stores.ts` | D1 implementations of `WorkersSavedStateStore` and `WorkersSavedSessionStore` (each implements `set`, `get`, `del`) |

## Changed Files

| File | Change |
|------|--------|
| `src/api/routes.ts` | Add OAuth endpoints, change `POST /enroll` to `GET /enroll?handle=`, remove old JSON enroll response |
| `src/api/enroll-page.ts` | Change typeahead selection from `fetch()` POST to `window.location` redirect to `/enroll?handle=...` |
| `src/sync/likes.ts` | Accept authenticated `Agent` instead of using unauthenticated public API |
| `src/workflow.ts` | Construct OAuth client in Workflow, restore sessions for likes sync |
| `src/env.ts` | Add `OAUTH_PRIVATE_KEY` to Env type |
| `schema.sql` | Add `oauth_state` and `oauth_sessions` tables |
| `wrangler.toml` | Add `nodejs_compat` if not already present |
| `package.json` | Add `atproto-oauth-client-cloudflare-workers`, remove `@atproto/oauth-client` and `@atproto/jwk-webcrypto` |

## Enrollment Page Changes

The enrollment page (`src/api/enroll-page.ts`) changes minimally:

- The `enroll(actor)` function changes from a `fetch('/enroll', ...)` POST to `window.location.href = '/enroll?handle=' + encodeURIComponent(actor.handle)`
- The success/error result box is removed (user is redirected away, never sees it)
- The note text "We'll look at your public likes" is updated to "We'll ask permission to read your likes" since access is now authorized, not public
- The page checks for `?error=resolve_failed` query param on load and shows an error message if present
- The recs lookup page (`src/api/recs-lookup-page.ts`) is unchanged

## What Stays the Same

- Recs page, recs lookup page
- Admin endpoints
- Jetstream DO (publisher discovery)
- Document sync (`src/sync/documents.ts`)
- Publisher discovery (`src/sync/discover.ts`)
- Embedding pipeline (`src/recommend/embed.ts`)
- Recommendation engine (`src/recommend/index.ts`)
- D1 schema for users, likes, documents, publishers, recommendations

## Edge Cases

- **User revokes access:** The session restore will fail. The cron skips that user and logs the error. The user would need to re-enroll.
- **Token refresh failure:** The SDK handles refresh automatically. If refresh fails permanently, same as revocation — skip and log.
- **User on self-hosted PDS:** Works because we use `aud=*` and the SDK auto-discovers the user's PDS from their DID.
- **Cloudflare Workers compatibility:** Validated via spike. Uses `atproto-oauth-client-cloudflare-workers` which patches two fetch incompatibilities (`request.cache` and `request.redirect`). Requires `nodejs_compat` for DNS handle resolution.

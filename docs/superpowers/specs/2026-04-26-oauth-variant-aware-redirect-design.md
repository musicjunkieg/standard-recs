# OAuth Variant-Aware Redirect — Design

**Date:** 2026-04-26
**Status:** Approved for implementation
**Related:** Builds on the three-variant infrastructure shipped in PRs #21 (variant routing), #25 (redesign), and #28 (substandard ranking). Fixes a UX bug where users who enroll from `nonstandardrecs.site` or `substandardrecs.site` always end up on `standardrecs.site` after the OAuth roundtrip, because all three variants share a single registered OAuth callback URL.

## Problem

The `WorkersOAuthClient` is configured in `src/oauth/client.ts` with `redirect_uris: [\`${base}/oauth/callback\`]` where `base = env.WORKER_URL`. `WORKER_URL` is a single string in `wrangler.toml` (currently `https://standardrecs.site`). So:

1. User on `https://nonstandardrecs.site` clicks enroll. The `/enroll` handler calls `client.authorize(handle, { scope })`. The library generates an authorize URL pointing at the user's PDS, including `redirect_uri = https://standardrecs.site/oauth/callback` (from client metadata).
2. PDS redirects user to standardrecs.site/oauth/callback (the only registered URL).
3. The callback handler at `/oauth/callback` runs on `standardrecs.site` (because that's where PDS sent the browser). It does `c.redirect(\`/recs/${did}\`)` — a relative redirect, so the browser stays on `standardrecs.site`.
4. User who started on nonstandardrecs.site ends up on `standardrecs.site/recs/[did]`.

This is the entire bug. It applies symmetrically to substandardrecs.site enrollments.

## Goal

After OAuth completes, return the user to the same variant hostname they enrolled from. The variant they pick at the start of the flow is the variant they get for the rest of their session.

Out of scope:

- Persisting variant preference per user across sessions (e.g., a cookie or DB field). The variant is determined per request by Host header, and that's the existing pattern. We just need to honor the originating host through one OAuth roundtrip.
- Cross-variant navigation UI (e.g., "switch to substandard" link). Users navigate by typing the hostname.
- Changing the canonical client_id / client metadata location. The OAuth client is one OAuth client from PDS's perspective; we just want it to have multiple valid redirect URIs.
- Changing how `WORKER_URL` is used. Today it is referenced only in `src/oauth/client.ts` (passed to `buildClientMetadata` for `client_id`, `client_uri`, and `jwks_uri`); it stays pinned to the canonical app URL. Only the OAuth `redirect_uris` array gets expanded.

## Approach

Register all three callback URLs in the OAuth client metadata, then have the `/enroll` handler pass the matching one to `client.authorize()` based on the originating Host header.

The AT Proto OAuth library supports this directly:

- `OAuthAuthorizationRequestParameters` (the type behind `AuthorizeOptions`) includes `redirect_uri?: string`. Confirmed by reading `node_modules/atproto-oauth-client-cloudflare-workers/node_modules/@atproto/oauth-types/dist/oauth-authorization-request-parameters.d.ts` line 11 (Zod schema) and line 111 (the parsed type).
- `redirect_uris` in `OAuthClientMetadata` is `[string, ...string[]]`. Confirmed by reading the same package's client-metadata type.
- The library will reject an `authorize()` call whose `redirect_uri` isn't in the registered `redirect_uris` list — that's the security guarantee. So we MUST register all three URIs in client metadata for this approach to work.

Once PDS redirects back to whichever URL was specified in the authorize call, the callback handler runs on that host and the existing relative `c.redirect(\`/recs/${did}\`)` keeps the user there.

### Why not OAuth state encoding?

An alternative approach would encode the originating host into OAuth `state`, callback always lands at standardrecs.site, decode state, do an absolute cross-host redirect to the right variant. This works but has drawbacks:

- Adds state encoding/decoding logic with its own correctness surface
- Cross-host redirects can interact badly with browser cookie scopes (the `WorkersSavedStateStore` and `WorkersSavedSessionStore` use D1, not cookies, so this is less of a problem here than on a typical webapp — but still a wrinkle)
- Doesn't match the OAuth spec's intent: redirect_uri is supposed to be where the auth response lands, not a hop on the way to where it lands

The multi-redirect-uri approach is the spec-faithful pattern when you have multiple legitimate landing pages for the same OAuth client.

### Why not three OAuth clients?

We could publish three separate `client-metadata.json` files (one per variant hostname), each registering its own callback. But then PDS treats them as three separate OAuth clients — a user who consents to one variant would have to re-consent to another, sessions wouldn't share, and the enrollment table would lose its single-source-of-truth shape. The single-client + multi-redirect approach is significantly simpler.

## Schema

No schema change. No new env vars. No new secrets.

## Signatures

### Changed: `src/oauth/client.ts` — `buildClientMetadata`

```ts
function buildClientMetadata(workerUrl: string) {
  const base = workerUrl.replace(/\/$/, "");
  // Register all three variant hostnames as valid redirect URIs.
  // PDS will only honor a redirect_uri that exactly matches one of
  // these. The /enroll handler picks the right one per request based
  // on the Host header so the user lands back on the variant they
  // enrolled from. client_id and jwks_uri stay on the canonical
  // worker URL so PDS treats this as one OAuth client across all
  // three variant hostnames.
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: "standard-recs",
    client_uri: base,
    redirect_uris: [
      "https://standardrecs.site/oauth/callback",
      "https://nonstandardrecs.site/oauth/callback",
      "https://substandardrecs.site/oauth/callback",
    ] as [string, ...string[]],
    // ...rest unchanged...
  };
}
```

The hostnames are hardcoded rather than derived from `HOSTNAME_TO_VARIANT` because:

- They're not strictly variant-coupled — the OAuth client could conceivably register additional redirect URIs that aren't variants.
- The OAuth client metadata file is publicly served at `/oauth/client-metadata.json` and PDS caches it — changing the list is a coordination event with PDS implementations, not a config change. Keeping the list explicit and grep-able in the code is appropriate.
- Importing from `variants.ts` would create a circular-ish dependency since `routes.ts` imports both.

If we ever add a fourth variant, the developer adding it touches both `variants.ts` AND `oauth/client.ts`. That's fine — the list is short.

### Changed: `src/api/routes.ts` — the `/enroll` handler

```ts
api.get("/enroll", async (c) => {
  const handle = c.req.query("handle")?.trim();
  if (!handle) {
    return c.redirect("/?error=resolve_failed");
  }

  // Use the originating host's callback URL so PDS sends the user
  // back to the variant they enrolled from. variantFromHost handles
  // port stripping and unknown-host fallback (always returning the
  // standard variant), so this works in dev and prod.
  const variant = c.get("variant");
  const redirectUri = `https://${variant.hostname}/oauth/callback`;

  try {
    const client = await createOAuthClient(c.env);

    let url: URL;
    try {
      url = await client.authorize(handle, {
        scope: "atproto rpc:app.bsky.feed.getActorLikes?aud=*",
        redirect_uri: redirectUri,
      });
    } catch (scopeErr) {
      const isScopeRejection =
        scopeErr instanceof Error &&
        "error" in scopeErr &&
        (scopeErr as { error?: string }).error === "invalid_scope";
      if (!isScopeRejection) throw scopeErr;
      console.warn("Granular scope rejected, falling back to transition:generic");
      url = await client.authorize(handle, {
        scope: "atproto transition:generic",
        redirect_uri: redirectUri,
      });
    }

    return c.redirect(url.toString());
  } catch (err) {
    // ...unchanged...
  }
});
```

`c.get("variant")` is already populated by the variant-routing middleware that runs before every request. `variant.hostname` is the canonical hostname per `VARIANTS` in `src/variants.ts`. No changes to the variant registry are needed.

### Unchanged: `src/api/routes.ts` — the `/oauth/callback` handler

The callback handler stays exactly as it is. Because PDS now returns the user to the originating variant's `/oauth/callback` URL, the relative `c.redirect(\`/recs/${did}\`)` already keeps them on the right host.

The `c.get("variant")` value inside the callback handler will reflect whichever host PDS sent the user back to — not the one where they originally clicked enroll, but the one where they're going to land. Since the callback only does a relative redirect, this is exactly the host they'll be on for the recs page.

### Unchanged: client_id, jwks_uri, all other client metadata fields

These remain pinned to `WORKER_URL` (`https://standardrecs.site`). PDS uses `client_id` as the stable identity of the OAuth client; pinning it to a single hostname is correct.

## Verification plan

Post-deploy, in order:

1. **Client metadata reflects all three URIs:**
   ```bash
   curl -s https://standardrecs.site/oauth/client-metadata.json | jq .redirect_uris
   ```
   Expected: an array of three URLs in the order specified.

2. **Same on the other two hosts** (the metadata file is served at all three because `/oauth/client-metadata.json` is in the public route set):
   ```bash
   curl -s https://nonstandardrecs.site/oauth/client-metadata.json | jq .redirect_uris
   curl -s https://substandardrecs.site/oauth/client-metadata.json | jq .redirect_uris
   ```
   Expected: identical arrays. The metadata file content is variant-independent — it advertises the OAuth client, not any one variant.

3. **Standard variant enrollment works (regression check):** open `https://standardrecs.site` in a private browser window, enter a test handle, complete the OAuth flow, confirm landing at `https://standardrecs.site/recs/[did]`.

4. **Nonstandard variant enrollment lands on the correct variant:** open `https://nonstandardrecs.site` in a private browser window, enter a test handle, complete the OAuth flow, confirm landing at `https://nonstandardrecs.site/recs/[did]` (NOT `standardrecs.site/recs/[did]`).

5. **Substandard variant enrollment lands on the correct variant:** open `https://substandardrecs.site` in a private browser window, enter a test handle, complete the OAuth flow, confirm landing at `https://substandardrecs.site/recs/[did]`.

6. **Existing enrolled users are unaffected.** Their session tokens are stored in D1 and tied to DID, not to the host. Visiting any variant's `/recs/[did]` should still render their existing recommendations.

## Failure modes

- **PDS rejects the new authorize call because the redirect_uri isn't recognized.** This would mean PDS hasn't refetched the client metadata after our deploy. AT Proto PDSes typically cache client metadata briefly (minutes to hours). Workaround: wait for the cache to expire, or test from a PDS instance under our control (Bluesky's main PDS handles cache invalidation reasonably).

- **A user's PDS implementation strictly validates `redirect_uri` against the registered list and the array isn't read correctly.** Unlikely — the OAuth spec is clear about this and the library handles it. If observed, fall back to the OAuth state-encoding approach mentioned in the "Why not" section above.

- **Browser caches the old client metadata.** Public file, no cache headers set today; browsers don't pin OAuth client metadata so this isn't a real concern. PDS is the only consumer that matters.

- **A new variant is added without updating `redirect_uris`.** The new variant's `/enroll` handler would generate an authorize URL with a redirect_uri that PDS rejects. Easy to detect (enrollment fails with a clear error) and easy to fix (add the URL to the list and redeploy). Worth a note in the variant-addition checklist if we ever document one.

## Files touched

| File | Change |
|---|---|
| `src/oauth/client.ts` | `buildClientMetadata` returns three `redirect_uris` instead of one. Hardcoded list, with a comment explaining why. |
| `src/api/routes.ts` | `/enroll` handler reads `c.get("variant").hostname` and passes `redirect_uri: \`https://${hostname}/oauth/callback\`` to both `client.authorize()` calls (granular-scope and fallback). |
| `docs/superpowers/specs/2026-04-26-oauth-variant-aware-redirect-design.md` | This file. |
| `docs/superpowers/plans/2026-04-26-oauth-variant-aware-redirect.md` | Implementation plan (next step). |

No changes to `src/variants.ts`, `src/oauth/stores.ts`, the `/oauth/callback` handler, the `/oauth/client-metadata.json` handler, the `/oauth/jwks.json` handler, the OAuth session/state stores, or anywhere else.

Net diff size estimate: ~10 lines changed.

## Non-goals (explicit, to prevent scope creep in review)

- **Not** changing `WORKER_URL` semantics or its other usages. It stays as the single canonical app URL.
- **Not** adding a database column or cookie to remember a user's preferred variant.
- **Not** rewriting the variant registry to derive `redirect_uris` programmatically. Hardcoded list is fine for three entries.
- **Not** introducing OAuth `state` encoding for variant carry-through. The multi-redirect-uri approach is the spec-faithful solution.
- **Not** touching the callback handler. It remains relative-redirect, which is correct once PDS sends the user to the right host.
- **Not** invalidating existing OAuth sessions. The client_id is unchanged; existing sessions stay valid.
- **Not** publishing variant-specific client metadata files. There remains exactly one `client_id` URL and one metadata file content.

# Admin Auth Middleware — Design

**Date:** 2026-04-13
**Status:** Approved for implementation
**Related:** none (standalone security fix)

## Problem

Seven of the nine `/admin/*` endpoints on the Worker have **no authentication**. Anyone who discovers an admin path can:

- Trigger full sync pipelines on demand (`POST /admin/sync`) — burns Voyage API budget and workflow execution time.
- Kill the Jetstream Durable Object (`POST /admin/jetstream/stop`) — silently breaks real-time publisher discovery.
- Enroll arbitrary publishers (`POST /admin/add-publisher`) — pollutes the database with attacker-controlled content.

Two endpoints — `/admin/test-embed` and `/admin/debug-embed` — currently gate on `Authorization: Bearer $VOYAGE_API_KEY` via inline checks. This was a stopgap before a proper gate existed. It also leaks operational coupling: rotating the Voyage key now breaks debugging.

Meanwhile, Cloudflare is logging a steady stream of drive-by probes (`/wp-admin`, `/.env`, `/.git/config`, etc.) from the three branded subdomains. None have hit `/admin/*` yet, but they will.

## Goal

Gate every `/admin/*` route behind a single bearer token stored as a secret, and remove the Voyage-key-as-admin-token hack from `test-embed` and `debug-embed`.

Out of scope for this change:
- IP allowlisting
- Request signing
- Rate limiting
- WAF rules for drive-by probes (separate concern, configured at the Cloudflare edge, not in code)

## Approach

Mount Hono's built-in `bearerAuth` middleware at `/admin/*`, verifying against a new `ADMIN_TOKEN` secret.

### Why `bearerAuth`, not a hand-rolled check

Hono's `bearerAuth` middleware (`hono/bearer-auth`, already present in the installed Hono 4.12.10) does four things the inline checks in `test-embed` / `debug-embed` currently don't:

1. **Timing-safe comparison.** When `token` is passed as a string, Hono internally calls `timingSafeEqual(token, observed, hashFunction)`. The existing inline `token !== c.env.VOYAGE_API_KEY` check is not timing-safe. In practice, network jitter dwarfs any comparison-time signal, so the existing check is not meaningfully exploitable, but "defer to the library's audited implementation" is still the right call.
2. **Correct `WWW-Authenticate` response header** on 401s, per RFC 6750. Clients and scanners that follow the spec know how to retry; the inline checks just return a JSON 401.
3. **Rejects malformed `Authorization` headers** with 400 `Bad Request` rather than 401, which matches RFC 6750 semantics.
4. **One line of middleware replaces two copies of the same hand-rolled check** — DRY, and future admin endpoints are gated automatically without per-route boilerplate.

### The env-binding vs construction-time token problem

`bearerAuth({ token })` takes the token as a value at middleware-construction time, not request time. On Cloudflare Workers, secrets live on `c.env`, which is only available inside a request handler — there is no module-scope access to `c.env.ADMIN_TOKEN`.

Two options:

**Option A — `verifyToken` callback.** The `verifyToken: (token, c) => boolean` variant has access to `Context` and can read `c.env.ADMIN_TOKEN` at request time. But the callback path bypasses Hono's internal `timingSafeEqual` — our callback would have to do the compare itself, and a naive `===` would lose timing safety.

**Option B — construct the middleware per request.** Wrap `bearerAuth({ token: c.env.ADMIN_TOKEN })` in a thin outer middleware that constructs it on each request and immediately invokes it. This is cheap (regex compile + a few object properties, microseconds) and delegates everything — including timing-safe compare — to Hono.

**Chosen: Option B.** Construction cost is negligible, and the whole point of using the library is that its audited internals handle the security-sensitive bits. Writing our own timing-safe compare in a `verifyToken` callback would be reimplementing for no reason.

### The exact shape

```ts
// src/api/routes.ts
import { bearerAuth } from "hono/bearer-auth";

// … existing middleware …

// Admin routes require a valid bearer token. The token is a per-
// deployment secret (wrangler secret put ADMIN_TOKEN). We construct
// the middleware per request because bearerAuth takes the token at
// construction time, and secrets are only available on c.env inside
// a request handler. The construction cost is microseconds and we
// inherit Hono's timing-safe comparison this way.
api.use("/admin/*", async (c, next) => {
  const mw = bearerAuth({ token: c.env.ADMIN_TOKEN });
  return mw(c, next);
});

// … existing /admin/* routes unchanged, except the inline checks in
// test-embed and debug-embed are removed …
```

### Changes to `test-embed` and `debug-embed`

Remove the inline `const token = …; if (!token || token !== c.env.VOYAGE_API_KEY) { return 401 }` block from both handlers. The admin middleware now covers them. Callers that used to send `Authorization: Bearer $VOYAGE_API_KEY` must update to `Authorization: Bearer $ADMIN_TOKEN`.

## Schema / bindings

- **`src/env.ts`**: add `ADMIN_TOKEN: string;` to the `Secrets` block (next to `VOYAGE_API_KEY` and `OAUTH_PRIVATE_KEY`).
- **`wrangler.toml`**: no change. Secrets are not declared in `wrangler.toml`; they're set via `wrangler secret put`.

## Operational impact

### Pre-deploy

Before merging and deploying, the operator must set the secret:

```bash
# Generate the token and pipe it directly into wrangler — no plaintext copy on disk.
openssl rand -hex 32 | wrangler secret put ADMIN_TOKEN
```

If you also need the value locally for ad-hoc smoke tests, store it in a secret manager (macOS Keychain via `security add-generic-password`, 1Password CLI, `pass`, etc.) rather than writing it to a file in the repo or home directory. Do **not** `tee` the output into `admin-token.txt` or any other plaintext file — that leaves the secret on disk for backup scanners, accidental commits, and shell-history greps to find.

If the secret is missing at runtime, `bearerAuth({ token: undefined })` does **not** throw during construction — the guard inside `bearerAuth` is `if (!("token" in options || "verifyToken" in options))`, and since `{ token: undefined }` has the key present, construction succeeds. At request time, `typeof options.token === "string"` is false and `Array.isArray(undefined)` is false, so `equal` stays `false` and every request is rejected with `401 Unauthorized`. The middleware still fails closed — admin routes are unreachable — but the observable signal is a 401, not a 500. Public routes remain unaffected. When testing pre-deploy, a 401 on `/admin/sync` is ambiguous: it could mean "secret is set and the token I sent is wrong" or "secret is unset entirely." The operator verification steps below must therefore always assert both the missing-header and correct-token cases.

### Post-deploy

Existing ad-hoc admin operations must include the header:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://standardrecs.site/admin/sync
```

The cron trigger is unaffected because it invokes `env.SYNC_PIPELINE.create()` directly from the `scheduled` handler in `src/index.ts`, bypassing HTTP entirely. The `JetstreamListener` Durable Object reconnect path is also unaffected — it's DO alarm state, not an HTTP caller.

### Rollback

If something breaks post-deploy, the rollback is:

1. `git revert <merge-commit>` and redeploy, OR
2. `wrangler secret delete ADMIN_TOKEN` — this will fail closed: every `/admin/*` request returns 401 (same mechanism as the missing-secret case described above). The secret can be re-put without a redeploy.

Public routes (enroll, recs, stats, OAuth, users) are never touched by this change and cannot break from an admin-token misconfiguration.

## Verification plan

1. **Unauthenticated request returns 401** with `WWW-Authenticate: Bearer realm=""`:
   ```bash
   curl -i -X POST https://standardrecs.site/admin/sync
   ```
2. **Wrong token returns 401**:
   ```bash
   curl -i -X POST -H "Authorization: Bearer wrong" https://standardrecs.site/admin/sync
   ```
3. **Correct token returns the usual 200 + `{ triggered: true, … }`**:
   ```bash
   curl -i -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://standardrecs.site/admin/sync
   ```
4. **Public routes unchanged** — enrollment page, `/stats`, `/recs/:did` all work without any header:
   ```bash
   curl -I https://standardrecs.site/
   curl -I https://standardrecs.site/stats
   ```
5. **`test-embed` and `debug-embed`** now accept `$ADMIN_TOKEN` and reject `$VOYAGE_API_KEY`:
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://standardrecs.site/admin/test-embed
   ```
6. **Cron still fires successfully** — watch `wrangler tail` at the next scheduled run and confirm the full pipeline kicks off normally.

## Files touched

| File | Change |
|---|---|
| `src/env.ts` | Add `ADMIN_TOKEN: string;` secret binding |
| `src/api/routes.ts` | Import `bearerAuth`, add `/admin/*` middleware, remove inline Voyage-key checks from `test-embed` and `debug-embed` |
| `docs/superpowers/specs/2026-04-13-admin-auth-design.md` | This file |
| `docs/superpowers/plans/2026-04-13-admin-auth.md` | Implementation plan (next step) |

No schema changes. No `wrangler.toml` changes. No dependency changes.

## Non-goals (explicit, to prevent scope creep in review)

- **Not** adding `ADMIN_TOKEN` to `wrangler.toml` — secrets do not belong there.
- **Not** gating OAuth routes (`/oauth/*`). Those are public on purpose — they're how Bluesky clients complete the auth handshake.
- **Not** implementing log-noise reduction for drive-by probes. That's a Cloudflare edge / WAF concern, separate PR, separate config surface.
- **Not** rotating the existing `VOYAGE_API_KEY`. This change does not re-use it and does not expose it.
- **Not** adding role-based access control, token revocation lists, or multi-token support. A single admin secret is sufficient for an operator-only surface.

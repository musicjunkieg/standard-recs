# OAuth Variant-Aware Redirect Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OAuth enrollment land users back on the variant hostname they enrolled from (instead of always landing on `standardrecs.site`) by registering all three callback URLs in OAuth client metadata and having the `/enroll` handler pick the right one per request.

**Architecture:** Two tightly-scoped changes. `src/oauth/client.ts` registers three `redirect_uris` in `buildClientMetadata` (hardcoded list, with explanatory comment). `src/api/routes.ts` `/enroll` handler reads `c.get("variant").hostname` and passes `redirect_uri: \`https://${hostname}/oauth/callback\`` to both `client.authorize()` calls. The existing relative redirect in `/oauth/callback` already keeps users on whichever host PDS sent them to.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, `atproto-oauth-client-cloudflare-workers`. No new dependencies, no schema, no env vars, no secrets.

**Spec:** `docs/superpowers/specs/2026-04-26-oauth-variant-aware-redirect-design.md` (on branch `fix/oauth-variant-aware-redirect`)

**Branch:** `fix/oauth-variant-aware-redirect` (already created off `main` by the controller, with the spec already committed)

**Pre-session state notes for the implementer:**
- `wrangler.toml` has unstaged local edits (`TOP_N = "12"`, `WORKER_URL = "https://standardrecs.site"`) that must NOT be committed. They are long-lived dev-box overrides. This plan does NOT touch `wrangler.toml`.
- Other untracked paths (`docs/stitch/`, two plan files under `docs/superpowers/plans/`) are not part of this PR and must not be staged.
- No test runner is configured per `CLAUDE.md`. Validation is exclusively `npx tsc --noEmit` and `npx wrangler deploy --dry-run`.

---

## Chunk 1: Implementation

### Task 1: Register all three redirect URIs in OAuth client metadata

**Why:** PDS validates `redirect_uri` from each authorize call against the registered `redirect_uris` array in client metadata. Currently only one URL is registered (`${WORKER_URL}/oauth/callback`). Without this change, Task 2's `redirect_uri` parameter would be rejected by PDS as not registered.

**Files:**
- Modify: `src/oauth/client.ts` (the `buildClientMetadata` function around line 12)

**Steps:**

- [ ] **Step 1: Read `src/oauth/client.ts`** to confirm shape

  You should see a `buildClientMetadata(workerUrl: string)` function (around line 12) that returns an object with `redirect_uris: [\`${base}/oauth/callback\`] as [string, ...string[]]`. The `base` variable is `workerUrl.replace(/\/$/, "")`.

- [ ] **Step 2: Replace the single-element `redirect_uris` with the three-element list**

  Find:
  ```ts
    redirect_uris: [`${base}/oauth/callback`] as [string, ...string[]],
  ```

  Replace with:
  ```ts
    // Register all three variant hostnames as valid redirect URIs.
    // PDS will only honor a redirect_uri that exactly matches one of
    // these. The /enroll handler picks the right one per request based
    // on the Host header so the user lands back on the variant they
    // enrolled from. client_id and jwks_uri stay on the canonical
    // worker URL so PDS treats this as one OAuth client across all
    // three variant hostnames.
    redirect_uris: [
      "https://standardrecs.site/oauth/callback",
      "https://nonstandardrecs.site/oauth/callback",
      "https://substandardrecs.site/oauth/callback",
    ] as [string, ...string[]],
  ```

  Notes:
  - The hostnames are hardcoded (not derived from `HOSTNAME_TO_VARIANT` in `src/variants.ts`). The spec's "Why hardcoded?" rationale: keeping the list explicit and grep-able in the OAuth file is appropriate since the OAuth client metadata is publicly served and PDS-cached, so changes are coordination events.
  - The `as [string, ...string[]]` type assertion is required by the library's type for `redirect_uris` (must be a non-empty tuple).
  - The order of URIs in the array does not matter for OAuth correctness; the order shown matches the variant key order in `src/variants.ts`.

- [ ] **Step 3: Verify nothing else in `buildClientMetadata` changed**

  Run: `git diff src/oauth/client.ts`

  Expected: ONLY the `redirect_uris` line and its surrounding comment block changed. `client_id`, `client_name`, `client_uri`, `scope`, `grant_types`, `response_types`, `application_type`, `token_endpoint_auth_method`, `token_endpoint_auth_signing_alg`, `dpop_bound_access_tokens`, and `jwks_uri` should all be unchanged.

- [ ] **Step 4: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean. The `as [string, ...string[]]` assertion satisfies the library's tuple-type requirement.

- [ ] **Step 5: Commit**

  ```bash
  git add src/oauth/client.ts
  git commit -m "$(cat <<'EOF'
  feat(oauth): register all three variant callback URLs

  Registers https://{standardrecs,nonstandardrecs,substandardrecs}.site/oauth/callback
  in the OAuth client metadata's redirect_uris array. Without this,
  PDS would reject any authorize call whose redirect_uri isn't the
  one previously-registered URL. The /enroll handler change in the
  next commit needs all three to be valid.

  client_id, client_uri, and jwks_uri remain pinned to WORKER_URL
  (the canonical app URL) so PDS treats this as one OAuth client
  with three valid landing URLs, not three separate clients.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 6: Verify commit**

  Run: `git show HEAD --stat`
  Expected: only `src/oauth/client.ts` changed, small diff (~10 lines added including the comment, 1 line removed).

  Run: `git status --short`
  Expected: only the pre-session dirty state (`M wrangler.toml`, three `??` paths). No other `M` lines.

**Self-review questions:**
- Did you touch any file other than `src/oauth/client.ts`?
- Are all three URIs hardcoded (no string interpolation against `base` for the redirect_uris)?
- Is the explanatory comment present and accurate?
- Are `client_id`, `client_uri`, and `jwks_uri` unchanged (still using `${base}`)?

---

### Task 2: Pass variant-aware `redirect_uri` from `/enroll` to `client.authorize()`

**Why:** With three URIs registered (Task 1), the OAuth client now needs to specify which one to use per authorize call. Without specifying, the library uses an unpredictable default (likely the first registered URI, but library-implementation-dependent). The `/enroll` handler reads the originating Host header via the existing variant middleware, picks the matching callback URL, and passes it explicitly. PDS then sends the user back to that exact host, where the existing relative redirect in `/oauth/callback` keeps them on the right variant.

**Files:**
- Modify: `src/api/routes.ts` (the `/enroll` handler around lines 64-95)

**Steps:**

- [ ] **Step 1: Read `src/api/routes.ts` lines 64-95** to confirm shape

  You should see the `/enroll` handler with this structure:
  ```ts
  api.get("/enroll", async (c) => {
    const handle = c.req.query("handle")?.trim();

    if (!handle) {
      return c.redirect("/?error=resolve_failed");
    }

    try {
      const client = await createOAuthClient(c.env);

      // Try granular scope first; fall back to transition:generic only on scope rejection
      let url: URL;
      try {
        url = await client.authorize(handle, {
          scope: "atproto rpc:app.bsky.feed.getActorLikes?aud=*",
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
        });
      }

      return c.redirect(url.toString());
    } catch (err) {
      // ...error path...
    }
  });
  ```

  Both `client.authorize()` calls take a `{ scope: string }` options object with no `redirect_uri`.

- [ ] **Step 2: Compute the variant-aware `redirect_uri` once before the authorize calls**

  Find (the line right after the early `if (!handle)` return, before the `try { const client = ... }` block):
  ```ts
    if (!handle) {
      return c.redirect("/?error=resolve_failed");
    }

    try {
      const client = await createOAuthClient(c.env);
  ```

  Insert the redirect URI computation between the closing brace of the `if` and the `try`:
  ```ts
    if (!handle) {
      return c.redirect("/?error=resolve_failed");
    }

    // Use the originating host's callback URL so PDS sends the user
    // back to the variant they enrolled from. variantFromHost (run by
    // the global middleware above) handles port stripping and
    // unknown-host fallback (always returning the standard variant),
    // so this works in dev and prod.
    const variant = c.get("variant");
    const redirectUri = `https://${variant.hostname}/oauth/callback`;

    try {
      const client = await createOAuthClient(c.env);
  ```

- [ ] **Step 3: Add `redirect_uri: redirectUri` to BOTH `client.authorize()` calls**

  First call — find:
  ```ts
        url = await client.authorize(handle, {
          scope: "atproto rpc:app.bsky.feed.getActorLikes?aud=*",
        });
  ```

  Replace with:
  ```ts
        url = await client.authorize(handle, {
          scope: "atproto rpc:app.bsky.feed.getActorLikes?aud=*",
          redirect_uri: redirectUri,
        });
  ```

  Second call (the `transition:generic` fallback) — find:
  ```ts
        url = await client.authorize(handle, {
          scope: "atproto transition:generic",
        });
  ```

  Replace with:
  ```ts
        url = await client.authorize(handle, {
          scope: "atproto transition:generic",
          redirect_uri: redirectUri,
        });
  ```

  Note: BOTH calls need the option. Skipping the fallback call would cause the second-attempt enrollment (after a scope rejection) to lose the variant.

- [ ] **Step 4: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean.

  If you get an error like `Type '{ scope: string; redirect_uri: string; }' is not assignable to type 'AuthorizeOptions'`, the library's `redirect_uri` field may have a stricter URL-template type that requires the value to be a literal `https://${string}` template. The string `\`https://${variant.hostname}/oauth/callback\`` should satisfy this because TypeScript can statically verify the template prefix. If you still get a type error, you may need to cast: `as \`https://${string}\`` — but try without the cast first.

- [ ] **Step 5: Sanity sweep**

  Run: `grep -n 'redirect_uri\|variant.hostname' src/api/routes.ts`

  Expected matches:
  - The new `const redirectUri = ...` line
  - Two `redirect_uri: redirectUri` lines (one per `client.authorize()` call)

- [ ] **Step 6: Dry-run deploy**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -15`
  Expected: successful dry-run. Sandbox EPERM warnings about `~/Library/Preferences` are expected; ignore them.

- [ ] **Step 7: Verify scope**

  Run: `git status --short`
  Expected: ONLY `M src/api/routes.ts` plus pre-session dirty state. NO other `M` lines.

  Run: `git diff src/api/routes.ts | grep -c "^+\|^-"`
  Expected: roughly 10-15 lines of `+`/`-` markers (small focused diff).

- [ ] **Step 8: Commit**

  ```bash
  git add src/api/routes.ts
  git commit -m "$(cat <<'EOF'
  fix(oauth): preserve variant through OAuth roundtrip

  The /enroll handler now reads c.get("variant").hostname (populated
  by the variant-routing middleware from the Host header) and passes
  redirect_uri = https://{hostname}/oauth/callback to both
  client.authorize() calls — the granular-scope attempt and the
  transition:generic fallback. PDS now sends users back to the
  variant they enrolled from instead of always to standardrecs.site.

  The existing relative c.redirect(`/recs/${did}`) in /oauth/callback
  already keeps users on whichever host received them, so no callback
  changes are needed.

  Fixes the UX where users enrolling on nonstandardrecs.site or
  substandardrecs.site landed on standardrecs.site/recs/[did].

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 9: Verify commit**

  Run: `git show HEAD --stat`
  Expected: only `src/api/routes.ts` changed.

  Run: `git status --short`
  Expected: only pre-session dirty state.

**Self-review questions:**
- Did you touch any file other than `src/api/routes.ts`?
- Is the `redirectUri` constant declared OUTSIDE the `try { ... }` block so both authorize calls can see it?
- Are BOTH `client.authorize()` calls passing the new `redirect_uri` option?
- Did you add or remove anything else (e.g., a refactor that wasn't in the plan)? If yes, escalate — that's scope creep.
- Does typecheck pass? Does dry-run succeed?

---

## Chunk 2: Verification and shipping

### Task 3: Final verification, push, and PR

**Why:** No code changes — pure verification + GitHub. Confirms typecheck is clean across the whole branch, dirty state is preserved, then pushes and opens the PR. Deploy and post-deploy verification are user-gated.

**Files:** None modified.

**Steps:**

- [ ] **Step 1: Verify the working tree**

  Run: `git status --short`

  Expected:
  ```text
   M wrangler.toml
  ?? docs/stitch/
  ?? docs/superpowers/plans/2026-04-08-oauth-likes-implementation.md
  ?? docs/superpowers/plans/2026-04-12-likes-doc-embedding-experiment.md
  ```

  The `M wrangler.toml` is the pre-session dirty state and must remain. If you see `M` on any file beyond `wrangler.toml`, stop and investigate.

  Run: `git diff wrangler.toml`
  Expected: only the two pre-session lines — `TOP_N` from `"10"` to `"12"`, `WORKER_URL` from the long `workers.dev` URL to `https://standardrecs.site`. Nothing else.

- [ ] **Step 2: Verify the branch commit list**

  Run: `git log --oneline main..HEAD`

  Expected (top to bottom, most recent first):
  ```text
  <task-2-sha> fix(oauth): preserve variant through OAuth roundtrip
  <task-1-sha> feat(oauth): register all three variant callback URLs
  <spec-r1-sha> docs(spec): correct WORKER_URL usage scope (oauth/client.ts only)
  <spec-sha> docs(spec): OAuth variant-aware redirect
  ```

  Four commits total. If you see more or fewer, stop and check with the controller.

- [ ] **Step 3: Final typecheck**

  Run: `npx tsc --noEmit`
  Expected: clean.

- [ ] **Step 4: Final dry-run**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -15`
  Expected: successful dry-run.

- [ ] **Step 5: Push the branch**

  Run: `git push -u origin fix/oauth-variant-aware-redirect`

  If push fails with `sign_and_send_pubkey: signing failed for ED25519`, the SSH agent has hiccuped (known transient on this Mac). Retry once with `git push`. If it still fails, escalate to the controller.

- [ ] **Step 6: Open the PR**

  ```bash
  gh pr create --title "fix(oauth): preserve variant through OAuth roundtrip" --body "$(cat <<'EOF'
  ## Summary

  Fixes the UX where users who enrolled from \`nonstandardrecs.site\` or \`substandardrecs.site\` always landed on \`standardrecs.site/recs/[did]\` after OAuth completed.

  - **\`src/oauth/client.ts\`**: \`buildClientMetadata\` now registers all three variant callback URLs (\`https://{standardrecs,nonstandardrecs,substandardrecs}.site/oauth/callback\`) in the OAuth client metadata's \`redirect_uris\` array. \`client_id\` and \`jwks_uri\` remain pinned to the canonical \`WORKER_URL\` so PDS treats this as one OAuth client with three valid landing URLs, not three separate clients.
  - **\`src/api/routes.ts\` (\`/enroll\` handler)**: reads \`c.get(\"variant\").hostname\` (populated by the existing variant-routing middleware) and passes \`redirect_uri: \\\`https://${hostname}/oauth/callback\\\`\` to both \`client.authorize()\` calls — the granular-scope attempt and the \`transition:generic\` fallback. PDS now sends users back to the variant they enrolled from.

  No schema change. No new env vars. No new secrets. The \`/oauth/callback\` handler is unchanged — its existing relative \`c.redirect(\\\`/recs/${did}\\\`)\` already keeps users on whichever host received them.

  Spec: \`docs/superpowers/specs/2026-04-26-oauth-variant-aware-redirect-design.md\`
  Plan: \`docs/superpowers/plans/2026-04-26-oauth-variant-aware-redirect.md\`

  ## PDS metadata cache caveat

  AT Proto PDSes typically cache \`client-metadata.json\` briefly (minutes to hours). Within that window post-deploy, a user attempting enrollment may have their PDS reject the new \`redirect_uri\` because the cached metadata still has only one URL registered. This is transient and self-resolves once the cache expires.

  ## Test plan

  - [ ] Merge + \`npm run deploy\`
  - [ ] Verify metadata serves the three URIs:
    \`\`\`bash
    curl -s https://standardrecs.site/oauth/client-metadata.json | jq .redirect_uris
    \`\`\`
    Expected: array with all three callback URLs.
  - [ ] Same on the other two hosts (the file is host-agnostic content):
    \`\`\`bash
    curl -s https://nonstandardrecs.site/oauth/client-metadata.json | jq .redirect_uris
    curl -s https://substandardrecs.site/oauth/client-metadata.json | jq .redirect_uris
    \`\`\`
    Expected: identical arrays.
  - [ ] Standard variant regression check: open \`https://standardrecs.site\` in a private window, enter a test handle, complete OAuth, confirm landing at \`https://standardrecs.site/recs/[did]\`.
  - [ ] Nonstandard variant: open \`https://nonstandardrecs.site\` in a private window, enter a test handle, complete OAuth, confirm landing at \`https://nonstandardrecs.site/recs/[did]\` (NOT \`standardrecs.site\`).
  - [ ] Substandard variant: open \`https://substandardrecs.site\` in a private window, enter a test handle, complete OAuth, confirm landing at \`https://substandardrecs.site/recs/[did]\`.
  - [ ] Existing enrolled users still see their recs at any variant's \`/recs/[did]\`. (Sessions are stored in D1 keyed by DID, not host.)

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Return the PR URL in your summary so the controller can link it.

- [ ] **Step 7: Handoff**

  Do NOT merge. Do NOT deploy. Do NOT run the post-deploy verification yourself. These are user-gated actions per `CLAUDE.md` and the subagent-driven-development skill. Return control to the controller with a DONE status and the PR URL.

---

## Deferred follow-ups (not part of this plan)

- **Cookie-based variant memory across sessions** — if a user wants to stay on substandardrecs even after closing the tab. Not needed: variant is a per-request choice via Host header.
- **Cross-variant navigation UI** — "switch to nonstandard" link on the recs page. Out of scope here.
- **Variant-specific OAuth scopes or display names** — same OAuth client across all three; same scope string.
- **OAuth state encoding for variant carry-through** — alternative considered in spec; rejected because multi-redirect-uri is the spec-faithful pattern.

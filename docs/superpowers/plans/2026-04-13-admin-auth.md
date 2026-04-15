# Admin Auth Middleware Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every `/admin/*` endpoint on the Worker behind a single `ADMIN_TOKEN` bearer secret, using Hono's built-in `bearerAuth` middleware. Remove the existing inline `VOYAGE_API_KEY` checks from `test-embed` and `debug-embed`.

**Architecture:** One new type-level secret (`ADMIN_TOKEN` in `src/env.ts`), one new middleware mount (`api.use("/admin/*", …)` in `src/api/routes.ts`), two handler-local cleanups (remove inline auth from `test-embed` and `debug-embed`). The middleware is constructed per-request inside a thin wrapper so it can read `c.env.ADMIN_TOKEN` at request time while still delegating timing-safe comparison to Hono.

**Tech Stack:** Hono 4.12.10 (`hono/bearer-auth`), TypeScript, Cloudflare Workers, Wrangler for secret management.

**Spec:** `docs/superpowers/specs/2026-04-13-admin-auth-design.md` (on branch `feat/admin-auth`)

**Branch:** `feat/admin-auth` (already created off `main` by the controller — fast-forward merge target for `fix/embed-scaling` already landed)

**Pre-session state notes for the implementer:**
- `wrangler.toml` has unstaged local edits (`TOP_N = "12"`, `WORKER_URL = "https://standardrecs.site"`) that must **not** be committed. They are long-lived dev-box overrides. This plan does **not** touch `wrangler.toml`, so the dirty state should pass through untouched. If you find yourself needing to commit `wrangler.toml` for any reason, stop and ask the controller.
- Other untracked paths (`.claude/`, `docs/stitch/`, two plan files under `docs/superpowers/plans/`) are not part of this PR and must not be staged.

---

## Chunk 1: Environment and routing

### Task 1: Add `ADMIN_TOKEN` binding to `src/env.ts`

**Why:** `bearerAuth` will read `c.env.ADMIN_TOKEN` at request time. Without the type-level binding, TypeScript won't know the field exists and the middleware closure won't compile. This task is purely type plumbing — it adds a slot, nothing references it yet until Task 2.

**Files:**
- Modify: `src/env.ts`

**Steps:**

- [ ] **Step 1: Read `src/env.ts` to confirm shape**

  You should see a `Secrets` block containing exactly:
  ```ts
  // Secrets
  VOYAGE_API_KEY: string;
  OAUTH_PRIVATE_KEY: string;
  ```

- [ ] **Step 2: Add `ADMIN_TOKEN: string;` to the Secrets block**

  Place it immediately after `OAUTH_PRIVATE_KEY`, so the block reads:
  ```ts
  // Secrets
  VOYAGE_API_KEY: string;
  OAUTH_PRIVATE_KEY: string;
  ADMIN_TOKEN: string;
  ```

  Do **not** reorder the existing lines. Do **not** add a comment — the binding name is self-explanatory and the spec documents the semantics. Do **not** touch the Config vars block.

- [ ] **Step 3: Run typecheck to verify no regression**

  Run: `npx tsc --noEmit`
  Expected: Clean (zero errors). The binding is declared but not yet referenced, so this is strictly additive.

- [ ] **Step 4: Commit**

  ```bash
  git add src/env.ts
  git commit -m "feat(env): add ADMIN_TOKEN secret binding"
  ```

  Append the `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer per this repo's convention.

---

### Task 2: Mount `bearerAuth` middleware on `/admin/*` and remove inline Voyage-key checks

**Why:** This is the actual security fix. One middleware mount replaces two hand-rolled checks and gates seven currently-unprotected endpoints. The change is self-contained to `src/api/routes.ts` and must be atomic — partial application would leave the system in a worse state than before (inconsistent auth posture, two different tokens required, or gaps).

**Files:**
- Modify: `src/api/routes.ts`

**Steps:**

- [ ] **Step 1: Read the top of `src/api/routes.ts` (lines 1–45)**

  Confirm the import block and the existing middleware mount pattern (`api.use("*", cors())`, `api.use("*", async (c, next) => { … variant … })`).

- [ ] **Step 2: Add the `bearerAuth` import**

  Add this import immediately after the existing `import { cors } from "hono/cors";` line:
  ```ts
  import { bearerAuth } from "hono/bearer-auth";
  ```

  Keep it grouped with the other Hono-library imports. Do **not** move any existing imports.

- [ ] **Step 3: Locate the `// ─── Admin ───` section header in `routes.ts`**

  It's above `api.post("/admin/sync", …)`. This is where the admin route group begins. All nine admin routes are below it.

- [ ] **Step 4: Insert the admin middleware immediately above the `// ─── Admin ───` header**

  Place this block between the last non-admin route and the `// ─── Admin ───` comment:

  ```ts
  // Admin routes require a valid bearer token. The token is a per-
  // deployment secret (wrangler secret put ADMIN_TOKEN). We construct
  // bearerAuth per request because the middleware takes `token` at
  // construction time, and secrets are only available on `c.env` inside
  // a request handler. The construction cost is microseconds and we
  // inherit Hono's timing-safe comparison this way.
  api.use("/admin/*", async (c, next) => {
    const mw = bearerAuth({ token: c.env.ADMIN_TOKEN });
    return mw(c, next);
  });
  ```

  This is one of the few comments worth keeping — it explains **why** we construct per-request rather than at module scope, which is non-obvious and would be the first thing a future reader wants to refactor away without understanding the constraint.

- [ ] **Step 5: Remove the inline auth block from `api.get("/admin/test-embed", …)`**

  Find the handler that begins around line 596. The first five or so lines of the body look like:
  ```ts
  api.get("/admin/test-embed", async (c) => {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token || token !== c.env.VOYAGE_API_KEY) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let currentStep = "voyage-fetch";
  ```

  Delete the three-line `const token = …; if (!token || token !== c.env.VOYAGE_API_KEY) { return c.json({ error: "Unauthorized" }, 401); }` block, plus the blank line that follows it. The handler should now open directly onto `let currentStep = "voyage-fetch";`.

  Also update the comment immediately above the handler. It currently reads:
  ```ts
  // Test Voyage API + Vectorize with a single embedding.
  // Gated by VOYAGE_API_KEY in the Authorization header to prevent
  // unauthenticated callers from triggering billable API calls.
  ```
  Change the second and third lines to:
  ```ts
  // Gated by the /admin/* bearer middleware (ADMIN_TOKEN) — do not
  // add a second inline check here.
  ```
  Rationale: the comment must reflect reality or it misleads the next reader. The "do not add a second inline check" nudge exists because the natural impulse when seeing an unprotected-looking handler is to add belt-and-suspenders auth, which would just duplicate the middleware.

- [ ] **Step 6: Remove the inline auth block from `api.post("/admin/debug-embed", …)`**

  Find the handler that begins around line 682. Same pattern — delete the three-line inline check at the top of the body. The handler should now open directly onto `const results: Array<{ step: string; ok: boolean; detail: unknown }> = [];`.

  This handler has no inline comment documenting its gate, so nothing to update above it.

- [ ] **Step 7: Sanity-sweep for any other `VOYAGE_API_KEY`-based auth checks you may have missed**

  Run: `grep -n 'VOYAGE_API_KEY' src/api/routes.ts`

  Expected surviving matches:
  - Line ~20: `import { VOYAGE_API, VOYAGE_MODEL, EMBEDDING_DIMENSIONS, … } from "../recommend/embed.js";` (not this one, different symbol — ignore)
  - Line ~612: `Authorization: Bearer ${c.env.VOYAGE_API_KEY}` — this is the **outbound** call to Voyage's API and must stay.
  - Line ~815 (approximate): another outbound `Authorization: Bearer ${apiKey}` in a helper. Also must stay.

  No surviving `c.env.VOYAGE_API_KEY` comparisons or `req.header("Authorization")` reads should remain in handler bodies. If you find any, delete them — they are leftover inline auth.

- [ ] **Step 8: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: Clean. Any error here most likely means the middleware import path is wrong (`hono/bearer-auth` is correct — do not use `hono/middleware/bearer-auth`).

- [ ] **Step 9: Dry-run deploy**

  Run: `npx wrangler deploy --dry-run 2>&1 | tail -40`

  Expected output contains a bindings table with `env.ADMIN_TOKEN` listed as a secret/text binding (Wrangler does not reveal secret values in dry-run — that's fine, the line exists means the binding is declared). A `(secret)` or empty-value display is expected. Subrequest count should not have changed materially.

  You may see a known sandbox EPERM warning from Wrangler trying to write a log to `~/Library/Preferences` — ignore that, the dry-run still completes.

- [ ] **Step 10: Self-review — confirm the admin surface is consistent**

  Run: `grep -n '/admin/' src/api/routes.ts`

  Expected: exactly nine handler registrations (`api.get`/`api.post` for `/admin/...`), plus the one `api.use("/admin/*", …)` line you just added. No stray inline Authorization checks inside any of them.

  Also run: `grep -n 'Authorization' src/api/routes.ts`

  Expected matches should be the outbound Voyage fetches and possibly the OAuth flow — nothing in `/admin/*` handler bodies.

- [ ] **Step 11: Commit**

  ```bash
  git add src/api/routes.ts
  git commit -m "$(cat <<'EOF'
  feat(api): gate /admin/* behind ADMIN_TOKEN bearer middleware

  One api.use("/admin/*", ...) replaces nine handlers' worth of
  implicit and explicit auth state. The existing inline
  VOYAGE_API_KEY checks in /admin/test-embed and /admin/debug-embed
  were a stopgap; they're removed now that real admin auth exists.

  See docs/superpowers/specs/2026-04-13-admin-auth-design.md for
  why the middleware is constructed per-request and why
  verifyToken was rejected.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Chunk 2: Verification and shipping

### Task 3: Final verification, PR, and handoff

**Why:** The code change is small enough that there are no meaningful test seams to exercise locally (no test runner configured, no unit tests in this repo — per `CLAUDE.md`). The real validation happens post-deploy against the running Worker. This task confirms the tree is clean, the dirty-state invariants are preserved, and opens the PR.

**Files:** None modified. This task is git state + GitHub.

**Steps:**

- [ ] **Step 1: Verify the working tree**

  Run: `git status --short`

  Expected:
  ```
   M wrangler.toml
  ?? .claude/
  ?? docs/stitch/
  ?? docs/superpowers/plans/2026-04-08-oauth-likes-implementation.md
  ?? docs/superpowers/plans/2026-04-12-likes-doc-embedding-experiment.md
  ```

  The `M wrangler.toml` is the pre-session dirty state and must remain. If you see `M` on any file this plan did not explicitly modify (beyond `wrangler.toml`), stop and investigate.

  Run: `git diff wrangler.toml`

  Expected: only two changed lines — `TOP_N` from `"10"` to `"12"`, and `WORKER_URL` from the long `workers.dev` URL to `https://standardrecs.site`. Nothing else. If `EMBED_BATCH_LIMIT` appears in this diff, something has gone very wrong — that value was committed on the previous PR and should now be in the base file content.

- [ ] **Step 2: Verify the branch commit list**

  Run: `git log --oneline main..HEAD`

  Expected (top to bottom, most recent first):
  ```
  <task-3-pr-open>        (not yet — that's the next step)
  <task-2-sha> feat(api): gate /admin/* behind ADMIN_TOKEN bearer middleware
  <task-1-sha> feat(env): add ADMIN_TOKEN secret binding
  <spec-review-sha> docs(spec): fix ADMIN_TOKEN-missing failure mode (401, not 500)
  <spec-sha> docs(spec): admin auth middleware (ADMIN_TOKEN bearer)
  ```

  If you see more or fewer commits, stop and check with the controller.

- [ ] **Step 3: Final typecheck against the whole branch**

  Run: `npx tsc --noEmit`
  Expected: Clean.

- [ ] **Step 4: Final dry-run**

  Run: `npx wrangler deploy --dry-run 2>&1 | grep -A1 -B1 "ADMIN_TOKEN\|Your Worker has access"`

  Expected: a bindings table that includes `env.ADMIN_TOKEN` (value hidden or shown as empty — either is correct in dry-run).

- [ ] **Step 5: Push the branch**

  ```bash
  git push -u origin feat/admin-auth
  ```

- [ ] **Step 6: Open the PR**

  ```bash
  gh pr create --title "feat(api): gate /admin/* behind ADMIN_TOKEN bearer middleware" --body "$(cat <<'EOF'
  ## Summary

  Seven of nine `/admin/*` endpoints were unauthenticated. This PR gates all of them behind a single bearer token stored as a `ADMIN_TOKEN` secret.

  - `src/api/routes.ts`: new `api.use("/admin/*", …)` middleware mount, constructed per request so it can read `c.env.ADMIN_TOKEN`. Hono's internal `timingSafeEqual` handles the compare.
  - `src/api/routes.ts`: inline `VOYAGE_API_KEY`-as-admin-token checks removed from `test-embed` and `debug-embed`. Callers must now use `ADMIN_TOKEN` instead. (The Voyage key is rotated independently and should never have been gating admin.)
  - `src/env.ts`: new `ADMIN_TOKEN: string;` secret binding.

  Spec: `docs/superpowers/specs/2026-04-13-admin-auth-design.md`
  Plan: `docs/superpowers/plans/2026-04-13-admin-auth.md`

  ## Pre-deploy

  Generate and set the secret before merging:

  ```bash
  openssl rand -hex 32
  npx wrangler secret put ADMIN_TOKEN
  ```

  Setting the secret before merging is safe — the currently-deployed code ignores the binding entirely. Setting it after merging would leave admin routes returning 401 until the secret lands.

  ## Test plan

  - [ ] `npx wrangler secret put ADMIN_TOKEN` (pre-merge, on `main`)
  - [ ] Merge this PR
  - [ ] `npm run deploy`
  - [ ] `curl -i -X POST https://standardrecs.site/admin/sync` → 401 + `WWW-Authenticate: Bearer realm=""`
  - [ ] `curl -i -X POST -H "Authorization: Bearer wrong" https://standardrecs.site/admin/sync` → 401
  - [ ] `curl -i -X POST -H "Authorization: Bearer \$ADMIN_TOKEN" https://standardrecs.site/admin/sync` → 200 `{ triggered: true, … }`
  - [ ] `curl -H "Authorization: Bearer \$ADMIN_TOKEN" https://standardrecs.site/admin/test-embed` → 200
  - [ ] `curl -I https://standardrecs.site/` → 200 (public routes unaffected)
  - [ ] Watch `wrangler tail` at next cron run — full pipeline kicks off normally (cron bypasses HTTP, so unaffected by bearer auth)

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Return the PR URL in your summary so the controller can link it.

- [ ] **Step 7: Handoff**

  Do not merge, deploy, or set the secret yourself — these actions are user-gated per `CLAUDE.md` and the subagent-driven-development skill. Return control to the controller with a DONE status and the PR URL.

---

## Deferred follow-ups (not part of this plan)

- **Cloudflare edge WAF rules** for drive-by probes (`/wp-admin`, `/.env`, `/.git/*`, `/phpmyadmin`, `/wp-json/*`). Configured in the dashboard, not in code. Separate concern.
- **Token rotation UX** (rotating `ADMIN_TOKEN` requires a `wrangler secret put` + any active admin sessions to re-auth). A single-op operator surface; no UX work needed until there's more than one operator.
- **Audit logging** on admin routes — nice-to-have, not required. Cloudflare already logs every request.

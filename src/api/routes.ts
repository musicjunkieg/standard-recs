/**
 * HTTP API routes.
 *
 * Enrollment triggers a Workflow instance for the user's like backfill.
 * Admin endpoints manage the Jetstream DO and trigger the full pipeline.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env.js";
import { createOAuthClient, buildClientMetadata } from "../oauth/client.js";
import { Agent } from "@atproto/api";
import { listUsers } from "../sync/users.js";
import { enrollPage } from "./enroll-page.js";
import { recsPage } from "./recs-page.js";
import { recsLookupPage } from "./recs-lookup-page.js";

const api = new Hono<{ Bindings: Env }>();

api.use("*", cors());

// ─── Public ───

// Enrollment page
api.get("/", (c) => c.html(enrollPage));

// API info
api.get("/api", (c) => {
  return c.json({
    name: "standard-recs",
    description: "Recommend Standard.site documents based on your Bluesky likes",
    endpoints: {
      "GET /enroll?handle=": "Enroll via OAuth (redirects to PDS)",
      "GET /recs/:did": "Get recommendations for a DID",
      "GET /stats": "Database stats",
    },
  });
});

// Enroll — initiates OAuth flow by redirecting user to their PDS
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
    console.error("OAuth authorize failed:", err);
    return c.redirect("/?error=resolve_failed");
  }
});

// Recs lookup page
api.get("/recs", (c) => c.html(recsLookupPage));

// Resolve handle → DID and redirect to recs page
api.get("/recs/by-handle/:handle", async (c) => {
  const handle = c.req.param("handle");

  const user = await c.env.DB.prepare(
    `SELECT did FROM users WHERE handle = ?`,
  )
    .bind(handle)
    .first<{ did: string }>();

  if (!user) {
    return c.html(recsPage({ state: "not_found" }), 404);
  }

  return c.redirect(`/recs/${user.did}`);
});

// Get recommendations for a user (content-negotiated: HTML for browsers, JSON for API)
api.get("/recs/:did", async (c) => {
  const did = c.req.param("did");
  const wantsHtml = c.req.header("Accept")?.includes("text/html");

  const user = await c.env.DB.prepare(
    `SELECT did, handle FROM users WHERE did = ?`,
  )
    .bind(did)
    .first<{ did: string; handle: string }>();

  if (!user) {
    if (wantsHtml) {
      return c.html(recsPage({ state: "not_found" }), 404);
    }
    return c.json({ error: "User not enrolled" }, 404);
  }

  const { results: recs } = await c.env.DB.prepare(
    `SELECT r.document_uri, r.score, r.generated_at,
            d.title, d.description, d.site, d.path, d.tags, d.published_at
     FROM recommendations r
     JOIN documents d ON r.document_uri = d.uri
     WHERE r.did = ?
     ORDER BY r.score DESC`,
  )
    .bind(did)
    .all();

  if (wantsHtml) {
    return c.html(
      recsPage({
        state: "found",
        handle: user.handle,
        did: user.did,
        recs: recs.map((r: Record<string, unknown>) => ({
          uri: r.document_uri as string,
          score: r.score as number,
          title: r.title as string,
          description: r.description as string | null,
          url: buildDocumentUrl(r.site as string | null, r.path as string | null),
          site: r.site as string | null,
        })),
      }),
    );
  }

  return c.json({
    did: user.did,
    handle: user.handle,
    recommendations: recs.map((r: Record<string, unknown>) => ({
      uri: r.document_uri,
      score: r.score,
      title: r.title,
      description: r.description,
      url: buildDocumentUrl(r.site as string | null, r.path as string | null),
      tags: r.tags ? JSON.parse(r.tags as string) : [],
      published_at: r.published_at,
      generated_at: r.generated_at,
    })),
  });
});

// Stats
api.get("/stats", async (c) => {
  const [users, likes, docs, recs, publishers] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM users`),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM likes`),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM documents`),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM recommendations`),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM publishers`),
  ]);

  // Get Jetstream DO status
  let jetstream = null;
  try {
    const doId = c.env.JETSTREAM_LISTENER.idFromName("singleton");
    const stub = c.env.JETSTREAM_LISTENER.get(doId);
    const res = await stub.fetch(new Request("http://do/status"));
    jetstream = await res.json();
  } catch { /* DO might not be started */ }

  return c.json({
    users: (users.results[0] as { n: number }).n,
    likes: (likes.results[0] as { n: number }).n,
    documents: (docs.results[0] as { n: number }).n,
    recommendations: (recs.results[0] as { n: number }).n,
    publishers: (publishers.results[0] as { n: number }).n,
    jetstream,
  });
});

// List enrolled users
api.get("/users", async (c) => {
  const users = await listUsers(c.env.DB);
  return c.json({ users });
});

// ─── Admin ───

// Trigger full sync pipeline
api.post("/admin/sync", async (c) => {
  const instance = await c.env.SYNC_PIPELINE.create({
    id: `full-${Date.now()}`,
    params: { mode: "full" as const },
  });

  return c.json({
    triggered: true,
    instanceId: instance.id,
    note: "Full pipeline Workflow started.",
  });
});

// Sync a single user's likes via Workflow
api.post("/admin/sync-user/:did", async (c) => {
  const did = c.req.param("did");

  const user = await c.env.DB.prepare(`SELECT did FROM users WHERE did = ?`)
    .bind(did)
    .first();

  if (!user) {
    return c.json({ error: "User not enrolled" }, 404);
  }

  const instance = await c.env.SYNC_PIPELINE.create({
    id: `user-${did.replace(/:/g, "-")}-${Date.now()}`,
    params: { mode: "user" as const, did },
  });

  return c.json({ triggered: true, instanceId: instance.id, did });
});

// Start the Jetstream listener DO
api.post("/admin/jetstream/start", async (c) => {
  const doId = c.env.JETSTREAM_LISTENER.idFromName("singleton");
  const stub = c.env.JETSTREAM_LISTENER.get(doId);
  const res = await stub.fetch(new Request("http://do/start"));
  const data = await res.json();
  return c.json(data);
});

// Stop the Jetstream listener DO
api.post("/admin/jetstream/stop", async (c) => {
  const doId = c.env.JETSTREAM_LISTENER.idFromName("singleton");
  const stub = c.env.JETSTREAM_LISTENER.get(doId);
  const res = await stub.fetch(new Request("http://do/stop"));
  const data = await res.json();
  return c.json(data);
});

// Jetstream listener status
api.get("/admin/jetstream/status", async (c) => {
  const doId = c.env.JETSTREAM_LISTENER.idFromName("singleton");
  const stub = c.env.JETSTREAM_LISTENER.get(doId);
  const res = await stub.fetch(new Request("http://do/status"));
  const data = await res.json();
  return c.json(data);
});

// OAuth client metadata (required by AT Protocol OAuth)
api.get("/oauth/client-metadata.json", (c) => {
  return c.json(buildClientMetadata(c.env.WORKER_URL));
});

// OAuth JWKS (public keys for client authentication)
api.get("/oauth/jwks.json", async (c) => {
  const { JoseKey } = await import("@atproto/jwk-jose");
  const key = await JoseKey.fromImportable(c.env.OAUTH_PRIVATE_KEY, "key-1");
  return c.json({ keys: [key.publicJwk] });
});

// OAuth callback — exchanges code for tokens, creates user, triggers sync
api.get("/oauth/callback", async (c) => {
  try {
    const client = await createOAuthClient(c.env);
    const params = new URL(c.req.url).searchParams;
    const { session } = await client.callback(params);
    const did = session.did;

    // Resolve handle from the authenticated session
    const agent = new Agent(session);
    const profile = await agent.getProfile({ actor: did });
    const handle = profile.data.handle;

    // Clear stale handle mapping (if another DID previously owned this handle)
    // then upsert the user. DID is the stable identity; handles can move.
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET handle = '' WHERE handle = ? AND did != ?`).bind(handle, did),
      c.env.DB.prepare(
        `INSERT INTO users (did, handle) VALUES (?, ?)
         ON CONFLICT(did) DO UPDATE SET handle = excluded.handle`,
      ).bind(did, handle),
    ]);

    // Kick off user-mode Workflow for initial likes sync
    await c.env.SYNC_PIPELINE.create({
      id: `enroll-${did.replace(/:/g, "-")}-${Date.now()}`,
      params: { mode: "user" as const, did },
    });

    return c.redirect(`/recs/${did}`);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return c.redirect("/?error=auth_failed");
  }
});

// Add a publisher manually (optional seed)
api.post("/admin/add-publisher", async (c) => {
  const body = await c.req.json<{ did: string; label?: string }>();

  if (!body.did) {
    return c.json({ error: "did is required" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`,
  )
    .bind(body.did, body.label ?? null)
    .run();

  return c.json({ added: true, did: body.did });
});

// ─── Helpers ───

function buildDocumentUrl(
  site: string | null,
  path: string | null,
): string | null {
  if (!site) return null;
  if (site.startsWith("at://")) return null;
  const base = site.replace(/\/$/, "");
  return path ? `${base}${path}` : base;
}

export { api };

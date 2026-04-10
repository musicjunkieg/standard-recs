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
import { AtpAgent } from "@atproto/api";

// Unauthenticated agent for public profile lookups (DID → handle).
// We can't use the OAuth session for this — its scope is narrow and
// doesn't include rpc:app.bsky.actor.getProfile.
const publicAgent = new AtpAgent({ service: "https://public.api.bsky.app" });
import { listUsers } from "../sync/users.js";
import { VOYAGE_API, VOYAGE_MODEL, EMBEDDING_DIMENSIONS } from "../recommend/embed.js";
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

    // Resolve handle via the public appview, NOT the authenticated session.
    // The OAuth scope only grants getActorLikes, not getProfile.
    const profile = await publicAgent.getProfile({ actor: did });
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

// Test Voyage API + Vectorize with a single embedding.
// Gated by VOYAGE_API_KEY in the Authorization header to prevent
// unauthenticated callers from triggering billable API calls.
api.get("/admin/test-embed", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token || token !== c.env.VOYAGE_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let currentStep = "voyage-fetch";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let res: Response;
    try {
      res = await fetch(VOYAGE_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.VOYAGE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: VOYAGE_MODEL,
          input: ["Hello world test embedding"],
          input_type: "query",
          output_dimension: EMBEDDING_DIMENSIONS,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      return c.json({ step: "voyage-fetch", ok: false, status: res.status, body }, 502);
    }

    currentStep = "voyage-parse";
    const data = await res.json() as Record<string, unknown>;
    if (
      !data ||
      !Array.isArray(data.data) ||
      data.data.length === 0 ||
      !Array.isArray((data.data as Record<string, unknown>[])[0]?.embedding)
    ) {
      return c.json({
        step: "voyage-parse",
        ok: false,
        error: "Unexpected Voyage response shape",
        receivedKeys: data ? Object.keys(data) : null,
      }, 422);
    }
    const vector = (data.data as Array<{ embedding: number[] }>)[0].embedding;

    currentStep = "vector-upsert";
    const probeId = `test-embed-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await c.env.VECTORS.upsert([{
      id: probeId,
      values: vector,
      namespace: "likes",
      metadata: { type: "test" },
    }]);

    currentStep = "vector-cleanup";
    await c.env.VECTORS.deleteByIds([probeId]);

    return c.json({
      step: "all",
      ok: true,
      voyageStatus: res.status,
      vectorDimensions: vector.length,
    });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    return c.json({
      step: currentStep,
      ok: false,
      error: isTimeout
        ? "Voyage API request timed out after 10s"
        : err instanceof Error ? err.message : String(err),
    }, isTimeout ? 504 : 500);
  }
});

// Debug embed with real data — fetches 5 real likes + 5 real docs from D1,
// sends them through Voyage, upserts to Vectorize, returns full result or error.
// POST because it writes to Vectorize (side effects).
api.post("/admin/debug-embed", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token || token !== c.env.VOYAGE_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const results: Array<{ step: string; ok: boolean; detail: unknown }> = [];

  // Test with real likes
  try {
    const { results: likes } = await c.env.DB
      .prepare(
        `SELECT uri, liked_post_text FROM likes
         WHERE liked_post_text IS NOT NULL AND liked_post_text != ''
         LIMIT 5`,
      )
      .all<{ uri: string; liked_post_text: string }>();

    if (likes.length === 0) {
      results.push({ step: "likes-query", ok: true, detail: "no likes with text" });
    } else {
      const texts = likes.map((l) => l.liked_post_text);
      const res = await fetchVoyage(c.env.VOYAGE_API_KEY, texts, "query");

      if (!res.ok) {
        const body = await res.text();
        results.push({ step: "likes-voyage", ok: false, detail: { status: res.status, body: body.slice(0, 1000) } });
      } else {
        const data = await res.json() as Record<string, unknown>;
        const validation = validateVoyageResponse(data, likes.length);
        if (!validation.ok) {
          results.push({ step: "likes-voyage-parse", ok: false, detail: validation.error });
        } else {
          const embeddings = validation.embeddings;
          const vectors: VectorizeVector[] = embeddings.map((emb, i) => ({
            id: likes[i].uri,
            values: emb,
            namespace: "likes",
            metadata: { type: "like" },
          }));
          await c.env.VECTORS.upsert(vectors);
          results.push({ step: "likes-embed", ok: true, detail: { count: likes.length, dimensions: embeddings[0].length } });
        }
      }
    }
  } catch (err) {
    results.push({ step: "likes", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // Test with real documents
  try {
    const { results: docs } = await c.env.DB
      .prepare(
        `SELECT uri, title, description, text_content FROM documents
         WHERE (text_content IS NOT NULL AND text_content != '')
            OR (description IS NOT NULL AND description != '')
         LIMIT 5`,
      )
      .all<{ uri: string; title: string; description: string | null; text_content: string | null }>();

    if (docs.length === 0) {
      results.push({ step: "docs-query", ok: true, detail: "no docs with content" });
    } else {
      const texts = docs.map((d) => {
        const body = d.text_content || d.description || "";
        return `${d.title}\n\n${body}`.slice(0, 16000);
      });
      const res = await fetchVoyage(c.env.VOYAGE_API_KEY, texts, "document");

      if (!res.ok) {
        const body = await res.text();
        results.push({ step: "docs-voyage", ok: false, detail: { status: res.status, body: body.slice(0, 1000) } });
      } else {
        const data = await res.json() as Record<string, unknown>;
        const validation = validateVoyageResponse(data, docs.length);
        if (!validation.ok) {
          results.push({ step: "docs-voyage-parse", ok: false, detail: validation.error });
        } else {
          const embeddings = validation.embeddings;
          const vectors: VectorizeVector[] = embeddings.map((emb, i) => ({
            id: docs[i].uri,
            values: emb,
            namespace: "documents",
            metadata: { type: "document", title: docs[i].title },
          }));
          await c.env.VECTORS.upsert(vectors);
          results.push({ step: "docs-embed", ok: true, detail: { count: docs.length, dimensions: embeddings[0].length } });
        }
      }
    }
  } catch (err) {
    results.push({ step: "docs", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  const allOk = results.every((r) => r.ok);
  return c.json({ ok: allOk, results }, allOk ? 200 : 502);
});

// ─── Helpers ───

/** Fetch Voyage embeddings with a 15s timeout. */
async function fetchVoyage(
  apiKey: string,
  texts: string[],
  inputType: "query" | "document",
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(VOYAGE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: texts,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Validate Voyage response shape and return extracted embeddings. */
function validateVoyageResponse(
  data: Record<string, unknown>,
  expectedCount: number,
): { ok: true; embeddings: number[][] } | { ok: false; error: string } {
  if (!data || !Array.isArray(data.data)) {
    return { ok: false, error: `Missing data array. Keys: ${Object.keys(data)}` };
  }
  const items = data.data as Array<Record<string, unknown>>;
  if (items.length !== expectedCount) {
    return { ok: false, error: `Expected ${expectedCount} embeddings, got ${items.length}` };
  }
  for (let i = 0; i < items.length; i++) {
    if (!Array.isArray(items[i]?.embedding)) {
      return { ok: false, error: `Item ${i} missing embedding array` };
    }
  }
  return {
    ok: true,
    embeddings: items.map((item) => item.embedding as number[]),
  };
}

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

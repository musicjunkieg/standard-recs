/**
 * HTTP API routes.
 *
 * Enrollment triggers a Workflow instance for the user's like backfill.
 * Admin endpoints manage the Jetstream DO and trigger the full pipeline.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env.js";
import { type Variant, variantFromHost } from "../variants.js";
import { createOAuthClient, buildClientMetadata } from "../oauth/client.js";
import { AtpAgent } from "@atproto/api";

// Unauthenticated agent for public profile lookups (DID → handle).
// We can't use the OAuth session for this — its scope is narrow and
// doesn't include rpc:app.bsky.actor.getProfile.
const publicAgent = new AtpAgent({ service: "https://public.api.bsky.app" });
import { listUsers } from "../sync/users.js";
import { VOYAGE_API, VOYAGE_MODEL, EMBEDDING_DIMENSIONS, LIKES_NAMESPACE_QUERY, LIKES_NAMESPACE_DOC } from "../recommend/embed.js";
import { generateUserRecommendations } from "../recommend/index.js";
import { enrollPage } from "./enroll-page.js";
import { recsPage } from "./recs-page.js";
import { recsLookupPage } from "./recs-lookup-page.js";

const api = new Hono<{ Bindings: Env; Variables: { variant: Variant } }>();

api.use("*", cors());

// Variant routing middleware. Reads the Host header and stores the
// matched Variant on the request context. Every downstream handler
// reads it via c.get("variant") and doesn't need to know about
// hostnames. Unknown hosts fall back to "standard" inside
// variantFromHost so dev mode (localhost:8787) still works.
api.use("*", async (c, next) => {
  const variant = variantFromHost(c.req.header("host"));
  c.set("variant", variant);
  await next();
});

// ─── Public ───

// Enrollment page
api.get("/", (c) => c.html(enrollPage(c.get("variant"))));

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
api.get("/recs", (c) => c.html(recsLookupPage(c.get("variant"))));

// Resolve handle → DID and redirect to recs page
api.get("/recs/by-handle/:handle", async (c) => {
  const handle = c.req.param("handle");

  const user = await c.env.DB.prepare(
    `SELECT did FROM users WHERE handle = ?`,
  )
    .bind(handle)
    .first<{ did: string }>();

  if (!user) {
    return c.html(recsPage({ state: "not_found", variant: c.get("variant") }), 404);
  }

  return c.redirect(`/recs/${user.did}`);
});

// Get recommendations for a user (content-negotiated: HTML for browsers, JSON for API)
api.get("/recs/:did", async (c) => {
  const did = c.req.param("did");
  const variant = c.get("variant");
  const wantsHtml = c.req.header("Accept")?.includes("text/html");

  const user = await c.env.DB.prepare(
    `SELECT did, handle FROM users WHERE did = ?`,
  )
    .bind(did)
    .first<{ did: string; handle: string }>();

  if (!user) {
    if (wantsHtml) {
      return c.html(recsPage({ state: "not_found", variant: c.get("variant") }), 404);
    }
    return c.json({ error: "User not enrolled" }, 404);
  }

  if (variant.ranking.kind === "placeholder") {
    if (wantsHtml) {
      return c.html(recsPage({ state: "placeholder", variant }));
    }
    return c.json({
      did: user.did,
      handle: user.handle,
      variant: variant.key,
      state: "placeholder",
      message: "Recommendations for this variant aren't available yet.",
      recommendations: [],
    });
  }

  const { results: recs } = await c.env.DB.prepare(
    `SELECT r.document_uri, r.score, r.generated_at,
            d.title, d.description, d.site, d.path, d.tags, d.published_at,
            p.url AS publication_url, p.name AS publication_name
     FROM recommendations r
     JOIN documents d ON r.document_uri = d.uri
     LEFT JOIN publications p ON d.site = p.uri
     WHERE r.did = ? AND r.variant = ?
     ORDER BY r.score DESC`,
  )
    .bind(did, variant.key)
    .all();

  if (wantsHtml) {
    return c.html(
      recsPage({
        state: "found",
        handle: user.handle,
        did: user.did,
        variant: c.get("variant"),
        recs: recs.map((r: Record<string, unknown>) => ({
          uri: r.document_uri as string,
          score: r.score as number,
          title: r.title as string,
          description: r.description as string | null,
          url: buildDocumentUrl(
            r.publication_url as string | null,
            r.site as string | null,
            r.path as string | null,
          ),
          site: (r.publication_name as string | null)
            ?? extractHostname(r.publication_url as string | null)
            ?? extractHostname(r.site as string | null)
            ?? null,
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
      url: buildDocumentUrl(
        r.publication_url as string | null,
        r.site as string | null,
        r.path as string | null,
      ),
      publication: r.publication_name
        ?? extractHostname(r.publication_url as string | null)
        ?? extractHostname(r.site as string | null)
        ?? null,
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

// Compare recommendations between the two like-embedding namespaces.
// POST because generateUserRecommendations *can* write to D1 — we pass
// dryRun=true here so this endpoint computes both rec lists without
// touching the persisted recommendations table.
api.post("/admin/compare-recs", async (c) => {
  const did = c.req.query("did");
  if (!did) {
    return c.json({ error: "missing did query param" }, 400);
  }

  const topN = parseInt(c.env.TOP_N ?? "10", 10) || 10;
  const variantsParam = c.req.query("variants");

  // New branch: variant comparison — triggered by ?variants=standard,nonstandard
  // (or any subset). One generateUserRecommendations call returns both variants
  // after the Task 6 refactor; we just filter by .variant here.
  if (variantsParam) {
    const requestedVariants = variantsParam
      .split(",")
      .map((v) => v.trim())
      .filter((v): v is "standard" | "nonstandard" =>
        v === "standard" || v === "nonstandard",
      );

    if (requestedVariants.length === 0) {
      return c.json(
        { error: "variants param must include 'standard' and/or 'nonstandard'" },
        400,
      );
    }

    const rawLambda = parseFloat(c.env.MMR_LAMBDA ?? "0.6");
    const lambda =
      Number.isFinite(rawLambda) && rawLambda >= 0 && rawLambda <= 1
        ? rawLambda
        : 0.6;

    const likesNamespace =
      c.env.LIKE_QUERY_NAMESPACE === "likes_doc" ? "likes_doc" : "likes";

    const allRecs = await generateUserRecommendations(
      c.env.DB,
      c.env.VECTORS,
      did,
      topN,
      likesNamespace,
      true, // dryRun — don't touch D1
      lambda,
    );

    // Collect all unique document URIs across all requested variants for
    // a single enrichment query.
    const variantBuckets: Record<string, typeof allRecs> = {};
    for (const v of requestedVariants) {
      variantBuckets[v] = allRecs.filter((r) => r.variant === v);
    }

    const allUris = Array.from(
      new Set(
        Object.values(variantBuckets)
          .flat()
          .map((r) => r.document_uri),
      ),
    );

    type DocRow = {
      uri: string;
      title: string;
      description: string | null;
      site: string | null;
      path: string | null;
      publication_url: string | null;
      publication_name: string | null;
    };

    let docs: DocRow[] = [];
    if (allUris.length > 0) {
      const placeholders = allUris.map(() => "?").join(",");
      const result = await c.env.DB.prepare(
        `SELECT d.uri, d.title, d.description, d.site, d.path,
                p.url AS publication_url, p.name AS publication_name
         FROM documents d
         LEFT JOIN publications p ON d.site = p.uri
         WHERE d.uri IN (${placeholders})`,
      )
        .bind(...allUris)
        .all<DocRow>();
      docs = result.results;
    }

    const docMap = new Map(docs.map((d) => [d.uri, d]));

    const enrichRec = (rec: { document_uri: string; score: number }) => {
      const d = docMap.get(rec.document_uri);
      return {
        uri: rec.document_uri,
        score: rec.score,
        title: d?.title ?? null,
        description: d?.description ?? null,
        url: buildDocumentUrl(
          d?.publication_url ?? null,
          d?.site ?? null,
          d?.path ?? null,
        ),
        site:
          d?.publication_name ??
          extractHostname(d?.publication_url ?? null) ??
          extractHostname(d?.site ?? null) ??
          null,
      };
    };

    const enrichedVariants: Record<string, ReturnType<typeof enrichRec>[]> = {};
    for (const v of requestedVariants) {
      enrichedVariants[v] = variantBuckets[v].map(enrichRec);
    }

    return c.json({ did, lambda, topN, variants: enrichedVariants });
  }

  // Existing branch: namespace comparison (supports PR #18 usage).
  //
  // Note: after Task 6's refactor, generateUserRecommendations returns
  // BOTH variants (standard + nonstandard) in one call, so each of the
  // two calls below returns 2 * topN rows. The legacy PR #18 response
  // shape is "top-N per namespace," matching the standard ranking
  // (top-N by raw cosine). Filter each call's result to just the
  // .variant === "standard" rows before enrichment so the response
  // shape stays exactly what PR #18 consumers expect.
  const [allQueryRecs, allDocRecs] = await Promise.all([
    generateUserRecommendations(
      c.env.DB,
      c.env.VECTORS,
      did,
      topN,
      LIKES_NAMESPACE_QUERY,
      true, // dryRun
    ),
    generateUserRecommendations(
      c.env.DB,
      c.env.VECTORS,
      did,
      topN,
      LIKES_NAMESPACE_DOC,
      true, // dryRun
    ),
  ]);
  const queryRecs = allQueryRecs.filter((r) => r.variant === "standard");
  const docRecs = allDocRecs.filter((r) => r.variant === "standard");

  // Enrich each rec with document metadata. Mirrors the join the public
  // /recs/:did route uses: documents has no `url` column — the resolved
  // web URL is built from the publication's URL plus the document's path.
  const allUris = Array.from(
    new Set([...queryRecs, ...docRecs].map((r) => r.document_uri)),
  );

  type DocRow = {
    uri: string;
    title: string;
    description: string | null;
    site: string | null;
    path: string | null;
    publication_url: string | null;
    publication_name: string | null;
  };

  let docs: DocRow[] = [];
  if (allUris.length > 0) {
    const placeholders = allUris.map(() => "?").join(",");
    const result = await c.env.DB.prepare(
      `SELECT d.uri, d.title, d.description, d.site, d.path,
              p.url AS publication_url, p.name AS publication_name
       FROM documents d
       LEFT JOIN publications p ON d.site = p.uri
       WHERE d.uri IN (${placeholders})`,
    )
      .bind(...allUris)
      .all<DocRow>();
    docs = result.results;
  }

  const docMap = new Map(docs.map((d) => [d.uri, d]));

  const enrich = (rec: { document_uri: string; score: number }) => {
    const d = docMap.get(rec.document_uri);
    return {
      uri: rec.document_uri,
      score: rec.score,
      title: d?.title ?? null,
      description: d?.description ?? null,
      url: buildDocumentUrl(
        d?.publication_url ?? null,
        d?.site ?? null,
        d?.path ?? null,
      ),
      site:
        d?.publication_name ??
        extractHostname(d?.publication_url ?? null) ??
        extractHostname(d?.site ?? null) ??
        null,
    };
  };

  return c.json({
    did,
    topN,
    query: queryRecs.map(enrich),
    document: docRecs.map(enrich),
  });
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
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Test with real likes
  {
    let currentStep = "likes-query";
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
        currentStep = "likes-voyage";
        const texts = likes.map((l) => l.liked_post_text);
        const res = await fetchVoyage(c.env.VOYAGE_API_KEY, texts, "query");

        if (!res.ok) {
          const body = await res.text();
          results.push({ step: "likes-voyage", ok: false, detail: { status: res.status, body } });
        } else {
          currentStep = "likes-voyage-parse";
          const data = await res.json() as Record<string, unknown>;
          const validation = validateVoyageResponse(data, likes.length);
          if (!validation.ok) {
            results.push({ step: "likes-voyage-parse", ok: false, detail: validation.error });
          } else {
            currentStep = "likes-upsert";
            const embeddings = validation.embeddings;
            const probeIds = likes.map((l) => `debug-${nonce}-${l.uri}`);
            const vectors: VectorizeVector[] = embeddings.map((emb, i) => ({
              id: probeIds[i],
              values: emb,
              namespace: "debug-likes",
              metadata: { type: "like" },
            }));
            await c.env.VECTORS.upsert(vectors);

            currentStep = "likes-cleanup";
            await c.env.VECTORS.deleteByIds(probeIds);
            results.push({ step: "likes-embed", ok: true, detail: { count: likes.length, dimensions: embeddings[0].length } });
          }
        }
      }
    } catch (err) {
      results.push({ step: currentStep, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // Test with real documents
  {
    let currentStep = "docs-query";
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
        currentStep = "docs-voyage";
        const texts = docs.map((d) => {
          const body = d.text_content || d.description || "";
          return `${d.title}\n\n${body}`.slice(0, 16000);
        });
        const res = await fetchVoyage(c.env.VOYAGE_API_KEY, texts, "document");

        if (!res.ok) {
          const body = await res.text();
          results.push({ step: "docs-voyage", ok: false, detail: { status: res.status, body } });
        } else {
          currentStep = "docs-voyage-parse";
          const data = await res.json() as Record<string, unknown>;
          const validation = validateVoyageResponse(data, docs.length);
          if (!validation.ok) {
            results.push({ step: "docs-voyage-parse", ok: false, detail: validation.error });
          } else {
            currentStep = "docs-upsert";
            const embeddings = validation.embeddings;
            const probeIds = docs.map((d) => `debug-${nonce}-${d.uri}`);
            const vectors: VectorizeVector[] = embeddings.map((emb, i) => ({
              id: probeIds[i],
              values: emb,
              namespace: "debug-documents",
              metadata: { type: "document", title: docs[i].title },
            }));
            await c.env.VECTORS.upsert(vectors);

            currentStep = "docs-cleanup";
            await c.env.VECTORS.deleteByIds(probeIds);
            results.push({ step: "docs-embed", ok: true, detail: { count: docs.length, dimensions: embeddings[0].length } });
          }
        }
      }
    } catch (err) {
      results.push({ step: currentStep, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
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
  if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
    const desc = !data ? "null/undefined" : `keys: ${Object.keys(data)}`;
    return { ok: false, error: `Missing data array. Response was ${desc}` };
  }
  const items = data.data as Array<Record<string, unknown>>;
  if (items.length !== expectedCount) {
    return { ok: false, error: `Expected ${expectedCount} embeddings, got ${items.length}` };
  }
  // Sort by index to match input order — Voyage can return items out of order.
  // Same pattern as embed.ts getEmbeddings().
  items.sort((a, b) => (a.index as number) - (b.index as number));
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

/**
 * Build a clickable URL for a document.
 *
 * @param publicationUrl - The publication's web URL (from the publications table), or null
 * @param site - The document's site field (may be an at:// URI or an https URL)
 * @param path - The document's path within the publication
 */
/** Extract hostname from an HTTP(S) URL, or return null for non-URLs (at:// etc). */
function extractHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.hostname;
    }
  } catch { /* not a valid URL */ }
  return null;
}

function buildDocumentUrl(
  publicationUrl: string | null,
  site: string | null,
  path: string | null,
): string | null {
  // Normalize path to ensure a single leading slash
  const normalizedPath = path
    ? (path.startsWith("/") ? path : `/${path}`)
    : null;

  // Prefer the publication's resolved web URL
  if (publicationUrl) {
    const base = publicationUrl.replace(/\/$/, "");
    return normalizedPath ? `${base}${normalizedPath}` : base;
  }
  // Fall back to site if it's already an https URL
  if (site && !site.startsWith("at://")) {
    const base = site.replace(/\/$/, "");
    return normalizedPath ? `${base}${normalizedPath}` : base;
  }
  return null;
}

export { api };

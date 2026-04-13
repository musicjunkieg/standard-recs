/**
 * Embedding pipeline — Voyage AI voyage-3.5-lite.
 *
 * Uses Voyage's input_type parameter for better retrieval:
 *   - Likes are embedded as "query", "document", or both, controlled by
 *     LIKE_EMBED_MODE. The doc-embedded copies live in the "likes_doc"
 *     namespace with vector IDs prefixed by "d:" so namespace lookups
 *     stay unambiguous.
 *   - Documents are embedded as "document" (what's being retrieved)
 *
 * This cross-domain optimization is a free quality boost from Voyage
 * that OpenAI doesn't offer.
 *
 * Dimensions: 1024 (Voyage default for 3.5-lite)
 * Free tier: 200M tokens — covers this project for months.
 */

import { vectorIds } from "./vector-id.js";

export const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_MODEL = "voyage-3.5-lite";
export const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = 100;

export const LIKES_NAMESPACE_QUERY = "likes";
export const LIKES_NAMESPACE_DOC = "likes_doc";
export const LIKES_DOC_ID_PREFIX = "d:";

export type LikeEmbedMode = "query" | "document" | "both";

export function parseEmbedMode(raw: string | undefined): LikeEmbedMode {
  if (raw === "document" || raw === "both") return raw;
  return "query";
}

export function parseLikesNamespace(raw: string | undefined): string {
  return raw === LIKES_NAMESPACE_DOC ? LIKES_NAMESPACE_DOC : LIKES_NAMESPACE_QUERY;
}

type EmbedResult = {
  likes: number;
  documents: number;
  errors: number;
};

/**
 * Embed likes into the specified namespace(s).
 */
async function embedLikesIntoNamespace(
  vectors: VectorizeIndex,
  apiKey: string,
  rows: Array<{ uri: string; liked_post_text: string }>,
  inputType: "query" | "document",
  namespace: string,
  idPrefix: string,
): Promise<{ embedded: number; errors: number }> {
  if (rows.length === 0) return { embedded: 0, errors: 0 };

  let embedded = 0;
  let errors = 0;
  const batches = chunk(rows, BATCH_SIZE);

  for (const batch of batches) {
    try {
      const texts = batch.map((l) => l.liked_post_text);
      const embeddings = await getEmbeddings(texts, apiKey, inputType);

      const baseIds = await vectorIds(batch.map((l) => l.uri));
      const ids = baseIds.map((h) => idPrefix + h);

      const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
        id: ids[i],
        values,
        namespace,
        metadata: { type: "like", uri: batch[i].uri },
      }));

      await vectors.upsert(vectorBatch);
      embedded += batch.length;
    } catch (err) {
      errors += batch.length;
      console.error(
        `Like embedding batch failed (${namespace}):`,
        truncErr(err),
      );
    }
  }

  return { embedded, errors };
}

/**
 * Embed all un-embedded likes and documents.
 */
export async function embedAll(
  db: D1Database,
  vectors: VectorizeIndex,
  apiKey: string,
  embedMode: LikeEmbedMode = "query",
): Promise<EmbedResult> {
  let queryEmbedCount = 0;
  let docEmbedCount = 0;
  let docCount = 0;
  let errors = 0;

  // --- Likes (one or both namespaces depending on mode) ---
  const { results: unembeddedLikes } = await db
    .prepare(
      `SELECT uri, liked_post_text FROM likes
       WHERE liked_post_text IS NOT NULL AND liked_post_text != ''
       ORDER BY liked_at DESC
       LIMIT 500`,
    )
    .all<{ uri: string; liked_post_text: string }>();

  const wantQuery = embedMode === "query" || embedMode === "both";
  const wantDoc = embedMode === "document" || embedMode === "both";

  if (wantQuery) {
    const r = await embedLikesIntoNamespace(
      vectors,
      apiKey,
      unembeddedLikes,
      "query",
      LIKES_NAMESPACE_QUERY,
      "",
    );
    queryEmbedCount += r.embedded;
    errors += r.errors;
  }

  if (wantDoc) {
    const r = await embedLikesIntoNamespace(
      vectors,
      apiKey,
      unembeddedLikes,
      "document",
      LIKES_NAMESPACE_DOC,
      LIKES_DOC_ID_PREFIX,
    );
    docEmbedCount += r.embedded;
    errors += r.errors;
  }

  // --- Documents (embedded as "document") ---
  const { results: docs } = await db
    .prepare(
      `SELECT uri, title, description, text_content FROM documents
       WHERE (text_content IS NOT NULL AND text_content != '')
          OR (description IS NOT NULL AND description != '')
       LIMIT 500`,
    )
    .all<{
      uri: string;
      title: string;
      description: string | null;
      text_content: string | null;
    }>();

  if (docs.length > 0) {
    const batches = chunk(docs, BATCH_SIZE);

    for (const batch of batches) {
      try {
        const texts = batch.map((d) => {
          const body = d.text_content || d.description || "";
          return `${d.title}\n\n${body}`.slice(0, 16000);
        });

        const embeddings = await getEmbeddings(texts, apiKey, "document");

        const ids = await vectorIds(batch.map((d) => d.uri));
        const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
          id: ids[i],
          values,
          namespace: "documents",
          metadata: { type: "document", title: batch[i].title, uri: batch[i].uri },
        }));

        await vectors.upsert(vectorBatch);
        docCount += batch.length;
      } catch (err) {
        errors += batch.length;
        console.error("Document embedding batch failed:", truncErr(err));
      }
    }
  }

  // Both branches process the same input rows, so the count of distinct
  // likes touched in this run is whichever branch ran (or the max in "both").
  const likesProcessed = Math.max(queryEmbedCount, docEmbedCount);
  console.log(
    `Embedded ${likesProcessed} likes ` +
      `(query=${queryEmbedCount}, doc=${docEmbedCount}), ` +
      `${docCount} documents (${errors} errors)`,
  );
  return { likes: likesProcessed, documents: docCount, errors };
}

/**
 * Call Voyage AI embeddings API.
 */
async function getEmbeddings(
  texts: string[],
  apiKey: string,
  inputType: "query" | "document",
): Promise<number[][]> {
  const res = await fetch(VOYAGE_API, {
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
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** Truncate an error to ~500 chars so it doesn't blow the 256KB log budget. */
function truncErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? msg.slice(0, 500) + "…(truncated)" : msg;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

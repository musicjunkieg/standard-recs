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
const DEFAULT_EMBED_BATCH_LIMIT = 2000;

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
 * Embed all un-embedded likes and documents.
 */
export async function embedAll(
  db: D1Database,
  vectors: VectorizeIndex,
  apiKey: string,
  embedMode: LikeEmbedMode = "query",
  embedBatchLimit: number = DEFAULT_EMBED_BATCH_LIMIT,
): Promise<EmbedResult> {
  let queryEmbedCount = 0;
  let docEmbedCount = 0;
  let stampedLikes = 0;
  let docCount = 0;
  let errors = 0;

  // --- Likes (one or both namespaces depending on mode) ---
  const { results: unembeddedLikes } = await db
    .prepare(
      `SELECT uri, liked_post_text FROM likes
       WHERE liked_post_text IS NOT NULL
         AND liked_post_text != ''
         AND embedded_at IS NULL
       ORDER BY liked_at DESC
       LIMIT ?`,
    )
    .bind(embedBatchLimit)
    .all<{ uri: string; liked_post_text: string }>();

  const wantQuery = embedMode === "query" || embedMode === "both";
  const wantDoc = embedMode === "document" || embedMode === "both";

  if (unembeddedLikes.length > 0 && (wantQuery || wantDoc)) {
    const batches = chunk(unembeddedLikes, BATCH_SIZE);

    for (const batch of batches) {
      try {
        const texts = batch.map((l) => l.liked_post_text);
        const baseIds = await vectorIds(batch.map((l) => l.uri));

        if (wantQuery) {
          const embeddings = await getEmbeddings(texts, apiKey, "query");
          if (embeddings.length !== texts.length) {
            throw new Error(
              `Voyage returned ${embeddings.length} embeddings for ${texts.length} inputs (query namespace)`,
            );
          }
          const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
            id: baseIds[i],
            values,
            namespace: LIKES_NAMESPACE_QUERY,
            metadata: { type: "like", uri: batch[i].uri },
          }));
          await vectors.upsert(vectorBatch);
          queryEmbedCount += batch.length;
        }

        if (wantDoc) {
          const embeddings = await getEmbeddings(texts, apiKey, "document");
          if (embeddings.length !== texts.length) {
            throw new Error(
              `Voyage returned ${embeddings.length} embeddings for ${texts.length} inputs (doc namespace)`,
            );
          }
          const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
            id: LIKES_DOC_ID_PREFIX + baseIds[i],
            values,
            namespace: LIKES_NAMESPACE_DOC,
            metadata: { type: "like", uri: batch[i].uri },
          }));
          await vectors.upsert(vectorBatch);
          docEmbedCount += batch.length;
        }

        // All requested namespaces have successfully upserted this
        // batch. Stamp the rows now so they don't re-embed on the next
        // cron. Must be inside the same try as the upserts above — if
        // any upsert threw, we never reach the stamp and the catch
        // block leaves embedded_at NULL, preserving the invariant
        // "embedded_at IS NOT NULL iff in Vectorize."
        const placeholders = batch.map(() => "?").join(",");
        await db
          .prepare(
            `UPDATE likes SET embedded_at = datetime('now') WHERE uri IN (${placeholders})`,
          )
          .bind(...batch.map((l) => l.uri))
          .run();
        stampedLikes += batch.length;
      } catch (err) {
        errors += batch.length;
        console.error(`Like embedding batch failed:`, truncErr(err));
      }
    }
  }

  // --- Documents (embedded as "document") ---
  const { results: docs } = await db
    .prepare(
      `SELECT uri, title, description, text_content FROM documents
       WHERE ((text_content IS NOT NULL AND text_content != '')
           OR (description IS NOT NULL AND description != ''))
         AND embedded_at IS NULL
       LIMIT ?`,
    )
    .bind(embedBatchLimit)
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

        if (embeddings.length !== texts.length) {
          throw new Error(
            `Voyage returned ${embeddings.length} embeddings for ${texts.length} inputs`,
          );
        }

        const ids = await vectorIds(batch.map((d) => d.uri));
        const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
          id: ids[i],
          values,
          namespace: "documents",
          metadata: { type: "document", title: batch[i].title, uri: batch[i].uri },
        }));

        await vectors.upsert(vectorBatch);
        docCount += batch.length;

        // Stamp the just-embedded documents. Inside the try so upsert-
        // success/stamp-skip can't happen; stamp-UPDATE-fails-after-upsert-
        // succeeded is benign (idempotent re-embed next cron).
        const placeholders = batch.map(() => "?").join(",");
        await db
          .prepare(
            `UPDATE documents SET embedded_at = datetime('now') WHERE uri IN (${placeholders})`,
          )
          .bind(...batch.map((d) => d.uri))
          .run();
      } catch (err) {
        errors += batch.length;
        console.error("Document embedding batch failed:", truncErr(err));
      }
    }
  }

  // likesProcessed reports fully committed (stamped) rows only. In
  // LIKE_EMBED_MODE=both, a batch that succeeds in the query namespace
  // but throws in the doc namespace never reaches the stamp — those
  // rows stay NULL and re-embed next cron. Using stampedLikes (not
  // Math.max of the per-namespace counts) means the returned count
  // reflects actual committed state, not "any upsert succeeded."
  const likesProcessed = stampedLikes;
  console.log(
    `Embedded ${likesProcessed} likes ` +
      `(query=${queryEmbedCount}, doc=${docEmbedCount}), ` +
      `${docCount} documents (${errors} errors). ` +
      `Limit: ${embedBatchLimit}.`,
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

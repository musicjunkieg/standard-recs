/**
 * Embedding pipeline — Voyage AI voyage-3.5-lite.
 *
 * Uses Voyage's input_type parameter for better retrieval:
 *   - Likes are embedded as "query" (what the user is looking for)
 *   - Documents are embedded as "document" (what's being retrieved)
 *
 * This cross-domain optimization is a free quality boost from Voyage
 * that OpenAI doesn't offer.
 *
 * Dimensions: 1024 (Voyage default for 3.5-lite)
 * Free tier: 200M tokens — covers this project for months.
 */

const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3.5-lite";
const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = 100;

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
): Promise<EmbedResult> {
  let likeCount = 0;
  let docCount = 0;
  let errors = 0;

  // --- Likes (embedded as "query") ---
  const { results: unembeddedLikes } = await db
    .prepare(
      `SELECT uri, liked_post_text FROM likes
       WHERE liked_post_text IS NOT NULL AND liked_post_text != ''
       ORDER BY liked_at DESC
       LIMIT 500`,
    )
    .all<{ uri: string; liked_post_text: string }>();

  if (unembeddedLikes.length > 0) {
    const batches = chunk(unembeddedLikes, BATCH_SIZE);

    for (const batch of batches) {
      try {
        const texts = batch.map((l) => l.liked_post_text);
        const embeddings = await getEmbeddings(texts, apiKey, "query");

        const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
          id: batch[i].uri,
          values,
          namespace: "likes",
          metadata: { type: "like" },
        }));

        await vectors.upsert(vectorBatch);
        likeCount += batch.length;
      } catch (err) {
        errors += batch.length;
        console.error("Like embedding batch failed:", err);
      }
    }
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

        const vectorBatch: VectorizeVector[] = embeddings.map((values, i) => ({
          id: batch[i].uri,
          values,
          namespace: "documents",
          metadata: { type: "document", title: batch[i].title },
        }));

        await vectors.upsert(vectorBatch);
        docCount += batch.length;
      } catch (err) {
        errors += batch.length;
        console.error("Document embedding batch failed:", err);
      }
    }
  }

  console.log(
    `Embedded ${likeCount} likes, ${docCount} documents (${errors} errors)`,
  );
  return { likes: likeCount, documents: docCount, errors };
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

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

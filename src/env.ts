/**
 * Cloudflare Workers bindings.
 */
export type Env = {
  // Storage
  DB: D1Database;
  VECTORS: VectorizeIndex;

  // Workflows
  SYNC_PIPELINE: Workflow;

  // Durable Objects
  JETSTREAM_LISTENER: DurableObjectNamespace;

  // Secrets
  VOYAGE_API_KEY: string;
  OAUTH_PRIVATE_KEY: string;

  // Config vars
  SYNC_BATCH_SIZE: string;
  SYNC_DOCS_BATCH_SIZE: string;
  SYNC_DOCS_MAX_BATCHES: string;
  WINDOW_DAYS: string;
  TOP_N: string;
  WORKER_URL: string;
  LIKE_EMBED_MODE: string;        // "query" | "document" | "both"
  LIKE_QUERY_NAMESPACE: string;   // "likes" | "likes_doc"
  MMR_LAMBDA: string;             // "0.6" — nonstandardrecs MMR lambda knob
  EMBED_BATCH_LIMIT: string;
};

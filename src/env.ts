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
  WINDOW_DAYS: string;
  TOP_N: string;
};

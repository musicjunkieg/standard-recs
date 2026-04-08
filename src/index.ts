/**
 * standard-recs — Cloudflare Worker entry point.
 *
 * - HTTP requests → Hono API
 * - Cron trigger → creates a SyncPipeline Workflow instance
 * - Exports the Workflow class and Durable Object class
 */

import type { Env } from "./env.js";
import { api } from "./api/routes.js";

// Re-export classes so Cloudflare can instantiate them
export { SyncPipelineWorkflow } from "./workflow.js";
export { JetstreamListener } from "./durable/jetstream-listener.js";

export default {
  /**
   * HTTP request handler — delegates to Hono.
   */
  fetch: api.fetch,

  /**
   * Cron trigger — kicks off the full sync pipeline as a Workflow.
   * The Workflow handles all retries and step durability.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log("Cron: triggering SyncPipeline Workflow");

    await env.SYNC_PIPELINE.create({
      id: `cron-${Date.now()}`,
      params: { mode: "full" as const },
    });
  },
} satisfies ExportedHandler<Env>;

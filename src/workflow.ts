/**
 * SyncPipelineWorkflow — durable execution of the sync + recommend pipeline.
 *
 * Two modes:
 *   { mode: "full" }           — Full daily pipeline (cron)
 *   { mode: "user", did: "…" } — Backfill one user's likes on enrollment
 *
 * Each step is independently retried and memoized. If the Voyage API
 * rate-limits during embedding, only that step retries — likes don't
 * re-sync.
 *
 * Document sync is split across many sequential Workflow steps so each
 * invocation stays under the per-invocation subrequest limit. Each step
 * processes SYNC_DOCS_BATCH_SIZE publishers and the workflow loops until
 * the batch returns processed === 0.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "./env.js";
import { syncUserLikes, syncAllLikes, pruneStaleLikes } from "./sync/likes.js";
import { runDiscovery, syncDocumentsBatch } from "./sync/documents.js";
import { embedAll } from "./recommend/embed.js";
import { generateAllRecommendations, generateUserRecommendations } from "./recommend/index.js";

export type SyncParams =
  | { mode: "full" }
  | { mode: "user"; did: string };

/** Defaults for batch sizing when env vars are missing or invalid. */
const DEFAULT_SYNC_DOCS_BATCH_SIZE = 50;
const DEFAULT_SYNC_DOCS_MAX_BATCHES = 300;

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class SyncPipelineWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const params = event.payload;

    if (params.mode === "user") {
      await this.runUserSync(params.did, step);
    } else {
      await this.runFullPipeline(step);
    }
  }

  /**
   * Single-user enrollment backfill.
   * Syncs their likes, discovers publishers, syncs documents in batches,
   * then embeds + recommends.
   */
  private async runUserSync(did: string, step: WorkflowStep) {
    const windowDays = parseInt(this.env.WINDOW_DAYS || "30", 10);
    const topN = parseInt(this.env.TOP_N || "10", 10);

    const likeResult = await step.do(`sync-likes-${did}`, async () => {
      const { createOAuthClient } = await import("./oauth/client.js");
      const { Agent } = await import("@atproto/api");
      const client = await createOAuthClient(this.env);
      const session = await client.restore(did);
      const agent = new Agent(session);
      const result = await syncUserLikes(this.env.DB, agent, did, windowDays);
      return { stored: result.stored, fetched: result.fetched };
    });

    console.log(`User ${did}: ${likeResult.stored} likes synced`);

    // Discovery + batched document sync
    await step.do(`discover-${did}`, async () => {
      return await runDiscovery(this.env.DB);
    });

    await this.runBatchedDocumentSync(step, `user-${did}`);

    // Embed + recommend if we have an API key
    if (this.env.VOYAGE_API_KEY) {
      await step.do(`embed-for-user-${did}`, async () => {
        const result = await embedAll(this.env.DB, this.env.VECTORS, this.env.VOYAGE_API_KEY);
        return { likes: result.likes, documents: result.documents };
      });

      await step.do(`recommend-for-user-${did}`, async () => {
        const recs = await generateUserRecommendations(
          this.env.DB, this.env.VECTORS, did, topN,
        );
        return { count: recs.length };
      });
    }
  }

  /**
   * Full daily pipeline — all users, all publishers.
   */
  private async runFullPipeline(step: WorkflowStep) {
    const windowDays = parseInt(this.env.WINDOW_DAYS || "30", 10);
    const batchSize = parseInt(this.env.SYNC_BATCH_SIZE || "50", 10);
    const topN = parseInt(this.env.TOP_N || "10", 10);

    // Step 1: Sync likes for all users
    const likeResults = await step.do("sync-all-likes", async () => {
      const results = await syncAllLikes(this.env, windowDays, batchSize);
      const totalNew = results.reduce((a, r) => a + r.stored, 0);
      return { users: results.length, newLikes: totalNew };
    });

    console.log(`Likes: ${likeResults.newLikes} new across ${likeResults.users} users`);

    // Step 2: Prune stale likes
    const pruned = await step.do("prune-likes", async () => {
      return await pruneStaleLikes(this.env.DB, windowDays);
    });

    console.log(`Pruned: ${pruned} stale likes`);

    // Clean up abandoned OAuth authorization flows (older than 15 min)
    await step.do("cleanup-oauth-state", async () => {
      const result = await this.env.DB
        .prepare(`DELETE FROM oauth_state WHERE created_at < datetime('now', '-15 minutes')`)
        .run();
      return result.meta.changes ?? 0;
    });

    // Step 3: Discover publishers (lightrail + social graph) in its own step
    const discovery = await step.do("discover", async () => {
      return await runDiscovery(this.env.DB);
    });

    console.log(`Discovery: ${discovery.discovered} new publishers (${discovery.errors} errors)`);

    // Step 4: Batched document sync — one Workflow step per batch
    await this.runBatchedDocumentSync(step, "full");

    // Step 5: Embed
    if (this.env.VOYAGE_API_KEY) {
      const embedResult = await step.do("embed", async () => {
        const result = await embedAll(this.env.DB, this.env.VECTORS, this.env.VOYAGE_API_KEY);
        return { likes: result.likes, documents: result.documents, errors: result.errors };
      });

      console.log(`Embedded: ${embedResult.likes} likes, ${embedResult.documents} docs`);

      // Step 6: Generate recommendations
      const recCount = await step.do("recommend", async () => {
        return await generateAllRecommendations(this.env.DB, this.env.VECTORS, topN);
      });

      console.log(`Recommendations: ${recCount} total`);
    } else {
      console.log("Skipping embed + recommend — VOYAGE_API_KEY not set");
    }

    return { likeResults, pruned, discovery };
  }

  /**
   * Loop `syncDocumentsBatch` across many Workflow steps until no more
   * publishers need syncing. Each step has its own subrequest budget.
   * Stops at SYNC_DOCS_MAX_BATCHES (from env) as a safety cap.
   */
  private async runBatchedDocumentSync(
    step: WorkflowStep,
    scope: string,
  ): Promise<void> {
    const batchSize = parseIntOrDefault(
      this.env.SYNC_DOCS_BATCH_SIZE,
      DEFAULT_SYNC_DOCS_BATCH_SIZE,
    );
    const maxBatches = parseIntOrDefault(
      this.env.SYNC_DOCS_MAX_BATCHES,
      DEFAULT_SYNC_DOCS_MAX_BATCHES,
    );

    for (let i = 0; i < maxBatches; i++) {
      const result = await step.do(
        `sync-documents-batch-${scope}-${i}`,
        async () => {
          return await syncDocumentsBatch(
            this.env.DB,
            this.env.VECTORS,
            batchSize,
          );
        },
      );

      console.log(
        `  batch ${scope}-${i}: processed=${result.processed} stored=${result.stored} bridged=${result.bridged} errors=${result.errors}`,
      );

      if (result.processed === 0) break;
    }
  }
}

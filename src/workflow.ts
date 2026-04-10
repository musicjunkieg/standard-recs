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
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "./env.js";
import { syncUserLikes, syncAllLikes, pruneStaleLikes } from "./sync/likes.js";
import { syncAllDocuments } from "./sync/documents.js";
import { embedAll } from "./recommend/embed.js";
import { generateAllRecommendations, generateUserRecommendations } from "./recommend/index.js";

export type SyncParams =
  | { mode: "full" }
  | { mode: "user"; did: string };

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
   * Syncs their likes, discovers publishers from those likes,
   * and generates their recommendations if embeddings are available.
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

    // Sync documents from all publishers. syncAllDocuments internally runs
    // lightrail + social-graph discovery to pick up any new ones before
    // fetching the latest docs.
    await step.do(`sync-docs-for-user-${did}`, async () => {
      const result = await syncAllDocuments(this.env.DB);
      return { stored: result.stored, discovered: result.discovered };
    });

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

    // Step 3a: Prune publishers without a valid site.standard.publication
    // (filters out brid.gy bridged accounts that have docs but no publication)
    const pruneResult = await step.do("prune-invalid-publishers", async () => {
      const { pruneInvalidPublishers } = await import("./sync/discover.js");
      return await pruneInvalidPublishers(this.env.DB, this.env.VECTORS);
    });

    console.log(
      `Publishers: pruned ${pruneResult.removed} invalid, skipped ${pruneResult.skipped} (lookup failed) of ${pruneResult.checked} checked`,
    );

    // Step 3b: Discover publishers + sync documents
    const docResult = await step.do("sync-documents", async () => {
      const result = await syncAllDocuments(this.env.DB);
      return {
        discovered: result.discovered,
        stored: result.stored,
        errors: result.errors,
      };
    });

    console.log(`Docs: ${docResult.discovered} publishers discovered, ${docResult.stored} stored`);

    // Step 4: Embed
    if (this.env.VOYAGE_API_KEY) {
      const embedResult = await step.do("embed", async () => {
        const result = await embedAll(this.env.DB, this.env.VECTORS, this.env.VOYAGE_API_KEY);
        return { likes: result.likes, documents: result.documents, errors: result.errors };
      });

      console.log(`Embedded: ${embedResult.likes} likes, ${embedResult.documents} docs`);

      // Step 5: Generate recommendations
      const recCount = await step.do("recommend", async () => {
        return await generateAllRecommendations(this.env.DB, this.env.VECTORS, topN);
      });

      console.log(`Recommendations: ${recCount} total`);
    } else {
      console.log("Skipping embed + recommend — VOYAGE_API_KEY not set");
    }

    return { likeResults, pruned, pruneResult, docResult };
  }
}

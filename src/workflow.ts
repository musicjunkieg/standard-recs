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
import { syncDocumentsBatch } from "./sync/documents.js";
import { runDiscovery } from "./sync/discover.js";
import { embedAll, parseEmbedMode, parseLikesNamespace } from "./recommend/embed.js";
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

    const syncStatus = await this.runBatchedDocumentSync(step, `user-${did}`);

    // Embed + recommend only when the sync actually completed. An incomplete
    // corpus produces misleading per-user recommendations and wastes Voyage
    // API quota re-embedding partial state every enrollment.
    if (!syncStatus.drained) {
      console.log(
        `Skipping embed + recommend for ${did} — document sync was truncated by the batch cap.`,
      );
    } else if (this.env.VOYAGE_API_KEY) {
      await step.do(`embed-for-user-${did}`, async () => {
        const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
        const result = await embedAll(
          this.env.DB,
          this.env.VECTORS,
          this.env.VOYAGE_API_KEY,
          embedMode,
        );
        return { likes: result.likes, documents: result.documents };
      });

      await step.do(`recommend-for-user-${did}`, async () => {
        const likesNamespace = parseLikesNamespace(this.env.LIKE_QUERY_NAMESPACE);
        const recs = await generateUserRecommendations(
          this.env.DB, this.env.VECTORS, did, topN, likesNamespace,
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
    const syncStatus = await this.runBatchedDocumentSync(step, "full");

    // Step 5: Embed + recommend — only when the sync actually completed.
    // An incomplete corpus would produce misleading recommendations and
    // burn Voyage API quota on every cron until the corpus is whole.
    if (!syncStatus.drained) {
      console.log(
        "Skipping embed + recommend — document sync was truncated by the batch cap.",
      );
    } else if (this.env.VOYAGE_API_KEY) {
      const embedResult = await step.do("embed", async () => {
        const embedMode = parseEmbedMode(this.env.LIKE_EMBED_MODE);
        const result = await embedAll(
          this.env.DB,
          this.env.VECTORS,
          this.env.VOYAGE_API_KEY,
          embedMode,
        );
        return { likes: result.likes, documents: result.documents, errors: result.errors };
      });

      console.log(`Embedded: ${embedResult.likes} likes, ${embedResult.documents} docs`);

      // Step 6: Generate recommendations
      const recCount = await step.do("recommend", async () => {
        const likesNamespace = parseLikesNamespace(this.env.LIKE_QUERY_NAMESPACE);
        return await generateAllRecommendations(this.env.DB, this.env.VECTORS, topN, likesNamespace);
      });

      console.log(`Recommendations: ${recCount} total`);
    } else {
      console.log("Skipping embed + recommend — VOYAGE_API_KEY not set");
    }

    return { likeResults, pruned, discovery, syncDrained: syncStatus.drained };
  }

  /**
   * Loop `syncDocumentsBatch` across many Workflow steps until no more
   * publishers need syncing. Each step has its own subrequest budget.
   * Stops at SYNC_DOCS_MAX_BATCHES (from env) as a safety cap.
   *
   * Returns `drained: true` when every pending publisher was processed.
   * Returns `drained: false` when the loop exited because it hit the
   * max-batches cap — callers MUST skip downstream steps (embed,
   * recommend) because the corpus is incomplete.
   */
  private async runBatchedDocumentSync(
    step: WorkflowStep,
    scope: string,
  ): Promise<{ drained: boolean }> {
    const batchSize = parseIntOrDefault(
      this.env.SYNC_DOCS_BATCH_SIZE,
      DEFAULT_SYNC_DOCS_BATCH_SIZE,
    );
    const maxBatches = parseIntOrDefault(
      this.env.SYNC_DOCS_MAX_BATCHES,
      DEFAULT_SYNC_DOCS_MAX_BATCHES,
    );

    let drained = false;
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

      // Only log when something interesting happened (non-zero stored,
      // bridged, or errors). The sync loop can run hundreds of batches and
      // each log line eats into the 256KB per-invocation log budget.
      if (result.stored > 0 || result.bridged > 0 || result.errors > 0) {
        console.log(
          `  batch ${scope}-${i}: processed=${result.processed} stored=${result.stored} bridged=${result.bridged} errors=${result.errors}`,
        );
      }

      // A short batch means syncDocumentsBatch couldn't claim `batchSize`
      // publishers — there's nothing left to do. Break immediately instead
      // of doing one more round-trip just to see processed === 0.
      if (result.processed < batchSize) {
        drained = true;
        break;
      }
    }

    if (!drained) {
      console.warn(
        `  sync-documents (${scope}): hit SYNC_DOCS_MAX_BATCHES cap (${maxBatches} × ${batchSize} = ${maxBatches * batchSize} publishers). Queue truncated; skipping embed + recommend until the next run completes the corpus.`,
      );
    }

    return { drained };
  }
}

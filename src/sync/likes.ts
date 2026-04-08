/**
 * Sync a user's Bluesky likes into D1.
 *
 * Uses @atproto/api to paginate through getActorLikes,
 * resolves each liked post's text, and stores it.
 */

import { Agent } from "@atproto/api";
import type { Env } from "../env.js";
import { createOAuthClient } from "../oauth/client.js";

export type SyncResult = {
  user: string;
  fetched: number;
  stored: number;
  errors: number;
};

/**
 * Fetch and store likes for a single enrolled user.
 */
export async function syncUserLikes(
  db: D1Database,
  agent: Agent,
  did: string,
  windowDays: number,
): Promise<SyncResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  let cursor: string | undefined;
  let fetched = 0;
  let stored = 0;
  let errors = 0;
  let done = false;

  while (!done) {
    const res = await agent.app.bsky.feed.getActorLikes({
      actor: did,
      limit: 100,
      cursor,
    });

    const { feed, cursor: nextCursor } = res.data;
    if (!feed.length) break;

    // Batch inserts for this page
    const stmts: D1PreparedStatement[] = [];

    for (const item of feed) {
      fetched++;

      const likedAt = item.post.indexedAt;
      if (likedAt && new Date(likedAt) < cutoff) {
        done = true;
        break;
      }

      const likeUri = `like:${did}:${item.post.uri}`;
      const postText = extractPostText(item.post.record);

      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO likes (uri, did, liked_post_uri, liked_post_text, liked_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(likeUri, did, item.post.uri, postText, likedAt ?? null),
      );
      stored++;
    }

    if (stmts.length > 0) {
      try {
        await db.batch(stmts);
      } catch (err) {
        errors += stmts.length;
        console.error(`Batch insert failed for ${did}:`, err);
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;

    // Be kind to the public API
    await sleep(250);
  }

  // Update sync timestamp
  await db
    .prepare(`UPDATE users SET last_synced_at = datetime('now') WHERE did = ?`)
    .bind(did)
    .run();

  return { user: did, fetched, stored, errors };
}

/**
 * Sync likes for all enrolled users.
 */
export async function syncAllLikes(
  env: Env,
  windowDays: number,
  batchSize: number,
): Promise<SyncResult[]> {
  const { results: users } = await env.DB
    .prepare(
      `SELECT did, handle FROM users ORDER BY last_synced_at ASC NULLS FIRST LIMIT ?`,
    )
    .bind(batchSize)
    .all<{ did: string; handle: string }>();

  console.log(`Syncing likes for ${users.length} users`);

  const client = await createOAuthClient(env);
  const results: SyncResult[] = [];

  for (const user of users) {
    console.log(`  → ${user.handle}`);
    try {
      const session = await client.restore(user.did);
      const agent = new Agent(session);
      const result = await syncUserLikes(env.DB, agent, user.did, windowDays);
      results.push(result);
      console.log(`    ${result.stored} new (${result.fetched} checked)`);
    } catch (err) {
      console.error(`    Failed (session restore or sync): ${user.handle}`, err);
      results.push({ user: user.did, fetched: 0, stored: 0, errors: 1 });
    }
  }

  return results;
}

/**
 * Prune likes older than the rolling window.
 */
export async function pruneStaleLikes(
  db: D1Database,
  windowDays: number,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const result = await db
    .prepare(`DELETE FROM likes WHERE liked_at < ?`)
    .bind(cutoff.toISOString())
    .run();

  return result.meta.changes ?? 0;
}

function extractPostText(record: unknown): string | null {
  if (
    record &&
    typeof record === "object" &&
    "text" in record &&
    typeof (record as { text: unknown }).text === "string"
  ) {
    return (record as { text: string }).text;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

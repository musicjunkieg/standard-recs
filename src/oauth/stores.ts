/**
 * D1-backed stores for AT Protocol OAuth state and sessions.
 *
 * WorkersSavedStateStore: short-lived authorization state (cleared after callback).
 * WorkersSavedSessionStore: long-lived user sessions (used by cron pipeline).
 */

import type {
  WorkersSavedState,
  WorkersSavedStateStore,
  WorkersSavedSession,
  WorkersSavedSessionStore,
} from "atproto-oauth-client-cloudflare-workers";

export function createStateStore(db: D1Database): WorkersSavedStateStore {
  return {
    async set(key: string, val: WorkersSavedState) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO oauth_state (key, state, created_at)
           VALUES (?, ?, datetime('now'))`,
        )
        .bind(key, JSON.stringify(val))
        .run();
    },
    async get(key: string) {
      const row = await db
        .prepare(`SELECT state, created_at FROM oauth_state WHERE key = ?`)
        .bind(key)
        .first<{ state: string; created_at: string }>();
      if (!row) return undefined;
      // Expire state older than 15 minutes
      const age = Date.now() - new Date(row.created_at + "Z").getTime();
      if (age > 15 * 60 * 1000) {
        await db.prepare(`DELETE FROM oauth_state WHERE key = ?`).bind(key).run();
        return undefined;
      }
      return JSON.parse(row.state);
    },
    async del(key: string) {
      await db
        .prepare(`DELETE FROM oauth_state WHERE key = ?`)
        .bind(key)
        .run();
    },
  };
}

export function createSessionStore(db: D1Database): WorkersSavedSessionStore {
  return {
    async set(sub: string, val: WorkersSavedSession) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO oauth_sessions (did, session, updated_at)
           VALUES (?, ?, datetime('now'))`,
        )
        .bind(sub, JSON.stringify(val))
        .run();
    },
    async get(sub: string) {
      const row = await db
        .prepare(`SELECT session FROM oauth_sessions WHERE did = ?`)
        .bind(sub)
        .first<{ session: string }>();
      return row ? JSON.parse(row.session) : undefined;
    },
    async del(sub: string) {
      await db
        .prepare(`DELETE FROM oauth_sessions WHERE did = ?`)
        .bind(sub)
        .run();
    },
  };
}

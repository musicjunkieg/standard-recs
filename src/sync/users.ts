/**
 * Enroll and manage users.
 */

/**
 * List all enrolled users.
 */
export async function listUsers(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT did, handle, enrolled_at, last_synced_at FROM users ORDER BY enrolled_at`)
    .all();
  return results;
}

/**
 * Remove a user and their associated data.
 */
export async function removeUser(db: D1Database, did: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM recommendations WHERE did = ?`).bind(did),
    db.prepare(`DELETE FROM likes WHERE did = ?`).bind(did),
    db.prepare(`DELETE FROM users WHERE did = ?`).bind(did),
  ]);
}

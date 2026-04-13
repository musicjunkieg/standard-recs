-- standard-recs D1 schema
-- Run with: npm run db:init

CREATE TABLE IF NOT EXISTS users (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS likes (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  liked_post_uri TEXT NOT NULL,
  liked_post_text TEXT,
  liked_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (did) REFERENCES users(did)
);

CREATE INDEX IF NOT EXISTS idx_likes_did ON likes(did);
CREATE INDEX IF NOT EXISTS idx_likes_liked_at ON likes(liked_at);

CREATE TABLE IF NOT EXISTS documents (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  site TEXT,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  text_content TEXT,
  tags TEXT,
  published_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at);

-- `variant` and `rank` were added in successive 2026-04-13 migrations;
-- see the "Migration history" comment at the bottom of this file for
-- how they were applied to the existing production database. A fresh
-- database bootstrapped from this file gets the final shape directly
-- via the CREATE TABLE statement below.
CREATE TABLE IF NOT EXISTS recommendations (
  did TEXT NOT NULL,
  document_uri TEXT NOT NULL,
  score REAL NOT NULL,
  variant TEXT NOT NULL DEFAULT 'standard',
  rank INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (did, document_uri),
  FOREIGN KEY (did) REFERENCES users(did),
  FOREIGN KEY (document_uri) REFERENCES documents(uri)
);

CREATE INDEX IF NOT EXISTS idx_recs_did_variant ON recommendations(did, variant);

-- Publishers are auto-discovered from users' social graphs.
-- DIDs get added here automatically when the cron discovers that
-- someone a user liked also publishes site.standard.document records.
-- You can also manually seed this table if you want to bootstrap faster.
CREATE TABLE IF NOT EXISTS publishers (
  did TEXT PRIMARY KEY,
  label TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT,
  pds_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_publishers_last_synced
  ON publishers(last_synced_at);

CREATE TABLE IF NOT EXISTS publications (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  url TEXT NOT NULL,
  name TEXT
);

CREATE INDEX IF NOT EXISTS idx_publications_did ON publications(did);

CREATE TABLE IF NOT EXISTS oauth_state (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  did TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Migration history
-- ────────────────────────────────────────────────────────────────
--
-- This file describes the FINAL table shape. Fresh databases are
-- bootstrapped directly via the CREATE TABLE IF NOT EXISTS statements
-- above. For the existing production database, the migrations were
-- applied ad-hoc via `wrangler d1 execute --remote --command=...`
-- and are recorded here as historical reference only.
--
-- No migration system: this project has a single production DB and
-- a small set of incremental schema changes. If the change cadence
-- ever warrants it, move these to a real migrations/ directory with
-- timestamped files and a tracking table. Not today.
--
--   2026-04-13 (nonstandardrecs variant system):
--     ALTER TABLE recommendations ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';
--     CREATE INDEX IF NOT EXISTS idx_recs_did_variant ON recommendations(did, variant);
--
--   2026-04-13 round 3 (preserve MMR pick order at read time):
--     ALTER TABLE recommendations ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
--
-- If you're bootstrapping a new database, you DO NOT need to run the
-- ALTER statements — the CREATE TABLE above already has the
-- variant and rank columns. SQLite's ALTER TABLE ADD COLUMN is
-- idempotent-unsafe (errors on duplicate column) so re-running these
-- ALTERs against an already-migrated database fails fast, which is
-- why they're in comments, not executable SQL.

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

CREATE TABLE IF NOT EXISTS recommendations (
  did TEXT NOT NULL,
  document_uri TEXT NOT NULL,
  score REAL NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (did, document_uri),
  FOREIGN KEY (did) REFERENCES users(did),
  FOREIGN KEY (document_uri) REFERENCES documents(uri)
);

-- Publishers are auto-discovered from users' social graphs.
-- DIDs get added here automatically when the cron discovers that
-- someone a user liked also publishes site.standard.document records.
-- You can also manually seed this table if you want to bootstrap faster.
CREATE TABLE IF NOT EXISTS publishers (
  did TEXT PRIMARY KEY,
  label TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_publishers_last_synced
  ON publishers(last_synced_at);

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

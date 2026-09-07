CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  write_hash TEXT NOT NULL,
  payload TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
-- Deleted shares retain only a tombstone: delayed writes cannot recreate a revoked link.
CREATE INDEX IF NOT EXISTS shares_active ON shares(updated_at) WHERE payload IS NOT NULL;

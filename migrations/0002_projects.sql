-- One row per project that has its own publish key. The server keeps only a
-- SHA-256 of the key. A project with no row here accepts the admin token only.
CREATE TABLE projects (
  slug TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  owner TEXT,
  created_at TEXT NOT NULL
);

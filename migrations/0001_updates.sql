-- One row per published update or rollback. The newest row for a
-- (project, channel, runtime version, platform) is what clients receive.
CREATE TABLE updates (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  channel TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  kind TEXT NOT NULL CHECK (kind IN ('update', 'rollback')),
  manifest TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX updates_latest
  ON updates (project, channel, runtime_version, platform, created_at DESC);

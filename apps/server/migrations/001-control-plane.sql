CREATE TABLE smoke_records (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE control_plane_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('RUNNING', 'CLEAN', 'INTERRUPTED'))
) STRICT;

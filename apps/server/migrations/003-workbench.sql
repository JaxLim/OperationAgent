-- Product-shell state owned by Express. Projects are remembered folder paths only; no workspace content.
CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL CHECK(key = 'workbench'),
  value TEXT NOT NULL CHECK(json_valid(value) AND oa_utf16_length(value) BETWEEN 2 AND 4096),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(oa_utf16_length(name) BETWEEN 1 AND 80),
  path TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(oa_utf16_length(path) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL
) STRICT;

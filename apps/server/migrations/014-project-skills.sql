CREATE TABLE project_skill_grants (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK(oa_utf16_length(path) BETWEEN 1 AND 100),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (project_id, path)
) STRICT;

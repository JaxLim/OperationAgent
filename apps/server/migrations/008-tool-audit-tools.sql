-- M2 agent tools. SQLite cannot alter a CHECK constraint, so tool_audit is rebuilt with the same columns, a tool_id
-- check that admits every read-channel tool, and its rows copied unchanged (007 stays as applied: migrations are
-- checksummed and never edited). `bytes` counts returned bytes for read_file and returned entries for list_directory.
CREATE TABLE tool_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  tool_id TEXT NOT NULL CHECK(tool_id IN ('read_file', 'list_directory')),
  project_id TEXT CHECK(project_id IS NULL OR oa_utf16_length(project_id) = 36),
  task_id TEXT CHECK(task_id IS NULL OR oa_utf16_length(task_id) = 36),
  tool_call_id TEXT CHECK(tool_call_id IS NULL OR oa_utf16_length(tool_call_id) = 36),
  path TEXT NOT NULL CHECK(oa_utf16_length(path) <= 512),
  decision TEXT NOT NULL CHECK(decision IN ('allowed', 'refused', 'failed')),
  code TEXT CHECK(code IS NULL OR oa_utf16_length(code) BETWEEN 1 AND 64),
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO tool_audit_next SELECT id, tool_id, project_id, task_id, tool_call_id, path, decision, code, bytes, duration_ms, created_at FROM tool_audit;
DROP TABLE tool_audit;
ALTER TABLE tool_audit_next RENAME TO tool_audit;
CREATE INDEX tool_audit_created ON tool_audit(created_at, id);

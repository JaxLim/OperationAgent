-- M2 Read Gate (SEC-08). One row per tool decision made by Express: allowed reads, policy refusals and adapter failures.
-- No file content, hash of content or workspace root is stored; `path` is the normalized workspace-relative path (empty
-- when the requested path was not valid). There is no foreign key, so the audit trail outlives a removed project.
CREATE TABLE tool_audit (
  id TEXT PRIMARY KEY NOT NULL,
  tool_id TEXT NOT NULL CHECK(tool_id IN ('read_file')),
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
CREATE INDEX tool_audit_created ON tool_audit(created_at, id);

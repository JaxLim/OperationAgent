-- M5.2 selective retrieval (ADR-PLAT-001 D3). The read channel gains search_text and find_files, so tool_audit is
-- rebuilt once more with a tool_id check that admits them and its rows copied unchanged (007 and 008 stay as applied:
-- migrations are checksummed and never edited). `bytes` counts returned bytes for read_file, returned entries for
-- list_directory and find_files, and returned matches for search_text. A search query is never stored.
CREATE TABLE tool_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  tool_id TEXT NOT NULL CHECK(tool_id IN ('read_file', 'list_directory', 'search_text', 'find_files')),
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

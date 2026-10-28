-- Preserve 001 and its recorded checksum; upgrade all existing rows transactionally.
CREATE TABLE smoke_records_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK(oa_utf16_length(value) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO smoke_records_v2 (id, value, created_at)
  SELECT id, value, created_at FROM smoke_records;
DROP TABLE smoke_records;
ALTER TABLE smoke_records_v2 RENAME TO smoke_records;

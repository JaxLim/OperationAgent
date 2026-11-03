-- M2 settings expansion owned by Express. Linked model providers and web-search providers store only safeStorage
-- ciphertext and a four-character hint, exactly like the Anthropic key in 005. Endpoints are fixed in code, not here.
CREATE TABLE provider_credentials (
  slot TEXT PRIMARY KEY NOT NULL CHECK(slot IN ('openai', 'google', 'openrouter', 'exa', 'tavily', 'brave', 'firecrawl')),
  scheme TEXT NOT NULL CHECK(scheme = 'electron-safestorage-v1'),
  ciphertext TEXT NOT NULL CHECK(oa_utf16_length(ciphertext) BETWEEN 4 AND 8192),
  hint TEXT CHECK(hint IS NULL OR oa_utf16_length(hint) = 4),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE provider_models (
  provider TEXT PRIMARY KEY NOT NULL CHECK(provider IN ('openai', 'google', 'openrouter')),
  model TEXT NOT NULL CHECK(oa_utf16_length(model) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL
) STRICT;
-- Agent profiles and MCP server definitions are configuration only: nothing here is executed, launched or contacted.
-- Values are re-validated against the contracts on every read; a row that no longer validates is not returned. The
-- 32 KiB cap fits the largest valid definition even when every character is escaped in JSON.
CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE CHECK(oa_utf16_length(name) BETWEEN 2 AND 32),
  value TEXT NOT NULL CHECK(json_valid(value) AND oa_utf16_length(value) BETWEEN 2 AND 32768),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE CHECK(oa_utf16_length(name) BETWEEN 1 AND 48),
  value TEXT NOT NULL CHECK(json_valid(value) AND oa_utf16_length(value) BETWEEN 2 AND 32768),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

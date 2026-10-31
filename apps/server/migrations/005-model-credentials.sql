-- M2 model settings owned by Express (ARCHITECTURE §6.2/§6.3). Only safeStorage ciphertext and non-sensitive metadata
-- are stored: the provider, a four-character recognition hint and timestamps. Plaintext keys never reach SQLite.
CREATE TABLE model_credentials (
  provider TEXT PRIMARY KEY NOT NULL CHECK(provider = 'anthropic'),
  scheme TEXT NOT NULL CHECK(scheme = 'electron-safestorage-v1'),
  ciphertext TEXT NOT NULL CHECK(oa_utf16_length(ciphertext) BETWEEN 4 AND 8192),
  hint TEXT CHECK(hint IS NULL OR oa_utf16_length(hint) = 4),
  updated_at TEXT NOT NULL
) STRICT;
-- The chosen model per provider; unknown values read back as the default instead of being trusted.
CREATE TABLE model_settings (
  provider TEXT PRIMARY KEY NOT NULL CHECK(provider = 'anthropic'),
  model TEXT NOT NULL CHECK(oa_utf16_length(model) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL
) STRICT;

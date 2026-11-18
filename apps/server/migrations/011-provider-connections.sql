CREATE TABLE custom_providers (
  id TEXT PRIMARY KEY NOT NULL,
  base_url TEXT UNIQUE NOT NULL CHECK(length(base_url) BETWEEN 1 AND 512),
  allow_local INTEGER NOT NULL CHECK(allow_local IN (0,1)),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
  ciphertext TEXT NOT NULL CHECK(length(ciphertext) BETWEEN 4 AND 8192)
) STRICT;

CREATE TABLE hf_account (
  slot INTEGER PRIMARY KEY CHECK(slot = 1),
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_ciphertext TEXT NOT NULL CHECK(length(access_ciphertext) BETWEEN 4 AND 8192),
  refresh_ciphertext TEXT CHECK(length(refresh_ciphertext) BETWEEN 4 AND 8192),
  expires_at INTEGER NOT NULL,
  model TEXT CHECK(length(model) BETWEEN 1 AND 128)
) STRICT;

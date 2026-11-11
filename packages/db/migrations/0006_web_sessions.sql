CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_expires ON web_sessions(expires_at);

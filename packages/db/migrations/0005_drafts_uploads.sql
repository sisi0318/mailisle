CREATE TABLE uploads (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_text TEXT NOT NULL DEFAULT '', cc_text TEXT NOT NULL DEFAULT '', bcc_text TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', html TEXT,
  in_reply_to TEXT, refs TEXT NOT NULL DEFAULT '[]', attachment_ids TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);
CREATE INDEX drafts_updated ON drafts(updated_at);
CREATE INDEX drafts_account ON drafts(account_id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, encrypted_config TEXT NOT NULL,
  last_sync INTEGER, error TEXT
);
CREATE TABLE folders (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  uid_validity TEXT NOT NULL DEFAULT '', uid_next INTEGER NOT NULL DEFAULT 1, modseq TEXT
);
CREATE UNIQUE INDEX folders_account_path ON folders(account_id, path);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_key TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, refs TEXT NOT NULL,
  subject TEXT NOT NULL, from_json TEXT NOT NULL, to_json TEXT NOT NULL, date INTEGER NOT NULL,
  preview TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', cached INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_remote_key ON messages(account_id, remote_key);
CREATE INDEX messages_date ON messages(date);
CREATE INDEX messages_message_id ON messages(message_id);
CREATE INDEX messages_thread ON messages(thread_id);
CREATE TABLE locations (
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, uid INTEGER NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, flags TEXT NOT NULL,
  PRIMARY KEY(folder_id, uid)
);
CREATE INDEX locations_message ON locations(message_id);
CREATE VIRTUAL TABLE message_search USING fts5(id UNINDEXED, content, tokenize='unicode61');
CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_search WHERE id = old.id;
END;

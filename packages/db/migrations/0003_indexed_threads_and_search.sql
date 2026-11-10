CREATE TABLE thread_keys (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (account_id, reference)
);
CREATE INDEX thread_keys_thread ON thread_keys(thread_id);
INSERT OR IGNORE INTO thread_keys(account_id, reference, thread_id)
  SELECT account_id, message_id, thread_id FROM messages WHERE message_id <> '';
INSERT OR IGNORE INTO thread_keys(account_id, reference, thread_id)
  SELECT m.account_id, ref.value, m.thread_id FROM messages m, json_each(m.refs) ref WHERE ref.value <> '';

CREATE TABLE message_search_rows (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
);
INSERT INTO message_search_rows(id, message_id) SELECT rowid, id FROM message_search;
DROP TRIGGER messages_search_delete;
CREATE TRIGGER message_search_rows_delete AFTER DELETE ON message_search_rows BEGIN
  DELETE FROM message_search WHERE rowid = old.id;
END;

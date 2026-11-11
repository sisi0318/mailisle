ALTER TABLE messages ADD COLUMN body_indexed INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET body_indexed = cached;
CREATE INDEX messages_pending_body ON messages(account_id, body_indexed, date DESC, id DESC);

ALTER TABLE folders ADD COLUMN sync_complete INTEGER NOT NULL DEFAULT 0;
UPDATE folders SET sync_complete = 1 WHERE uid_validity <> '' AND (uid_next > 1 OR modseq IS NOT NULL);

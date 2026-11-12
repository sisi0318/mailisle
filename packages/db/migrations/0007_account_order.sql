ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY rowid) - 1 AS position FROM accounts
)
UPDATE accounts SET sort_order = (SELECT position FROM ordered WHERE ordered.id = accounts.id);

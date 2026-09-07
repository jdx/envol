-- 0001 was already applied to the hosted D1 before durable cursors were added.
CREATE TABLE IF NOT EXISTS runtime_state (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);

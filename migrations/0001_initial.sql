CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, installation_id INTEGER NOT NULL,
 public INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
 branch TEXT NOT NULL, channel TEXT NOT NULL, ruleset_id INTEGER, candidate_id TEXT,
 UNIQUE(project_id, name), UNIQUE(project_id, branch)
);
CREATE TABLE IF NOT EXISTS candidates (
 id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES lines(id), request_key TEXT NOT NULL,
 version TEXT NOT NULL, tag TEXT NOT NULL, state TEXT NOT NULL,
 base_sha TEXT, sha TEXT, pr INTEGER, run_id TEXT, workflow_ref TEXT, error TEXT,
 revision INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(line_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_candidate ON candidates(line_id)
 WHERE state NOT IN ('released','cancelled','failed');
CREATE TABLE IF NOT EXISTS artifacts (
 candidate_id TEXT NOT NULL REFERENCES candidates(id), name TEXT NOT NULL,
 digest TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL,
 PRIMARY KEY(candidate_id,name)
);
CREATE TABLE IF NOT EXISTS publications (
 candidate_id TEXT NOT NULL REFERENCES candidates(id), destination TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', external_id TEXT, error TEXT,
 PRIMARY KEY(candidate_id,destination)
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL REFERENCES candidates(id),
 kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER NOT NULL DEFAULT 0,
 fence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE TABLE IF NOT EXISTS metrics (
 project_id TEXT NOT NULL REFERENCES projects(id), source TEXT NOT NULL, metric TEXT NOT NULL,
 day TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(project_id,source,metric,day)
);
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

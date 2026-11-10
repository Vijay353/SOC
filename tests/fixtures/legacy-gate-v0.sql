-- Gate store schema exactly as shipped before V3 (tag v3-baseline, server/src/gate/store.ts).
-- Used to prove the CH-16 migration works on an existing database.
CREATE TABLE IF NOT EXISTS gate_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS response_requests (
  request_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  incident_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL,
  approval_id TEXT,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES response_requests(request_id),
  incident_revision INTEGER,
  decision TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  summary TEXT NOT NULL,
  policy_input TEXT NOT NULL,
  evidence_hashes TEXT NOT NULL,
  approver_ids TEXT NOT NULL,
  ci_id TEXT,
  idempotency_key TEXT,
  machine_action_count INTEGER,
  stage_input TEXT,
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  trace TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT,
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events WHEN (SELECT value FROM gate_settings WHERE key='allow_reset') IS NOT 'yes' BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TABLE IF NOT EXISTS imports (
  import_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  preview TEXT NOT NULL,
  backup_dir TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

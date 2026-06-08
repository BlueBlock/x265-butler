-- Plan 29-01: durable remote-agent state (worker registry + per-job lease/state).
--
-- remote_worker:
-- - upserted by /api/remote-agents/workers POST heartbeat/register
-- - active workers = lease_expires_at >= now
--
-- remote_job_lease:
-- - durable server-side job lease + lifecycle state for remote execution flow
-- - one lease row per job_id (PRIMARY KEY) for deterministic recovery

CREATE TABLE remote_worker (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id         TEXT    NOT NULL UNIQUE,
  display_name      TEXT    NOT NULL,
  base_url          TEXT    NOT NULL,
  capabilities_json TEXT    NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  lease_expires_at  INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX idx_remote_worker_lease_expires_at ON remote_worker(lease_expires_at);

CREATE TABLE remote_job_lease (
  job_id             INTEGER PRIMARY KEY REFERENCES job(id) ON DELETE CASCADE,
  worker_id          TEXT    NOT NULL REFERENCES remote_worker(worker_id) ON DELETE CASCADE,
  lease_token        TEXT    NOT NULL,
  state              TEXT    NOT NULL CHECK (state IN (
                        'prepared',
                        'claimed',
                        'running',
                        'completed',
                        'failed',
                        'cancelled'
                      )),
  progress_percent   REAL,
  message            TEXT,
  lease_expires_at   INTEGER NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at         INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100))
);

CREATE INDEX idx_remote_job_lease_worker_id ON remote_job_lease(worker_id);
CREATE INDEX idx_remote_job_lease_state ON remote_job_lease(state);
CREATE INDEX idx_remote_job_lease_expires_at ON remote_job_lease(lease_expires_at);

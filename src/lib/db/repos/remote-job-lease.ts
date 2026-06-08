import type Database from 'better-sqlite3';
import type { RemoteJobLeaseRow, RemoteJobLeaseState } from '../schema';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

export interface RemoteJobLeaseCreateInput {
  jobId: number;
  workerId: string;
  leaseToken: string;
  state?: RemoteJobLeaseState;
  progressPercent?: number | null;
  message?: string | null;
  leaseExpiresAt: number;
}

export interface RemoteJobLeaseRepo {
  put(input: RemoteJobLeaseCreateInput): RemoteJobLeaseRow;
  getByJobId(jobId: number): RemoteJobLeaseRow | undefined;
  listExpiredActive(now?: number): RemoteJobLeaseRow[];
  validateActiveLease(
    jobId: number,
    workerId: string,
    leaseToken: string,
    now?: number,
  ): RemoteJobLeaseRow | undefined;
  setState(
    jobId: number,
    state: RemoteJobLeaseState,
    patch?: { progressPercent?: number | null; message?: string | null; leaseExpiresAt?: number },
  ): RemoteJobLeaseRow | undefined;
}

export function makeRemoteJobLeaseRepo(db: Db): RemoteJobLeaseRepo {
  const putStmt = db.prepare<
    [number, string, string, string, number | null, string | null, number],
    void
  >(
    `INSERT INTO remote_job_lease (job_id, worker_id, lease_token, state, progress_percent, message, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       worker_id = excluded.worker_id,
       lease_token = excluded.lease_token,
       state = excluded.state,
       progress_percent = excluded.progress_percent,
       message = excluded.message,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = CAST(strftime('%s','now') AS INTEGER)`,
  );

  const getByJobIdStmt = db.prepare<[number], RemoteJobLeaseRow>(
    'SELECT * FROM remote_job_lease WHERE job_id = ?',
  );

  const listExpiredActiveStmt = db.prepare<[number], RemoteJobLeaseRow>(
    "SELECT * FROM remote_job_lease WHERE lease_expires_at < ? AND state IN ('claimed','running') ORDER BY lease_expires_at ASC",
  );

  const setStateStmt = db.prepare<
    [string, number | null, string | null, number, number],
    void
  >(
    `UPDATE remote_job_lease
     SET state = ?, progress_percent = ?, message = ?, lease_expires_at = ?,
         updated_at = CAST(strftime('%s','now') AS INTEGER)
     WHERE job_id = ?`,
  );

  return {
    put(input: RemoteJobLeaseCreateInput): RemoteJobLeaseRow {
      putStmt.run(
        input.jobId,
        input.workerId,
        input.leaseToken,
        input.state ?? 'prepared',
        input.progressPercent ?? null,
        input.message ?? null,
        input.leaseExpiresAt,
      );

      const row = getByJobIdStmt.get(input.jobId);
      if (!row) {
        throw new Error('remoteJobLeaseRepo.put: row missing after upsert');
      }
      return row;
    },

    getByJobId(jobId: number): RemoteJobLeaseRow | undefined {
      return getByJobIdStmt.get(jobId);
    },

    listExpiredActive(now = NOW_SECONDS()): RemoteJobLeaseRow[] {
      return listExpiredActiveStmt.all(now);
    },

    validateActiveLease(
      jobId: number,
      workerId: string,
      leaseToken: string,
      now = NOW_SECONDS(),
    ): RemoteJobLeaseRow | undefined {
      const row = getByJobIdStmt.get(jobId);
      if (!row) return undefined;
      if (row.worker_id !== workerId) return undefined;
      if (row.lease_token !== leaseToken) return undefined;
      if (row.lease_expires_at < now) return undefined;
      return row;
    },

    setState(
      jobId: number,
      state: RemoteJobLeaseState,
      patch?: { progressPercent?: number | null; message?: string | null; leaseExpiresAt?: number },
    ): RemoteJobLeaseRow | undefined {
      const current = getByJobIdStmt.get(jobId);
      if (!current) return undefined;
      setStateStmt.run(
        state,
        patch?.progressPercent ?? current.progress_percent,
        patch?.message ?? current.message,
        patch?.leaseExpiresAt ?? current.lease_expires_at,
        jobId,
      );
      return getByJobIdStmt.get(jobId);
    },
  };
}

export function newLeaseExpiry(ttlSeconds = 300, now = NOW_SECONDS()): number {
  return now + ttlSeconds;
}

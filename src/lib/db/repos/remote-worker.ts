import type Database from 'better-sqlite3';
import type { RemoteWorkerRow } from '../schema';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);
const LEASE_TTL_SECONDS = 300;

export interface RemoteWorkerUpsertInput {
  workerId: string;
  displayName: string;
  baseUrl: string;
  capabilities: Record<string, unknown>;
}

export interface RemoteWorkerView {
  workerId: string;
  displayName: string;
  baseUrl: string;
  capabilities: Record<string, unknown>;
  registeredAtIso: string;
  lastSeenAtIso: string;
  leaseExpiresAtIso: string;
}

export interface RemoteWorkerRepo {
  upsertHeartbeat(input: RemoteWorkerUpsertInput, now?: number): RemoteWorkerView;
  listActive(now?: number): RemoteWorkerView[];
  getActiveByWorkerId(workerId: string, now?: number): RemoteWorkerView | undefined;
}

function toIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function toView(row: RemoteWorkerRow): RemoteWorkerView {
  return {
    workerId: row.worker_id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    capabilities: JSON.parse(row.capabilities_json) as Record<string, unknown>,
    registeredAtIso: toIso(row.created_at),
    lastSeenAtIso: toIso(row.last_seen_at),
    leaseExpiresAtIso: toIso(row.lease_expires_at),
  };
}

export function makeRemoteWorkerRepo(db: Db): RemoteWorkerRepo {
  const upsertStmt = db.prepare<[string, string, string, string, number, number], void>(
    `INSERT INTO remote_worker (worker_id, display_name, base_url, capabilities_json, last_seen_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET
       display_name = excluded.display_name,
       base_url = excluded.base_url,
       capabilities_json = excluded.capabilities_json,
       last_seen_at = excluded.last_seen_at,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = CAST(strftime('%s','now') AS INTEGER)`,
  );

  const getByWorkerIdStmt = db.prepare<[string], RemoteWorkerRow>(
    'SELECT * FROM remote_worker WHERE worker_id = ?',
  );

  const listActiveStmt = db.prepare<[number], RemoteWorkerRow>(
    'SELECT * FROM remote_worker WHERE lease_expires_at >= ? ORDER BY worker_id ASC',
  );

  const getActiveByWorkerIdStmt = db.prepare<[string, number], RemoteWorkerRow>(
    'SELECT * FROM remote_worker WHERE worker_id = ? AND lease_expires_at >= ?',
  );

  return {
    upsertHeartbeat(input: RemoteWorkerUpsertInput, now = NOW_SECONDS()): RemoteWorkerView {
      const leaseExpiresAt = now + LEASE_TTL_SECONDS;
      upsertStmt.run(
        input.workerId,
        input.displayName,
        input.baseUrl,
        JSON.stringify(input.capabilities ?? {}),
        now,
        leaseExpiresAt,
      );

      const row = getByWorkerIdStmt.get(input.workerId);
      if (!row) {
        throw new Error('remoteWorkerRepo.upsertHeartbeat: row missing after upsert');
      }
      return toView(row);
    },

    listActive(now = NOW_SECONDS()): RemoteWorkerView[] {
      return listActiveStmt.all(now).map(toView);
    },

    getActiveByWorkerId(workerId: string, now = NOW_SECONDS()): RemoteWorkerView | undefined {
      const row = getActiveByWorkerIdStmt.get(workerId, now);
      return row ? toView(row) : undefined;
    },
  };
}

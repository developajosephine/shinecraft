import {
  resolveLww,
  type ConflictInfo,
  type ConflictLogEntry,
  type Op,
  type SyncResponse,
  type SyncStatus,
  type WashRecord,
} from '@washlog/shared';
import type pg from 'pg';
import type { Pool } from './db';

interface RecordRow {
  id: string;
  record_type: string;
  data: Record<string, unknown>;
  version: number;
  updated_at: Date;
  updated_by: string;
  deleted: boolean;
  deleted_at: Date | null;
  change_seq: string;
}

export function rowToRecord(row: RecordRow): WashRecord {
  return {
    ...row.data,
    id: row.id,
    type: row.record_type,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    deleted: row.deleted,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
  } as WashRecord;
}

const NEXT_SEQ = `nextval(pg_get_serial_sequence('records', 'change_seq'))`;
const WRITE_LOCK = 727001;

async function logConflict(client: pg.PoolClient, op: Op, conflict: ConflictInfo): Promise<void> {
  for (const f of conflict.fields) {
    await client.query(
      `INSERT INTO conflict_log
         (record_id, record_type, field, winning_value, rejected_value, winning_device, rejected_device, policy)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [
        op.recordId,
        op.recordType,
        f.field,
        JSON.stringify(f.winningValue ?? null),
        JSON.stringify(f.rejectedValue ?? null),
        conflict.winningDevice,
        conflict.rejectedDevice,
        f.policy,
      ],
    );
  }
}

/** Steps 2–3 of the protocol: lock the record, apply the policy. Runs inside the caller's transaction. */
async function applyOp(
  client: pg.PoolClient,
  op: Op,
): Promise<{ status: SyncStatus; row: RecordRow | null; conflict: ConflictInfo | null }> {
  const found = await client.query<RecordRow>('SELECT * FROM records WHERE id = $1 FOR UPDATE', [op.recordId]);
  const row = found.rows[0] ?? null;

  if (!row) {
    if (op.type !== 'create') return { status: 'rejected', row: null, conflict: null };
    const inserted = await client.query<RecordRow>(
      `INSERT INTO records (id, record_type, data, version, updated_at, updated_by, deleted, deleted_at)
       VALUES ($1, $2, $3::jsonb, 1, $4, $5, false, NULL) RETURNING *`,
      [op.recordId, op.recordType, JSON.stringify(op.payload), op.clientTimestamp, op.deviceId],
    );
    return { status: 'applied', row: inserted.rows[0], conflict: null };
  }

  if (row.record_type !== op.recordType) return { status: 'rejected', row, conflict: null };

  if (op.type === 'delete') {
    if (row.deleted) return { status: 'applied', row, conflict: null }; // already a tombstone
    // Deletion wins, even from a stale baseVersion.
    const deleted = await client.query<RecordRow>(
      `UPDATE records SET deleted = true, deleted_at = $2, version = version + 1,
              updated_at = $2, updated_by = $3, change_seq = ${NEXT_SEQ}
       WHERE id = $1 RETURNING *`,
      [op.recordId, op.clientTimestamp, op.deviceId],
    );
    return { status: 'applied', row: deleted.rows[0], conflict: null };
  }

  // create-on-existing (re-sent create under a new opId) is treated as an update.
  if (row.deleted) {
    // Tombstones win: the record cannot be resurrected.
    const conflict: ConflictInfo = {
      winner: 'server',
      winningDevice: row.updated_by,
      rejectedDevice: op.deviceId,
      fields: [{ field: '(record)', winningValue: 'deleted', rejectedValue: op.payload, policy: 'tombstone' }],
    };
    await logConflict(client, op, conflict);
    return { status: 'rejected', row, conflict };
  }

  const write = async (data: Record<string, unknown>) =>
    (
      await client.query<RecordRow>(
        `UPDATE records SET data = $2::jsonb, version = version + 1,
                updated_at = $3, updated_by = $4, change_seq = ${NEXT_SEQ}
         WHERE id = $1 RETURNING *`,
        [op.recordId, JSON.stringify(data), op.clientTimestamp, op.deviceId],
      )
    ).rows[0];

  // A stale baseVersion is only a conflict if ANOTHER device wrote in between. A device's own
  // queued ops (create, edit, edit — all made offline on the same base) chain without conflict.
  const stale = op.baseVersion !== null && op.baseVersion < row.version && row.updated_by !== op.deviceId;
  if (op.type === 'create' ? row.updated_by === op.deviceId : !stale) {
    return { status: 'applied', row: await write({ ...row.data, ...op.payload }), conflict: null };
  }

  const resolved = resolveLww(
    { data: row.data, updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by },
    { payload: op.payload, clientTimestamp: op.clientTimestamp, deviceId: op.deviceId },
  );
  const conflict: ConflictInfo = {
    winner: resolved.winner,
    winningDevice: resolved.winningDevice,
    rejectedDevice: resolved.rejectedDevice,
    fields: resolved.fields,
  };
  await logConflict(client, op, conflict);
  return {
    status: 'conflict_resolved',
    row: resolved.changed ? await write(resolved.merged) : row,
    conflict,
  };
}

/**
 * Handle one operation exactly once, in a single transaction:
 * claim the opId, lock the record, apply the policy, store the response, commit.
 */
export async function handleOp(pool: Pool, op: Op): Promise<SyncResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Claim the op ID. A concurrent retry of the same op blocks here until we commit,
    //    then sees the conflict and gets nothing back.
    const claimed = await client.query(
      `INSERT INTO processed_ops (op_id, device_id, record_id) VALUES ($1, $2, $3)
       ON CONFLICT (op_id) DO NOTHING RETURNING op_id`,
      [op.opId, op.deviceId, op.recordId],
    );
    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      const stored = await pool.query<{ result: SyncResponse | null }>(
        'SELECT result FROM processed_ops WHERE op_id = $1',
        [op.opId],
      );
      // Stored outcome, but with the record as it is NOW, so a late retry never rolls the client back.
      const current = await pool.query<RecordRow>('SELECT * FROM records WHERE id = $1', [op.recordId]);
      return {
        opId: op.opId,
        conflict: stored.rows[0]?.result?.conflict ?? null,
        record: current.rows[0] ? rowToRecord(current.rows[0]) : null,
        status: 'duplicate',
      };
    }

    // Serialise writers so change_seq values commit in order and a pull can never miss a row.
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);

    // 2–3. Lock the record and apply the policy.
    const outcome = await applyOp(client, op);
    const response: SyncResponse = {
      opId: op.opId,
      status: outcome.status,
      record: outcome.row ? rowToRecord(outcome.row) : null,
      conflict: outcome.conflict,
    };

    // 4. Store the response next to the op ID and commit both together with the record.
    await client.query('UPDATE processed_ops SET result = $2::jsonb WHERE op_id = $1', [
      op.opId,
      JSON.stringify(response),
    ]);
    await client.query('COMMIT');
    return response;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function changesSince(pool: Pool, since: number): Promise<{ records: WashRecord[]; latestSeq: number }> {
  const res = await pool.query<RecordRow>('SELECT * FROM records WHERE change_seq > $1 ORDER BY change_seq', [since]);
  const latestSeq = res.rows.reduce((max, r) => Math.max(max, Number(r.change_seq)), since);
  return { records: res.rows.map(rowToRecord), latestSeq };
}

export async function allRecords(pool: Pool): Promise<WashRecord[]> {
  const res = await pool.query<RecordRow>('SELECT * FROM records ORDER BY change_seq');
  return res.rows.map(rowToRecord);
}

export async function recentConflicts(pool: Pool, limit = 200): Promise<ConflictLogEntry[]> {
  const res = await pool.query('SELECT * FROM conflict_log ORDER BY id DESC LIMIT $1', [limit]);
  return res.rows.map((r) => ({
    id: r.id,
    recordId: r.record_id,
    recordType: r.record_type,
    field: r.field,
    winningValue: r.winning_value,
    rejectedValue: r.rejected_value,
    winningDevice: r.winning_device,
    rejectedDevice: r.rejected_device,
    policy: r.policy,
    createdAt: r.created_at.toISOString(),
  }));
}

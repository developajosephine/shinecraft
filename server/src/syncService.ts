import {
  authorizeOp,
  mergeCatalog,
  resolveLww,
  type Catalog,
  type ConflictInfo,
  type FieldStamps,
  type ConflictLogEntry,
  type Op,
  type SyncResponse,
  type SyncStatus,
  type WashRecord,
} from '@washlog/shared';
import type pg from 'pg';
import { SERVICE_ACTOR, writeAudit, type Actor } from './auth';
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
  field_stamps: FieldStamps;
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

/** Stamp the given fields as last written by this op. */
function stamp(existing: FieldStamps, fields: string[], op: Op): FieldStamps {
  const stamps = { ...existing };
  for (const field of fields) stamps[field] = { timestamp: op.clientTimestamp, deviceId: op.deviceId };
  return stamps;
}

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
        f.winningDevice,
        f.rejectedDevice,
        f.policy,
      ],
    );
  }
}

/** Steps 2–3 of the protocol: lock the record, apply the policy. Runs inside the caller's transaction. */
async function applyOp(
  client: pg.PoolClient,
  op: Op,
  actor: Actor,
): Promise<{ status: SyncStatus; row: RecordRow | null; conflict: ConflictInfo | null; reasons?: string[] }> {
  const found = await client.query<RecordRow>('SELECT * FROM records WHERE id = $1 FOR UPDATE', [op.recordId]);
  const row = found.rows[0] ?? null;

  // Role rules first. A refused op is answered (not errored) so it leaves the phone's queue,
  // and it is logged where everyone can see it.
  const reasons = authorizeOp(actor.role, op, row?.data);
  if (actor.kind === 'user' && actor.deviceId !== op.deviceId) reasons.push('This login belongs to a different device.');
  if (reasons.length > 0) {
    const conflict: ConflictInfo = {
      winner: 'server',
      fields: [
        {
          field: '(permission)',
          winningValue: reasons.join(' '),
          rejectedValue: op.type === 'delete' ? 'delete' : op.payload,
          winningDevice: row?.updated_by ?? 'server',
          rejectedDevice: op.deviceId,
          policy: 'forbidden',
        },
      ],
    };
    await logConflict(client, op, conflict);
    return { status: 'rejected', row, conflict, reasons };
  }

  if (!row) {
    if (op.type !== 'create') return { status: 'rejected', row: null, conflict: null };
    const inserted = await client.query<RecordRow>(
      `INSERT INTO records (id, record_type, data, version, updated_at, updated_by, deleted, deleted_at, field_stamps)
       VALUES ($1, $2, $3::jsonb, 1, $4, $5, false, NULL, $6::jsonb) RETURNING *`,
      [
        op.recordId,
        op.recordType,
        JSON.stringify(op.payload),
        op.clientTimestamp,
        op.deviceId,
        JSON.stringify(stamp({}, Object.keys(op.payload), op)),
      ],
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
      fields: [
        {
          field: '(record)',
          winningValue: 'deleted',
          rejectedValue: op.payload,
          winningDevice: row.updated_by,
          rejectedDevice: op.deviceId,
          policy: 'tombstone',
        },
      ],
    };
    await logConflict(client, op, conflict);
    return { status: 'rejected', row, conflict };
  }

  /** Write the given payload fields, stamp them, bump version and change_seq. */
  const write = async (data: Record<string, unknown>, fields: string[]) =>
    (
      await client.query<RecordRow>(
        `UPDATE records SET data = $2::jsonb, field_stamps = $3::jsonb, version = version + 1,
                updated_at = $4, updated_by = $5, change_seq = ${NEXT_SEQ}
         WHERE id = $1 RETURNING *`,
        [
          op.recordId,
          JSON.stringify(data),
          JSON.stringify(stamp(row.field_stamps, fields, op)),
          op.clientTimestamp,
          op.deviceId,
        ],
      )
    ).rows[0];

  // Fast path: the client edited the version the server still has.
  if (op.type === 'update' && op.baseVersion === row.version) {
    return { status: 'applied', row: await write({ ...row.data, ...op.payload }, Object.keys(op.payload)), conflict: null };
  }

  // Stale baseVersion (or a re-sent create): resolve field by field with the shared LWW function.
  const resolved = resolveLww(
    {
      data: row.data,
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by,
      fieldStamps: row.field_stamps,
    },
    { payload: op.payload, clientTimestamp: op.clientTimestamp, deviceId: op.deviceId },
  );
  const next = resolved.accepted.length > 0 ? await write(resolved.merged, resolved.accepted) : row;

  // No contested field (e.g. this phone's own queued edits, or a different field than the
  // other phone touched and nothing differed): a plain apply.
  if (resolved.fields.length === 0) return { status: 'applied', row: next, conflict: null };

  const conflict: ConflictInfo = { winner: resolved.winner, fields: resolved.fields };
  await logConflict(client, op, conflict);
  return { status: 'conflict_resolved', row: next, conflict };
}

/**
 * Handle one operation exactly once, in a single transaction:
 * claim the opId, lock the record, apply the policy, store the response, commit.
 */
export async function handleOp(pool: Pool, op: Op, actor: Actor = SERVICE_ACTOR): Promise<SyncResponse> {
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
    const outcome = await applyOp(client, op, actor);
    const response: SyncResponse = {
      opId: op.opId,
      status: outcome.status,
      record: outcome.row ? rowToRecord(outcome.row) : null,
      conflict: outcome.conflict,
      ...(outcome.reasons ? { reasons: outcome.reasons } : {}),
    };

    // Who did what: written in the same transaction as the change itself.
    await writeAudit(client, { ...actor, deviceId: op.deviceId }, {
      action: `${op.recordType}.${op.type}`,
      outcome: outcome.status,
      recordId: op.recordId,
      detail: { opId: op.opId, fields: Object.keys(op.payload), ...(outcome.reasons ? { reasons: outcome.reasons } : {}) },
    });

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

/** Reference data from the lookup tables (migration 004), merged over the built-in defaults. */
export async function readCatalog(pool: Pool): Promise<Catalog> {
  const [vehicles, services, units] = await Promise.all([
    pool.query('SELECT code, label, default_water_litres FROM vehicle_types ORDER BY sort_order, code'),
    pool.query('SELECT code, label, default_price_kes FROM services ORDER BY sort_order, code'),
    pool.query('SELECT code, label FROM supply_units ORDER BY sort_order, code'),
  ]);
  return mergeCatalog({
    vehicleTypes: vehicles.rows.map((r) => ({ code: r.code, label: r.label, defaultWaterLitres: Number(r.default_water_litres) })),
    services: services.rows.map((r) => ({ code: r.code, label: r.label, defaultPriceKes: r.default_price_kes })),
    supplyUnits: units.rows.map((r) => ({ code: r.code, label: r.label })),
  });
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

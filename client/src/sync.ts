import type { ChangesResponse, ConflictLogEntry, Op, SyncResponse } from '@washlog/shared';
import { getMeta, setMeta, type LocalRecord, type WashLogDB } from './db';

/** How the sync loop talks to the server. Throws on network error, non-2xx or timeout. */
export interface Transport {
  sendOp(op: Op): Promise<SyncResponse>;
  fetchChanges(since: number): Promise<ChangesResponse>;
  fetchConflicts(): Promise<ConflictLogEntry[]>;
}

export interface PushResult {
  sent: number;
  error?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Remove an acknowledged op and reconcile the record map — one transaction. */
async function applyAck(db: WashLogDB, op: Op, res: SyncResponse | null): Promise<void> {
  await db.transaction('rw', db.records, db.opQueue, db.ackedOps, db.conflicts, async () => {
    await db.opQueue.delete(op.seq);
    await db.ackedOps.put({ opId: op.opId, ackedAt: new Date().toISOString() });

    const remaining = await db.opQueue.where('recordId').equals(op.recordId).count();
    if (remaining === 0) {
      // No local edits left for this record: the server copy is the truth.
      if (res?.record) await db.records.put({ ...res.record, pending: false } as LocalRecord);
      else await db.records.update(op.recordId, { pending: false });
    } else if (res?.record) {
      // Later local ops are still queued: keep the local fields, stay pending, track the version.
      await db.records.update(op.recordId, { version: res.record.version });
    }

    if (res?.conflict) {
      const createdAt = new Date().toISOString();
      await db.conflicts.bulkAdd(
        res.conflict.fields.map((f) => ({
          recordId: op.recordId,
          recordType: op.recordType,
          field: f.field,
          winningValue: f.winningValue,
          rejectedValue: f.rejectedValue,
          winningDevice: res.conflict!.winningDevice,
          rejectedDevice: res.conflict!.rejectedDevice,
          policy: f.policy,
          createdAt,
        })),
      );
    }
  });
}

/**
 * Drain the queue strictly in FIFO order. Always sends the head op; on any failure
 * stops and leaves the head (same opId) in place. Never skips ahead.
 */
export async function pushQueue(db: WashLogDB, transport: Transport): Promise<PushResult> {
  let sent = 0;
  for (;;) {
    const head = await db.opQueue.orderBy('seq').first();
    if (!head) return { sent };

    // Already acknowledged (e.g. crash between ack and dequeue): drop it, do not resend.
    if (await db.ackedOps.get(head.opId)) {
      await applyAck(db, head, null);
      continue;
    }

    let res: SyncResponse;
    try {
      res = await transport.sendOp(head);
    } catch (err) {
      return { sent, error: message(err) };
    }
    await applyAck(db, head, res); // only reached after a 2xx acknowledgment
    sent++;
  }
}

/** Apply server changes to the record map, except records that still have pending ops. */
export async function pullChanges(db: WashLogDB, transport: Transport): Promise<number> {
  const since = (await getMeta<number>(db, 'lastPulledSeq')) ?? 0;
  const { records, latestSeq } = await transport.fetchChanges(since);
  let applied = 0;
  await db.transaction('rw', db.records, db.opQueue, db.meta, async () => {
    for (const record of records) {
      const pendingOps = await db.opQueue.where('recordId').equals(record.id).count();
      if (pendingOps > 0) continue; // the server resolves these when our ops are pushed
      await db.records.put({ ...record, pending: false } as LocalRecord);
      applied++;
    }
    await db.meta.put({ key: 'lastPulledSeq', value: latestSeq });
  });
  return applied;
}

/** Replace the local conflict log copy with the server's. */
export async function refreshConflicts(db: WashLogDB, transport: Transport): Promise<void> {
  const entries = await transport.fetchConflicts();
  await db.transaction('rw', db.conflicts, async () => {
    await db.conflicts.clear();
    await db.conflicts.bulkAdd(entries.map(({ id, ...rest }) => ({ serverId: id, ...rest })));
  });
}

export interface SyncResult {
  ok: boolean;
  sent: number;
  error?: string;
}

const running = new WeakMap<WashLogDB, Promise<SyncResult>>();

/** One sync run: push the queue, then pull. Concurrent calls share the same run. */
export function syncOnce(db: WashLogDB, transport: Transport): Promise<SyncResult> {
  let run = running.get(db);
  if (!run) {
    run = runSync(db, transport).finally(() => running.delete(db));
    running.set(db, run);
  }
  return run;
}

async function runSync(db: WashLogDB, transport: Transport): Promise<SyncResult> {
  const push = await pushQueue(db, transport);
  if (push.error) {
    await setMeta(db, 'lastError', push.error);
    return { ok: false, sent: push.sent, error: push.error };
  }
  try {
    await pullChanges(db, transport);
    await refreshConflicts(db, transport);
  } catch (err) {
    await setMeta(db, 'lastError', message(err));
    return { ok: false, sent: push.sent, error: message(err) };
  }
  await db.meta.bulkPut([
    { key: 'lastSyncAt', value: new Date().toISOString() },
    { key: 'lastError', value: null },
  ]);
  return { ok: true, sent: push.sent };
}

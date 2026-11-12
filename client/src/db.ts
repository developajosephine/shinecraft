import Dexie, { type Table } from 'dexie';
import type { ConflictPolicy, Op, RecordType, WashRecord } from '@washlog/shared';

/** A record as held on this phone: the shared shape plus the local "has unsynced ops" flag. */
export type LocalRecord = WashRecord & { pending: boolean };

export interface MetaRow {
  key: string; // deviceId | deviceName | lastPulledSeq | lastSyncAt | lastError
  value: unknown;
}

export interface AckedOp {
  opId: string;
  ackedAt: string;
}

export interface LocalConflict {
  id?: number;
  serverId?: number;
  recordId: string;
  recordType: RecordType;
  field: string;
  winningValue: unknown;
  rejectedValue: unknown;
  winningDevice: string;
  rejectedDevice: string;
  policy: ConflictPolicy;
  createdAt: string;
}

export class WashLogDB extends Dexie {
  /** Record map keyed by record ID. */
  records!: Table<LocalRecord, string>;
  /** Durable FIFO queue of pending operations; `seq` auto-increments, so key order = enqueue order. */
  opQueue!: Table<Op, number, Omit<Op, 'seq'>>;
  /** Operation-ID set: every op the server has acknowledged. */
  ackedOps!: Table<AckedOp, string>;
  meta!: Table<MetaRow, string>;
  /** Local copy of the conflict log. */
  conflicts!: Table<LocalConflict, number>;

  constructor(name = 'washlog') {
    super(name);
    // Note: IndexedDB cannot index booleans, so `pending`/`deleted` are filtered in memory.
    this.version(1).stores({
      records: 'id, type, pending, deleted',
      opQueue: '++seq, opId, recordId',
      ackedOps: 'opId',
      meta: 'key',
      conflicts: '++id, recordId',
    });
  }
}

export const db = new WashLogDB();

export async function getMeta<T>(database: WashLogDB, key: string): Promise<T | undefined> {
  return (await database.meta.get(key))?.value as T | undefined;
}

export async function setMeta(database: WashLogDB, key: string, value: unknown): Promise<void> {
  await database.meta.put({ key, value });
}

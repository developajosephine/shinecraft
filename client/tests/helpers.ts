import type { ChangesResponse, ConflictLogEntry, Op, SyncResponse, WashRecord } from '@washlog/shared';
import { WashLogDB } from '../src/db';
import { setupDevice } from '../src/store';
import type { Transport } from '../src/sync';

export async function newDb(name = `test-${crypto.randomUUID()}`): Promise<WashLogDB> {
  const db = new WashLogDB(name);
  await setupDevice(db, 'Test phone');
  return db;
}

export const jobFields = (plate: string) => ({
  plate,
  vehicleType: 'saloon',
  service: 'body',
  priceKes: 300,
  paymentMethod: null,
  attendant: 'Tester',
  status: 'waiting',
  waterLitres: 40,
  createdAt: new Date().toISOString(),
});

/** In-memory stand-in for the server: applies ops, bumps versions, records what it was sent. */
export class FakeServer implements Transport {
  sent: Op[] = [];
  records = new Map<string, WashRecord>();
  failing = false;
  changes: ChangesResponse = { records: [], latestSeq: 0 };
  /** Called just before each op is "received" — lets a test inspect client state mid-flight. */
  onSend: (op: Op) => Promise<void> | void = () => {};

  async sendOp(op: Op): Promise<SyncResponse> {
    await this.onSend(op);
    this.sent.push(op);
    if (this.failing) throw new Error('Network error — server unreachable');
    const prev = this.records.get(op.recordId);
    const record = {
      ...prev,
      ...op.payload,
      id: op.recordId,
      type: op.recordType,
      version: (prev?.version ?? 0) + 1,
      updatedAt: op.clientTimestamp,
      updatedBy: op.deviceId,
      deleted: op.type === 'delete',
      deletedAt: op.type === 'delete' ? op.clientTimestamp : null,
    } as WashRecord;
    this.records.set(op.recordId, record);
    return { opId: op.opId, status: 'applied', record, conflict: null };
  }

  async fetchChanges(): Promise<ChangesResponse> {
    return this.changes;
  }

  async fetchConflicts(): Promise<ConflictLogEntry[]> {
    return [];
  }
}

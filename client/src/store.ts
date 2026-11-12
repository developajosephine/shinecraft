import { parseFields, sameValue, type OpPayload, type RecordType } from '@washlog/shared';
import { getMeta, type LocalRecord, type WashLogDB } from './db';

export class ValidationError extends Error {
  constructor(public reasons: string[]) {
    super(reasons.join('; '));
    this.name = 'ValidationError';
  }
}

export interface Device {
  deviceId: string;
  deviceName: string;
}

export async function getDevice(db: WashLogDB): Promise<Device | null> {
  const deviceId = await getMeta<string>(db, 'deviceId');
  const deviceName = await getMeta<string>(db, 'deviceName');
  return deviceId && deviceName ? { deviceId, deviceName } : null;
}

/** First run: name this phone and give it a permanent device ID. */
export async function setupDevice(db: WashLogDB, name: string): Promise<Device> {
  const deviceName = name.trim();
  if (!deviceName) throw new ValidationError(['Device name is required']);
  return db.transaction('rw', db.meta, async () => {
    const deviceId = (await getMeta<string>(db, 'deviceId')) ?? crypto.randomUUID();
    await db.meta.bulkPut([
      { key: 'deviceId', value: deviceId },
      { key: 'deviceName', value: deviceName },
    ]);
    return { deviceId, deviceName };
  });
}

async function requireDeviceId(db: WashLogDB): Promise<string> {
  const deviceId = await getMeta<string>(db, 'deviceId');
  if (!deviceId) throw new Error('Device is not set up');
  return deviceId;
}

/*
 * Every mutation below runs in ONE transaction over `records` + `opQueue`:
 * the record map is updated (pending = true) and exactly one op is appended.
 * If either write fails, IndexedDB rolls back both.
 */

export async function createRecord(db: WashLogDB, type: RecordType, fields: unknown): Promise<string> {
  const parsed = parseFields(type, fields, false);
  if (!parsed.success) throw new ValidationError(parsed.errors);
  const id = crypto.randomUUID();
  await db.transaction('rw', db.records, db.opQueue, db.meta, async () => {
    const deviceId = await requireDeviceId(db);
    const now = new Date().toISOString();
    await db.records.put({
      ...parsed.data,
      id,
      type,
      version: 0,
      updatedAt: now,
      updatedBy: deviceId,
      deleted: false,
      deletedAt: null,
      pending: true,
    } as LocalRecord);
    await db.opQueue.add({
      opId: crypto.randomUUID(), // generated once, here; retries reuse it
      deviceId,
      recordType: type,
      recordId: id,
      type: 'create',
      payload: parsed.data,
      baseVersion: null,
      clientTimestamp: now,
    });
  });
  return id;
}

/** Returns false when nothing actually changed (no op is queued). */
export async function updateRecord(db: WashLogDB, id: string, changes: unknown): Promise<boolean> {
  return db.transaction('rw', db.records, db.opQueue, db.meta, async () => {
    const existing = await db.records.get(id);
    if (!existing || existing.deleted) throw new Error('Record not found');
    const parsed = parseFields(existing.type, changes, true);
    if (!parsed.success) throw new ValidationError(parsed.errors);

    // Only the fields that really changed go into the op, so a concurrent edit
    // to a different field on another phone is not overwritten.
    const current = existing as unknown as Record<string, unknown>;
    const diff: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(parsed.data)) {
      if (!sameValue(current[field], value)) diff[field] = value;
    }
    if (Object.keys(diff).length === 0) return false;

    const deviceId = await requireDeviceId(db);
    const now = new Date().toISOString();
    await db.records.put({ ...existing, ...diff, updatedAt: now, updatedBy: deviceId, pending: true } as LocalRecord);
    await db.opQueue.add({
      opId: crypto.randomUUID(),
      deviceId,
      recordType: existing.type,
      recordId: id,
      type: 'update',
      payload: diff as OpPayload,
      baseVersion: existing.version,
      clientTimestamp: now,
    });
    return true;
  });
}

/** Deletes are tombstones: the record stays in the map with deleted = true. */
export async function deleteRecord(db: WashLogDB, id: string): Promise<void> {
  await db.transaction('rw', db.records, db.opQueue, db.meta, async () => {
    const existing = await db.records.get(id);
    if (!existing || existing.deleted) return;
    const deviceId = await requireDeviceId(db);
    const now = new Date().toISOString();
    await db.records.put({
      ...existing,
      deleted: true,
      deletedAt: now,
      updatedAt: now,
      updatedBy: deviceId,
      pending: true,
    });
    await db.opQueue.add({
      opId: crypto.randomUUID(),
      deviceId,
      recordType: existing.type,
      recordId: id,
      type: 'delete',
      payload: {},
      baseVersion: existing.version,
      clientTimestamp: now,
    });
  });
}

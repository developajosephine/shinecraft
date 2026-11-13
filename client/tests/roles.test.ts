import { describe, expect, it } from 'vitest';
import type { Op, Session, SyncResponse } from '@washlog/shared';
import { getMeta } from '../src/db';
import { createRecord, deleteRecord, saveSession, updateRecord, ValidationError } from '../src/store';
import { pushQueue } from '../src/sync';
import { FakeServer, jobFields, newDb } from './helpers';

const session = (role: Session['user']['role']): Session => ({
  token: 'test-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: '00000000-0000-4000-8000-000000000001', name: 'Tester', role },
});

describe('roles on the phone', () => {
  it('an attendant cannot queue a payment or a delete; nothing is queued', async () => {
    const db = await newDb();
    await saveSession(db, session('attendant'));
    const id = await createRecord(db, 'job', jobFields('KRR 001A'));
    const before = await db.opQueue.count();

    await expect(updateRecord(db, id, { status: 'paid', paymentMethod: 'cash' })).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteRecord(db, id)).rejects.toBeInstanceOf(ValidationError);
    expect(await db.opQueue.count()).toBe(before);
    expect((await db.records.get(id))?.deleted).toBe(false);

    // Moving the job along is still fine.
    expect(await updateRecord(db, id, { status: 'washing' })).toBe(true);
  });

  it('a cashier can take payment', async () => {
    const db = await newDb();
    await saveSession(db, session('cashier'));
    const id = await createRecord(db, 'job', jobFields('KRR 002B'));
    expect(await updateRecord(db, id, { status: 'paid', paymentMethod: 'cash' })).toBe(true);
  });

  it('a create the server refuses leaves the queue and the local copy is removed; the queue keeps moving', async () => {
    const db = await newDb();
    const refusedId = await createRecord(db, 'job', jobFields('KRR 003C'));
    const okId = await createRecord(db, 'job', jobFields('KRR 004D'));

    const server = new FakeServer();
    const real = server.sendOp.bind(server);
    server.sendOp = async (op: Op): Promise<SyncResponse> => {
      if (op.recordId !== refusedId) return real(op);
      server.sent.push(op);
      return { opId: op.opId, status: 'rejected', record: null, conflict: null, reasons: ['This login belongs to a different device.'] };
    };

    expect(await pushQueue(db, server)).toEqual({ sent: 2, refused: 1 });
    expect(await db.opQueue.count()).toBe(0);
    expect(await db.records.get(refusedId)).toBeUndefined();
    expect((await db.records.get(okId))?.pending).toBe(false);
  });

  it('a 401 is a failed send: the op stays queued for after the next login', async () => {
    const db = await newDb();
    await createRecord(db, 'job', jobFields('KRR 005E'));
    const server = new FakeServer();
    server.sendOp = async () => {
      throw new Error('Please log in again');
    };
    const result = await pushQueue(db, server);
    expect(result.error).toBe('Please log in again');
    expect(await db.opQueue.count()).toBe(1);
    expect(await getMeta(db, 'deviceId')).toBeTruthy();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@washlog/shared';
import { WashLogDB } from '../src/db';
import { createRecord, deleteRecord, updateRecord } from '../src/store';
import { pushQueue } from '../src/sync';
import { FakeServer, jobFields, newDb } from './helpers';

describe('operation queue', () => {
  it('preserves FIFO order across 3+ ops and dequeues each op only after its ack', async () => {
    const db = await newDb();
    await createRecord(db, 'job', jobFields('KAA 001A'));
    await createRecord(db, 'job', jobFields('KAA 002B'));
    await createRecord(db, 'job', jobFields('KAA 003C'));
    await createRecord(db, 'supply', { item: 'Shampoo', quantity: 5, unit: 'litres' });

    const queued = await db.opQueue.orderBy('seq').toArray();
    expect(queued.map((o) => o.payload.plate ?? o.payload.item)).toEqual(['KAA 001A', 'KAA 002B', 'KAA 003C', 'Shampoo']);
    const seqs = queued.map((o) => o.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const server = new FakeServer();
    const queueSizeWhileSending: number[] = [];
    server.onSend = async (op) => {
      // The op being sent must still be in the queue: it is not removed before the ack.
      expect(await db.opQueue.get(op.seq)).toBeDefined();
      queueSizeWhileSending.push(await db.opQueue.count());
    };

    const result = await pushQueue(db, server);
    expect(result).toEqual({ sent: 4 });
    expect(server.sent.map((o) => o.opId)).toEqual(queued.map((o) => o.opId)); // sent in enqueue order
    expect(queueSizeWhileSending).toEqual([4, 3, 2, 1]);
    expect(await db.opQueue.count()).toBe(0);
    expect(await db.ackedOps.count()).toBe(4);
  });

  it('record update + enqueue are atomic: a failure inside the transaction writes neither', async () => {
    const db = await newDb();

    // create: the record is written first, then the enqueue blows up
    const add = vi.spyOn(db.opQueue, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(createRecord(db, 'job', jobFields('KBB 111A'))).rejects.toThrow('disk full');
    expect(add).toHaveBeenCalledTimes(1);
    expect(await db.records.count()).toBe(0);
    expect(await db.opQueue.count()).toBe(0);

    // update: the record must keep its old value and stay at one queued op
    const id = await createRecord(db, 'job', jobFields('KBB 222B'));
    vi.spyOn(db.opQueue, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(updateRecord(db, id, { priceKes: 999 })).rejects.toThrow('disk full');
    expect(((await db.records.get(id)) as JobRecord).priceKes).toBe(300);
    expect(await db.opQueue.count()).toBe(1);

    // delete: no tombstone without its op
    vi.spyOn(db.opQueue, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(deleteRecord(db, id)).rejects.toThrow('disk full');
    expect((await db.records.get(id))!.deleted).toBe(false);
    expect(await db.opQueue.count()).toBe(1);
  });

  it('keeps multiple ops for the same record as separate queue entries, in order', async () => {
    const db = await newDb();
    const id = await createRecord(db, 'job', jobFields('KCC 333C'));
    await updateRecord(db, id, { status: 'washing' });
    await updateRecord(db, id, { status: 'done', priceKes: 450 });
    await deleteRecord(db, id);

    const ops = await db.opQueue.where('recordId').equals(id).sortBy('seq');
    expect(ops.map((o) => o.type)).toEqual(['create', 'update', 'update', 'delete']);
    expect(ops[1].payload).toEqual({ status: 'washing' }); // history is not collapsed into the latest state
    expect(ops[2].payload).toEqual({ status: 'done', priceKes: 450 });
    expect(new Set(ops.map((o) => o.opId)).size).toBe(4);

    expect(await db.records.count()).toBe(1); // one entry in the record map
    const record = (await db.records.get(id))!;
    expect(record.deleted).toBe(true); // tombstone, hidden from lists
    expect(record.pending).toBe(true);
  });

  it('does not queue an op when an edit changes nothing', async () => {
    const db = await newDb();
    const id = await createRecord(db, 'job', jobFields('KCC 444D'));
    expect(await updateRecord(db, id, { priceKes: 300, plate: 'kcc 444d' })).toBe(false);
    expect(await db.opQueue.count()).toBe(1);
  });

  it('rejects invalid data before anything is written', async () => {
    const db = await newDb();
    await expect(createRecord(db, 'job', { ...jobFields('KDD 555E'), priceKes: -1 })).rejects.toThrow(/priceKes/);
    expect(await db.records.count()).toBe(0);
    expect(await db.opQueue.count()).toBe(0);
  });

  it('data persists across closing and reopening the database (reload)', async () => {
    const name = `reload-${crypto.randomUUID()}`;
    const first = await newDb(name);
    const id = await createRecord(first, 'job', jobFields('KEE 666F'));
    await updateRecord(first, id, { status: 'washing' });
    const before = await first.opQueue.orderBy('seq').toArray();
    const deviceId = (await first.meta.get('deviceId'))!.value;
    first.close();

    const reopened = new WashLogDB(name); // a fresh page load
    const record = (await reopened.records.get(id)) as JobRecord & { pending: boolean };
    expect(record.plate).toBe('KEE 666F');
    expect(record.status).toBe('washing');
    expect(record.pending).toBe(true);
    expect(await reopened.opQueue.orderBy('seq').toArray()).toEqual(before); // same ops, same opIds, same order
    expect((await reopened.meta.get('deviceId'))!.value).toBe(deviceId);

    // and the reloaded queue still syncs
    const server = new FakeServer();
    expect(await pushQueue(reopened, server)).toEqual({ sent: 2 });
    expect(server.sent.map((o) => o.opId)).toEqual(before.map((o) => o.opId));
  });
});

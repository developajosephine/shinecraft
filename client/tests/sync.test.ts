import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, mergeCatalog, type JobRecord, type WashRecord } from '@washlog/shared';
import { createRecord, updateRecord } from '../src/store';
import { pullChanges, pushQueue, syncOnce } from '../src/sync';
import { FakeServer, jobFields, newDb } from './helpers';

describe('sync loop', () => {
  it('a failed send leaves the head op in place with the same opId; later ops are not sent', async () => {
    const db = await newDb();
    await createRecord(db, 'job', jobFields('KFF 001A'));
    await createRecord(db, 'job', jobFields('KFF 002B'));
    await createRecord(db, 'job', jobFields('KFF 003C'));
    const before = await db.opQueue.orderBy('seq').toArray();

    const server = new FakeServer();
    server.failing = true;
    const failed = await pushQueue(db, server);
    expect(failed.sent).toBe(0);
    expect(failed.error).toMatch(/Network error/);
    expect(server.sent).toHaveLength(1); // only the head was attempted — never skips ahead
    expect(server.sent[0].opId).toBe(before[0].opId);
    expect(await db.opQueue.orderBy('seq').toArray()).toEqual(before); // nothing removed, nothing reordered
    expect(await db.ackedOps.count()).toBe(0);

    // retry: the very same opId goes out again, then the rest in order
    server.failing = false;
    expect(await pushQueue(db, server)).toEqual({ sent: 3 });
    expect(server.sent.map((o) => o.opId)).toEqual([before[0].opId, ...before.map((o) => o.opId)]);
    expect(await db.opQueue.count()).toBe(0);
  });

  it('records the error and skips the pull when the push fails', async () => {
    const db = await newDb();
    await createRecord(db, 'job', jobFields('KFF 004D'));
    const server = new FakeServer();
    server.failing = true;
    const result = await syncOnce(db, server);
    expect(result.ok).toBe(false);
    expect((await db.meta.get('lastError'))!.value).toMatch(/Network error/);

    server.failing = false;
    expect((await syncOnce(db, server)).ok).toBe(true);
    expect((await db.meta.get('lastError'))!.value).toBeNull();
    expect((await db.meta.get('lastSyncAt'))!.value).toBeTruthy();
  });

  it('an op already in ackedOps is skipped and removed, not resent', async () => {
    const db = await newDb();
    const id1 = await createRecord(db, 'job', jobFields('KGG 001A'));
    await createRecord(db, 'job', jobFields('KGG 002B'));
    const [first, second] = await db.opQueue.orderBy('seq').toArray();
    // Simulate "ack recorded, but the app died before the op left the queue".
    await db.ackedOps.put({ opId: first.opId, ackedAt: new Date().toISOString() });

    const server = new FakeServer();
    expect(await pushQueue(db, server)).toEqual({ sent: 1 });
    expect(server.sent.map((o) => o.opId)).toEqual([second.opId]);
    expect(await db.opQueue.count()).toBe(0);
    expect((await db.records.get(id1))!.pending).toBe(false);
  });

  it('clears pending only when no ops for that record remain', async () => {
    const db = await newDb();
    const id = await createRecord(db, 'job', jobFields('KHH 001A'));
    await updateRecord(db, id, { status: 'washing' });

    const server = new FakeServer();
    let checked = false;
    server.onSend = async (op) => {
      if (op.type !== 'update') return;
      // The create was acked, but the update is still queued.
      const record = (await db.records.get(id)) as JobRecord & { pending: boolean };
      expect(record.pending).toBe(true);
      expect(record.version).toBe(1); // server version tracked
      expect(record.status).toBe('washing'); // local edit not clobbered by the create's ack
      checked = true;
    };
    await pushQueue(db, server);
    expect(checked).toBe(true);
    const record = (await db.records.get(id)) as JobRecord & { pending: boolean };
    expect(record.pending).toBe(false);
    expect(record.version).toBe(2);
    expect(record.status).toBe('washing');
  });

  it('pulled changes do not overwrite records with pending ops', async () => {
    const db = await newDb();
    const server = new FakeServer();
    const pendingId = await createRecord(db, 'job', jobFields('KJJ 001A'));
    const syncedId = await createRecord(db, 'job', jobFields('KJJ 002B'));
    await pushQueue(db, server); // both synced
    await updateRecord(db, pendingId, { priceKes: 700 }); // local edit, not yet pushed

    const fromServer = (id: string): WashRecord =>
      ({ ...server.records.get(id)!, priceKes: 111, version: 5, updatedBy: 'other-phone' }) as WashRecord;
    const brandNew = { ...fromServer(syncedId), id: crypto.randomUUID(), plate: 'KJJ 003C' } as WashRecord;
    server.changes = { records: [fromServer(pendingId), fromServer(syncedId), brandNew], latestSeq: 42 };

    expect(await pullChanges(db, server)).toBe(2);

    const pending = (await db.records.get(pendingId)) as JobRecord & { pending: boolean };
    expect(pending.priceKes).toBe(700); // local edit kept
    expect(pending.pending).toBe(true);
    expect(await db.opQueue.where('recordId').equals(pendingId).count()).toBe(1);

    const synced = (await db.records.get(syncedId)) as JobRecord & { pending: boolean };
    expect(synced.priceKes).toBe(111); // no local ops -> server copy applied
    expect(synced.version).toBe(5);
    expect(await db.records.get(brandNew.id)).toBeDefined();
    expect((await db.meta.get('lastPulledSeq'))!.value).toBe(42);
  });
});

describe('reference data (catalog)', () => {
  it('a sync stores the server catalog on the phone; a failed catalog fetch keeps the stored copy and does not fail the sync', async () => {
    const db = await newDb();
    const server = new FakeServer();
    const custom = mergeCatalog({ services: [{ code: 'body', label: 'Body only', defaultPriceKes: 350 }] });
    let catalogFails = false;
    const transport = Object.assign(server, {
      fetchCatalog: async () => {
        if (catalogFails) throw new Error('Network error — server unreachable');
        return custom;
      },
    });

    expect((await syncOnce(db, transport)).ok).toBe(true);
    expect((await db.meta.get('catalog'))!.value).toEqual(custom);

    catalogFails = true;
    expect((await syncOnce(db, transport)).ok).toBe(true);
    expect((await db.meta.get('catalog'))!.value).toEqual(custom);
  });

  it('without a catalog from the server the built-in values are used', async () => {
    const db = await newDb();
    expect(await db.meta.get('catalog')).toBeUndefined();
    expect(mergeCatalog((await db.meta.get('catalog'))?.value)).toEqual(DEFAULT_CATALOG);
  });
});

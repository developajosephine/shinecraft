import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createOp,
  dbRecord,
  deleteOp,
  jobPayload,
  push,
  setup,
  T1,
  T2,
  T3,
  updateOp,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.pool.end();
});

async function newJob(overrides: Record<string, unknown> = {}) {
  const op = createOp({ payload: jobPayload(overrides) });
  await push(ctx, op);
  return op.recordId;
}

const logFor = async (recordId: string) =>
  (await ctx.pool.query('SELECT * FROM conflict_log WHERE record_id = $1 ORDER BY id', [recordId])).rows;

describe('conflict resolution', () => {
  it('two devices update the same record from the same baseVersion -> second is conflict_resolved, later timestamp wins, conflict_log written', async () => {
    const id = await newJob({ status: 'washing', priceKes: 300 });

    // A (offline at v1): status=paid at T1. B (offline at v1): price changed at T2.
    const a = await push(ctx, updateOp(id, { status: 'paid' }, { deviceId: 'device-A', clientTimestamp: T1 }));
    expect(a.body.status).toBe('applied');
    expect(a.body.record.version).toBe(2);

    const b = await push(ctx, updateOp(id, { priceKes: 500 }, { deviceId: 'device-B', clientTimestamp: T2 }));
    expect(b.status).toBe(200);
    expect(b.body.status).toBe('conflict_resolved');
    expect(b.body.conflict.winner).toBe('incoming');
    expect(b.body.conflict.fields).toEqual([
      {
        field: 'priceKes',
        winningValue: 500,
        rejectedValue: 300,
        winningDevice: 'device-B',
        rejectedDevice: 'device-A',
        policy: 'lww-flag-money',
      },
    ]);
    // B won its field; A's status change (a different field) survives.
    expect(b.body.record).toMatchObject({ version: 3, priceKes: 500, status: 'paid', updatedBy: 'device-B' });

    const log = await logFor(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      record_type: 'job',
      field: 'priceKes',
      winning_value: 500,
      rejected_value: 300,
      winning_device: 'device-B',
      rejected_device: 'device-A',
      policy: 'lww-flag-money', // money fields are flagged
    });
  });

  it('a stale update with an EARLIER timestamp loses: server value kept, version unchanged, rejection logged', async () => {
    const id = await newJob({ status: 'waiting' });
    await push(ctx, updateOp(id, { status: 'done' }, { deviceId: 'device-A', clientTimestamp: T2 }));

    const b = await push(ctx, updateOp(id, { status: 'washing' }, { deviceId: 'device-B', clientTimestamp: T1 }));
    expect(b.body.status).toBe('conflict_resolved');
    expect(b.body.conflict.winner).toBe('server');
    expect(b.body.conflict.fields[0]).toMatchObject({ winningDevice: 'device-A', rejectedDevice: 'device-B' });
    expect(b.body.record).toMatchObject({ version: 2, status: 'done' });

    const log = await logFor(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ field: 'status', winning_value: 'done', rejected_value: 'washing', policy: 'lww' });
  });

  it('equal timestamps: the lexicographically greater deviceId wins, whichever arrives first', async () => {
    // B arrives second
    const first = await newJob();
    await push(ctx, updateOp(first, { priceKes: 400 }, { deviceId: 'device-A', clientTimestamp: T1 }));
    const bSecond = await push(ctx, updateOp(first, { priceKes: 600 }, { deviceId: 'device-B', clientTimestamp: T1 }));
    expect(bSecond.body.conflict.fields[0].winningDevice).toBe('device-B');
    expect(bSecond.body.record.priceKes).toBe(600);

    // A arrives second
    const second = await newJob();
    await push(ctx, updateOp(second, { priceKes: 600 }, { deviceId: 'device-B', clientTimestamp: T1 }));
    const aSecond = await push(ctx, updateOp(second, { priceKes: 400 }, { deviceId: 'device-A', clientTimestamp: T1 }));
    expect(aSecond.body.conflict.fields[0].winningDevice).toBe('device-B');
    expect(aSecond.body.record.priceKes).toBe(600);
  });

  it('logs one row per differing field and skips fields both sides agree on', async () => {
    const id = await newJob();
    await push(ctx, updateOp(id, { status: 'paid', paymentMethod: 'cash' }, { deviceId: 'device-A', clientTimestamp: T1 }));
    const b = await push(
      ctx,
      updateOp(
        id,
        { status: 'paid', paymentMethod: 'mpesa', mpesaCode: 'SYNTH12345' },
        { deviceId: 'device-B', clientTimestamp: T2 },
      ),
    );
    expect(b.body.status).toBe('conflict_resolved');
    const log = await logFor(id);
    expect(log.map((r) => [r.field, r.policy])).toEqual([
      ['mpesaCode', 'lww-flag-money'],
      ['paymentMethod', 'lww-flag-money'],
    ]); // status is 'paid' on both sides -> not a conflict
  });

  it('edits to different fields both survive, whichever phone syncs first', async () => {
    const final: Record<string, unknown>[] = [];
    for (const order of ['A-first', 'B-first']) {
      const create = createOp({ deviceId: 'device-C', payload: jobPayload({ status: 'washing', priceKes: 300 }) });
      await push(ctx, create);
      const a = updateOp(create.recordId, { status: 'paid' }, { deviceId: 'device-A', clientTimestamp: T1 });
      const b = updateOp(create.recordId, { priceKes: 500 }, { deviceId: 'device-B', clientTimestamp: T2 });
      const [first, second] = order === 'A-first' ? [a, b] : [b, a];
      expect((await push(ctx, first)).body.status).toBe('applied');
      const res = await push(ctx, second);
      expect(res.body.status).toBe('conflict_resolved');
      final.push({ status: res.body.record.status, priceKes: res.body.record.priceKes, version: res.body.record.version });
    }
    expect(final[0]).toEqual({ status: 'paid', priceKes: 500, version: 3 });
    expect(final[1]).toEqual(final[0]); // same end state in both orders
  });

  it("a device's own queued ops chain without conflict (stale baseVersion, same device)", async () => {
    const create = createOp({ deviceId: 'device-A' });
    await push(ctx, create);
    // Both edits were queued offline before the create was acknowledged: baseVersion 0.
    const one = await push(ctx, updateOp(create.recordId, { status: 'washing' }, { baseVersion: 0, clientTimestamp: T1 }));
    const two = await push(ctx, updateOp(create.recordId, { status: 'done' }, { baseVersion: 0, clientTimestamp: T2 }));
    expect([one.body.status, two.body.status]).toEqual(['applied', 'applied']);
    expect(two.body.record).toMatchObject({ version: 3, status: 'done' });
    expect(await logFor(create.recordId)).toHaveLength(0);
  });
});

describe('deletion policy', () => {
  it('delete then stale update -> rejected, record stays deleted, rejection logged', async () => {
    const id = await newJob({ plate: 'KDD 404D' });

    const del = await push(ctx, deleteOp(id, { deviceId: 'device-A', clientTimestamp: T1 }));
    expect(del.body.status).toBe('applied');
    expect(del.body.record).toMatchObject({ deleted: true, version: 2 });

    // B edited offline from v1, with a LATER timestamp. Deletion still wins.
    const stale = await push(ctx, updateOp(id, { priceKes: 900 }, { deviceId: 'device-B', clientTimestamp: T3 }));
    expect(stale.status).toBe(200);
    expect(stale.body.status).toBe('rejected');
    expect(stale.body.record).toMatchObject({ id, deleted: true, version: 2 }); // the tombstone comes back

    const row = await dbRecord(ctx, id);
    expect(row.deleted).toBe(true);
    expect(row.version).toBe(2);
    expect(row.data.priceKes).toBe(300); // untouched

    const log = await logFor(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      policy: 'tombstone',
      winning_device: 'device-A',
      rejected_device: 'device-B',
      rejected_value: { priceKes: 900 },
    });
  });

  it('a re-sent create cannot resurrect a tombstoned record', async () => {
    const create = createOp();
    await push(ctx, create);
    await push(ctx, deleteOp(create.recordId));
    const again = await push(ctx, createOp({ recordId: create.recordId, deviceId: 'device-B', clientTimestamp: T3 }));
    expect(again.body.status).toBe('rejected');
    expect((await dbRecord(ctx, create.recordId)).deleted).toBe(true);
  });

  it('delete wins from a stale baseVersion, and deleting twice is harmless', async () => {
    const id = await newJob();
    await push(ctx, updateOp(id, { status: 'done' }, { deviceId: 'device-B', clientTimestamp: T2 }));
    const del = await push(ctx, deleteOp(id, { deviceId: 'device-A', baseVersion: 1, clientTimestamp: T1 }));
    expect(del.body.status).toBe('applied');
    expect(del.body.record.deleted).toBe(true);
    const twice = await push(ctx, deleteOp(id, { deviceId: 'device-B', baseVersion: 2, clientTimestamp: T3 }));
    expect(twice.body.status).toBe('applied');
    expect((await dbRecord(ctx, id)).version).toBe(3);
  });

  it('GET /api/conflicts returns the log, newest first', async () => {
    const res = await request(ctx.app).get('/api/conflicts').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.conflicts.length).toBeGreaterThanOrEqual(5);
    const ids = res.body.conflicts.map((c: { id: number }) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(res.body.conflicts[0]).toEqual(
      expect.objectContaining({
        recordId: expect.any(String),
        field: expect.any(String),
        winningDevice: expect.any(String),
        rejectedDevice: expect.any(String),
        policy: expect.any(String),
        createdAt: expect.any(String),
      }),
    );
  });
});

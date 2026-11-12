import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, count, createOp, dbRecord, jobPayload, push, setup, updateOp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('POST /api/sync/ops — apply and dedup', () => {
  it('create -> 200 applied, version 1', async () => {
    const op = createOp({ payload: jobPayload({ plate: ' kba 001a ' }) });
    const res = await push(ctx, op);
    expect(res.status).toBe(200);
    expect(res.body.opId).toBe(op.opId);
    expect(res.body.status).toBe('applied');
    expect(res.body.conflict).toBeNull();
    expect(res.body.record).toMatchObject({
      id: op.recordId,
      type: 'job',
      version: 1,
      plate: 'KBA 001A', // normalised by the shared schema
      deleted: false,
      updatedBy: 'device-A',
    });
    expect(ctx.logs.at(-1)).toContain(op.opId); // each op is logged with status + duration
    expect(JSON.parse(ctx.logs.at(-1)!)).toMatchObject({ status: 'applied', durationMs: expect.any(Number) });
  });

  it('same op sent twice -> second is duplicate, exactly one row, version unchanged', async () => {
    const op = createOp();
    const first = await push(ctx, op);
    const second = await push(ctx, op);
    expect(first.body.status).toBe('applied');
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');
    expect(second.body.record.version).toBe(1);

    const rows = await ctx.pool.query('SELECT version FROM records WHERE id = $1', [op.recordId]);
    expect(rows.rows).toEqual([{ version: 1 }]);
    const ops = await ctx.pool.query('SELECT count(*) FROM processed_ops WHERE op_id = $1', [op.opId]);
    expect(Number(ops.rows[0].count)).toBe(1);
  });

  it('a duplicated update is not applied twice', async () => {
    const create = createOp();
    await push(ctx, create);
    const update = updateOp(create.recordId, { priceKes: 450 });
    expect((await push(ctx, update)).body.record.version).toBe(2);
    const again = await push(ctx, update);
    expect(again.body.status).toBe('duplicate');
    expect((await dbRecord(ctx, create.recordId)).version).toBe(2);
  });

  it('concurrent retries of the same op apply it exactly once', async () => {
    const op = createOp();
    const responses = await Promise.all([push(ctx, op), push(ctx, op), push(ctx, op), push(ctx, op)]);
    const statuses = responses.map((r) => r.body.status).sort();
    expect(statuses).toEqual(['applied', 'duplicate', 'duplicate', 'duplicate']);
    expect((await dbRecord(ctx, op.recordId)).version).toBe(1);
  });

  it('lost ack: drop-ack-next answers 503 but commits; retry with the same opId -> duplicate, no duplicate job', async () => {
    const before = await count(ctx, 'records');
    await request(ctx.app).post('/api/demo/drop-ack-next').set(auth).expect(200);

    const op = createOp({ payload: jobPayload({ plate: 'KBC 777X' }) });
    const dropped = await push(ctx, op);
    expect(dropped.status).toBe(503); // the client never sees the acknowledgment…
    expect((await dbRecord(ctx, op.recordId)).version).toBe(1); // …but the job is committed

    const retry = await push(ctx, op); // same opId, as the client queue guarantees
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('duplicate');
    expect(retry.body.record).toMatchObject({ id: op.recordId, version: 1, plate: 'KBC 777X' });

    expect(await count(ctx, 'records')).toBe(before + 1); // one car, not two
    const plates = await ctx.pool.query(`SELECT count(*) FROM records WHERE data->>'plate' = 'KBC 777X'`);
    expect(Number(plates.rows[0].count)).toBe(1);
  });

  it('fail-next -> 503 and nothing applied; retry -> applied', async () => {
    const recordsBefore = await count(ctx, 'records');
    const opsBefore = await count(ctx, 'processed_ops');
    await request(ctx.app).post('/api/demo/fail-next').set(auth).expect(200);

    const op = createOp();
    const failed = await push(ctx, op);
    expect(failed.status).toBe(503);
    expect(await count(ctx, 'records')).toBe(recordsBefore);
    expect(await count(ctx, 'processed_ops')).toBe(opsBefore); // op ID not consumed

    const retry = await push(ctx, op);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('applied'); // not "duplicate": the first attempt wrote nothing
    expect(retry.body.record.version).toBe(1);
  });

  it('invalid op -> 400 with reasons, nothing written, opId not recorded', async () => {
    const recordsBefore = await count(ctx, 'records');
    const opsBefore = await count(ctx, 'processed_ops');

    const bad = createOp({ payload: jobPayload({ priceKes: -50, vehicleType: 'spaceship' }) });
    const res = await push(ctx, bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_op');
    expect(res.body.reasons.join(' ')).toMatch(/priceKes/);
    expect(res.body.reasons.join(' ')).toMatch(/vehicleType/);

    for (const broken of [
      createOp({ opId: 'not-a-uuid' }),
      createOp({ type: 'explode' }),
      createOp({ payload: { ...jobPayload(), isAdmin: true } }), // unknown field
      updateOp(bad.recordId, {}), // empty update
      { hello: 'world' },
    ]) {
      expect((await push(ctx, broken)).status).toBe(400);
    }

    expect(await count(ctx, 'records')).toBe(recordsBefore);
    expect(await count(ctx, 'processed_ops')).toBe(opsBefore);
    const recorded = await ctx.pool.query('SELECT 1 FROM processed_ops WHERE op_id = $1', [bad.opId]);
    expect(recorded.rowCount).toBe(0);

    // the same opId is still usable once the payload is fixed
    const fixed = await push(ctx, { ...bad, payload: jobPayload() });
    expect(fixed.body.status).toBe('applied');
  });

  it('rejects bodies over 100kb and malformed JSON without writing', async () => {
    const opsBefore = await count(ctx, 'processed_ops');
    const huge = createOp({ payload: jobPayload({ attendant: 'x'.repeat(150_000) }) });
    expect((await push(ctx, huge)).status).toBe(413);
    const malformed = await request(ctx.app)
      .post('/api/sync/ops')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"opId": ');
    expect(malformed.status).toBe(400);
    expect(await count(ctx, 'processed_ops')).toBe(opsBefore);
  });
});

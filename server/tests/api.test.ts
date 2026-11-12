import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createPool, migrate } from '../src/db';
import { auth, count, createOp, deleteOp, push, setup, TOKEN, updateOp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('auth', () => {
  it('missing or wrong token -> 401 on every protected route, and nothing is written', async () => {
    const op = createOp();
    expect((await request(ctx.app).post('/api/sync/ops').send(op)).status).toBe(401);
    expect((await request(ctx.app).post('/api/sync/ops').set('Authorization', 'Bearer wrong').send(op)).status).toBe(401);
    expect((await request(ctx.app).post('/api/sync/ops').set('Authorization', TOKEN).send(op)).status).toBe(401);
    expect((await request(ctx.app).get('/api/sync/changes?since=0')).status).toBe(401);
    expect((await request(ctx.app).get('/api/conflicts')).status).toBe(401);
    expect((await request(ctx.app).get('/api/records')).status).toBe(401);
    expect((await request(ctx.app).post('/api/demo/fail-next')).status).toBe(401);
    expect(await count(ctx, 'records')).toBe(0);
    expect(await count(ctx, 'processed_ops')).toBe(0);
  });
});

describe('GET /healthz', () => {
  it('-> 200 with db ok and the revision, no token needed', async () => {
    const res = await request(ctx.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', revision: 'test' });
  });

  it('-> 503 when the database is unreachable', async () => {
    const deadPool = createPool('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = createApp({ pool: deadPool, syncToken: TOKEN, demoMode: false, revision: 'test', log: () => {} });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('unreachable');
    await deadPool.end();
  });
});

describe('GET /api/sync/changes', () => {
  it('returns only changes newer than `since`, including tombstones', async () => {
    const a = createOp();
    const b = createOp();
    await push(ctx, a);
    await push(ctx, b);

    const all = await request(ctx.app).get('/api/sync/changes?since=0').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.records.map((r: { id: string }) => r.id)).toEqual([a.recordId, b.recordId]);
    const checkpoint: number = all.body.latestSeq;
    expect(checkpoint).toBeGreaterThan(0);

    // nothing new yet
    const none = await request(ctx.app).get(`/api/sync/changes?since=${checkpoint}`).set(auth);
    expect(none.body).toEqual({ records: [], latestSeq: checkpoint });

    // an update and a delete bump change_seq; a brand new record appears too
    const c = createOp();
    await push(ctx, updateOp(a.recordId, { status: 'washing' }));
    await push(ctx, c);
    await push(ctx, deleteOp(b.recordId));

    const newer = await request(ctx.app).get(`/api/sync/changes?since=${checkpoint}`).set(auth);
    expect(newer.body.records.map((r: { id: string }) => r.id)).toEqual([a.recordId, c.recordId, b.recordId]);
    expect(newer.body.records[0]).toMatchObject({ status: 'washing', version: 2 });
    expect(newer.body.records[2]).toMatchObject({ deleted: true });
    expect(newer.body.latestSeq).toBeGreaterThan(checkpoint);
  });

  it('rejects a malformed since', async () => {
    expect((await request(ctx.app).get('/api/sync/changes?since=abc').set(auth)).status).toBe(400);
    expect((await request(ctx.app).get('/api/sync/changes?since=-1').set(auth)).status).toBe(400);
  });
});

describe('GET /api/records', () => {
  it('lists all current records', async () => {
    const res = await request(ctx.app).get('/api/records').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(3);
  });
});

describe('demo toggles and migrations', () => {
  it('demo endpoints return 404 when DEMO_MODE is off', async () => {
    const app = createApp({ pool: ctx.pool, syncToken: TOKEN, demoMode: false, revision: 'test', log: () => {} });
    expect((await request(app).post('/api/demo/fail-next').set(auth)).status).toBe(404);
    expect((await request(app).post('/api/demo/drop-ack-next').set(auth)).status).toBe(404);
    expect((await request(app).get('/api/demo/status').set(auth)).status).toBe(404);
  });

  it('migrations are idempotent: running them again changes nothing and keeps data', async () => {
    const before = await count(ctx, 'records');
    expect(await migrate(ctx.pool)).toEqual([]);
    expect(await count(ctx, 'records')).toBe(before);
  });
});

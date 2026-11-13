import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createUser, ensureDemoUsers, DEMO_PIN } from '../src/auth';
import { auth, count, createOp, dbRecord, deleteOp, jobPayload, setup, TOKEN, updateOp, type TestContext } from './helpers';

let ctx: TestContext;
const tokens: Record<string, string> = {};

const loginAs = (name: string, pin: string, deviceId: string) => request(ctx.app).post('/api/auth/login').send({ name, pin, deviceId });
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const pushAs = (who: string, op: object) => request(ctx.app).post('/api/sync/ops').set(as(who)).send(op);

beforeAll(async () => {
  ctx = await setup();
  await ensureDemoUsers(ctx.pool);
  for (const [who, device] of [
    ['Amani', 'phone-amani'],
    ['Chiku', 'phone-chiku'],
    ['Manager', 'phone-manager'],
  ]) {
    tokens[who] = (await loginAs(who, DEMO_PIN, device)).body.token;
  }
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('login and sessions', () => {
  it('right name + PIN -> a session token; the PIN and token are stored only as hashes', async () => {
    const res = await loginAs('amani', DEMO_PIN, 'phone-x');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'Amani', role: 'attendant' });
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    const user = (await ctx.pool.query(`SELECT pin_hash FROM users WHERE name = 'Amani'`)).rows[0];
    expect(user.pin_hash).toMatch(/^scrypt\$/);
    expect(user.pin_hash).not.toContain(DEMO_PIN);
    const stored = await ctx.pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [res.body.token]);
    expect(stored.rowCount).toBe(0);
  });

  it('wrong PIN and unknown name get the same 401', async () => {
    const wrong = await loginAs('Baraka', '0000', 'phone-x');
    const unknown = await loginAs('Nobody', '0000', 'phone-x');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('a session token works on the API; logout ends it', async () => {
    const token = (await loginAs('Baraka', DEMO_PIN, 'phone-b')).body.token;
    const header = { Authorization: `Bearer ${token}` };
    const me = await request(ctx.app).get('/api/auth/me').set(header);
    expect(me.body.user).toMatchObject({ name: 'Baraka', role: 'attendant' });
    expect((await request(ctx.app).post('/api/auth/logout').set(header)).status).toBe(200);
    expect((await request(ctx.app).get('/api/auth/me').set(header)).status).toBe(401);
  });

  it('an expired session is refused', async () => {
    const token = (await loginAs('Baraka', DEMO_PIN, 'phone-b')).body.token;
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE device_id = 'phone-b'`);
    expect((await request(ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('the service token is no longer handed out to browsers', async () => {
    const res = await request(ctx.app).get('/app-config.json');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('roles on sync operations', () => {
  it('an attendant can create a job, and it is always recorded in their own name', async () => {
    const op = createOp({ deviceId: 'phone-amani', payload: jobPayload({ attendant: 'Somebody Else' }) });
    const res = await pushAs('Amani', op);
    expect(res.body.status).toBe('applied');
    expect((await dbRecord(ctx, op.recordId)).data.attendant).toBe('Amani');
  });

  it('an attendant cannot take payment, change the price or delete: rejected, logged, record untouched', async () => {
    const create = createOp({ deviceId: 'phone-amani' });
    await pushAs('Amani', create);
    const conflictsBefore = await count(ctx, 'conflict_log');

    const pay = await pushAs('Amani', updateOp(create.recordId, { status: 'paid', paymentMethod: 'cash' }, { deviceId: 'phone-amani' }));
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe('rejected');
    expect(pay.body.reasons.join(' ')).toMatch(/cashier or manager/);
    expect(pay.body.conflict.fields[0].policy).toBe('forbidden');

    const price = await pushAs('Amani', updateOp(create.recordId, { priceKes: 1 }, { deviceId: 'phone-amani' }));
    expect(price.body.status).toBe('rejected');
    const del = await pushAs('Amani', deleteOp(create.recordId, { deviceId: 'phone-amani' }));
    expect(del.body.status).toBe('rejected');

    const row = await dbRecord(ctx, create.recordId);
    expect(row.data).toMatchObject({ status: 'waiting', priceKes: 300, paymentMethod: null });
    expect(row.deleted).toBe(false);
    expect(await count(ctx, 'conflict_log')).toBe(conflictsBefore + 3);
  });

  it('an attendant can still move a job through washing and done', async () => {
    const create = createOp({ deviceId: 'phone-amani' });
    await pushAs('Amani', create);
    const res = await pushAs('Amani', updateOp(create.recordId, { status: 'washing' }, { deviceId: 'phone-amani' }));
    expect(res.body.status).toBe('applied');
  });

  it('a refused op is still exactly-once: the retry gets the same answer', async () => {
    const create = createOp({ deviceId: 'phone-amani' });
    await pushAs('Amani', create);
    const del = deleteOp(create.recordId, { deviceId: 'phone-amani' });
    const first = await pushAs('Amani', del);
    const again = await pushAs('Amani', del);
    expect(first.body.status).toBe('rejected');
    expect(again.body.status).toBe('duplicate');
    expect((await dbRecord(ctx, create.recordId)).deleted).toBe(false);
  });

  it('a cashier can take payment but cannot delete; a manager can delete', async () => {
    const create = createOp({ deviceId: 'phone-amani' });
    await pushAs('Amani', create);
    const pay = await pushAs('Chiku', updateOp(create.recordId, { status: 'paid', paymentMethod: 'cash' }, { deviceId: 'phone-chiku' }));
    expect(pay.body.status).toBe('applied');
    const del = await pushAs('Chiku', deleteOp(create.recordId, { deviceId: 'phone-chiku', baseVersion: 2 }));
    expect(del.body.status).toBe('rejected');
    const managerDel = await pushAs('Manager', deleteOp(create.recordId, { deviceId: 'phone-manager', baseVersion: 2 }));
    expect(managerDel.body.status).toBe('applied');
    expect((await dbRecord(ctx, create.recordId)).deleted).toBe(true);
  });

  it('a session only works for the device it was opened on', async () => {
    const op = createOp({ deviceId: 'some-other-phone' });
    const res = await pushAs('Amani', op);
    expect(res.body.status).toBe('rejected');
    expect(await dbRecord(ctx, op.recordId)).toBeUndefined();
  });
});

describe('manager-only endpoints', () => {
  it('attendants and cashiers get 403 on users, audit and demo toggles', async () => {
    for (const who of ['Amani', 'Chiku']) {
      expect((await request(ctx.app).get('/api/users').set(as(who))).status).toBe(403);
      expect((await request(ctx.app).post('/api/users').set(as(who)).send({ name: 'X', role: 'manager', pin: '1111' })).status).toBe(403);
      expect((await request(ctx.app).get('/api/audit').set(as(who))).status).toBe(403);
      expect((await request(ctx.app).post('/api/demo/fail-next').set(as(who))).status).toBe(403);
    }
  });

  it('a manager can add a user, and never sees PIN hashes', async () => {
    const created = await request(ctx.app).post('/api/users').set(as('Manager')).send({ name: 'Daudi', role: 'attendant', pin: '13579' });
    expect(created.status).toBe(201);
    expect((await loginAs('Daudi', '13579', 'phone-d')).status).toBe(200);
    const dup = await request(ctx.app).post('/api/users').set(as('Manager')).send({ name: 'daudi', role: 'cashier', pin: '1111' });
    expect(dup.status).toBe(409);
    const weak = await request(ctx.app).post('/api/users').set(as('Manager')).send({ name: 'Eve', role: 'cashier', pin: '12' });
    expect(weak.status).toBe(400);
    const list = await request(ctx.app).get('/api/users').set(as('Manager'));
    expect(JSON.stringify(list.body)).not.toMatch(/scrypt|pin/i);
  });

  it('deactivating a user ends their sessions at once', async () => {
    const user = await createUser(ctx.pool, 'Faraji', 'attendant', '4321');
    const token = (await loginAs('Faraji', '4321', 'phone-f')).body.token;
    const off = await request(ctx.app).patch(`/api/users/${user!.id}`).set(as('Manager')).send({ active: false });
    expect(off.status).toBe(200);
    expect((await request(ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await loginAs('Faraji', '4321', 'phone-f')).status).toBe(401);
  });

  it('the last active manager cannot be demoted or deactivated', async () => {
    const users = (await request(ctx.app).get('/api/users').set(auth)).body.users;
    const manager = users.find((u: { name: string }) => u.name === 'Manager');
    const res = await request(ctx.app).patch(`/api/users/${manager.id}`).set(auth).send({ role: 'cashier' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('last_manager');
  });

  it('the audit log records who did what, including refused ops and failed logins', async () => {
    const entries = (await request(ctx.app).get('/api/audit').set(as('Manager'))).body.entries;
    const has = (m: object) => entries.some((e: object) => Object.entries(m).every(([k, v]) => (e as Record<string, unknown>)[k] === v));
    expect(has({ userName: 'Amani', action: 'job.create', outcome: 'applied' })).toBe(true);
    expect(has({ userName: 'Amani', action: 'job.delete', outcome: 'rejected' })).toBe(true);
    expect(has({ userName: 'Chiku', action: 'job.update', outcome: 'applied' })).toBe(true);
    expect(has({ action: 'auth.login', outcome: 'failed' })).toBe(true);
    expect(has({ action: 'user.create', outcome: 'ok' })).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('13579');
  });
});

describe('rate limits and headers', () => {
  it('a name is locked after repeated wrong PINs, even for the right PIN', async () => {
    const app = createApp({ pool: ctx.pool, syncToken: TOKEN, demoMode: false, revision: 'test', clientDist: '/nonexistent', log: () => {}, limits: { loginFailures: 3 } });
    const attempt = (pin: string) => request(app).post('/api/auth/login').send({ name: 'Chiku', pin, deviceId: 'phone-z' });
    for (let i = 0; i < 3; i++) expect((await attempt('0000')).status).toBe(401);
    const locked = await attempt(DEMO_PIN);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('too many requests from one address -> 429 with Retry-After', async () => {
    const app = createApp({ pool: ctx.pool, syncToken: TOKEN, demoMode: false, revision: 'test', clientDist: '/nonexistent', log: () => {}, limits: { apiPerMinute: 5 } });
    for (let i = 0; i < 5; i++) expect((await request(app).get('/api/conflicts').set(auth)).status).toBe(200);
    const res = await request(app).get('/api/conflicts').set(auth);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeDefined();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  it('every response carries the security headers; HSTS only when enabled', async () => {
    const res = await request(ctx.app).get('/healthz');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
    const prod = createApp({ pool: ctx.pool, syncToken: TOKEN, demoMode: false, revision: 'test', clientDist: '/nonexistent', log: () => {}, hsts: true });
    expect((await request(prod).get('/healthz')).headers['strict-transport-security']).toContain('max-age');
  });

  it('login options list demo accounts only in demo mode', async () => {
    expect((await request(ctx.app).get('/api/auth/options')).body.demoAccounts).toHaveLength(4);
    const prod = createApp({ pool: ctx.pool, syncToken: TOKEN, demoMode: false, revision: 'test', clientDist: '/nonexistent', log: () => {} });
    expect((await request(prod).get('/api/auth/options')).body).toEqual({ demoMode: false, demoAccounts: [], demoPin: null });
  });
});

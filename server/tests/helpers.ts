import { randomUUID } from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app';
import { DEV_TEST_DATABASE_URL } from '../src/config';
import { createPool, migrate, type Pool } from '../src/db';

// Pick up TEST_DATABASE_URL from the repo-root .env, if there is one (real env vars win).
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  /* no .env - use the docker-compose test database */
}

export const TOKEN = 'test-token';
export const auth = { Authorization: `Bearer ${TOKEN}` };

export interface TestContext {
  pool: Pool;
  app: ReturnType<typeof createApp>;
  logs: string[];
}

/** Fresh schema + migrated tables + app, against the real test Postgres. Call once per test file. */
export async function setup(demoMode = true): Promise<TestContext> {
  const pool = createPool(process.env.TEST_DATABASE_URL || DEV_TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const logs: string[] = [];
  const app = createApp({
    pool,
    syncToken: TOKEN,
    demoMode,
    revision: 'test',
    clientDist: '/nonexistent',
    limits: { loginPerMinute: 1000 }, // the suites log in far more often than a person would
    log: (line) => logs.push(line),
  });
  return { pool, app, logs };
}

export const T0 = '2026-01-10T08:00:00.000Z';
export const T1 = '2026-01-10T08:05:00.000Z';
export const T2 = '2026-01-10T08:10:00.000Z';
export const T3 = '2026-01-10T08:15:00.000Z';

let seq = 0;

export function jobPayload(overrides: Record<string, unknown> = {}) {
  return {
    plate: 'KDA 123A',
    vehicleType: 'saloon',
    service: 'body',
    priceKes: 300,
    paymentMethod: null,
    attendant: 'Attendant 1',
    status: 'waiting',
    waterLitres: 40,
    createdAt: T0,
    ...overrides,
  };
}

export function createOp(overrides: Record<string, unknown> = {}) {
  return {
    opId: randomUUID(),
    seq: ++seq,
    deviceId: 'device-A',
    recordType: 'job',
    recordId: randomUUID(),
    type: 'create',
    payload: jobPayload(),
    baseVersion: null,
    clientTimestamp: T0,
    ...overrides,
  };
}

export function updateOp(recordId: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return createOp({ recordId, type: 'update', payload, baseVersion: 1, clientTimestamp: T1, ...overrides });
}

export function deleteOp(recordId: string, overrides: Record<string, unknown> = {}) {
  return createOp({ recordId, type: 'delete', payload: {}, baseVersion: 1, clientTimestamp: T1, ...overrides });
}

export const push = (ctx: TestContext, op: object) => request(ctx.app).post('/api/sync/ops').set(auth).send(op);

export async function count(ctx: TestContext, table: 'records' | 'processed_ops' | 'conflict_log'): Promise<number> {
  return Number((await ctx.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}

export async function dbRecord(ctx: TestContext, id: string) {
  return (await ctx.pool.query('SELECT * FROM records WHERE id = $1', [id])).rows[0];
}

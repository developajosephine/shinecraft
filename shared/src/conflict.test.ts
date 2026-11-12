import { describe, expect, it } from 'vitest';
import { compareLww, parseOp, resolveLww } from './index';

const T1 = '2026-01-10T08:00:00.000Z';
const T2 = '2026-01-10T08:05:00.000Z';

describe('resolveLww', () => {
  const server = {
    data: { plate: 'KDA 123A', status: 'washing', priceKes: 300 },
    updatedAt: T1,
    updatedBy: 'device-A',
  };

  it('later timestamp wins (incoming later)', () => {
    const r = resolveLww(server, { payload: { priceKes: 500 }, clientTimestamp: T2, deviceId: 'device-B' });
    expect(r.winner).toBe('incoming');
    expect(r.winningDevice).toBe('device-B');
    expect(r.rejectedDevice).toBe('device-A');
    expect(r.merged.priceKes).toBe(500);
    expect(r.changed).toBe(true);
  });

  it('later timestamp wins (server later)', () => {
    const r = resolveLww(
      { ...server, updatedAt: T2 },
      { payload: { priceKes: 500 }, clientTimestamp: T1, deviceId: 'device-B' },
    );
    expect(r.winner).toBe('server');
    expect(r.winningDevice).toBe('device-A');
    expect(r.merged.priceKes).toBe(300);
    expect(r.changed).toBe(false);
  });

  it('equal timestamps: greater deviceId wins, regardless of argument order', () => {
    const a = { timestamp: T1, deviceId: 'device-A' };
    const b = { timestamp: T1, deviceId: 'device-B' };
    expect(compareLww(a, b)).toBeLessThan(0);
    expect(compareLww(b, a)).toBeGreaterThan(0);

    // B arrives second against A's write -> B wins
    const bSecond = resolveLww(server, { payload: { priceKes: 500 }, clientTimestamp: T1, deviceId: 'device-B' });
    // A arrives second against B's write -> B still wins
    const aSecond = resolveLww(
      { data: { ...server.data, priceKes: 500 }, updatedAt: T1, updatedBy: 'device-B' },
      { payload: { priceKes: 300 }, clientTimestamp: T1, deviceId: 'device-A' },
    );
    expect(bSecond.winningDevice).toBe('device-B');
    expect(aSecond.winningDevice).toBe('device-B');
    expect(bSecond.merged.priceKes).toBe(500);
    expect(aSecond.merged.priceKes).toBe(500);
  });

  it('returns per-field winning and rejected values, flagging money fields', () => {
    const r = resolveLww(server, {
      payload: { priceKes: 500, status: 'paid', plate: 'KDA 123A' },
      clientTimestamp: T2,
      deviceId: 'device-B',
    });
    // plate is unchanged, so it is not a conflict
    expect(r.fields).toEqual([
      { field: 'priceKes', winningValue: 500, rejectedValue: 300, policy: 'lww-flag-money' },
      { field: 'status', winningValue: 'paid', rejectedValue: 'washing', policy: 'lww' },
    ]);
  });

  it('when the server wins, the incoming values are the rejected ones', () => {
    const r = resolveLww(
      { ...server, updatedAt: T2 },
      { payload: { status: 'paid' }, clientTimestamp: T1, deviceId: 'device-B' },
    );
    expect(r.fields).toEqual([{ field: 'status', winningValue: 'washing', rejectedValue: 'paid', policy: 'lww' }]);
  });
});

describe('parseOp', () => {
  const base = {
    opId: '11111111-1111-4111-8111-111111111111',
    seq: 1,
    deviceId: 'device-A',
    recordType: 'job',
    recordId: '22222222-2222-4222-8222-222222222222',
    type: 'update',
    payload: { plate: ' kda 123a ' },
    baseVersion: 1,
    clientTimestamp: T1,
  };

  it('normalises plates', () => {
    const r = parseOp(base);
    expect(r.success && r.data.payload.plate).toBe('KDA 123A');
  });

  it('rejects unknown fields, bad enums and negative prices with reasons', () => {
    const r = parseOp({ ...base, payload: { priceKes: -5, status: 'stolen', hack: true } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('requires every field on create', () => {
    expect(parseOp({ ...base, type: 'create', baseVersion: null }).success).toBe(false);
  });
});

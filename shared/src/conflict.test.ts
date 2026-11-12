import { describe, expect, it } from 'vitest';
import { compareLww, parseOp, resolveLww } from './index';

const T1 = '2026-01-10T08:00:00.000Z';
const T2 = '2026-01-10T08:05:00.000Z';
const T3 = '2026-01-10T08:10:00.000Z';

describe('resolveLww', () => {
  // Record created by device-C at T1; nobody has touched it since.
  const server = {
    data: { plate: 'KDA 123A', status: 'washing', priceKes: 300 },
    updatedAt: T1,
    updatedBy: 'device-C',
  };

  it('later timestamp wins (incoming later)', () => {
    const r = resolveLww(server, { payload: { priceKes: 500 }, clientTimestamp: T2, deviceId: 'device-B' });
    expect(r.winner).toBe('incoming');
    expect(r.fields[0]).toMatchObject({ winningDevice: 'device-B', rejectedDevice: 'device-C' });
    expect(r.merged.priceKes).toBe(500);
    expect(r.accepted).toEqual(['priceKes']);
  });

  it('later timestamp wins (server later)', () => {
    const r = resolveLww(
      { ...server, updatedAt: T2 },
      { payload: { priceKes: 500 }, clientTimestamp: T1, deviceId: 'device-B' },
    );
    expect(r.winner).toBe('server');
    expect(r.fields[0]).toMatchObject({ winningDevice: 'device-C', rejectedDevice: 'device-B' });
    expect(r.merged.priceKes).toBe(300);
    expect(r.accepted).toEqual([]);
  });

  it('equal timestamps: greater deviceId wins, regardless of argument order', () => {
    const a = { timestamp: T1, deviceId: 'device-A' };
    const b = { timestamp: T1, deviceId: 'device-B' };
    expect(compareLww(a, b)).toBeLessThan(0);
    expect(compareLww(b, a)).toBeGreaterThan(0);
    expect(compareLww(a, a)).toBe(0);

    // B arrives second against A's write -> B wins
    const bSecond = resolveLww(
      { ...server, updatedBy: 'device-A' },
      { payload: { priceKes: 500 }, clientTimestamp: T1, deviceId: 'device-B' },
    );
    // A arrives second against B's write -> B still wins
    const aSecond = resolveLww(
      { data: { ...server.data, priceKes: 500 }, updatedAt: T1, updatedBy: 'device-B' },
      { payload: { priceKes: 300 }, clientTimestamp: T1, deviceId: 'device-A' },
    );
    expect(bSecond.fields[0].winningDevice).toBe('device-B');
    expect(aSecond.fields[0].winningDevice).toBe('device-B');
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
      {
        field: 'priceKes',
        winningValue: 500,
        rejectedValue: 300,
        winningDevice: 'device-B',
        rejectedDevice: 'device-C',
        policy: 'lww-flag-money',
      },
      {
        field: 'status',
        winningValue: 'paid',
        rejectedValue: 'washing',
        winningDevice: 'device-B',
        rejectedDevice: 'device-C',
        policy: 'lww',
      },
    ]);
  });

  it('decides each field against the stamp of whoever last wrote THAT field', () => {
    // A wrote status late (T3); the price was last written long ago (T1).
    const r = resolveLww(
      {
        ...server,
        updatedAt: T3,
        updatedBy: 'device-A',
        fieldStamps: {
          status: { timestamp: T3, deviceId: 'device-A' },
          priceKes: { timestamp: T1, deviceId: 'device-C' },
        },
      },
      { payload: { status: 'done', priceKes: 500 }, clientTimestamp: T2, deviceId: 'device-B' },
    );
    expect(r.winner).toBe('mixed');
    expect(r.merged).toMatchObject({ status: 'washing', priceKes: 500 }); // B loses status, wins price
    expect(r.accepted).toEqual(['priceKes']);
    expect(r.fields.map((f) => [f.field, f.winningDevice, f.rejectedValue])).toEqual([
      ['priceKes', 'device-B', 300],
      ['status', 'device-A', 'done'],
    ]);
  });

  it("a device never conflicts with its own earlier write", () => {
    const r = resolveLww(
      { ...server, updatedBy: 'device-B', updatedAt: T2 },
      { payload: { status: 'done' }, clientTimestamp: T2, deviceId: 'device-B' },
    );
    expect(r.fields).toEqual([]);
    expect(r.accepted).toEqual(['status']);
    expect(r.merged.status).toBe('done');
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

import { MONEY_FIELDS, type ConflictInfo, type ConflictPolicy, type FieldConflict } from './types';

export interface LwwStamp {
  timestamp: string; // ISO string from the writing device's clock
  deviceId: string;
}

function millis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Total order over writes: later timestamp wins; on an exact tie the
 * lexicographically greater deviceId wins. Returns > 0 when `a` beats `b`,
 * < 0 when `b` beats `a`, 0 only when both stamps are identical.
 * compareLww(a, b) === -compareLww(b, a), so the winner never depends on argument order.
 */
export function compareLww(a: LwwStamp, b: LwwStamp): number {
  const dt = millis(a.timestamp) - millis(b.timestamp);
  if (dt !== 0) return dt;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId > b.deviceId ? 1 : -1;
}

/** Same value for conflict purposes? (undefined and null are both "empty".) */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function policyForField(field: string): ConflictPolicy {
  return MONEY_FIELDS.includes(field) ? 'lww-flag-money' : 'lww';
}

export interface LwwServerSide {
  data: Record<string, unknown>; // current server field values
  updatedAt: string;
  updatedBy: string;
}

export interface LwwIncoming {
  payload: Record<string, unknown>; // fields the stale op wants to change
  clientTimestamp: string;
  deviceId: string;
}

export interface LwwResult extends ConflictInfo {
  /** Field values after resolution (server data, plus the payload if incoming won). */
  merged: Record<string, unknown>;
  /** True when the server record must be rewritten (incoming won and something differs). */
  changed: boolean;
}

/**
 * Last-writer-wins resolution for an update made on a stale baseVersion.
 * The whole op wins or loses on (clientTimestamp, deviceId); every payload field
 * whose value differs from the server's is reported with its winning and rejected value.
 */
export function resolveLww(server: LwwServerSide, incoming: LwwIncoming): LwwResult {
  const incomingWins =
    compareLww(
      { timestamp: incoming.clientTimestamp, deviceId: incoming.deviceId },
      { timestamp: server.updatedAt, deviceId: server.updatedBy },
    ) >= 0;

  const fields: FieldConflict[] = [];
  for (const field of Object.keys(incoming.payload).sort()) {
    const theirs = incoming.payload[field];
    const ours = server.data[field];
    if (sameValue(theirs, ours)) continue;
    fields.push({
      field,
      winningValue: (incomingWins ? theirs : ours) ?? null,
      rejectedValue: (incomingWins ? ours : theirs) ?? null,
      policy: policyForField(field),
    });
  }

  return {
    winner: incomingWins ? 'incoming' : 'server',
    winningDevice: incomingWins ? incoming.deviceId : server.updatedBy,
    rejectedDevice: incomingWins ? server.updatedBy : incoming.deviceId,
    fields,
    merged: incomingWins ? { ...server.data, ...incoming.payload } : { ...server.data },
    changed: incomingWins && fields.length > 0,
  };
}

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

/** Who last wrote one field, and when (by their clock). */
export type FieldStamps = Record<string, LwwStamp>;

export interface LwwServerSide {
  data: Record<string, unknown>; // current server field values
  updatedAt: string; // fallback stamp for fields that have none
  updatedBy: string;
  fieldStamps?: FieldStamps;
}

export interface LwwIncoming {
  payload: Record<string, unknown>; // fields the stale op wants to change
  clientTimestamp: string;
  deviceId: string;
}

export interface LwwResult extends ConflictInfo {
  /** Field values after resolution. */
  merged: Record<string, unknown>;
  /** Payload fields that were accepted and must be written (and re-stamped). */
  accepted: string[];
}

/**
 * Last-writer-wins resolution for an update made on a stale baseVersion, decided per field.
 * For each payload field whose value differs from the server's, the op's
 * (clientTimestamp, deviceId) is compared with the stamp of whoever last wrote that field:
 * later timestamp wins, tie -> greater deviceId. Each such field is reported with its
 * winning and rejected value and both devices. Fields this device itself wrote last are
 * simply applied (a phone cannot conflict with its own earlier edit).
 */
export function resolveLww(server: LwwServerSide, incoming: LwwIncoming): LwwResult {
  const theirStamp: LwwStamp = { timestamp: incoming.clientTimestamp, deviceId: incoming.deviceId };
  const fields: FieldConflict[] = [];
  const accepted: string[] = [];
  const merged = { ...server.data };

  for (const field of Object.keys(incoming.payload).sort()) {
    const theirs = incoming.payload[field];
    const ours = server.data[field];
    if (sameValue(theirs, ours)) continue;

    const ourStamp = server.fieldStamps?.[field] ?? { timestamp: server.updatedAt, deviceId: server.updatedBy };
    const ownField = ourStamp.deviceId === incoming.deviceId;
    const incomingWins = ownField || compareLww(theirStamp, ourStamp) > 0;
    if (incomingWins) {
      merged[field] = theirs;
      accepted.push(field);
    }
    if (ownField) continue;
    fields.push({
      field,
      winningValue: (incomingWins ? theirs : ours) ?? null,
      rejectedValue: (incomingWins ? ours : theirs) ?? null,
      winningDevice: incomingWins ? incoming.deviceId : ourStamp.deviceId,
      rejectedDevice: incomingWins ? ourStamp.deviceId : incoming.deviceId,
      policy: policyForField(field),
    });
  }

  const won = fields.filter((f) => f.winningDevice === incoming.deviceId).length;
  return {
    winner: won === 0 ? 'server' : won === fields.length ? 'incoming' : 'mixed',
    fields,
    merged,
    accepted,
  };
}

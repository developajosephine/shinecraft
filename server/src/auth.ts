import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Role, Session, User } from '@washlog/shared';
import type pg from 'pg';
import type { Pool } from './db';

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_DAYS = 30; // long, because phones may be offline for days

/** Who is making a request: a logged-in user, or the operator's service token. */
export interface Actor {
  kind: 'user' | 'service';
  userId: string | null;
  name: string;
  role: Role;
  deviceId: string | null;
}

export const SERVICE_ACTOR: Actor = { kind: 'service', userId: null, name: 'service', role: 'manager', deviceId: null };

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// Verified against when the user does not exist, so a wrong name costs the same time as a wrong PIN.
const DUMMY_HASH = hashPin(crypto.randomBytes(8).toString('hex'));

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function constantTimeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

interface UserRow {
  id: string;
  name: string;
  role: Role;
  pin_hash: string;
  active: boolean;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({ id: r.id, name: r.name, role: r.role, active: r.active, createdAt: r.created_at.toISOString() });

const END_SESSIONS_FOR_USER = 'DELETE FROM sessions WHERE user_id = $1';
const END_SESSION = 'DELETE FROM sessions WHERE token_hash = $1';

/** Check name + PIN and open a session for this device. Null when the credentials are wrong. */
export async function login(pool: Pool, name: string, pin: string, deviceId: string): Promise<Session | null> {
  const found = await pool.query<UserRow>('SELECT * FROM users WHERE lower(name) = lower($1)', [name.trim()]);
  const user = found.rows[0];
  const ok = await verifyPin(pin, user?.pin_hash ?? (await DUMMY_HASH));
  if (!user || !user.active || !ok) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query('INSERT INTO sessions (token_hash, user_id, device_id, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(token),
    user.id,
    deviceId,
    expiresAt,
  ]);
  return { token, expiresAt: expiresAt.toISOString(), user: { id: user.id, name: user.name, role: user.role } };
}

/** The user behind a session token, or null if it is unknown, expired, or the user was deactivated. */
export async function resolveSession(pool: Pool, token: string): Promise<Actor | null> {
  const found = await pool.query<{ id: string; name: string; role: Role; device_id: string }>(
    `SELECT u.id, u.name, u.role, s.device_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  const row = found.rows[0];
  return row ? { kind: 'user', userId: row.id, name: row.name, role: row.role, deviceId: row.device_id } : null;
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query(END_SESSION, [sha256(token)]);
}

export async function listUsers(pool: Pool): Promise<User[]> {
  return (await pool.query<UserRow>('SELECT * FROM users ORDER BY lower(name)')).rows.map(toUser);
}

/** Null when the name is already taken. */
export async function createUser(pool: Pool, name: string, role: Role, pin: string): Promise<User | null> {
  const created = await pool.query<UserRow>(
    `INSERT INTO users (id, name, role, pin_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(name)) DO NOTHING RETURNING *`,
    [crypto.randomUUID(), name.trim(), role, await hashPin(pin)],
  );
  return created.rows[0] ? toUser(created.rows[0]) : null;
}

export type UpdateUserResult = { user: User } | { error: 'not_found' | 'last_manager' };

/** Change role, active flag or PIN. Refuses to remove the last active manager. */
export async function updateUser(
  pool: Pool,
  id: string,
  changes: { role?: Role; active?: boolean; pin?: string },
): Promise<UpdateUserResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const user = found.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return { error: 'not_found' };
    }
    const role = changes.role ?? user.role;
    const active = changes.active ?? user.active;
    if (user.role === 'manager' && user.active && (role !== 'manager' || !active)) {
      const others = await client.query(`SELECT 1 FROM users WHERE role = 'manager' AND active AND id <> $1 LIMIT 1`, [id]);
      if (others.rowCount === 0) {
        await client.query('ROLLBACK');
        return { error: 'last_manager' };
      }
    }
    const pinHash = changes.pin ? await hashPin(changes.pin) : user.pin_hash;
    const updated = await client.query<UserRow>('UPDATE users SET role = $2, active = $3, pin_hash = $4 WHERE id = $1 RETURNING *', [
      id,
      role,
      active,
      pinHash,
    ]);
    // A new PIN, a new role or deactivation ends every existing session for that user.
    if (changes.pin || role !== user.role || !active) await client.query(END_SESSIONS_FOR_USER, [id]);
    await client.query('COMMIT');
    return { user: toUser(updated.rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Create the user if the name is free; never changes an existing account. */
export async function ensureUser(pool: Pool, name: string, role: Role, pin: string): Promise<boolean> {
  return (await createUser(pool, name, role, pin)) !== null;
}

export interface AuditEntry {
  action: string;
  outcome: string;
  recordId?: string | null;
  detail?: unknown;
}

type Queryable = Pick<pg.PoolClient, 'query'> | Pool;

export async function writeAudit(
  db: Queryable,
  actor: { userId: string | null; name: string; role: string; deviceId: string | null },
  entry: AuditEntry,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, user_name, role, device_id, action, record_id, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [actor.userId, actor.name, actor.role, actor.deviceId, entry.action, entry.recordId ?? null, entry.outcome, JSON.stringify(entry.detail ?? null)],
  );
}

export async function recentAudit(pool: Pool, limit = 200) {
  const res = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
  return res.rows.map((r) => ({
    id: Number(r.id),
    at: r.at.toISOString(),
    userName: r.user_name,
    role: r.role,
    deviceId: r.device_id,
    action: r.action,
    recordId: r.record_id,
    outcome: r.outcome,
    detail: r.detail,
  }));
}

/** Synthetic accounts for demos and local development. Only created when DEMO_MODE is on. */
export const DEMO_PIN = '2468';
export const DEMO_USERS: { name: string; role: Role }[] = [
  { name: 'Amani', role: 'attendant' },
  { name: 'Baraka', role: 'attendant' },
  { name: 'Chiku', role: 'cashier' },
  { name: 'Manager', role: 'manager' },
];

export async function ensureDemoUsers(pool: Pool): Promise<number> {
  let created = 0;
  for (const u of DEMO_USERS) if (await ensureUser(pool, u.name, u.role, DEMO_PIN)) created++;
  return created;
}

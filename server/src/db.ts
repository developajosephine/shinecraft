import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR } from './config';

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** "host:port/database" — never includes the password. */
function target(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch {
    return 'the configured DATABASE_URL';
  }
}

/** Plain-language help for the usual "database is not there" failures, or null for anything else. */
export function explainDbError(err: unknown, connectionString: string): string | null {
  const code = (err as { code?: string } | null)?.code;
  const where = target(connectionString);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
    return [
      `Cannot reach PostgreSQL at ${where} - no database is running there.`,
      '',
      'Fix it one of two ways:',
      '  - With Docker: start Docker Desktop, then run "npm run setup" (or "docker compose up -d").',
      '  - With your own PostgreSQL: create a .env file in the project root containing',
      '      DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/washlog',
      '    (see .env.example), then run the command again.',
    ].join('\n');
  }
  if (code === '28P01' || code === '28000') {
    return `PostgreSQL at ${where} rejected the username or password. Check DATABASE_URL in the .env file in the project root.`;
  }
  if (code === '3D000') {
    return `PostgreSQL is running, but the database in ${where} does not exist. Create it (CREATE DATABASE ...) or fix DATABASE_URL in .env.`;
  }
  return null;
}

const MIGRATION_LOCK = 727000;

/** Apply every .sql file in server/migrations once, in name order. Safe to call on every startup. */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    // Two instances starting together must not race each other.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

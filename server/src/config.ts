import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** server/src and server/dist are both one level below server/. */
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');
export const CLIENT_DIST = path.resolve(here, '../../client/dist');

export const DEV_DATABASE_URL = 'postgres://washlog:washlog@localhost:5433/washlog';
export const DEV_TEST_DATABASE_URL = 'postgres://washlog:washlog@localhost:5434/washlog_test';
export const DEV_SYNC_TOKEN = 'dev-token';

export interface Config {
  port: number;
  databaseUrl: string;
  syncToken: string;
  demoMode: boolean;
  revision: string;
}

export function loadConfig(): Config {
  // Optional repo-root .env for local development. Real env vars take precedence.
  try {
    process.loadEnvFile(path.resolve(here, '../../.env'));
  } catch {
    /* no .env file — fine */
  }

  const production = process.env.NODE_ENV === 'production';
  const databaseUrl = process.env.DATABASE_URL || (production ? '' : DEV_DATABASE_URL);
  const syncToken = process.env.SYNC_TOKEN || (production ? '' : DEV_SYNC_TOKEN);
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!syncToken) throw new Error('SYNC_TOKEN is required');

  return {
    port: Number(process.env.PORT) || 8080,
    databaseUrl,
    syncToken,
    // Demo toggles must be switched on explicitly in production.
    demoMode: process.env.DEMO_MODE ? process.env.DEMO_MODE === 'true' : !production,
    revision: process.env.GIT_SHA || 'dev',
  };
}

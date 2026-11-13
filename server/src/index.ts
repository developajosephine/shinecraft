import { createApp } from './app';
import { ensureDemoUsers, ensureUser } from './auth';
import { loadConfig } from './config';
import { createPool, explainDbError, migrate } from './db';
import { seedDemoData } from './seedData';

let databaseUrl = '';

async function main() {
  const config = loadConfig();
  databaseUrl = config.databaseUrl;
  const pool = createPool(config.databaseUrl);
  pool.on('error', (err) => console.error(JSON.stringify({ event: 'pg_pool_error', message: err.message })));

  const applied = await migrate(pool);
  console.log(JSON.stringify({ event: 'migrated', applied }));

  if (config.seedOnStart) {
    console.log(JSON.stringify({ event: 'seeded', result: await seedDemoData(pool) }));
  }

  // Accounts: synthetic demo users in demo mode, and/or a first manager from the environment.
  if (config.demoMode) console.log(JSON.stringify({ event: 'demo_users', created: await ensureDemoUsers(pool) }));
  if (config.adminName && config.adminPin) {
    if (!/^\d{4,8}$/.test(config.adminPin)) throw new Error('ADMIN_PIN must be 4 to 8 digits');
    const created = await ensureUser(pool, config.adminName, 'manager', config.adminPin);
    console.log(JSON.stringify({ event: 'admin_user', name: config.adminName, created }));
  }

  const app = createApp({ pool, ...config });
  const server = app.listen(config.port, () => {
    console.log(
      JSON.stringify({ event: 'listening', port: config.port, revision: config.revision, demoMode: config.demoMode }),
    );
  });

  const shutdown = () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  const help = explainDbError(err, databaseUrl);
  if (help) console.error(`\n${help}\n`);
  console.error(JSON.stringify({ event: 'fatal', message: (err instanceof Error && err.message) || String(err) }));
  process.exit(1);
});

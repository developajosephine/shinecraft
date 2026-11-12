import { createApp } from './app';
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

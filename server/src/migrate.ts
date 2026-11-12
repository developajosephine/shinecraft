import { loadConfig } from './config';
import { createPool, migrate } from './db';

const pool = createPool(loadConfig().databaseUrl);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Migrations already up to date');
} finally {
  await pool.end();
}

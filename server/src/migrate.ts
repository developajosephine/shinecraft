import { loadConfig } from './config';
import { createPool, explainDbError, migrate } from './db';

const { databaseUrl } = loadConfig();
const pool = createPool(databaseUrl);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Migrations already up to date');
} catch (err) {
  const help = explainDbError(err, databaseUrl);
  if (!help) throw err;
  console.error(`\n${help}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

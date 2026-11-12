// npm run seed - load the synthetic demo data (see src/seedData.ts). Safe to re-run.
import { loadConfig } from './src/config';
import { createPool, explainDbError, migrate } from './src/db';
import { seedDemoData } from './src/seedData';

const { databaseUrl } = loadConfig();
const pool = createPool(databaseUrl);
try {
  await migrate(pool);
  const tally = await seedDemoData(pool);
  console.log('Seeded synthetic demo data (25 jobs, 5 supplies, 3 attendants):', tally);
} catch (err) {
  const help = explainDbError(err, databaseUrl);
  if (!help) throw err;
  console.error(`\n${help}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

// One-command setup: npm run setup
// Checks the tools, starts the databases (Docker, unless .env points at your own PostgreSQL),
// runs migrations and loads the synthetic demo data. Safe to run again at any time.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

const run = (command) => spawnSync(command, { shell: true, stdio: 'inherit' }).status === 0;
const works = (command) => spawnSync(command, { shell: true, stdio: 'ignore' }).status === 0;
const step = (text) => console.log(`\n==> ${text}`);
const stop = (lines) => {
  console.error(`\nSetup stopped:\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
  process.exit(1);
};

const OWN_POSTGRES_HELP = [
  'To use your own PostgreSQL instead of Docker:',
  '  1. Create two databases: washlog and washlog_test',
  '  2. Copy .env.example to .env (in this folder) and set',
  '       DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/washlog',
  '       TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/washlog_test',
  '  3. Run "npm run setup" again',
];

step('Checking Node.js');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  stop([`Node.js 20.12 or newer is required; you have ${process.version}.`, 'Install the current LTS from https://nodejs.org']);
}
console.log(`Node.js ${process.version} - ok`);

if (!existsSync('node_modules')) {
  step('Installing dependencies (npm install)');
  if (!run('npm install')) stop(['npm install failed. Check your internet connection and try again.']);
}

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env - use the Docker defaults */
}

if (process.env.DATABASE_URL) {
  step('Database: using DATABASE_URL from .env (Docker not needed)');
} else {
  step('Database: starting PostgreSQL with Docker');
  if (!works('docker --version')) {
    stop(['Docker is not installed.', 'Install Docker Desktop from https://www.docker.com/products/docker-desktop', '', ...OWN_POSTGRES_HELP]);
  }
  if (!works('docker info')) {
    stop(['Docker is installed but not running.', 'Start Docker Desktop, wait until it says it is running, then run "npm run setup" again.', '', ...OWN_POSTGRES_HELP]);
  }
  if (!run('docker compose up -d --wait')) {
    stop(['"docker compose up -d --wait" failed (see the output above).', 'If port 5433 or 5434 is already in use, stop whatever is using it and try again.']);
  }
}

step('Creating tables (npm run migrate)');
if (!run('npm run migrate')) stop(['Migration failed - see the message above.']);

step('Loading synthetic demo data (npm run seed)');
if (!run('npm run seed')) stop(['Seeding failed - see the message above.']);

console.log(`
Setup complete.

  npm run dev      start the app, then open http://localhost:5173
  npm test         run all tests
`);

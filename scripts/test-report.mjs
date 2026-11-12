// Runs the full test suite and writes the output to docs/test-results.txt.
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const run = spawnSync('npm', ['test'], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
  shell: process.platform === 'win32',
});

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}

const header = [
  'WashLog test results',
  `Generated: ${new Date().toISOString()}`,
  `Commit:    ${commit}`,
  `Node:      ${process.version}`,
  `Command:   npm test`,
  `Exit code: ${run.status}`,
  '='.repeat(72),
  '',
].join('\n');

mkdirSync('docs', { recursive: true });
writeFileSync('docs/test-results.txt', header + (run.stdout ?? '') + (run.stderr ?? ''));
process.stdout.write((run.stdout ?? '') + (run.stderr ?? ''));
console.log(`\nWrote docs/test-results.txt (exit code ${run.status})`);
process.exit(run.status ?? 1);

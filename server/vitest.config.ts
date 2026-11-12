import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every test file resets the same Postgres schema, so files must not run in parallel.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});

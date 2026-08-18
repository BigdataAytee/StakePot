import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests share one database; running files in parallel would let
    // one suite's cleanup truncate another's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Property runs are wide; the invariant suite is the gate on the money path.
    testTimeout: 60_000,
  },
});

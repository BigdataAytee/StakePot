import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. `e2e/` is Playwright's, and the two runners fight over
    // `*.spec.ts` if vitest is allowed to see it.
    include: ['src/**/*.{test,spec}.ts?(x)'],
    environment: 'node',
    passWithNoTests: true,
  },
});

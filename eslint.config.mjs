import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/api/prisma/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The money path. `any` erases the Decimal guarantees the ledger depends on,
    // so it is an error here rather than a warning (Phase 0 constraint).
    files: ['packages/engine/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error',
    },
  },
  {
    // The other rule set the product cannot get wrong. `packages/rules` is the
    // single copy of the ticket-creation checklist, read by the AI engine, the
    // admin wizard and the community wizard alike — an `any` here is a hole in
    // all three at once.
    files: ['packages/rules/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error',
    },
  },
  {
    /*
     * The rules of hooks, as a build gate.
     *
     * Added after a hook placed below an early return shipped through
     * typecheck, lint, unit tests and a production build, and then blanked the
     * whole ticket page with minified React error #310 — "rendered more hooks
     * than during the previous render". The component returned early while it
     * had nothing to show and rendered fully once it did, so the fault only
     * appeared for a signed-in reader who actually held a position: the exact
     * person it could least afford to fail for.
     *
     * Only `rules-of-hooks`. `exhaustive-deps` is off rather than warned,
     * because `pnpm lint` runs with `--max-warnings=0` — a warning here is a
     * failed build, and it currently flags five long-standing effects whose
     * dependency arrays are deliberate. Rewriting those blind, in a commit
     * whose job is to stop a page crashing, is how a second bug gets shipped
     * beside the fix for the first. Turn it on with the audit that fixes them.
     */
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    // Integration stubs intentionally declare unimplemented signatures.
    files: ['apps/api/src/integrations/**/*.stub.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettier,
);

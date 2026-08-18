/**
 * Test environment.
 *
 * `src/config/env.ts` parses and validates on import, on purpose — a missing
 * secret should kill the process at boot rather than surface as a null inside a
 * trade. That means tests have to supply an environment before anything imports
 * it, which is what this file is for. It fills only what is absent, so a real
 * TEST_DATABASE_URL passed in from CI or the shell still wins.
 */
process.env['NODE_ENV'] ??= 'test';
process.env['DATABASE_URL'] ??=
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://stakeam:stakeam@localhost:5432/stakeam_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_SECRET'] ??= 'test-only-secret-at-least-32-characters-long';
process.env['SECRETS_KEY'] ??= 'test-only-secrets-key-at-least-32-chars-long';
process.env['LOG_LEVEL'] ??= 'silent';

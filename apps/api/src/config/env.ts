import { z } from 'zod';

/**
 * Every secret the Phase 0 manifest implies. Parsed once, at boot, so a missing
 * variable fails the process rather than surfacing as a null deep inside a
 * trade. Keep this in step with `.env.example`.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),

  /**
   * Key for secrets stored encrypted at rest — TOTP seeds today (§2.11).
   *
   * Optional so a development environment without 2FA still boots; the code
   * paths that need it fail loudly on use rather than silently storing
   * plaintext. Required in production, and it must not be the JWT secret:
   * rotating one should never force rotating the other.
   *
   * Read through `config/secrets.ts`, not from here — that is what gives it a
   * `_PREVIOUS` list and makes rotation something other than an outage. This
   * entry stays so a boot with a too-short key still fails at boot.
   */
  SECRETS_KEY: z.string().min(32, 'SECRETS_KEY must be at least 32 characters').optional(),

  /**
   * Superseded values of a secret, comma-separated, newest first (§2.11).
   *
   * Rotation is: publish the new key here alongside the old, let the sweep
   * re-seal, then delete the retired entry. Values listed here are accepted
   * for reading and never used for writing.
   */
  SECRETS_KEY_PREVIOUS: z.string().optional(),
  JWT_SECRET_PREVIOUS: z.string().optional(),

  /**
   * Signs proof-of-reserves exports (§2.10). Optional: without it the export
   * still generates and says plainly that it is unsigned, which is more useful
   * than refusing to produce the figures at all.
   */
  RESERVES_SIGNING_KEY: z.string().min(32).optional(),
  RESERVES_SIGNING_KEY_PREVIOUS: z.string().optional(),

  // Optional in development; the features that need them fail loudly on use.
  ANTHROPIC_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  TERMII_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default('StakeAm'),
  TERMII_BASE_URL: z.string().default('https://api.ng.termii.com'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@stakeam.ng'),

  /** SMTP connection string for transactional email (§2.12). */
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default('StakeAm <no-reply@stakeam.ng>'),

  WEB_ORIGIN: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${detail}`);
  }
  return parsed.data;
}

export const env: Env = load();

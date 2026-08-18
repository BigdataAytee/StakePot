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
   */
  SECRETS_KEY: z.string().min(32, 'SECRETS_KEY must be at least 32 characters').optional(),

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

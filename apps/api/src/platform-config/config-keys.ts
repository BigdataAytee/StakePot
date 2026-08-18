import { z } from 'zod';

/**
 * The typed registry of everything §6.4b calls a tunable.
 *
 * Values live in `platform_config` and reach the code through
 * `PlatformConfigService` — the schemas here say what shape a key's value must
 * have, not what it is. A key absent from this registry cannot be read, so a
 * typo in a config name fails loudly instead of silently returning undefined.
 */
export const CONFIG_SCHEMAS = {
  // Tiering and onboarding (§2.1)
  starter_balance_spc: z.number().nonnegative(),
  signup_bonus_spc: z.number().nonnegative(),
  tier0_expiry_days: z.number().int().positive(),
  kyc_required_at: z.enum(['deposit', 'withdrawal']),

  // Contact verification (§2.1)
  otp_ttl_seconds: z.number().int().positive(),
  otp_max_attempts: z.number().int().positive(),
  otp_resend_cooldown_seconds: z.number().int().nonnegative(),

  // Fees (§2.3, Rulebook §10) — charged on the losing pool
  official_fee_bps: z.number().int().nonnegative(),
  community_fee_bps: z.number().int().nonnegative(),
  community_creator_bps: z.number().int().nonnegative(),
  community_platform_bps: z.number().int().nonnegative(),
  exit_fee_rate: z.number().min(0).max(0.02),

  // Financial controls (§2.10)
  reconciliation_tolerance_spc: z.number().nonnegative(),
  withdrawals_frozen: z.boolean(),
  four_eyes_withdrawal_threshold_spc: z.number().nonnegative(),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;

export type ConfigValue<K extends ConfigKey> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;

export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

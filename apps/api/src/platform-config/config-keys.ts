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

  // Community shelf (§2.4, §2.5, Rulebook Part 3)
  conduct_bond_spc: z.number().nonnegative(),
  funding_window_hours: z.number().int().positive(),
  community_activation_pool_spc: z.number().nonnegative(),
  community_activation_backers: z.number().int().nonnegative(),
  /**
   * `per_outcome` is the Rulebook rule as written; `total_pot` is the amendment
   * §2.9's backtest recommends for wide fields. Seeded to the rulebook rule —
   * adopting the amendment is a rulebook decision, not a code one.
   */
  community_activation_mode: z.enum(['per_outcome', 'total_pot']),
  community_activation_total_pot_spc: z.number().nonnegative(),
  community_activation_min_funded_outcomes: z.number().int().positive(),

  // Path B seeds and Sponsor Syndicates (§2.4, Rulebook Part 3 §2–§3)
  /** The Symmetric Seed minimum, per pool. */
  symmetric_seed_per_outcome_spc: z.number().positive(),
  /** Distinct non-creator stakers a seeded market needs by window close. */
  participation_floor_users: z.number().int().nonnegative(),
  syndicate_min_contribution_spc: z.number().positive(),
  syndicate_max_sponsors: z.number().int().positive(),
  syndicate_round_hours: z.number().int().positive(),

  // AI question engine (§2.9 rule 3)
  ai_balance_low: z.number().min(0).max(1),
  ai_balance_high: z.number().min(0).max(1),
  ai_balance_multi_max: z.number().min(0).max(1),

  // Financial controls (§2.10)
  reconciliation_tolerance_spc: z.number().nonnegative(),
  withdrawals_frozen: z.boolean(),
  four_eyes_withdrawal_threshold_spc: z.number().nonnegative(),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;

export type ConfigValue<K extends ConfigKey> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;

export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

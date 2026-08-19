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
  /**
   * §2.17's referral reward, paid to the referrer once the referred account
   * verifies and stakes. Zero turns the programme off without removing it,
   * which is what you want the moment a farm is discovered.
   */
  referral_reward_spc: z.number().nonnegative(),
  signup_bonus_spc: z.number().nonnegative(),
  tier0_expiry_days: z.number().int().positive(),
  /**
   * The most an unverified (Tier 0) account may hold at risk across all open
   * markets — §2.1's "starter-balance trading capped at Tier 0". Verifying a
   * contact lifts it entirely.
   */
  tier0_stake_cap_spc: z.number().nonnegative(),
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

  // Resolution, disputes and config governance (§2.6, §6.4b)
  /** How long participants have to dispute a proposed resolution. */
  dispute_window_hours: z.number().int().positive(),
  /** How long a creator has to propose a resolution after the event (Part 3 §5). */
  resolution_proposal_hours: z.number().int().positive(),
  /** §6.4b: approved config changes take effect after a visible delay. */
  config_change_delay_hours: z.number().int().nonnegative(),

  // AI question engine (§2.9)
  ai_balance_low: z.number().min(0).max(1),
  ai_balance_high: z.number().min(0).max(1),
  ai_balance_multi_max: z.number().min(0).max(1),
  /** Term overlap at which a draft counts as restating a live market. */
  ai_duplicate_threshold: z.number().min(0).max(1),
  /** §2.9 rule 8's shelf plan: how many official markets run at once. */
  official_shelf_slots: z.number().int().positive(),
  /** What the platform puts into each pool when it opens an official market. */
  official_seed_per_outcome_spc: z.number().positive(),

  // Support desk and responsible gambling (§2.12, §6.7)
  /** Hours until a ticket is late, per category. */
  support_sla_hours: z.record(z.string(), z.number().int().positive()),
  /** §2.12's session reality check, after this many minutes of continuous use. */
  reality_check_minutes: z.number().int().positive(),
  /**
   * The platform's own daily caps. High in points mode and fully enforced —
   * §2.12 wants the flows exercised long before a licence depends on them.
   */
  rg_platform_stake_limit_spc: z.number().positive(),
  rg_platform_loss_limit_spc: z.number().positive(),
  rg_cooloff_max_days: z.number().int().positive(),
  /** The helpline text shown wherever limits are (§2.12). */
  rg_helpline: z.string().min(1),

  // Creator platform (§2.14). The bracketed numbers in §2.14c's ladder table.
  creator_level2_clean_resolutions: z.number().int().nonnegative(),
  creator_level3_clean_resolutions: z.number().int().nonnegative(),
  creator_level3_volume_spc: z.number().nonnegative(),
  /** The share of a creator's settled markets that must be clean for level 3. */
  creator_level3_clean_rate: z.number().min(0).max(1),
  /** Level → concurrent live markets. §2.14c's "max [2] live" / "max [10] live". */
  creator_max_live_markets: z.record(z.string(), z.number().int().positive()),
  /** Level → multiplier on `conduct_bond_spc`. Level 2's "reduced bond". */
  creator_bond_multiplier: z.record(z.string(), z.number().min(0).max(1)),
  /** Level → the creator's share of the community fee. The "[4%→4.5%]" bump. */
  creator_bps_by_level: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * Whether a level can be lost when the record stops supporting it. True keeps
   * privileges honest; false makes status a trophy. A policy call, not a code one.
   */
  creator_demotion_enabled: z.boolean(),
  /** §2.14d's nudges are only useful while they are rare. */
  nudge_min_hours_between: z.number().int().positive(),

  // The opportunity feed (§2.14b)
  /** Searches below this are noise, not unmet demand. */
  opportunity_min_searchers: z.number().int().positive(),
  /** Beyond this horizon an event is too far off for a creator to act on. */
  opportunity_horizon_days: z.number().int().positive(),
  /** How long an unclaimed opportunity stays on the feed. */
  opportunity_ttl_days: z.number().int().positive(),

  // The community layer (§2.15a, §2.15e)
  /** §2.15a: commenting requires this tier, plus eligibility to trade. */
  comment_min_tier: z.number().int().nonnegative(),
  comment_max_length: z.number().int().positive(),
  /** The gap between one person's comments — stops a flood. */
  comment_min_seconds_between: z.number().int().nonnegative(),
  /** The hourly cap — stops a slow grind the gap would not catch. */
  comment_rate_per_hour: z.number().int().positive(),
  /** Distinct reporters that pull a live comment into the moderation queue. */
  comment_reports_to_flag: z.number().int().positive(),

  // Leaderboards and prizes (§2.8, §6.8)
  /** Settled markets below this and an accuracy figure is noise, not a record. */
  leaderboard_min_markets_accuracy: z.number().int().nonnegative(),
  /** Stake below this and a profit figure is noise too. */
  leaderboard_min_staked_profit: z.number().nonnegative(),
  /** §2.1: Tier 1 "unlocks ... leaderboards, and prize eligibility". */
  leaderboard_min_tier: z.number().int().nonnegative(),
  leaderboard_page_size: z.number().int().positive(),
  /** How many places a weekly prize run pays. */
  prize_places: z.number().int().positive(),
  /** The pot a weekly run splits across those places, in SPC. */
  prize_pool_spc: z.number().nonnegative(),

  // Anti-fraud and integrity (§2.7, §6.5)
  /** Buy-then-sell round trips inside this window count as one wash cycle. */
  abuse_wash_window_minutes: z.number().int().positive(),
  /** Round trips on one market before it reads as churn rather than a change of mind. */
  abuse_wash_cycles: z.number().int().positive(),
  /** Trades in a sliding hour above which a person is unlikely to be typing. */
  abuse_flood_trades_per_hour: z.number().int().positive(),
  /** Accounts on one device above which it stops looking like a household. */
  abuse_cluster_accounts: z.number().int().positive(),
  /** The nightly audit's allowance on cached aggregates. Never on the ledger. */
  audit_cache_tolerance_spc: z.number().nonnegative(),

  // Financial controls (§2.10)
  reconciliation_tolerance_spc: z.number().nonnegative(),
  withdrawals_frozen: z.boolean(),
  four_eyes_withdrawal_threshold_spc: z.number().nonnegative(),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;

export type ConfigValue<K extends ConfigKey> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;

export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

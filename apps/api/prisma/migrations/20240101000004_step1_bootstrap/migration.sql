-- Step 1 bootstrap: the house accounts the double-entry ledger posts against,
-- and the platform_config rows §6.4b requires for anything tunable.

-- ---------------------------------------------------------------- house accounts
--
-- §3 makes ledger.user_id required, and §2.2 requires a double-entry ledger, so
-- the platform side of every transaction needs an account to sit in. Two:
--
--   sys_platform    holds `platform_fees` — the only fund class company costs
--                   may ever be paid from (§2.10)
--   sys_prize_pool  holds `prize_pool`, and in points mode is also the issuance
--                   account: signup bonuses and prizes are posted out of it, so
--                   its negative balance IS the total SPC in circulation
--
-- status = 'system' so the auth path refuses to log either of them in, and the
-- pwHash is a sentinel no argon2 verification can ever match.
INSERT INTO users (id, "contactVerified", tier, "pwHash", role, status, "createdAt")
VALUES
  ('sys_platform',   true, 2, '!system-account-no-login!', 'admin', 'system', NOW()),
  ('sys_prize_pool', true, 2, '!system-account-no-login!', 'admin', 'system', NOW());

INSERT INTO wallets ("userId", currency, available, escrowed)
VALUES
  ('sys_platform',   'SPC', 0, 0),
  ('sys_prize_pool', 'SPC', 0, 0);

-- ---------------------------------------------------------------- config
--
-- Seeded as version 1 / active with an effective date in the past. Every later
-- change goes through the four-eyes proposal flow (§6.4b) — these rows exist so
-- there is something to propose against, not so they can be edited in place.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  -- Tiering and onboarding (§2.1). The two balances are NOT pinned down by the
  -- spec — it lists "Tier limits and starter balance" as config. These are
  -- placeholders sized against the economy the rulebook does pin (2,000 min
  -- stake, 2,000 conduct bond, 20,000 activation) and need sign-off.
  ('starter_balance_spc',        '5000',         NOW(), 1, 'active'),
  ('signup_bonus_spc',           '10000',        NOW(), 1, 'active'),
  ('tier0_expiry_days',          '14',           NOW(), 1, 'active'),
  ('kyc_required_at',            '"withdrawal"', NOW(), 1, 'active'),

  -- OTP / contact verification (§2.1).
  ('otp_ttl_seconds',            '600',          NOW(), 1, 'active'),
  ('otp_max_attempts',           '5',            NOW(), 1, 'active'),
  ('otp_resend_cooldown_seconds','60',           NOW(), 1, 'active'),

  -- Fees (§2.3, Rulebook §10) — basis is the losing pool.
  ('official_fee_bps',           '300',          NOW(), 1, 'active'),
  ('community_fee_bps',          '700',          NOW(), 1, 'active'),
  ('community_creator_bps',      '400',          NOW(), 1, 'active'),
  ('community_platform_bps',     '300',          NOW(), 1, 'active'),
  ('exit_fee_rate',              '0.01',         NOW(), 1, 'active'),

  -- Financial controls (§2.10). Tolerance is zero on purpose: "any mismatch —
  -- even ₦1 — pages on-call and freezes withdrawals until a human clears it".
  ('reconciliation_tolerance_spc','0',           NOW(), 1, 'active'),
  ('withdrawals_frozen',         'false',        NOW(), 1, 'active'),
  ('four_eyes_withdrawal_threshold_spc', '50000', NOW(), 1, 'active');

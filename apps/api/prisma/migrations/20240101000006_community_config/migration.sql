-- Config the community shelf and the question engine read (§6.4b: every tunable
-- is a row, never a constant).
--
-- `community_activation_mode` is seeded to `per_outcome` — the Rulebook rule as
-- written. §2.9's backtest recommends `total_pot` for 4–5-outcome markets, where
-- the strict rule "fails even well-balanced markets on tail outcomes", but
-- adopting that is a rulebook amendment and belongs to whoever owns the rules.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('conduct_bond_spc',                         '2000',          NOW(), 1, 'active'),
  ('funding_window_hours',                     '72',            NOW(), 1, 'active'),
  ('community_activation_pool_spc',            '20000',         NOW(), 1, 'active'),
  ('community_activation_backers',             '10',            NOW(), 1, 'active'),
  ('community_activation_mode',                '"per_outcome"', NOW(), 1, 'active'),
  ('community_activation_total_pot_spc',       '60000',         NOW(), 1, 'active'),
  ('community_activation_min_funded_outcomes', '2',             NOW(), 1, 'active'),
  ('ai_balance_low',                           '0.35',          NOW(), 1, 'active'),
  ('ai_balance_high',                          '0.65',          NOW(), 1, 'active'),
  ('ai_balance_multi_max',                     '0.6',           NOW(), 1, 'active');

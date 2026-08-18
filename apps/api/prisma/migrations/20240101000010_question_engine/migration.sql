-- The AI market question engine's own tunables (§2.9, §6.4b).
--
-- `ai_duplicate_threshold` is term overlap, not a model's opinion: a duplicate
-- splits one argument across two markets, which is a liquidity problem worth
-- catching without a network call.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('ai_duplicate_threshold',        '0.6',   NOW(), 1, 'active'),
  ('official_shelf_slots',          '6',     NOW(), 1, 'active'),
  ('official_seed_per_outcome_spc', '50000', NOW(), 1, 'active');

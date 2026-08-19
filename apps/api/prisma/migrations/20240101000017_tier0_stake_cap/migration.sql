-- §2.1: "starter-balance trading capped at Tier 0."
--
-- The tier itself existed and the starter balance existed, but nothing capped
-- what an unverified account could put at risk — the fraud control the spec
-- names was not enforced anywhere. §7.2d also requires the cap to be shown in
-- the trade sheet before somebody commits, and a warning about a limit that
-- does not exist is worse than no warning at all, so the rule lands here first.
--
-- Sized at the starter balance: an unverified account may stake what it was
-- given and no more. Verifying a contact (Tier 1) lifts it. Like every other
-- tunable this is a §6.4b config row rather than a constant, so moving it is a
-- four-eyes proposal and not a deploy.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('tier0_stake_cap_spc', '5000', NOW(), 1, 'active')
-- The primary key is (key, version), so an unqualified ON CONFLICT (key) has
-- no index to infer and the statement fails outright. Caught by applying this
-- against a real database rather than by reading it.
ON CONFLICT (key, version) DO NOTHING;

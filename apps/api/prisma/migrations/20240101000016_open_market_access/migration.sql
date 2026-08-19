-- Open the market to unverified accounts.
--
-- §2.1's Tier 0 is "friction-free entry", and the product now takes that at its
-- word: nothing in the app asks a new account to prove a contact before using
-- it. Trading never checked a tier, but two surfaces did, and with no prompt
-- anywhere to verify they became dead ends rather than gates — a refusal with
-- no way to satisfy it.
--
-- Both are one row each, so this is reversible without a deploy: set either
-- back to 1 and the gate returns at the next config refresh.
--
--   comment_min_tier      posting a take on a market's thread (§2.15a)
--   leaderboard_min_tier  appearing on the board and in prize draws (§2.8)
--
-- Contact verification itself is untouched: the endpoints, the codes and the
-- Tier 1 bonus all still work for anyone who goes to /verify. What changes is
-- that nothing requires it — until money leaves, which is the boundary where it
-- becomes mandatory and where there is nothing to gate yet (§9, licensed phase).
UPDATE platform_config SET state = 'superseded'
 WHERE key IN ('comment_min_tier', 'leaderboard_min_tier') AND state = 'active';

INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('comment_min_tier',     '0', NOW(), 2, 'active'),
  ('leaderboard_min_tier', '0', NOW(), 2, 'active');

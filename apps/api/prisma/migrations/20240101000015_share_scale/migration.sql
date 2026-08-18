-- Widen share columns from 18 to 30 decimal places.
--
-- The pot identity `pot === C(q) − C(q0)` is checked against the *stored* share
-- vector. Every write truncated q to 18 dp, moving C(q) by up to one quantum,
-- in a consistent direction, once per trade. The invariant's tolerance bounds a
-- single round trip through storage — so after a few hundred trades the drift
-- exceeded it and the market began refusing every trade with "pot identity
-- violated". Permanently: the state that fails the check is the state on disk,
-- so nothing after it can succeed either. A market bricked by arithmetic.
--
-- Found by the 10× election-night load run, where three markets bricked partway
-- through and 85% of trades were refused.
--
-- Money stays at 18 dp: it is exact there, and the ledger's balance proofs
-- depend on that scale. Only shares — a derived quantity the curve consumes —
-- move. At 30 dp the same accumulation needs on the order of 10^12 trades.
ALTER TABLE "outcomes" ALTER COLUMN "sharesOutstanding" TYPE DECIMAL(60, 30);
ALTER TABLE "trades"   ALTER COLUMN "shares"            TYPE DECIMAL(60, 30);
ALTER TABLE "positions" ALTER COLUMN "shares"           TYPE DECIMAL(60, 30);

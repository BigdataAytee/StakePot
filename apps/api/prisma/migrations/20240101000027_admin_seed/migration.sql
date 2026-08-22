-- AlterEnum
--
-- A symmetric seed is neither an activation nor a trade, and a reader looking
-- at a jump in the pot with a flat price deserves to be told which of the two
-- it was.
ALTER TYPE "AnnotationType" ADD VALUE IF NOT EXISTS 'seed';

-- The ceiling on one admin top-up.
--
-- A ceiling rather than an approval step: raising it is itself a config change,
-- which is four-eyed and delayed (§6.8), so the slow door is where the real
-- control sits. Defaulted to the opening seed, so out of the box a top-up can
-- match what a market was opened with and no more.
-- Guarded on the key rather than with ON CONFLICT: the primary key here is
-- (key, version) and the "one active per key" rule is a *partial* unique index,
-- so neither is a conflict target this insert can name.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state)
SELECT 'official_seed_max_per_outcome_spc', '50000', NOW(), 1, 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM platform_config WHERE key = 'official_seed_max_per_outcome_spc'
);

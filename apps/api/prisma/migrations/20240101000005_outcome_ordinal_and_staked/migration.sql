-- Two columns the engine needs to round-trip through the database.
--
-- `ordinal` is the outcome's position in the engine's share vector. Inferring it
-- from insertion order would mean a reordered query silently prices one outcome
-- as another, which is a money bug that no test would obviously catch.
--
-- `stakedTotal` is money staked on the outcome, net of early exits. v2 §2.3
-- charges the resolution fee on the losing pool, and the cost curve keeps a
-- single undifferentiated pot — so what went in per outcome has to be carried
-- alongside it. It is a cache of the trades table, exactly as `potTotal` and
-- `sharesOutstanding` already are.

ALTER TABLE "outcomes" ADD COLUMN "ordinal" INTEGER;
ALTER TABLE "outcomes" ADD COLUMN "stakedTotal" DECIMAL(38,18) NOT NULL DEFAULT 0;

-- Backfill deterministically for any market that already exists, then make the
-- column required.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "marketId" ORDER BY id) - 1 AS n
  FROM "outcomes"
)
UPDATE "outcomes" o SET "ordinal" = numbered.n FROM numbered WHERE o.id = numbered.id;

ALTER TABLE "outcomes" ALTER COLUMN "ordinal" SET NOT NULL;

CREATE UNIQUE INDEX "outcomes_marketId_ordinal_key" ON "outcomes"("marketId", "ordinal");

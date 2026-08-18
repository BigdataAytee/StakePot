-- Path B seeds, Sponsor Syndicates and conduct bonds (§2.4, Rulebook Part 3).

-- CreateEnum
CREATE TYPE "ActivationPath" AS ENUM ('organic', 'seeded');

-- CreateEnum
CREATE TYPE "SyndicateState" AS ENUM ('open', 'filled', 'refunded');

-- AlterEnum: a seed leg is neither a buy nor a sell. It is recorded so the seed
-- appears in market history, and it is excluded everywhere a *stake* is counted.
ALTER TYPE "TradeSide" ADD VALUE 'seed';

-- AlterTable: how a market activates, and when its window shuts. The deadline is
-- stored rather than derived from createdAt so the schedule can be rebuilt from
-- Postgres after a Redis loss — a queue is not a source of truth.
ALTER TABLE "markets"
  ADD COLUMN "activationPath" "ActivationPath" NOT NULL DEFAULT 'organic',
  ADD COLUMN "fundingClosesAt" TIMESTAMP(3);

-- Backfill: every market that exists today opened on Path A, and its window ran
-- for the configured number of hours from creation — which is exactly what the
-- worker was recomputing on boot.
UPDATE "markets" m
SET "fundingClosesAt" = m."createdAt"
  + ((SELECT ("valueJson" #>> '{}')::int
      FROM platform_config
      WHERE key = 'funding_window_hours' AND state = 'active'
      ORDER BY version DESC LIMIT 1) * INTERVAL '1 hour')
WHERE m.shelf = 'community' AND m.state = 'funding';

-- AlterTable: the seeding round's terms, all locked when the round opens.
ALTER TABLE "syndicates"
  ADD COLUMN "perOutcomeMin" DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN "minContribution" DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN "maxSponsors" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "organiserBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "filledAt" TIMESTAMP(3);

-- The three columns above are required, but an ALTER TABLE cannot add a NOT NULL
-- column to a populated table without one, so they arrive with a default and
-- shed it immediately — no syndicate row may inherit terms nobody chose.
ALTER TABLE "syndicates"
  ALTER COLUMN "perOutcomeMin" DROP DEFAULT,
  ALTER COLUMN "minContribution" DROP DEFAULT,
  ALTER COLUMN "maxSponsors" DROP DEFAULT;

-- The state column was an unconstrained TEXT while §3's lifecycle was still
-- open. Converted in place rather than dropped and recreated: the values it
-- already holds are the values the enum names, and dropping a column that
-- decides whether contributions get refunded is not a migration to be casual
-- about.
ALTER TABLE "syndicates"
  ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state" TYPE "SyndicateState" USING "state"::"SyndicateState",
  ALTER COLUMN "state" SET DEFAULT 'open';

-- AlterTable
ALTER TABLE "syndicate_members"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "feeSharePct" SET DEFAULT 0;

-- AlterTable: a forfeited bond needs its reason on the record (Part 3 §5).
ALTER TABLE "bonds"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- One bond per market and one syndicate per market: both are properties of the
-- market itself, and a second row of either would mean money nobody can account
-- for. The database says so rather than the application remembering to.
DROP INDEX "syndicates_marketId_idx";
CREATE UNIQUE INDEX "bonds_marketId_key" ON "bonds"("marketId");
CREATE UNIQUE INDEX "syndicates_marketId_key" ON "syndicates"("marketId");
CREATE INDEX "syndicates_state_roundEndsAt_idx" ON "syndicates"("state", "roundEndsAt");

-- Config for Path B and the syndicate round (§6.4b: every tunable is a row).
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('symmetric_seed_per_outcome_spc', '20000', NOW(), 1, 'active'),
  ('participation_floor_users',      '10',    NOW(), 1, 'active'),
  ('syndicate_min_contribution_spc', '2000',  NOW(), 1, 'active'),
  ('syndicate_max_sponsors',         '20',    NOW(), 1, 'active'),
  ('syndicate_round_hours',          '72',    NOW(), 1, 'active');

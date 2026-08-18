-- Step 11: the creator platform (§2.14).
--
-- The tables themselves were scaffolded with the rest of §3's data model. What
-- this migration adds is everything that turns them from a shape into a
-- working ladder: the public identity a profile is addressed by, the counters
-- the ladder is computed from, the evidence behind an opportunity, and the
-- signals an autopsy hands back to §2.9's loop.

-- Why a market closed. A void and a settle teach a creator different things.
CREATE TYPE "AutopsyKind" AS ENUM ('resolved', 'voided');

-- The public name a creator is known by: the profile URL and the byline on
-- every share card. Nullable because an account that has never created
-- anything does not need one, unique because it is an address.
ALTER TABLE "users" ADD COLUMN "handle" TEXT;
ALTER TABLE "users" ADD COLUMN "displayName" TEXT;
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- The other half of the record. §2.14c's level 3 needs a clean *rate*, which
-- cannot be derived from a count of clean resolutions alone.
ALTER TABLE "creator_profiles" ADD COLUMN "disputedResolutions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "creator_profiles" ADD COLUMN "voidedAfterActivation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "creator_profiles" ADD COLUMN "levelUpdatedAt" TIMESTAMP(3);
ALTER TABLE "creator_profiles" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- §2.14c's level 3 privilege and §6.2's admin placement, as one column.
ALTER TABLE "markets" ADD COLUMN "featuredAt" TIMESTAMP(3);

-- The creator's share of the fee, fixed when the market opened. §2.14a shows a
-- creator an earnings preview before they commit; the number they were shown is
-- the number they are owed, whatever their level does between then and
-- settlement. Nullable: existing markets and every official market fall back to
-- the configured split, which is exactly what they were opened under.
ALTER TABLE "markets" ADD COLUMN "creatorBps" INTEGER;

-- Opportunities gain an identity, so the sweep that refreshes the feed updates
-- what is already there instead of reposting it every hour, and a claim
-- records which market captured it (§2.14b).
ALTER TABLE "opportunities" ADD COLUMN "evidenceJson" JSONB;
ALTER TABLE "opportunities" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "opportunities" ADD COLUMN "marketId" TEXT;
ALTER TABLE "opportunities" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Added nullable, backfilled, then constrained. Nothing has written an
-- opportunity yet, but a migration that only works on an empty table is a
-- migration that fails the first time someone reruns it against staging.
ALTER TABLE "opportunities" ADD COLUMN "dedupeKey" TEXT;
UPDATE "opportunities" SET "dedupeKey" = "id" WHERE "dedupeKey" IS NULL;
ALTER TABLE "opportunities" ALTER COLUMN "dedupeKey" SET NOT NULL;
CREATE UNIQUE INDEX "opportunities_dedupeKey_key" ON "opportunities"("dedupeKey");
CREATE INDEX "opportunities_claimedBy_idx" ON "opportunities"("claimedBy");

-- The autopsy's signals, as columns rather than inside `tipsJson`, precisely
-- because §2.9's loop has to query them.
ALTER TABLE "market_autopsies" ADD COLUMN "finalSplit" DECIMAL(38,18);
ALTER TABLE "market_autopsies" ADD COLUMN "volume" DECIMAL(38,18) NOT NULL DEFAULT 0;
ALTER TABLE "market_autopsies" ADD COLUMN "distinctStakers" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "market_autopsies" ADD COLUMN "views" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "market_autopsies" ADD COLUMN "kind" "AutopsyKind";
UPDATE "market_autopsies" SET "kind" = 'resolved' WHERE "kind" IS NULL;
ALTER TABLE "market_autopsies" ALTER COLUMN "kind" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- §2.14c's bracketed numbers, as tunables rather than as constants in code.

INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  -- Level 2: "[5] clean resolutions".
  ('creator_level2_clean_resolutions', '5', NOW(), 1, 'active'),
  -- Level 3: "sustained volume + clean record", made concrete.
  ('creator_level3_clean_resolutions', '20', NOW(), 1, 'active'),
  ('creator_level3_volume_spc', '5000000', NOW(), 1, 'active'),
  ('creator_level3_clean_rate', '0.9', NOW(), 1, 'active'),
  -- "max [2] live markets" / "max [10] live", and a Pro ceiling that still exists.
  ('creator_max_live_markets', '{"1": 2, "2": 10, "3": 25}', NOW(), 1, 'active'),
  -- Level 2's "reduced bond", as a multiplier on `conduct_bond_spc`.
  ('creator_bond_multiplier', '{"1": 1, "2": 0.5, "3": 0.25}', NOW(), 1, 'active'),
  -- The fee bump: "[4%→4.5%]", in bps of the losing pool.
  ('creator_bps_by_level', '{"1": 400, "2": 400, "3": 450}', NOW(), 1, 'active'),
  -- Whether a level can be lost. Privileges tied to a record should track the
  -- record, but demotion is a policy call, so it is one flip rather than a
  -- code change.
  ('creator_demotion_enabled', 'true', NOW(), 1, 'active'),
  -- The nudge throttle. §2.14d's prompts are only useful while they are rare.
  ('nudge_min_hours_between', '24', NOW(), 1, 'active'),
  -- §2.14b's unmet-demand signal.
  ('opportunity_min_searchers', '5', NOW(), 1, 'active'),
  ('opportunity_horizon_days', '45', NOW(), 1, 'active'),
  ('opportunity_ttl_days', '14', NOW(), 1, 'active');

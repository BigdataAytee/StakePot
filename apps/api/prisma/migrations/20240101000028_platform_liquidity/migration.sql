-- Platform liquidity: the seed tool's mode, and the market maker.

CREATE TYPE "LiquidityMode" AS ENUM ('test', 'live');

CREATE TYPE "MakerStatus" AS ENUM (
  'quoting',
  'idle',
  'budget_spent',
  'depth_reached',
  'inventory_capped',
  'market_closing',
  'killed'
);

-- Which orders the platform's maker posted. Defaults false, so every order
-- that already exists is correctly marked as somebody's.
ALTER TABLE "orders" ADD COLUMN "maker" BOOLEAN NOT NULL DEFAULT false;

-- The disclosure on a market and the reconciliation of platform positions both
-- ask "are there maker orders here", which is this index.
CREATE INDEX "orders_marketId_maker_idx" ON "orders" ("marketId", "maker");

CREATE TABLE "market_makers" (
  "marketId"       TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT false,
  "mode"           "LiquidityMode" NOT NULL DEFAULT 'test',
  "budget"         DECIMAL(38,18) NOT NULL,
  "spent"          DECIMAL(38,18) NOT NULL DEFAULT 0,
  "quoteSize"      DECIMAL(38,18) NOT NULL,
  "spreadKobo"     INTEGER NOT NULL,
  "minPriceKobo"   INTEGER NOT NULL DEFAULT 2,
  "maxPriceKobo"   INTEGER NOT NULL DEFAULT 98,
  "refreshMs"      INTEGER NOT NULL DEFAULT 60000,
  "depthStop"      DECIMAL(38,18) NOT NULL,
  "inventoryCap"   DECIMAL(38,18) NOT NULL,
  "status"         "MakerStatus" NOT NULL DEFAULT 'idle',
  "statusNote"     TEXT,
  "lastQuoteAt"    TIMESTAMP(3),
  "lastCycleAt"    TIMESTAMP(3),
  "killedAt"       TIMESTAMP(3),
  "killedBy"       TEXT,
  "killReason"     TEXT,
  "seededBy"       TEXT,
  "seededAt"       TIMESTAMP(3),
  "stackConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "market_makers_pkey" PRIMARY KEY ("marketId")
);

CREATE INDEX "market_makers_enabled_status_idx" ON "market_makers" ("enabled", "status");

ALTER TABLE "market_makers"
  ADD CONSTRAINT "market_makers_marketId_fkey"
  FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Config. Guarded on the key rather than with ON CONFLICT: the primary key is
-- (key, version) and "one active per key" is a partial unique index, so neither
-- is a conflict target this insert can name.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state)
SELECT k, v::jsonb, NOW(), 1, 'active'
FROM (VALUES
  -- LIVE mode off. It stays off until licensing, and turning it on also needs
  -- the `liquidity-live` feature flag.
  ('liquidity_live_enabled', 'false'),
  ('liquidity_bot_max_budget_spc', '250000'),
  ('liquidity_bot_depth_stop_spc', '50000'),
  ('liquidity_bot_stop_before_freeze_minutes', '30'),
  -- 2500 bps = 25 points of probability, chosen by measuring the engine at the
  -- wizard's default liquidity (L = 50,000, so a typical stake around 2,000):
  --
  --     2,000 ->   196 bps      10,000 ->   906 bps
  --     5,000 ->   476 bps      20,000 -> 1,648 bps
  --                             40,000 -> 2,753 bps
  --
  -- A confident trader putting in ten times the typical stake still gets
  -- through; the cheque that takes a market from 50% to 78% in one motion does
  -- not. Set tighter and the guard refuses ordinary conviction, which is the
  -- trading this platform exists for.
  ('max_impact_bps', '2500')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM platform_config WHERE platform_config.key = seed.k);

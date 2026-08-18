-- Step 13: leaderboards, prizes and analytics events (§2.8, §6.8).
--
-- The snapshot table gains a `board` column and takes it into the primary key:
-- §2.8 asks for *two* boards, profit and accuracy, and they rank different
-- people on purpose. Existing rows default to `profit`, which is what a single
-- unlabelled board could only have been.
--
-- The prize tables are new. §3's data model does not list them — it stops at
-- `leaderboard_snapshots` — but §2.8 asks for a distribution tool and §6.8 puts
-- "approve airtime payouts" behind two pairs of eyes, and neither is expressible
-- as a ledger row alone: a run has to exist, be reviewable, and be signed
-- *before* any money moves.

-- CreateEnum
CREATE TYPE "LeaderboardBoard" AS ENUM ('profit', 'accuracy');

-- CreateEnum
CREATE TYPE "PrizeRunState" AS ENUM ('draft', 'pending_approval', 'paid', 'cancelled');

-- DropIndex
DROP INDEX "leaderboard_snapshots_period_rank_idx";

-- AlterTable
ALTER TABLE "leaderboard_snapshots" DROP CONSTRAINT "leaderboard_snapshots_pkey",
ADD COLUMN     "board" "LeaderboardBoard" NOT NULL DEFAULT 'profit',
ADD COLUMN     "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "marketsSettled" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "marketsWon" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "staked" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "streak" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("period", "board", "userId");

-- CreateTable
CREATE TABLE "prize_runs" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "board" "LeaderboardBoard" NOT NULL,
    "state" "PrizeRunState" NOT NULL DEFAULT 'draft',
    "totalAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prize_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prize_awards" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "payoutRef" TEXT,

    CONSTRAINT "prize_awards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prize_runs_state_idx" ON "prize_runs"("state");

-- CreateIndex
CREATE UNIQUE INDEX "prize_runs_period_board_key" ON "prize_runs"("period", "board");

-- CreateIndex
CREATE INDEX "prize_awards_userId_idx" ON "prize_awards"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "prize_awards_runId_userId_key" ON "prize_awards"("runId", "userId");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_period_board_rank_idx" ON "leaderboard_snapshots"("period", "board", "rank");

-- AddForeignKey
ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_runId_fkey" FOREIGN KEY ("runId") REFERENCES "prize_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- §2.8's board rules and §6.8's prize run, as tunables.

INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  -- Settled markets below this and an accuracy figure is noise, not a record.
  ('leaderboard_min_markets_accuracy', '5',    NOW(), 1, 'active'),
  -- Stake below this and a profit figure is noise too.
  ('leaderboard_min_staked_profit',    '1000', NOW(), 1, 'active'),
  -- §2.1: Tier 1 "unlocks ... leaderboards, and prize eligibility".
  ('leaderboard_min_tier',             '1',    NOW(), 1, 'active'),
  ('leaderboard_page_size',            '50',   NOW(), 1, 'active'),
  -- How many places a weekly prize run pays, and the pot it splits.
  ('prize_places',                     '10',     NOW(), 1, 'active'),
  ('prize_pool_spc',                   '100000', NOW(), 1, 'active');

-- Reconciles the schema with the full architecture doc, which arrived after the
-- Phase 0 scaffold was built from the interim addendum.
--
-- 1. §2.2: "Currency field on every row (`SPC` — SPcoin — now, `NGN` later)".
--    The addendum called the points currency PTS. It is SPC.
--
--    Prisma's own diff wanted to build a new enum type and cast the old column
--    through text, which errors on any row already holding 'PTS'. RENAME VALUE
--    is lossless and instant — no table rewrite, no failed deploy.
--
-- 2. §3 lists `leaderboard_snapshots`, which the addendum's table list omitted.

ALTER TYPE "Currency" RENAME VALUE 'PTS' TO 'SPC';

CREATE TABLE "leaderboard_snapshots" (
    "period" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profit" DECIMAL(38,18) NOT NULL,
    "accuracy" DECIMAL(38,18) NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("period","userId")
);

CREATE INDEX "leaderboard_snapshots_period_rank_idx" ON "leaderboard_snapshots"("period", "rank");

ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

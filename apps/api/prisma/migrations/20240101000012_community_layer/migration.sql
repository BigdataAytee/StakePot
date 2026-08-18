-- Step 12: the community layer, phase 1 (§2.15a, §2.15d, §2.15e).
--
-- §2.15f's launch slice: take threads with position badges, challenge links,
-- and the moderation that keeps a Nigerian comment section from becoming
-- somebody else's tipster funnel. Titles, Top Calls and Squads are deliberately
-- absent — §2.15f ships those after launch.
--
-- Everything here is additive. `comments` and `challenges` were scaffolded with
-- the rest of §3's model; what this adds is the receipt (did the call land, and
-- how bold was it), the moderation trail, and a table to carry *why* a comment
-- is in the state it is in.

-- AlterEnum
ALTER TYPE "CommentState" ADD VALUE 'held';

-- AlterTable
ALTER TABLE "challenges" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "opens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "boldness" DECIMAL(38,18),
ADD COLUMN     "calledIt" BOOLEAN,
ADD COLUMN     "flagsJson" JSONB,
ADD COLUMN     "fromTrade" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedBy" TEXT;

-- CreateTable
CREATE TABLE "comment_reports" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_reports_commentId_idx" ON "comment_reports"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_reports_commentId_reporterId_key" ON "comment_reports"("commentId", "reporterId");

-- CreateIndex
CREATE INDEX "challenges_marketId_idx" ON "challenges"("marketId");

-- CreateIndex
CREATE INDEX "comments_state_createdAt_idx" ON "comments"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_acceptedBy_fkey" FOREIGN KEY ("acceptedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- §2.15e's rate limits, as tunables. Deliberately not `rate-limiter-flexible`:
-- that package belongs to step 14 in §5.1's manifest, and a comment cooldown
-- counted from the rows already being written needs no new dependency.

INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  -- §2.15a: "Commenting requires Tier 1 + eligibility to trade the market".
  ('comment_min_tier',            '1',   NOW(), 1, 'active'),
  ('comment_max_length',          '500', NOW(), 1, 'active'),
  -- Two limits, because they stop different things: the gap stops a flood, the
  -- hourly cap stops a slow grind.
  ('comment_min_seconds_between', '10',  NOW(), 1, 'active'),
  ('comment_rate_per_hour',       '20',  NOW(), 1, 'active'),
  -- Reports from this many distinct people pull a live comment into the queue
  -- without waiting for a moderator to notice it.
  ('comment_reports_to_flag',     '3',   NOW(), 1, 'active');

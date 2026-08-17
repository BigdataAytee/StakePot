-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('PTS', 'NGN');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'creator', 'resolver', 'admin');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('signup_bonus', 'trade_buy', 'trade_sell', 'stake', 'seed', 'payout', 'refund', 'fee_platform', 'fee_creator', 'bond_post', 'bond_refund', 'bond_forfeit', 'prize');

-- CreateEnum
CREATE TYPE "FundClass" AS ENUM ('user_escrow', 'user_available', 'platform_fees', 'prize_pool');

-- CreateEnum
CREATE TYPE "MarketShelf" AS ENUM ('official', 'community');

-- CreateEnum
CREATE TYPE "MarketState" AS ENUM ('draft', 'seeding', 'funding', 'active', 'frozen', 'pending_resolution', 'dispute_window', 'resolved', 'voided');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "BondState" AS ENUM ('held', 'refunded', 'forfeited');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('ai', 'community');

-- CreateEnum
CREATE TYPE "DraftState" AS ENUM ('suggested', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('bbnaija', 'football', 'election', 'economic', 'awards', 'transfer', 'other');

-- CreateEnum
CREATE TYPE "OpportunitySource" AS ENUM ('calendar', 'search_gap', 'seasonal');

-- CreateEnum
CREATE TYPE "CommentState" AS ENUM ('live', 'flagged', 'removed');

-- CreateEnum
CREATE TYPE "AnnotationType" AS ENUM ('open', 'activation', 'big_trade', 'news', 'freeze', 'resolution');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "contactVerified" BOOLEAN NOT NULL DEFAULT false,
    "tier" INTEGER NOT NULL DEFAULT 0,
    "kycRef" TEXT,
    "pwHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "userId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "available" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "escrowed" DECIMAL(38,18) NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("userId","currency")
);

-- CreateTable
CREATE TABLE "ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT,
    "type" "LedgerType" NOT NULL,
    "fundClass" "FundClass" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "currency" "Currency" NOT NULL,
    "ref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "shelf" "MarketShelf" NOT NULL,
    "question" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "criteriaJson" JSONB NOT NULL,
    "edgeCasesJson" JSONB NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "voidDate" TIMESTAMP(3) NOT NULL,
    "state" "MarketState" NOT NULL DEFAULT 'draft',
    "creatorId" TEXT,
    "liquidityParam" DECIMAL(38,18) NOT NULL,
    "potTotal" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "feeBps" INTEGER NOT NULL,
    "resolvedOutcomeId" TEXT,
    "resolutionEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sharesOutstanding" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "priceCurrent" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "isOther" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "shares" DECIMAL(38,18) NOT NULL,
    "cost" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "priceAfter" DECIMAL(38,18) NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "shares" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "avgPrice" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("userId","marketId","outcomeId")
);

-- CreateTable
CREATE TABLE "syndicates" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "roundEndsAt" TIMESTAMP(3) NOT NULL,
    "minTotal" DECIMAL(38,18) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "syndicates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "syndicate_members" (
    "id" TEXT NOT NULL,
    "syndicateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contribution" DECIMAL(38,18) NOT NULL,
    "feeSharePct" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "syndicate_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonds" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "state" "BondState" NOT NULL DEFAULT 'held',

    CONSTRAINT "bonds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolutions" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "proposedOutcomeId" TEXT NOT NULL,
    "evidenceUrl" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedBy" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalOutcomeId" TEXT,

    CONSTRAINT "resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "evidenceUrl" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "decidedBy" TEXT,
    "decision" TEXT,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_drafts" (
    "id" TEXT NOT NULL,
    "source" "DraftSource" NOT NULL,
    "templateJson" JSONB NOT NULL,
    "balanceEstimate" DECIMAL(38,18) NOT NULL,
    "engagementScore" DECIMAL(38,18) NOT NULL,
    "blocklistFlags" JSONB NOT NULL,
    "state" "DraftState" NOT NULL DEFAULT 'suggested',
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_outcomes_log" (
    "marketId" TEXT NOT NULL,
    "initialSplit" DECIMAL(38,18) NOT NULL,
    "finalSplit" DECIMAL(38,18) NOT NULL,
    "volume" DECIMAL(38,18) NOT NULL,
    "disputeCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "market_outcomes_log_pkey" PRIMARY KEY ("marketId")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "approver1" TEXT,
    "approver2" TEXT,
    "state" "ApprovalState" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ip" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL,
    "ledgerTotal" DECIMAL(38,18) NOT NULL,
    "walletTotal" DECIMAL(38,18) NOT NULL,
    "bankTotal" DECIMAL(38,18),
    "status" TEXT NOT NULL,
    "diff" DECIMAL(38,18) NOT NULL,
    "clearedBy" TEXT,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT,
    "category" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "slaDue" TIMESTAMP(3) NOT NULL,
    "assignedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rg_settings" (
    "userId" TEXT NOT NULL,
    "depositLimit" DECIMAL(38,18),
    "stakeLimit" DECIMAL(38,18),
    "lossLimit" DECIMAL(38,18),
    "cooloffUntil" TIMESTAMP(3),
    "selfExcluded" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rg_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "propertiesJson" JSONB NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_profiles" (
    "userId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "cleanResolutions" INTEGER NOT NULL DEFAULT 0,
    "totalVolumeHosted" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "accuracyPct" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "badgeFlags" JSONB NOT NULL,
    "followerCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "followers" (
    "followerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followers_pkey" PRIMARY KEY ("followerId","creatorId")
);

-- CreateTable
CREATE TABLE "ticket_templates" (
    "id" TEXT NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "templateJson" JSONB NOT NULL,
    "localisableFields" JSONB NOT NULL,
    "seasonWindow" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ticket_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "source" "OpportunitySource" NOT NULL,
    "title" TEXT NOT NULL,
    "templateId" TEXT,
    "demandScore" DECIMAL(38,18) NOT NULL,
    "claimedBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_autopsies" (
    "marketId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "outcomeSummary" TEXT NOT NULL,
    "tipsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_autopsies_pkey" PRIMARY KEY ("marketId")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "positionSnapshot" TEXT NOT NULL,
    "parentId" TEXT,
    "state" "CommentState" NOT NULL DEFAULT 'live',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation" (
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "accuracyPct" DECIMAL(38,18) NOT NULL,
    "calibration" DECIMAL(38,18) NOT NULL,
    "title" TEXT,
    "season" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reputation_pkey" PRIMARY KEY ("userId","category","season")
);

-- CreateTable
CREATE TABLE "squads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "screeningState" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "squads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "squad_members" (
    "squadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "squad_members_pkey" PRIMARY KEY ("squadId","userId")
);

-- CreateTable
CREATE TABLE "squad_challenges" (
    "id" TEXT NOT NULL,
    "squadA" TEXT NOT NULL,
    "squadB" TEXT NOT NULL,
    "marketSetJson" JSONB NOT NULL,
    "period" TEXT NOT NULL,
    "scoreA" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "scoreB" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "squad_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenges" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "positionSnapshot" TEXT NOT NULL,
    "linkToken" TEXT NOT NULL,
    "acceptedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "top_calls" (
    "id" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "entryPrice" DECIMAL(38,18) NOT NULL,
    "resolvedOutcome" TEXT NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "top_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" BIGSERIAL NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "pot" DECIMAL(38,18) NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_annotations" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "type" "AnnotationType" NOT NULL,
    "label" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "ledger_userId_createdAt_idx" ON "ledger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_marketId_createdAt_idx" ON "ledger"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_type_createdAt_idx" ON "ledger"("type", "createdAt");

-- CreateIndex
CREATE INDEX "markets_shelf_state_idx" ON "markets"("shelf", "state");

-- CreateIndex
CREATE INDEX "markets_state_eventDate_idx" ON "markets"("state", "eventDate");

-- CreateIndex
CREATE INDEX "outcomes_marketId_idx" ON "outcomes"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "trades_requestId_key" ON "trades"("requestId");

-- CreateIndex
CREATE INDEX "trades_marketId_createdAt_idx" ON "trades"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "trades_userId_createdAt_idx" ON "trades"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "positions_marketId_idx" ON "positions"("marketId");

-- CreateIndex
CREATE INDEX "syndicates_marketId_idx" ON "syndicates"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "syndicate_members_syndicateId_userId_key" ON "syndicate_members"("syndicateId", "userId");

-- CreateIndex
CREATE INDEX "bonds_creatorId_state_idx" ON "bonds"("creatorId", "state");

-- CreateIndex
CREATE INDEX "resolutions_marketId_idx" ON "resolutions"("marketId");

-- CreateIndex
CREATE INDEX "disputes_marketId_state_idx" ON "disputes"("marketId", "state");

-- CreateIndex
CREATE INDEX "market_drafts_state_createdAt_idx" ON "market_drafts"("state", "createdAt");

-- CreateIndex
CREATE INDEX "approvals_state_createdAt_idx" ON "approvals"("state", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_staffId_ts_idx" ON "admin_audit"("staffId", "ts");

-- CreateIndex
CREATE INDEX "reconciliation_runs_runDate_idx" ON "reconciliation_runs"("runDate");

-- CreateIndex
CREATE INDEX "support_tickets_state_slaDue_idx" ON "support_tickets"("state", "slaDue");

-- CreateIndex
CREATE INDEX "notifications_userId_sentAt_idx" ON "notifications"("userId", "sentAt");

-- CreateIndex
CREATE INDEX "events_name_ts_idx" ON "events"("name", "ts");

-- CreateIndex
CREATE INDEX "events_userId_ts_idx" ON "events"("userId", "ts");

-- CreateIndex
CREATE INDEX "followers_creatorId_idx" ON "followers"("creatorId");

-- CreateIndex
CREATE INDEX "ticket_templates_category_active_idx" ON "ticket_templates"("category", "active");

-- CreateIndex
CREATE INDEX "opportunities_expiresAt_idx" ON "opportunities"("expiresAt");

-- CreateIndex
CREATE INDEX "comments_marketId_createdAt_idx" ON "comments"("marketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "challenges_linkToken_key" ON "challenges"("linkToken");

-- CreateIndex
CREATE INDEX "top_calls_week_featured_idx" ON "top_calls"("week", "featured");

-- CreateIndex
CREATE INDEX "price_history_marketId_outcomeId_ts_idx" ON "price_history"("marketId", "outcomeId", "ts");

-- CreateIndex
CREATE INDEX "market_annotations_marketId_ts_idx" ON "market_annotations"("marketId", "ts");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_resolvedOutcomeId_fkey" FOREIGN KEY ("resolvedOutcomeId") REFERENCES "outcomes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syndicates" ADD CONSTRAINT "syndicates_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syndicates" ADD CONSTRAINT "syndicates_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syndicate_members" ADD CONSTRAINT "syndicate_members_syndicateId_fkey" FOREIGN KEY ("syndicateId") REFERENCES "syndicates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syndicate_members" ADD CONSTRAINT "syndicate_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonds" ADD CONSTRAINT "bonds_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonds" ADD CONSTRAINT "bonds_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_proposedBy_fkey" FOREIGN KEY ("proposedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_finalizedBy_fkey" FOREIGN KEY ("finalizedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_proposedOutcomeId_fkey" FOREIGN KEY ("proposedOutcomeId") REFERENCES "outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_finalOutcomeId_fkey" FOREIGN KEY ("finalOutcomeId") REFERENCES "outcomes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_outcomes_log" ADD CONSTRAINT "market_outcomes_log_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rg_settings" ADD CONSTRAINT "rg_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followers" ADD CONSTRAINT "followers_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followers" ADD CONSTRAINT "followers_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ticket_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_claimedBy_fkey" FOREIGN KEY ("claimedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_autopsies" ADD CONSTRAINT "market_autopsies_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_autopsies" ADD CONSTRAINT "market_autopsies_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation" ADD CONSTRAINT "reputation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squads" ADD CONSTRAINT "squads_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "squads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squad_challenges" ADD CONSTRAINT "squad_challenges_squadA_fkey" FOREIGN KEY ("squadA") REFERENCES "squads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squad_challenges" ADD CONSTRAINT "squad_challenges_squadB_fkey" FOREIGN KEY ("squadB") REFERENCES "squads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challengerId_fkey" FOREIGN KEY ("challengerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "top_calls" ADD CONSTRAINT "top_calls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "top_calls" ADD CONSTRAINT "top_calls_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_annotations" ADD CONSTRAINT "market_annotations_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


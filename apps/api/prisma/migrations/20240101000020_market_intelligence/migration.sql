-- CreateEnum
CREATE TYPE "SourceTier" AS ENUM ('resolution', 'news', 'signal');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('api', 'rss', 'sitemap', 'crawl');

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "tier" "SourceTier" NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "homeUrl" TEXT NOT NULL,
    "feedUrl" TEXT,
    "trust" DECIMAL(4,3) NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "corroborations" INTEGER NOT NULL DEFAULT 0,
    "categories" TEXT[],
    "region" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,
    "disabledReason" TEXT,
    "politenessMs" INTEGER NOT NULL DEFAULT 2000,
    "robotsCheckedAt" TIMESTAMP(3),
    "robotsAllows" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_items" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clusterId" TEXT,
    "factsJson" JSONB NOT NULL DEFAULT '{}',
    "entitiesJson" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "source_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_source_items" (
    "marketId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "relevance" DECIMAL(4,3) NOT NULL,
    "pinnedAt" TIMESTAMP(3),
    "pinnedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_source_items_pkey" PRIMARY KEY ("marketId","itemId")
);

-- CreateTable
CREATE TABLE "source_conflicts" (
    "id" TEXT NOT NULL,
    "marketId" TEXT,
    "factKey" TEXT NOT NULL,
    "claimsJson" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "note" TEXT,

    CONSTRAINT "source_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolution_dossiers" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "proposedOutcomeId" TEXT,
    "confidence" DECIMAL(4,3) NOT NULL,
    "recommendVoid" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL DEFAULT '[]',
    "conflictsJson" JSONB NOT NULL DEFAULT '[]',
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "accepted" BOOLEAN,

    CONSTRAINT "resolution_dossiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sources_tier_enabled_idx" ON "sources"("tier", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "sources_tier_homeUrl_key" ON "sources"("tier", "homeUrl");

-- CreateIndex
CREATE UNIQUE INDEX "source_items_url_key" ON "source_items"("url");

-- CreateIndex
CREATE INDEX "source_items_sourceId_publishedAt_idx" ON "source_items"("sourceId", "publishedAt");

-- CreateIndex
CREATE INDEX "source_items_clusterId_idx" ON "source_items"("clusterId");

-- CreateIndex
CREATE INDEX "market_source_items_marketId_relevance_idx" ON "market_source_items"("marketId", "relevance");

-- CreateIndex
CREATE INDEX "source_conflicts_marketId_resolvedAt_idx" ON "source_conflicts"("marketId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_dossiers_marketId_key" ON "resolution_dossiers"("marketId");

-- CreateIndex
CREATE INDEX "resolution_dossiers_reviewedAt_idx" ON "resolution_dossiers"("reviewedAt");

-- AddForeignKey
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_source_items" ADD CONSTRAINT "market_source_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "source_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


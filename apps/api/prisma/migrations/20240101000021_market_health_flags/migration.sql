-- AlterTable
ALTER TABLE "market_outcomes_log" ADD COLUMN     "warningsFired" TEXT[];

-- CreateTable
CREATE TABLE "market_health_flags" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "firstFiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firings" INTEGER NOT NULL DEFAULT 1,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "market_health_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_health_flags_marketId_clearedAt_idx" ON "market_health_flags"("marketId", "clearedAt");

-- CreateIndex
CREATE UNIQUE INDEX "market_health_flags_marketId_rule_key" ON "market_health_flags"("marketId", "rule");

-- AddForeignKey
ALTER TABLE "market_health_flags" ADD CONSTRAINT "market_health_flags_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


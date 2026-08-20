-- AlterEnum
--
-- Money behind a resting order is not a purchase: nothing has been bought
-- until the order fills. Typed separately so a wallet history can say "order
-- placed" rather than showing a trade the person does not hold.
ALTER TYPE "LedgerType" ADD VALUE 'order_lock';
ALTER TYPE "LedgerType" ADD VALUE 'order_release';

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "OrderState" AS ENUM ('open', 'filled', 'cancelled');

-- CreateEnum
CREATE TYPE "MatchSide" AS ENUM ('long', 'short');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "shares" DECIMAL(60,30) NOT NULL,
    "filled" DECIMAL(60,30) NOT NULL DEFAULT 0,
    "locked" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "state" "OrderState" NOT NULL DEFAULT 'open',
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_fills" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "takerUserId" TEXT NOT NULL,
    "makerUserId" TEXT NOT NULL,
    "takerSide" "OrderSide" NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "shares" DECIMAL(60,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matched_positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "side" "MatchSide" NOT NULL,
    "shares" DECIMAL(60,30) NOT NULL,
    "escrowed" DECIMAL(38,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matched_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_requestId_key" ON "orders"("requestId");

-- CreateIndex
CREATE INDEX "orders_marketId_outcomeId_side_state_priceKobo_createdAt_idx" ON "orders"("marketId", "outcomeId", "side", "state", "priceKobo", "createdAt");

-- CreateIndex
CREATE INDEX "orders_userId_state_idx" ON "orders"("userId", "state");

-- CreateIndex
CREATE INDEX "order_fills_marketId_createdAt_idx" ON "order_fills"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "order_fills_requestId_idx" ON "order_fills"("requestId");

-- CreateIndex
CREATE INDEX "matched_positions_marketId_outcomeId_idx" ON "matched_positions"("marketId", "outcomeId");

-- CreateIndex
CREATE UNIQUE INDEX "matched_positions_userId_marketId_outcomeId_side_key" ON "matched_positions"("userId", "marketId", "outcomeId", "side");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matched_positions" ADD CONSTRAINT "matched_positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matched_positions" ADD CONSTRAINT "matched_positions_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matched_positions" ADD CONSTRAINT "matched_positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express, put where they cannot be forgotten.
--
-- Every one of these is a money invariant, and the database is the only place
-- that holds them against code nobody has written yet. A price outside 1–99
-- kobo would let a pair escrow something other than ₦1 a share; a negative
-- lock would let an order rest on the book while *returning* money on
-- cancellation. Neither is reachable from the service today, and neither
-- should be reachable from a service written next year either.

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_price_range" CHECK ("priceKobo" BETWEEN 1 AND 99),
  ADD CONSTRAINT "orders_shares_positive" CHECK ("shares" > 0),
  ADD CONSTRAINT "orders_filled_bounded" CHECK ("filled" >= 0 AND "filled" <= "shares"),
  ADD CONSTRAINT "orders_locked_nonnegative" CHECK ("locked" >= 0);

ALTER TABLE "order_fills"
  ADD CONSTRAINT "order_fills_price_range" CHECK ("priceKobo" BETWEEN 1 AND 99),
  ADD CONSTRAINT "order_fills_shares_positive" CHECK ("shares" > 0);

ALTER TABLE "matched_positions"
  ADD CONSTRAINT "matched_positions_shares_positive" CHECK ("shares" > 0),
  ADD CONSTRAINT "matched_positions_escrow_nonnegative" CHECK ("escrowed" >= 0);

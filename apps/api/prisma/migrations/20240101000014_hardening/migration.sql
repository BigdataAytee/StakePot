-- Step 14: hardening (§2.7, §6.5, §11, §12).
--
-- Two tables, both feeding a queue a person reads rather than a rule that acts.
-- `abuse_flags` carries §6.5's "evidence + freeze/clear" — a flag whose reasoning
-- a reviewer cannot check is a flag nobody should act on. `device_fingerprints`
-- is §2.1's farm-detection hint, deliberately never a gate: fingerprints collide
-- between honest people on the same handset and browser.

-- CreateEnum
CREATE TYPE "AbuseFlagState" AS ENUM ('open', 'actioned', 'cleared');

-- CreateEnum
CREATE TYPE "AbuseFlagKind" AS ENUM ('wash_trading', 'stake_flood', 'multi_account');

-- CreateTable
CREATE TABLE "abuse_flags" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AbuseFlagKind" NOT NULL,
    "state" "AbuseFlagState" NOT NULL DEFAULT 'open',
    "severity" DECIMAL(38,18) NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abuse_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_fingerprints" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abuse_flags_dedupeKey_key" ON "abuse_flags"("dedupeKey");

-- CreateIndex
CREATE INDEX "abuse_flags_state_severity_idx" ON "abuse_flags"("state", "severity");

-- CreateIndex
CREATE INDEX "abuse_flags_userId_idx" ON "abuse_flags"("userId");

-- CreateIndex
CREATE INDEX "device_fingerprints_fingerprint_idx" ON "device_fingerprints"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "device_fingerprints_userId_fingerprint_key" ON "device_fingerprints"("userId", "fingerprint");

-- AddForeignKey
ALTER TABLE "abuse_flags" ADD CONSTRAINT "abuse_flags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abuse_flags" ADD CONSTRAINT "abuse_flags_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_fingerprints" ADD CONSTRAINT "device_fingerprints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- §2.7's thresholds. Every one is a judgement about where ordinary behaviour
-- ends, so every one is a tunable rather than a constant in code.

INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  -- A few round trips is an expensive change of mind; a pattern of them inside
  -- half an hour is churn for a leaderboard or a creator fee.
  ('abuse_wash_window_minutes', '30',  NOW(), 1, 'active'),
  ('abuse_wash_cycles',         '4',   NOW(), 1, 'active'),
  -- Counted per sliding hour, and counted in trades rather than in money: a big
  -- stake is confidence, four hundred small ones is a script.
  ('abuse_flood_trades_per_hour', '120', NOW(), 1, 'active'),
  -- Two accounts on one phone is a household. Six is a farm.
  ('abuse_cluster_accounts',    '4',   NOW(), 1, 'active'),
  -- The nightly audit (§2.7) tolerates nothing on the ledger itself; this is the
  -- allowance for the *cached* aggregates it cross-checks against.
  ('audit_cache_tolerance_spc', '0.000000000000000001', NOW(), 1, 'active');

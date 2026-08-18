-- Resolution and dispute flows, four-eyes approvals, staff roles (§2.6, §2.10,
-- §2.11, §6.11).

-- CreateEnum
CREATE TYPE "DisputeState" AS ENUM ('open', 'upheld', 'rejected', 'withdrawn');

-- AlterEnum: the three staff roles §6.11's matrix names and §3's enum omitted.
-- A permission matrix that cannot say "support reads tickets but not the
-- ledger" is not a permission matrix.
ALTER TYPE "UserRole" ADD VALUE 'support';
ALTER TYPE "UserRole" ADD VALUE 'trust_safety';
ALTER TYPE "UserRole" ADD VALUE 'finance';

-- AlterEnum: money a human moved by hand, typed so it is one query rather than
-- an inference. Only reachable through the approvals workflow (§2.10).
ALTER TYPE "LedgerType" ADD VALUE 'adjustment';

-- AlterTable: a proposal carries its written case, its decision and — kept
-- separate on purpose — when the action actually ran. An approved row that
-- never executed is an incident, and it should be visible as one.
ALTER TABLE "approvals"
  ADD COLUMN "reason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "rejection" TEXT,
  ADD COLUMN "executedAt" TIMESTAMP(3);

CREATE INDEX "approvals_actionType_state_idx" ON "approvals"("actionType", "state");

-- AlterTable
ALTER TABLE "disputes"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "decidedAt" TIMESTAMP(3);

-- The state column was TEXT while §3 left the lifecycle open. Converted in
-- place rather than dropped and recreated: a dispute row is evidence in a
-- money decision, and dropping the column that says how it ended would take
-- that with it.
ALTER TABLE "disputes"
  ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state" TYPE "DisputeState" USING "state"::"DisputeState",
  ALTER COLUMN "state" SET DEFAULT 'open';

-- AlterTable: when the dispute window shuts (§2.6). Stored on the market so the
-- job that closes it can be rebuilt from Postgres after a Redis loss.
ALTER TABLE "markets" ADD COLUMN "disputeClosesAt" TIMESTAMP(3);

-- Config for the resolution flow (§6.4b: every tunable is a row).
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('dispute_window_hours',        '48', NOW(), 1, 'active'),
  ('resolution_proposal_hours',   '48', NOW(), 1, 'active'),
  ('config_change_delay_hours',   '24', NOW(), 1, 'active');

-- §6.4b Platform Config Console: every tunable value lives in the database as
-- an editable, four-eyes-approved, versioned setting — never in code.

CREATE TYPE "ConfigState" AS ENUM ('active', 'pending', 'superseded');

CREATE TABLE "platform_config" (
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "ConfigState" NOT NULL DEFAULT 'pending',

    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("key","version")
);

CREATE INDEX "platform_config_key_state_idx" ON "platform_config"("key", "state");
CREATE INDEX "platform_config_state_effectiveAt_idx" ON "platform_config"("state", "effectiveAt");

CREATE TABLE "config_versions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "config_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "config_versions_key_proposedAt_idx" ON "config_versions"("key", "proposedAt");

-- At most one active row per key. §6.4b allows an active row plus a pending
-- successor; two live values for one key would be a silent economics bug.
CREATE UNIQUE INDEX "platform_config_one_active_per_key"
  ON "platform_config"("key") WHERE "state" = 'active';

-- §6.4b: "one-click rollback creates a new proposal, never an edit of history".
-- Same enforcement as the ledger — a config history that can be rewritten is
-- not an audit trail.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform_config" TO stakeam_app;
GRANT SELECT, INSERT ON TABLE "config_versions" TO stakeam_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "config_versions" FROM stakeam_app;

CREATE TRIGGER config_versions_append_only
  BEFORE UPDATE OR DELETE ON "config_versions"
  FOR EACH ROW EXECUTE FUNCTION stakeam_reject_mutation();

CREATE TRIGGER config_versions_no_truncate
  BEFORE TRUNCATE ON "config_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION stakeam_reject_mutation();

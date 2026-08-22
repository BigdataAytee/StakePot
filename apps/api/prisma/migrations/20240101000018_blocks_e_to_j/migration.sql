-- Blocks E–J: the tables the remaining consoles and member features need.
--
-- Eight tables, no changes to anything already carrying money. Every one of
-- them is either a record of something staff did (broadcasts, PII reads,
-- restore drills), a gate on something not yet live (feature flags), or a
-- member-facing fact the product promised and could not store (referrals,
-- consents, sessions, freezes).

-- ------------------------------------------------------------ feature flags

CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPct" INTEGER NOT NULL DEFAULT 0,
    "allowList" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- A percentage outside 0–100 is not a rollout, it is a typo that would read as
-- "off" or "everyone" depending on which way the maths rounded.
ALTER TABLE "feature_flags"
  ADD CONSTRAINT "feature_flags_rollout_range" CHECK ("rolloutPct" BETWEEN 0 AND 100);

-- ------------------------------------------------------------- broadcasts

CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "broadcasts_createdAt_idx" ON "broadcasts"("createdAt");

-- ---------------------------------------------------------- restore drills

CREATE TABLE "restore_drills" (
    "id" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "backupRef" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "notes" TEXT NOT NULL,
    "ranBy" TEXT NOT NULL,

    CONSTRAINT "restore_drills_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "restore_drills_ranAt_idx" ON "restore_drills"("ranAt");

-- --------------------------------------------------------- PII access log

CREATE TABLE "pii_access_log" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pii_access_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pii_access_log_subjectId_createdAt_idx" ON "pii_access_log"("subjectId", "createdAt");
CREATE INDEX "pii_access_log_staffId_createdAt_idx" ON "pii_access_log"("staffId", "createdAt");

-- An access log that staff can edit is not a log. Same treatment as `ledger`,
-- and for the same reason it takes two layers rather than one:
--
--   1. REVOKE from the application role. Note the role, not PUBLIC — migration
--      1 grants `stakeam_app` UPDATE and DELETE on every table created after
--      it, through ALTER DEFAULT PRIVILEGES, so a revoke aimed at PUBLIC
--      takes nothing away from the one account that connects here. That is
--      what this said in its first version, which made the guarantee in this
--      comment untrue while reading as though it held.
--   2. A trigger, because grants never constrain a table's *owner* — and in
--      development, and on the current Render blueprint, the app connects as
--      the owner.
REVOKE UPDATE, DELETE, TRUNCATE ON "pii_access_log" FROM stakeam_app;

CREATE TRIGGER pii_access_log_append_only
  BEFORE UPDATE OR DELETE ON "pii_access_log"
  FOR EACH ROW EXECUTE FUNCTION stakeam_reject_mutation();

CREATE TRIGGER pii_access_log_no_truncate
  BEFORE TRUNCATE ON "pii_access_log"
  FOR EACH STATEMENT EXECUTE FUNCTION stakeam_reject_mutation();

-- --------------------------------------------------------------- referrals

CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "qualifiedAt" TIMESTAMP(3),
    "rewardPaid" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "blockedFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- One row per referred account, ever. This unique index is the whole anti-abuse
-- floor: without it, "who referred you" is re-answerable and the reward is
-- farmable by asking again.
CREATE UNIQUE INDEX "referrals_referredId_key" ON "referrals"("referredId");
CREATE INDEX "referrals_referrerId_idx" ON "referrals"("referrerId");
CREATE INDEX "referrals_code_idx" ON "referrals"("code");

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredId_fkey"
  FOREIGN KEY ("referredId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nobody refers themselves.
ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_not_self" CHECK ("referrerId" <> "referredId");

-- ---------------------------------------------------------------- consents

CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "consents_userId_document_version_key"
  ON "consents"("userId", "document", "version");
CREATE INDEX "consents_userId_idx" ON "consents"("userId");

ALTER TABLE "consents" ADD CONSTRAINT "consents_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Consent is evidence. A withdrawn consent is a new fact, not an erased one.
-- Same two layers, and the same correction, as `pii_access_log` above.
REVOKE UPDATE, DELETE, TRUNCATE ON "consents" FROM stakeam_app;

CREATE TRIGGER consents_append_only
  BEFORE UPDATE OR DELETE ON "consents"
  FOR EACH ROW EXECUTE FUNCTION stakeam_reject_mutation();

CREATE TRIGGER consents_no_truncate
  BEFORE TRUNCATE ON "consents"
  FOR EACH STATEMENT EXECUTE FUNCTION stakeam_reject_mutation();

-- ------------------------------------------------------------- sessions

CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedFor" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");
CREATE INDEX "user_sessions_userId_revokedAt_idx" ON "user_sessions"("userId", "revokedAt");

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------- account freezes

CREATE TABLE "account_freezes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedBy" TEXT,

    CONSTRAINT "account_freezes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_freezes_userId_endsAt_idx" ON "account_freezes"("userId", "endsAt");

ALTER TABLE "account_freezes" ADD CONSTRAINT "account_freezes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------ config values
--
-- §2.17's referral reward. Seeded at 500 points — meaningful next to the
-- 5,000 starter balance without being worth farming for, and set to 0 the
-- moment a farm is found, which turns the programme off without removing it.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state)
VALUES ('referral_reward_spc', '500', NOW(), 1, 'active')
ON CONFLICT (key, version) DO NOTHING;

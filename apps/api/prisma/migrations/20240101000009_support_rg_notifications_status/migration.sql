-- Support ticketing, responsible gambling, notifications, the status page and
-- staff TOTP (§2.11, §2.12, §6.7).

-- CreateEnum
CREATE TYPE "TicketState" AS ENUM ('open', 'waiting_on_user', 'escalated', 'resolved', 'closed');
CREATE TYPE "TicketCategory" AS ENUM ('payout_query', 'dispute', 'account', 'rg_request', 'other');
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'push', 'email', 'sms');
CREATE TYPE "IncidentSeverity" AS ENUM ('informational', 'degraded', 'outage');
CREATE TYPE "IncidentState" AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');

-- AlterTable: staff 2FA (§2.11). The secret exists from the moment enrolment
-- starts; `totpConfirmedAt` is what makes it live, so a half-finished enrolment
-- cannot lock anybody out of their own account.
ALTER TABLE "users"
  ADD COLUMN "totpSecret" TEXT,
  ADD COLUMN "totpConfirmedAt" TIMESTAMP(3);

-- AlterTable: §2.12's self-exclusion record and session reality check.
ALTER TABLE "rg_settings"
  ADD COLUMN "selfExcludedAt" TIMESTAMP(3),
  ADD COLUMN "sessionStartedAt" TIMESTAMP(3),
  ADD COLUMN "lastRealityCheckAt" TIMESTAMP(3);

-- AlterTable: tickets gain a subject, an escalation stamp and a resolution
-- stamp. The text columns become enums in place — a ticket is a record of what
-- somebody asked for and how it went, and dropping the column that says which
-- would take that with it.
ALTER TABLE "support_tickets"
  ADD COLUMN "subject" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "escalatedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Both columns needed a default to be added NOT NULL to a populated table, and
-- both shed it immediately: Prisma keeps `updatedAt` in the application layer,
-- and a subject nobody wrote is not a subject.
ALTER TABLE "support_tickets"
  ALTER COLUMN "subject" DROP DEFAULT,
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "support_tickets"
  ALTER COLUMN "category" TYPE "TicketCategory" USING "category"::"TicketCategory";

ALTER TABLE "support_tickets"
  ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state" TYPE "TicketState" USING "state"::"TicketState",
  ALTER COLUMN "state" SET DEFAULT 'open';

-- AlterTable: a notification row is written whether or not the channel took it,
-- so "we tried to tell them" is a fact on the record rather than an inference.
ALTER TABLE "notifications"
  ADD COLUMN "failure" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "sentAt" DROP NOT NULL;

ALTER TABLE "notifications"
  ALTER COLUMN "channel" TYPE "NotificationChannel" USING "channel"::"NotificationChannel";

DROP INDEX "notifications_userId_sentAt_idx";
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "staffOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId","channel")
);

CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "status_incidents" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "state" "IncidentState" NOT NULL DEFAULT 'investigating',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "postedBy" TEXT NOT NULL,

    CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "incident_updates" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "state" "IncidentState" NOT NULL,
    "body" TEXT NOT NULL,
    "postedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_messages_ticketId_createdAt_idx" ON "support_messages"("ticketId", "createdAt");
CREATE INDEX "support_tickets_userId_createdAt_idx" ON "support_tickets"("userId", "createdAt");
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");
CREATE INDEX "status_incidents_state_startedAt_idx" ON "status_incidents"("state", "startedAt");
CREATE INDEX "incident_updates_incidentId_createdAt_idx" ON "incident_updates"("incidentId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "status_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Config for support SLAs and responsible gambling (§6.4b: every tunable is a
-- row). The RG limits sit high in points mode and are fully enforced — §2.12's
-- "the flows are tested long before the licence requires them".
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state) VALUES
  ('support_sla_hours',            '{"payout_query":4,"dispute":24,"account":24,"rg_request":2,"other":48}', NOW(), 1, 'active'),
  ('reality_check_minutes',        '60',       NOW(), 1, 'active'),
  ('rg_platform_stake_limit_spc',  '1000000',  NOW(), 1, 'active'),
  ('rg_platform_loss_limit_spc',   '1000000',  NOW(), 1, 'active'),
  ('rg_cooloff_max_days',          '30',       NOW(), 1, 'active'),
  ('rg_helpline',                  '"Gambling should be entertainment, not income. If it stops feeling like a game, take a break — set a limit or a cool-off below. Free, confidential help: 0800-000-0000."', NOW(), 1, 'active');

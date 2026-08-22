-- AlterTable
ALTER TABLE "markets" ADD COLUMN     "freezeAt" TIMESTAMP(3),
ADD COLUMN     "freezeReason" TEXT,
ADD COLUMN     "frozenAt" TIMESTAMP(3);


-- Backfill: every market that already exists gets the freeze time it has been
-- promising on its ticket all along, less the default two-minute buffer.
--
-- Not left null. The rules module falls back to `eventDate` for a null, which
-- is safe, but a live market whose freeze time is only implied is a market
-- whose countdown and API disagree by two minutes — and the countdown is what
-- a trader was shown.
UPDATE "markets" SET "freezeAt" = "eventDate" - interval '2 minutes' WHERE "freezeAt" IS NULL;

-- Markets already past trading carry the moment they stopped, so the Manage
-- tab's "past its event with no freeze" alarm does not fire on history.
UPDATE "markets"
   SET "frozenAt" = "eventDate", "freezeReason" = 'the event started'
 WHERE "frozenAt" IS NULL
   AND "state" IN ('frozen', 'pending_resolution', 'dispute_window', 'resolved', 'voided');

-- The freeze buffer, as a tunable rather than a constant: §6.4b's config
-- console owns it, with the money blast radius and the 24h delay that implies.
INSERT INTO platform_config (key, "valueJson", "effectiveAt", version, state)
VALUES ('freeze_buffer_seconds', '120', NOW(), 1, 'active')
ON CONFLICT (key, version) DO NOTHING;

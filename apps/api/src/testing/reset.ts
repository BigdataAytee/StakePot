import type { PrismaService } from '../prisma/prisma.service';

/**
 * Return the test database to its migrated state.
 *
 * Deletion follows the foreign keys: trades, positions and resolutions all
 * point at markets without a cascade, deliberately — nothing should be able to
 * remove a market and take its trade history with it. That makes the order here
 * explicit rather than incidental.
 *
 * The ledger trigger is dropped for the duration because the table is
 * append-only by design and a test fixture is the one legitimate exception.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('ALTER TABLE ledger DISABLE TRIGGER ledger_append_only');
  await prisma.$executeRawUnsafe('DELETE FROM ledger');
  await prisma.$executeRawUnsafe('ALTER TABLE ledger ENABLE TRIGGER ledger_append_only');

  await prisma.$executeRawUnsafe('ALTER TABLE admin_audit DISABLE TRIGGER admin_audit_append_only');
  await prisma.$executeRawUnsafe('DELETE FROM admin_audit');
  await prisma.$executeRawUnsafe('ALTER TABLE admin_audit ENABLE TRIGGER admin_audit_append_only');

  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.resolution.deleteMany();
  await prisma.priceHistory.deleteMany();
  await prisma.marketAnnotation.deleteMany();
  await prisma.bond.deleteMany();
  await prisma.syndicateMember.deleteMany();
  await prisma.syndicate.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.marketOutcomeLog.deleteMany();
  await prisma.marketAutopsy.deleteMany();
  await prisma.commentReport.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.challenge.deleteMany();
  await prisma.topCall.deleteMany();
  await prisma.supportMessage.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.incidentUpdate.deleteMany();
  await prisma.statusIncident.deleteMany();
  await prisma.rgSettings.deleteMany();
  await prisma.marketDraft.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.ticketTemplate.deleteMany();
  await prisma.market.deleteMany();
  // §2.14's creator record. Follows and profiles cascade from users, but the
  // analytics log does not — an `events` row outliving its market would count
  // toward the next test's conversion rate.
  await prisma.event.deleteMany();
  await prisma.follower.deleteMany();
  await prisma.creatorProfile.deleteMany();

  // Config the tests proposed: drop every version past the seeded one and put
  // the seeded row back in charge. `config_versions` is append-only, so the
  // trigger comes off for the fixture the same way the ledger's does.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE config_versions DISABLE TRIGGER config_versions_append_only',
  );
  await prisma.$executeRawUnsafe('DELETE FROM config_versions');
  await prisma.$executeRawUnsafe(
    'ALTER TABLE config_versions ENABLE TRIGGER config_versions_append_only',
  );
  await prisma.platformConfig.deleteMany({ where: { version: { gt: 1 } } });
  await prisma.platformConfig.updateMany({ where: { version: 1 }, data: { state: 'active' } });
  await prisma.approval.deleteMany();

  await prisma.wallet.updateMany({ data: { available: 0, escrowed: 0 } });
  await prisma.user.deleteMany({ where: { status: { not: 'system' } } });
  await prisma.reconciliationRun.deleteMany();
}

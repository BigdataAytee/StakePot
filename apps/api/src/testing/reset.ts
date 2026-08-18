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

  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.resolution.deleteMany();
  await prisma.priceHistory.deleteMany();
  await prisma.marketAnnotation.deleteMany();
  await prisma.market.deleteMany();

  await prisma.wallet.updateMany({ data: { available: 0, escrowed: 0 } });
  await prisma.user.deleteMany({ where: { status: { not: 'system' } } });
  await prisma.reconciliationRun.deleteMany();
}

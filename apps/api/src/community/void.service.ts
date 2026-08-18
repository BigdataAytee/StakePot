import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { LedgerService, type Tx } from '../ledger/ledger.service';

/**
 * Voiding a market and giving everything back (§2.4, §2.6, Rulebook Part 1 §6).
 *
 * "Void path available at every state → full refunds from escrow, zero fees."
 * Every route into a void ends here: a funding window that did not fill, a
 * seeding round that fell short, a seeded market that never found its crowd.
 * One implementation, because the property that matters — nobody is a naira
 * short — is not something three call sites should each be trusted to get right.
 *
 * The refund is computed from the ledger, not from stakes or positions. Whatever
 * a user has escrowed against this market comes back, whether it arrived as a
 * stake, a seed contribution or a conduct bond. Money that reached escrow by a
 * path this code has never heard of still goes home.
 */
@Injectable()
export class MarketVoidService {
  constructor(private readonly ledger: LedgerService) {}

  async voidAndRefund(tx: Tx, marketId: string, reason: string): Promise<void> {
    const escrowed = await tx.ledgerEntry.groupBy({
      by: ['userId'],
      where: { marketId, fundClass: 'user_escrow' },
      _sum: { amount: true },
    });

    for (const row of escrowed) {
      const held = new Decimal(row._sum.amount?.toString() ?? '0');
      if (held.lte(0)) continue;
      await this.ledger.post(
        tx,
        [
          {
            userId: row.userId,
            marketId,
            type: 'refund',
            fundClass: 'user_escrow',
            amount: held.negated(),
            currency: 'SPC',
          },
          {
            userId: row.userId,
            marketId,
            type: 'refund',
            fundClass: 'user_available',
            amount: held,
            currency: 'SPC',
          },
        ],
        `void:${marketId}`,
      );
    }

    // Only a bond still held is returned. A forfeited bond has already left
    // escrow, and marking it refunded would say the platform gave back money it
    // is still holding.
    await tx.bond.updateMany({
      where: { marketId, state: 'held' },
      data: { state: 'refunded', resolvedAt: new Date() },
    });
    await tx.syndicate.updateMany({
      where: { marketId, state: 'open' },
      data: { state: 'refunded' },
    });

    await tx.market.update({
      where: { id: marketId },
      data: { state: 'voided', potTotal: new Prisma.Decimal(0), fundingClosesAt: null },
    });
    await tx.outcome.updateMany({
      where: { marketId },
      data: { stakedTotal: new Prisma.Decimal(0), sharesOutstanding: new Prisma.Decimal(0) },
    });
    // Nobody holds anything in a voided market. Leaving shares on the positions
    // would leave a portfolio screen showing a stake that has already been paid
    // back — and would leave the next resolution attempt something to pay out.
    await tx.position.updateMany({
      where: { marketId },
      data: { shares: new Prisma.Decimal(0) },
    });
    await tx.marketAnnotation.create({
      data: { marketId, type: 'resolution', label: `Voided — ${reason}. Everyone refunded.` },
    });
  }
}

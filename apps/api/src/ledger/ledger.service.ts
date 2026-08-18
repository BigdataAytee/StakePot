import { Decimal } from '@stakeam/engine';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Currency, FundClass } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { assertBalanced, netFor, type Posting } from './posting';

export interface DerivedBalance {
  readonly available: Decimal;
  readonly escrowed: Decimal;
}

/** Prisma's transaction client — the money path always runs inside one. */
export type Tx = Prisma.TransactionClient;

/**
 * The only way money moves (§2.2, §2.10).
 *
 * Everything here writes inside a single database transaction: the ledger rows,
 * and the wallet totals they imply, land together or not at all. §2.2's "no
 * orphaned money" is a property of that atomicity, not of care taken by callers.
 *
 * Nothing in this service updates or deletes a ledger row. It cannot — the
 * database revokes both from the application role and a trigger blocks them
 * (migration 20240101000001). Corrections are reversing entries.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Post a balanced set of movements and update the wallets they affect.
   *
   * `ref` groups the rows of one transaction — it is how a payout, its fee and
   * the escrow it came out of are read back as a single event.
   */
  async post(tx: Tx, postings: readonly Posting[], ref: string): Promise<void> {
    assertBalanced(postings);

    await tx.ledgerEntry.createMany({
      data: postings.map((p) => ({
        userId: p.userId,
        ...(p.marketId === undefined ? {} : { marketId: p.marketId }),
        type: p.type,
        fundClass: p.fundClass,
        amount: new Prisma.Decimal(p.amount.toString()),
        currency: p.currency,
        ref,
      })),
    });

    await this.applyToWallets(tx, postings);
  }

  /**
   * Roll the postings up per (user, currency) and apply them to the wallet
   * cache in one write each.
   *
   * The wallet row is a cache of the ledger, never a second source of truth —
   * that is precisely what the nightly reconciliation re-derives and checks
   * (§2.10). A user's available balance may not go negative; the escrow leg
   * may not either.
   */
  private async applyToWallets(tx: Tx, postings: readonly Posting[]): Promise<void> {
    const touched = new Map<string, { userId: string; currency: Currency }>();
    for (const p of postings) {
      touched.set(`${p.userId}:${p.currency}`, { userId: p.userId, currency: p.currency });
    }

    for (const { userId, currency } of touched.values()) {
      const scoped = postings.filter((p) => p.userId === userId && p.currency === currency);
      const availableDelta = netFor(scoped, userId, 'user_available');
      const escrowedDelta = netFor(scoped, userId, 'user_escrow');
      const platformDelta = netFor(scoped, userId, 'platform_fees').plus(
        netFor(scoped, userId, 'prize_pool'),
      );

      // House accounts carry their balance in `available`; the fund class on the
      // row is what keeps platform_fees and prize_pool distinguishable.
      const available = availableDelta.plus(platformDelta);
      if (available.isZero() && escrowedDelta.isZero()) continue;

      await tx.wallet.upsert({
        where: { userId_currency: { userId, currency } },
        create: {
          userId,
          currency,
          available: new Prisma.Decimal(available.toString()),
          escrowed: new Prisma.Decimal(escrowedDelta.toString()),
        },
        update: {
          available: { increment: new Prisma.Decimal(available.toString()) },
          escrowed: { increment: new Prisma.Decimal(escrowedDelta.toString()) },
        },
      });
    }
  }

  /**
   * Recompute a user's balances from the ledger alone.
   *
   * This is the authoritative figure. `wallets` is a cache of it, and the two
   * disagreeing is the exact condition §2.10 says must freeze withdrawals.
   */
  async deriveBalance(userId: string, currency: Currency): Promise<DerivedBalance> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['fundClass'],
      where: { userId, currency },
      _sum: { amount: true },
    });

    const sumOf = (fundClass: FundClass): Decimal => {
      const row = grouped.find((g) => g.fundClass === fundClass);
      return new Decimal(row?._sum.amount?.toString() ?? '0');
    };

    return {
      available: sumOf('user_available').plus(sumOf('platform_fees')).plus(sumOf('prize_pool')),
      escrowed: sumOf('user_escrow'),
    };
  }

  /**
   * Total SPC in circulation: the negative of the issuance account's balance.
   *
   * Feeds §2.10's proof-of-reserves export — user liabilities on one side,
   * what backs them on the other.
   */
  async totalIssued(currency: Currency): Promise<Decimal> {
    const result = await this.prisma.ledgerEntry.aggregate({
      where: { fundClass: 'prize_pool', currency },
      _sum: { amount: true },
    });
    return new Decimal(result._sum.amount?.toString() ?? '0').negated();
  }
}

import { Injectable } from '@nestjs/common';
import type { Currency, FundClass } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

export interface FundClassTotals {
  readonly user_available: Decimal;
  readonly user_escrow: Decimal;
  readonly platform_fees: Decimal;
  readonly prize_pool: Decimal;
}

export interface SolvencyView {
  /** What users are owed: their available balances plus everything in escrow. */
  readonly userLiabilities: Decimal;
  /** What the platform holds against those liabilities. */
  readonly held: Decimal;
  /** held − userLiabilities. Zero on a healthy points-mode book. */
  readonly surplus: Decimal;
  readonly byFundClass: FundClassTotals;
  /** Money currently escrowed against open markets, per market state. */
  readonly escrowByMarketState: readonly { state: string; escrowed: Decimal; markets: number }[];
  readonly totalIssued: Decimal;
}

const ZERO = (): Decimal => new Decimal(0);

/**
 * The pot/solvency view (§6.1, §6.4, §2.10).
 *
 * "Total escrow vs user liabilities... fund-class view: user_escrow |
 * user_available | platform_fees | prize_pool — segregation, visible."
 *
 * Every figure here is derived from the append-only ledger rather than from the
 * wallet cache. The wallet totals are what reconciliation *checks*; a dashboard
 * that reported them would be quoting the thing under suspicion.
 */
@Injectable()
export class SolvencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async view(currency: Currency = 'SPC'): Promise<SolvencyView> {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['fundClass'],
      where: { currency },
      _sum: { amount: true },
    });

    const totalOf = (fundClass: FundClass): Decimal => {
      const row = rows.find((r) => r.fundClass === fundClass);
      return new Decimal(row?._sum.amount?.toString() ?? '0');
    };

    const byFundClass: FundClassTotals = {
      user_available: totalOf('user_available'),
      user_escrow: totalOf('user_escrow'),
      platform_fees: totalOf('platform_fees'),
      prize_pool: totalOf('prize_pool'),
    };

    // What users are owed, and what was issued to back it. House accounts never
    // post to a user fund class — fees land in `platform_fees`, issuance in
    // `prize_pool` — so these two sums need no exclusions.
    //
    // Because the ledger balances, `liabilities + platform_fees = issued`
    // identically: the surplus below *is* the platform's own earnings, and any
    // other value for it means the ledger does not sum to zero.
    const userLiabilities = byFundClass.user_available.plus(byFundClass.user_escrow);
    const totalIssued = await this.ledger.totalIssued(currency);
    const held = totalIssued;

    return {
      userLiabilities,
      held,
      surplus: held.minus(userLiabilities),
      byFundClass,
      escrowByMarketState: await this.escrowByMarketState(currency),
      totalIssued,
    };
  }

  /** Escrow still held against markets, split by what state those markets are in. */
  private async escrowByMarketState(
    currency: Currency,
  ): Promise<{ state: string; escrowed: Decimal; markets: number }[]> {
    const escrowed = await this.prisma.ledgerEntry.groupBy({
      by: ['marketId'],
      where: { currency, fundClass: 'user_escrow', marketId: { not: null } },
      _sum: { amount: true },
    });

    const marketIds = escrowed.map((row) => row.marketId).filter((id): id is string => id !== null);
    if (marketIds.length === 0) return [];

    const markets = await this.prisma.market.findMany({
      where: { id: { in: marketIds } },
      select: { id: true, state: true },
    });

    const byState = new Map<string, { escrowed: Decimal; markets: number }>();
    for (const row of escrowed) {
      const market = markets.find((m) => m.id === row.marketId);
      if (market === undefined) continue;
      const bucket = byState.get(market.state) ?? { escrowed: ZERO(), markets: 0 };
      byState.set(market.state, {
        escrowed: bucket.escrowed.plus(new Decimal(row._sum.amount?.toString() ?? '0')),
        markets: bucket.markets + 1,
      });
    }

    return [...byState.entries()]
      .map(([state, bucket]) => ({ state, ...bucket }))
      .sort((a, b) => b.escrowed.comparedTo(a.escrowed));
  }
}

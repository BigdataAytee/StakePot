import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { LedgerService, type Tx } from '../ledger/ledger.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { decideActivation, type ActivationRules, type OutcomeFunding } from './activation';
import { screenTemplate, type MarketTemplate } from './market-template';

export class CommunityMarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityMarketError';
  }
}

/**
 * The community shelf (§2.4, §2.5, Rulebook Part 3).
 *
 * A community market is somebody's promise to settle honestly, backed by a
 * bond. Everything here exists to make that promise enforceable: the bond is
 * escrowed before the market exists, the funding window is checked once and
 * only once, and a market that fails to activate returns every naira.
 */
@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly wallet: WalletService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Open a community market in `funding`, with the creator's conduct bond
   * escrowed (§2.5).
   *
   * The bond moves first. A market that exists without one is a promise nobody
   * is backing, and unwinding it later means a market already taking stakes.
   */
  async create(params: {
    creatorId: string;
    template: MarketTemplate;
    liquidityParam: string;
    fundingWindowHours?: number;
    now?: Date;
  }): Promise<{ marketId: string }> {
    const now = params.now ?? new Date();
    const problems = screenTemplate(params.template, { now });
    if (problems.length > 0) {
      throw new CommunityMarketError(problems.map((p) => p.message).join(' '));
    }

    const bond = new Decimal(await this.config.get('conduct_bond_spc'));
    const feeBps = await this.config.get('community_fee_bps');
    const windowHours =
      params.fundingWindowHours ?? (await this.config.get('funding_window_hours'));

    const labels = [
      ...params.template.outcomes.map((o) => ({ label: o.label, isOther: false })),
      ...(params.template.otherLabel === undefined
        ? []
        : [{ label: params.template.otherLabel, isOther: true }]),
    ];

    const criteria = Object.fromEntries(params.template.outcomes.map((o) => [o.label, o.criteria]));

    return this.prisma.$transaction(async (tx) => {
      const market = await tx.market.create({
        data: {
          shelf: 'community',
          creatorId: params.creatorId,
          question: params.template.question,
          sourceName: params.template.sourceName,
          sourceUrl: params.template.sourceUrl,
          criteriaJson: criteria,
          edgeCasesJson: params.template.edgeCases as Prisma.InputJsonValue,
          eventDate: new Date(params.template.eventDate),
          voidDate: new Date(params.template.voidDate),
          liquidityParam: new Prisma.Decimal(params.liquidityParam),
          feeBps,
          // Path A: the market takes stakes but does not trade until the window
          // closes and the floors are met.
          state: 'funding',
          outcomes: {
            create: labels.map((outcome, ordinal) => ({
              label: outcome.label,
              ordinal,
              isOther: outcome.isOther,
              priceCurrent: new Prisma.Decimal(1).div(labels.length),
            })),
          },
          annotations: {
            create: {
              type: 'open',
              label: `Funding window open for ${windowHours}h`,
            },
          },
        },
      });

      if (bond.gt(0)) {
        await this.wallet.escrow({
          userId: params.creatorId,
          marketId: market.id,
          amount: bond,
          type: 'bond_post',
          ref: `bond:${market.id}`,
          tx,
        });
        await tx.bond.create({
          data: {
            marketId: market.id,
            creatorId: params.creatorId,
            amount: new Prisma.Decimal(bond.toString()),
            state: 'held',
          },
        });
      }

      return { marketId: market.id };
    });
  }

  /**
   * Close a funding window: activate, or void and refund everyone (§2.4).
   *
   * Idempotent by state — a market not in `funding` is left alone. The job that
   * calls this can and will fire twice, and refunding a market twice is the
   * kind of mistake that has no clean correction.
   */
  async closeFundingWindow(marketId: string): Promise<{
    outcome: 'activated' | 'voided' | 'skipped';
    reason?: string;
  }> {
    const rules = await this.activationRules();

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;

      const market = await tx.market.findUniqueOrThrow({
        where: { id: marketId },
        include: { outcomes: { orderBy: { ordinal: 'asc' } } },
      });
      if (market.state !== 'funding') {
        return { outcome: 'skipped' as const };
      }

      const funding = await this.fundingFor(tx, market.id, market.creatorId, market.outcomes);
      const decision = decideActivation(funding, rules);

      if (decision.activate) {
        await tx.market.update({ where: { id: marketId }, data: { state: 'active' } });
        await tx.marketAnnotation.create({
          data: { marketId, type: 'activation', label: 'Activated — trading is open' },
        });
        return { outcome: 'activated' as const };
      }

      await this.voidAndRefund(tx, marketId, decision.reason);
      return { outcome: 'voided' as const, reason: decision.reason };
    });
  }

  /**
   * Void a market and return every naira in it — stakes and the creator's bond.
   *
   * The bond comes back because failing to attract stakes is not misconduct.
   * §2.4 says "full refund including seed"; forfeiting a bond is for a creator
   * who resolved dishonestly, which is a different flow entirely.
   */
  private async voidAndRefund(tx: Tx, marketId: string, reason: string): Promise<void> {
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

    await tx.bond.updateMany({ where: { marketId }, data: { state: 'refunded' } });
    await tx.market.update({
      where: { id: marketId },
      data: { state: 'voided', potTotal: new Prisma.Decimal(0) },
    });
    await tx.outcome.updateMany({
      where: { marketId },
      data: { stakedTotal: new Prisma.Decimal(0), sharesOutstanding: new Prisma.Decimal(0) },
    });
    await tx.marketAnnotation.create({
      data: { marketId, type: 'resolution', label: `Voided — ${reason}. Everyone refunded.` },
    });
  }

  /** Money staked and distinct backers per outcome, excluding the creator. */
  private async fundingFor(
    tx: Tx,
    marketId: string,
    creatorId: string | null,
    outcomes: readonly { id: string; label: string; isOther: boolean }[],
  ): Promise<OutcomeFunding[]> {
    const trades = await tx.trade.findMany({
      where: { marketId, side: 'buy' },
      select: { outcomeId: true, userId: true, cost: true },
    });

    return outcomes.map((outcome) => {
      const relevant = trades.filter((t) => t.outcomeId === outcome.id);
      const pool = relevant.reduce(
        (acc, t) => acc.plus(new Decimal(t.cost.toString())),
        new Decimal(0),
      );
      // §2.4's floor counts non-creator stakers: a creator cannot back their own
      // market into activation.
      const backers = new Set(relevant.filter((t) => t.userId !== creatorId).map((t) => t.userId))
        .size;
      return {
        outcomeId: outcome.id,
        label: outcome.label,
        isOther: outcome.isOther,
        pool,
        backers,
      };
    });
  }

  private async activationRules(): Promise<ActivationRules> {
    return {
      minPoolPerOutcome: new Decimal(await this.config.get('community_activation_pool_spc')),
      minBackers: await this.config.get('community_activation_backers'),
      mode: await this.config.get('community_activation_mode'),
      minTotalPot: new Decimal(await this.config.get('community_activation_total_pot_spc')),
      minFundedOutcomes: await this.config.get('community_activation_min_funded_outcomes'),
    };
  }
}

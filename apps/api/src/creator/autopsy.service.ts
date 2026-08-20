import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MarketHealthService } from '../market/health.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatorAnalyticsService } from './analytics.service';
import { autopsyFor, DEFAULT_AUTOPSY_RULES, type AutopsyFacts } from './autopsy';
import { CreatorService } from './creator.service';

/**
 * §2.14d's market autopsy, written the moment a market closes.
 *
 * "After each close, a short automated review (what worked, why it voided, one
 * improvement tip). Autopsy data feeds the AI engine's training loop (§2.9) —
 * creators and the AI improve from the same signals."
 *
 * Two things follow from that sentence and both are load-bearing. The review is
 * computed from the same facts §2.9's `recordOutcome` reads, so a creator and
 * the engine can never be told different stories about the same market. And it
 * is written in the same pass that updates the creator's record, so a market
 * cannot settle without its standing moving — the ladder has no way to miss one.
 */
@Injectable()
export class AutopsyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: CreatorAnalyticsService,
    private readonly creators: CreatorService,
    private readonly notifications: NotificationsService,
    private readonly health: MarketHealthService,
  ) {}

  /**
   * Write the autopsy for a closed market and move its creator's record.
   *
   * Idempotent on the autopsy row: the market id is the primary key, so a
   * redelivered resolution job cannot write a second review — and, more
   * importantly, cannot count the same resolution twice on the ladder.
   */
  async record(params: {
    marketId: string;
    kind: 'resolved' | 'voided';
    voidReason?: string;
  }): Promise<{ written: boolean }> {
    const existing = await this.prisma.marketAutopsy.findUnique({
      where: { marketId: params.marketId },
    });
    if (existing !== null) return { written: false };

    const market = await this.prisma.market.findUnique({
      where: { id: params.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } }, disputes: true },
    });
    if (market === null || market.creatorId === null) return { written: false };

    const [stakers, views, fees, warnings] = await Promise.all([
      this.prisma.trade.findMany({
        where: { marketId: market.id, side: 'buy', userId: { not: market.creatorId } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.analytics.viewCount(market.id),
      this.prisma.ledgerEntry.aggregate({
        where: { marketId: market.id, type: 'fee_creator' },
        _sum: { amount: true },
      }),
      // Rule 43's fourth column: what the Part 5 sweep flagged while this was
      // live. Cleared flags included — "it ran 85/15 for a week and converged
      // on the day" is the post-mortem, and the final split alone cannot say it.
      this.health.historyFor(market.id),
    ]);

    const pot = Number(market.potTotal);
    const winner = market.outcomes.find((outcome) => outcome.id === market.resolvedOutcomeId);
    const finalSplit =
      params.kind === 'voided' || winner === undefined || pot <= 0
        ? null
        : Number(winner.stakedTotal) / pot;

    // A dispute that was upheld is the one that says the criteria failed. One
    // that was refused means the creator was right and somebody disagreed —
    // that is the system working, not a mark against them.
    const upheld = market.disputes.some((dispute) => dispute.state === 'upheld');

    const facts: AutopsyFacts = {
      kind: params.kind,
      question: market.question,
      volume: pot,
      distinctStakers: stakers.length,
      views,
      finalSplit,
      disputed: upheld,
      activationPath: market.activationPath === 'seeded' ? 'seeded' : 'organic',
      voidReason: params.voidReason ?? null,
      creatorFeeEarned: Number((fees._sum.amount ?? new Prisma.Decimal(0)).abs()),
      warnings: warnings.map((warning) => ({ rule: warning.rule, message: warning.message })),
    };

    const autopsy = autopsyFor(facts, DEFAULT_AUTOPSY_RULES);

    await this.prisma.marketAutopsy.create({
      data: {
        marketId: market.id,
        creatorId: market.creatorId,
        kind: params.kind,
        outcomeSummary: autopsy.summary,
        tipsJson: {
          worked: autopsy.worked,
          tip: autopsy.tip,
          signals: autopsy.signals,
          warnings: warnings.map((warning) => ({
            rule: warning.rule,
            severity: warning.severity,
            message: warning.message,
            firstFiredAt: warning.firstFiredAt.toISOString(),
            clearedAt: warning.clearedAt?.toISOString() ?? null,
          })),
        } as Prisma.InputJsonValue,
        ...(finalSplit === null ? {} : { finalSplit: new Prisma.Decimal(finalSplit) }),
        volume: market.potTotal,
        distinctStakers: stakers.length,
        views,
      },
    });

    // The ladder moves here, from the same facts. A market that voided before
    // it ever activated is not held against the creator — nobody turned up,
    // which is a marketing problem, not misconduct.
    const activated = market.state !== 'funding' && market.state !== 'draft';
    const kind =
      params.kind === 'resolved'
        ? upheld
          ? ('disputed' as const)
          : ('clean' as const)
        : activated
          ? ('voided_after_activation' as const)
          : ('voided_before_activation' as const);

    await this.creators.recordSettlement({
      creatorId: market.creatorId,
      kind,
      volume: market.potTotal.toString(),
    });

    await this.notifications.notify({
      userId: market.creatorId,
      type: 'market_autopsy',
      body:
        autopsy.tip === null
          ? autopsy.summary
          : `${autopsy.summary} One thing for next time: ${autopsy.tip}`,
      data: { marketId: market.id },
    });

    return { written: true };
  }

  async forMarket(marketId: string): Promise<{
    summary: string;
    worked: readonly string[];
    tip: string | null;
    kind: string;
    volume: string;
    distinctStakers: number;
    views: number;
    finalSplit: string | null;
    warnings: readonly {
      rule: string;
      severity: string;
      message: string;
      clearedAt: string | null;
    }[];
    createdAt: Date;
  } | null> {
    const row = await this.prisma.marketAutopsy.findUnique({ where: { marketId } });
    if (row === null) return null;

    const tips = row.tipsJson as {
      worked?: string[];
      tip?: string | null;
      warnings?: { rule: string; severity: string; message: string; clearedAt: string | null }[];
    } | null;

    return {
      summary: row.outcomeSummary,
      worked: tips?.worked ?? [],
      tip: tips?.tip ?? null,
      kind: row.kind,
      volume: row.volume.toString(),
      distinctStakers: row.distinctStakers,
      views: row.views,
      finalSplit: row.finalSplit === null ? null : row.finalSplit.toString(),
      warnings: tips?.warnings ?? [],
      createdAt: row.createdAt,
    };
  }

  /** Every autopsy for a creator, newest first — the studio's history. */
  async forCreator(creatorId: string, take = 20) {
    const rows = await this.prisma.marketAutopsy.findMany({
      where: { creatorId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { market: { select: { question: true } } },
    });

    return rows.map((row) => {
      const tips = row.tipsJson as { worked?: string[]; tip?: string | null } | null;
      return {
        marketId: row.marketId,
        question: row.market.question,
        kind: row.kind,
        summary: row.outcomeSummary,
        tip: tips?.tip ?? null,
        worked: tips?.worked ?? [],
        volume: row.volume.toString(),
        distinctStakers: row.distinctStakers,
        finalSplit: row.finalSplit === null ? null : row.finalSplit.toString(),
        createdAt: row.createdAt,
      };
    });
  }
}

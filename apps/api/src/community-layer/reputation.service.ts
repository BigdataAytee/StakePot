import { Injectable } from '@nestjs/common';
import { topicKeyFor } from '@stakeam/engine';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import {
  accuracyOf,
  calibrationOf,
  reliability,
  titleFor,
  topCalls,
  type Call,
  type CallCandidate,
} from './reputation';

/**
 * §2.15b — computing the forecasting record, and §2.8's badge.
 *
 * The tables for this have existed since step 12 and nothing wrote to them.
 * The work is turning settled positions into `Call`s, which is where the one
 * real judgement lives: what counted as somebody's *stated probability*.
 *
 * It is `avgPrice` on the position — the average price they actually paid
 * across every buy — not the price at their first trade and not the price at
 * resolution. Somebody who bought at 20% and topped up at 60% believed
 * something in between, and averaging what they paid is the only reading of
 * their confidence that their own money backs.
 */
@Injectable()
export class ReputationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything one person's settled positions say about them.
   *
   * Zero-share positions are dropped: a position closed before resolution is
   * not a call about the outcome, it is a trade. Counting an early exit as a
   * wrong prediction would make selling look like being wrong, and the exit is
   * a feature of the product.
   */
  async callsOf(userId: string, since?: Date): Promise<Call[]> {
    const positions = await this.prisma.position.findMany({
      where: {
        userId,
        shares: { gt: 0 },
        market: {
          state: 'resolved',
          resolvedOutcomeId: { not: null },
          // Scoped by when the market was *settled*, not when it was created —
          // §2.15b's seasons are about recent form, and a market opened last
          // season but settled this one is this season's evidence.
          ...(since === undefined
            ? {}
            : { resolutions: { some: { finalizedAt: { gte: since } } } }),
        },
      },
      select: {
        outcomeId: true,
        avgPrice: true,
        market: { select: { question: true, sourceName: true, resolvedOutcomeId: true } },
      },
    });

    return positions.map((position) => ({
      probability: Math.min(1, Math.max(0, Number(position.avgPrice))),
      won: position.market.resolvedOutcomeId === position.outcomeId,
      category: topicKeyFor(position.market.question, position.market.sourceName),
    }));
  }

  /** A profile's reputation panel, computed live. */
  async profileOf(userId: string) {
    const calls = await this.callsOf(userId);
    const categories = [...new Set(calls.map((call) => call.category))];

    return {
      settled: calls.length,
      accuracy: accuracyOf(calls),
      calibration: calibrationOf(calls),
      reliability: reliability(calls),
      titles: categories
        .map((category) => ({ category, title: titleFor(category, calls) }))
        .filter((entry): entry is { category: string; title: string } => entry.title !== null),
    };
  }

  /**
   * Write the season's reputation rows (§2.15b).
   *
   * Recomputed wholesale per season rather than incremented, because an
   * incremented accuracy figure that drifts from the positions behind it is a
   * number nobody can defend, and this runs nightly over a table small enough
   * that the cost is irrelevant.
   */
  async recomputeSeason(season: string, since?: Date): Promise<{ users: number; titles: number }> {
    const users = await this.prisma.position.findMany({
      where: { shares: { gt: 0 }, market: { state: 'resolved' } },
      select: { userId: true },
      distinct: ['userId'],
    });

    let titles = 0;

    for (const { userId } of users) {
      const calls = await this.callsOf(userId, since);
      const categories = [...new Set(calls.map((call) => call.category))];

      for (const category of categories) {
        const inCategory = calls.filter((call) => call.category === category);
        const accuracy = accuracyOf(inCategory);
        const calibration = calibrationOf(inCategory);
        if (accuracy === null || calibration === null) continue;

        const title = titleFor(category, calls);
        if (title !== null) titles += 1;

        await this.prisma.reputation.upsert({
          where: { userId_category_season: { userId, category, season } },
          create: {
            userId,
            category,
            season,
            accuracyPct: accuracy,
            calibration,
            sampleSize: inCategory.length,
            title,
          },
          update: {
            accuracyPct: accuracy,
            calibration,
            sampleSize: inCategory.length,
            title,
          },
        });
      }
    }

    logger.info({ season, users: users.length, titles }, 'reputation recomputed');
    return { users: users.length, titles };
  }

  /**
   * §2.15b's weekly Top Calls — "the boldest correct predictions".
   *
   * Candidates are every winning position on a market that resolved inside the
   * week. `featured` stays false: §6.8 makes this "Top Calls **curation**", so
   * the job proposes and a person publishes. A showcase that auto-publishes is
   * one bad market away from featuring something nobody wants on the front
   * page.
   */
  async proposeTopCalls(week: string, window: { start: Date; end: Date }, limit = 5) {
    const positions = await this.prisma.position.findMany({
      where: {
        shares: { gt: 0 },
        market: {
          state: 'resolved',
          resolvedOutcomeId: { not: null },
          resolutions: { some: { finalizedAt: { gte: window.start, lt: window.end } } },
        },
      },
      select: {
        userId: true,
        marketId: true,
        outcomeId: true,
        avgPrice: true,
        market: {
          select: { question: true, sourceName: true, resolvedOutcomeId: true },
        },
        outcome: { select: { label: true } },
      },
    });

    const candidates: CallCandidate[] = positions.map((position) => ({
      userId: position.userId,
      marketId: position.marketId,
      probability: Math.min(1, Math.max(0, Number(position.avgPrice))),
      won: position.market.resolvedOutcomeId === position.outcomeId,
      category: topicKeyFor(position.market.question, position.market.sourceName),
    }));

    const picked = topCalls(candidates, limit);

    // Replaced wholesale: a re-run must not leave last run's proposals beside
    // this run's. Anything a person already featured is kept.
    await this.prisma.topCall.deleteMany({ where: { week, featured: false } });

    for (const call of picked) {
      const source = positions.find(
        (position) => position.userId === call.userId && position.marketId === call.marketId,
      );
      await this.prisma.topCall.create({
        data: {
          week,
          userId: call.userId,
          marketId: call.marketId,
          entryPrice: call.probability,
          resolvedOutcome: source?.outcome.label ?? '',
          featured: false,
        },
      });
    }

    logger.info({ week, proposed: picked.length }, 'top calls proposed for curation');
    return { proposed: picked.length };
  }
}

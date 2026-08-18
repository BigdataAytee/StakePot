import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LeaderboardBoard } from '@prisma/client';

import { AnalyticsService } from '../analytics/analytics.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_TIME,
  bestStreak,
  currentStreak,
  isoWeekOf,
  rank,
  weekWindow,
  type BoardRules,
  type Ranked,
  type TraderRecord,
} from './scoring';

/**
 * §2.8's leaderboards.
 *
 * "Weekly + all-time leaderboards (profit, accuracy %)."
 *
 * Computed from **settled markets only**. A board that counted open positions
 * would rank people on paper gains that can still evaporate, and the weekly
 * winner would change every time a price moved — which is not a competition, it
 * is a ticker. So a market contributes to somebody's record on the day it
 * resolves, and never before.
 *
 * The read path never touches the write path (§11): boards are served from
 * snapshots, and the sweep that computes them is the only thing that scans.
 */
@Injectable()
export class LeaderboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly analytics: AnalyticsService,
  ) {}

  async rules(): Promise<BoardRules> {
    const [minMarketsForAccuracy, minStakedForProfit, minTier] = await Promise.all([
      this.config.get('leaderboard_min_markets_accuracy'),
      this.config.get('leaderboard_min_staked_profit'),
      this.config.get('leaderboard_min_tier'),
    ]);
    return { minMarketsForAccuracy, minStakedForProfit, minTier };
  }

  /**
   * Everybody's record over a period, counted from the markets that settled in
   * it.
   *
   * Stake and return are read from the **ledger**, not from the trades table:
   * the ledger is what actually moved, it already nets early exits, and it is
   * the record the money room reconciles against. Two sources for one number is
   * how a leaderboard ends up disagreeing with a wallet.
   */
  async records(period: string): Promise<readonly TraderRecord[]> {
    const window = period === ALL_TIME ? null : weekWindow(period);

    // A market's settlement moment is `resolutions.finalizedAt` — the instant a
    // human posted the Final Resolution and the payout ran (§2.6). Every
    // resolved market has exactly one such row, including an official market
    // settled without a proposal, so this is a complete filter rather than a
    // partial one.
    const markets = await this.prisma.market.findMany({
      where: {
        state: 'resolved',
        resolvedOutcomeId: { not: null },
        ...(window === null
          ? {}
          : {
              resolutions: {
                some: { finalizedAt: { gte: window.start, lt: window.end } },
              },
            }),
      },
      select: { id: true, resolvedOutcomeId: true },
    });
    if (markets.length === 0) return [];

    const marketIds = markets.map((market) => market.id);
    const winners = new Map(markets.map((market) => [market.id, market.resolvedOutcomeId]));

    // What each person put in and got back on those markets.
    //
    // Grouped by fund class as well as type, and that is load-bearing: a
    // `trade_buy` writes *two* legs — money out of `user_available` and the same
    // money into `user_escrow` — so a sum across both cancels to zero. What
    // left their balance is the `user_available` leg alone, and what came back
    // is the `user_available` leg of the payout (the escrow release is a
    // different leg of the same transaction, not a gain).
    const money = await this.prisma.ledgerEntry.groupBy({
      by: ['userId', 'type', 'fundClass'],
      where: {
        marketId: { in: marketIds },
        type: { in: ['trade_buy', 'trade_sell', 'payout'] },
        fundClass: 'user_available',
      },
      _sum: { amount: true },
    });

    // Who held what when it settled, so "won" means held the winning outcome.
    const positions = await this.prisma.position.findMany({
      where: { marketId: { in: marketIds }, shares: { gt: 0 } },
      select: { userId: true, marketId: true, outcomeId: true },
    });

    const staked = new Map<string, Prisma.Decimal>();
    const returned = new Map<string, Prisma.Decimal>();
    for (const row of money) {
      const amount = row._sum.amount ?? new Prisma.Decimal(0);
      // An early exit (§2.3) is money coming back, so it counts as a return
      // rather than as un-staking: the risk was taken and then closed out.
      const target = row.type === 'trade_buy' ? staked : returned;
      const current = target.get(row.userId) ?? new Prisma.Decimal(0);
      target.set(row.userId, current.plus(amount.abs()));
    }

    const settledPerUser = new Map<string, Set<string>>();
    const wonPerUser = new Map<string, Set<string>>();
    for (const position of positions) {
      const settledSet = settledPerUser.get(position.userId) ?? new Set<string>();
      settledSet.add(position.marketId);
      settledPerUser.set(position.userId, settledSet);

      if (winners.get(position.marketId) === position.outcomeId) {
        const wonSet = wonPerUser.get(position.userId) ?? new Set<string>();
        wonSet.add(position.marketId);
        wonPerUser.set(position.userId, wonSet);
      }
    }

    const userIds = [...new Set([...staked.keys(), ...settledPerUser.keys()])].filter(
      (id) => !id.startsWith('sys_'),
    );
    if (userIds.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, tier: true },
    });
    const tiers = new Map(users.map((user) => [user.id, user.tier]));

    return userIds.map((userId) => ({
      userId,
      staked: Number(staked.get(userId) ?? 0),
      returned: Number(returned.get(userId) ?? 0),
      marketsWon: wonPerUser.get(userId)?.size ?? 0,
      marketsSettled: settledPerUser.get(userId)?.size ?? 0,
      tier: tiers.get(userId) ?? 0,
    }));
  }

  /** A person's settled results, newest first — the input to §2.8's streaks. */
  async streakOf(userId: string): Promise<{ current: number; best: number }> {
    const positions = await this.prisma.position.findMany({
      where: { userId, shares: { gt: 0 }, market: { state: 'resolved' } },
      select: {
        outcomeId: true,
        market: {
          select: {
            resolvedOutcomeId: true,
            resolutions: {
              where: { finalizedAt: { not: null } },
              orderBy: { finalizedAt: 'desc' },
              take: 1,
              select: { finalizedAt: true },
            },
          },
        },
      },
    });

    const ordered = positions
      .filter((position) => position.market.resolvedOutcomeId !== null)
      .sort((left, right) => {
        const l = left.market.resolutions[0]?.finalizedAt?.getTime() ?? 0;
        const r = right.market.resolutions[0]?.finalizedAt?.getTime() ?? 0;
        return r - l;
      })
      .map((position) => position.market.resolvedOutcomeId === position.outcomeId);

    return { current: currentStreak(ordered), best: bestStreak([...ordered].reverse()) };
  }

  /**
   * Compute and store a board.
   *
   * The snapshot is the published standing: written once per period per board,
   * and replaced wholesale rather than patched, so a row can never survive from
   * a computation whose inputs have since changed.
   */
  async snapshot(params: {
    period: string;
    board: LeaderboardBoard;
    now?: Date;
  }): Promise<{ entries: number }> {
    const rules = await this.rules();
    const records = await this.records(params.period);
    const ranked = rank(records, params.board, rules);

    const streaks = new Map<string, number>();
    for (const entry of ranked) {
      streaks.set(entry.userId, (await this.streakOf(entry.userId)).current);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.leaderboardSnapshot.deleteMany({
        where: { period: params.period, board: params.board },
      });
      if (ranked.length === 0) return;

      await tx.leaderboardSnapshot.createMany({
        data: ranked.map((entry) => ({
          period: params.period,
          board: params.board,
          userId: entry.userId,
          rank: entry.rank,
          profit: new Prisma.Decimal(entry.profit.toFixed(18)),
          accuracy: new Prisma.Decimal(entry.accuracy.toFixed(18)),
          staked: new Prisma.Decimal(entry.staked.toFixed(18)),
          marketsSettled: entry.marketsSettled,
          marketsWon: Math.round(entry.accuracy * entry.marketsSettled),
          streak: streaks.get(entry.userId) ?? 0,
          computedAt: params.now ?? new Date(),
        })),
      });
    });

    await this.analytics.record('leaderboard_snapshot', {
      period: params.period,
      board: params.board,
      entries: ranked.length,
    });

    return { entries: ranked.length };
  }

  /** Refresh every board a sweep is responsible for. */
  async snapshotAll(now = new Date()): Promise<Record<string, number>> {
    const period = isoWeekOf(now);
    const result: Record<string, number> = {};

    for (const board of ['profit', 'accuracy'] as const) {
      result[`${period}:${board}`] = (await this.snapshot({ period, board, now })).entries;
      result[`${ALL_TIME}:${board}`] = (
        await this.snapshot({ period: ALL_TIME, board, now })
      ).entries;
    }
    return result;
  }

  /** The published board. Served from the snapshot, never recomputed on read. */
  async board(params: { period: string; board: LeaderboardBoard; take?: number }) {
    const pageSize = params.take ?? (await this.config.get('leaderboard_page_size'));

    const rows = await this.prisma.leaderboardSnapshot.findMany({
      where: { period: params.period, board: params.board },
      orderBy: { rank: 'asc' },
      take: Math.min(pageSize, 200),
      include: { user: { select: { handle: true, displayName: true } } },
    });

    return rows.map((row) => ({
      rank: row.rank,
      userId: row.userId,
      handle: row.user.handle,
      displayName: row.user.displayName,
      profit: row.profit.toString(),
      accuracyPct: Math.round(Number(row.accuracy) * 1000) / 10,
      marketsSettled: row.marketsSettled,
      marketsWon: row.marketsWon,
      streak: row.streak,
      staked: row.staked.toString(),
    }));
  }

  /** Where one person stands, for their profile. */
  async standingOf(userId: string, period: string) {
    const rows = await this.prisma.leaderboardSnapshot.findMany({
      where: { userId, period },
    });

    return rows.map((row) => ({
      board: row.board,
      rank: row.rank,
      profit: row.profit.toString(),
      accuracyPct: Math.round(Number(row.accuracy) * 1000) / 10,
      streak: row.streak,
    }));
  }

  /** Which periods have a published board, newest first. */
  async periods(): Promise<readonly string[]> {
    const rows = await this.prisma.leaderboardSnapshot.findMany({
      distinct: ['period'],
      select: { period: true },
      orderBy: { period: 'desc' },
      take: 30,
    });
    return rows.map((row) => row.period);
  }

  /** Ranked entries for a period, used by the prize tool to draw up a run. */
  async rankedFor(period: string, board: LeaderboardBoard): Promise<readonly Ranked[]> {
    const rules = await this.rules();
    return rank(await this.records(period), board, rules);
  }
}

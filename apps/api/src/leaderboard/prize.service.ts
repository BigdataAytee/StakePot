import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LeaderboardBoard } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { AnalyticsService } from '../analytics/analytics.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { type Tx } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

export class PrizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrizeError';
  }
}

/**
 * §2.8's prize tool: "airtime/data prize distribution tool for weekly winners
 * (promotional competition, points phase)".
 *
 * Three properties make this safe to point at real winners.
 *
 * A run is **drawn up before it is paid**. The awards exist as rows a reviewer
 * can read — who, what rank, how much — and the money only moves when a second
 * pair of eyes signs the run through §2.10's approvals workflow (§6.8: "approve
 * airtime payouts"). Nothing here credits anybody directly.
 *
 * It **pays from a snapshot, not from a live board**. A run drawn against a
 * board that is still moving would pay whoever happened to be top at the moment
 * of approval, which is not the competition anybody entered.
 *
 * And it **only ever pays Tier 1** (§2.1: "prizes and creator fees pay out only
 * to Tier 1+"), checked again at payment rather than trusted from draw time.
 */
@Injectable()
export class PrizeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly audit: AdminAuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * The default split across places: a decreasing weight, normalised.
   *
   * Weight `1/rank` rather than an equal split, because a competition that pays
   * tenth the same as first is not a competition. The last place carries the
   * division's remainder so the awards sum to the pot exactly.
   */
  private shares(places: number, pot: Decimal): readonly Decimal[] {
    const weights = Array.from({ length: places }, (_, index) => new Decimal(1).div(index + 1));
    const total = weights.reduce((acc, weight) => acc.plus(weight), new Decimal(0));

    const amounts: Decimal[] = [];
    let allocated = new Decimal(0);
    for (const [index, weight] of weights.entries()) {
      const last = index === places - 1;
      const amount = last
        ? pot.minus(allocated)
        : pot.times(weight).div(total).toDecimalPlaces(18, Decimal.ROUND_DOWN);
      allocated = allocated.plus(amount);
      amounts.push(amount);
    }
    return amounts;
  }

  /**
   * Draw up a run from a published board.
   *
   * Refuses when the board has not been snapshotted: paying against numbers
   * nobody published is how a prize run becomes an argument.
   */
  async draft(params: {
    period: string;
    board: LeaderboardBoard;
    staffId: string;
    places?: number;
    poolSpc?: string;
    note?: string;
  }): Promise<{ runId: string; awards: number; total: string }> {
    const existing = await this.prisma.prizeRun.findUnique({
      where: { period_board: { period: params.period, board: params.board } },
    });
    if (existing !== null && existing.state !== 'cancelled') {
      throw new PrizeError(`this period already has a ${existing.state} run`);
    }

    const places = params.places ?? (await this.config.get('prize_places'));
    const pot = new Decimal(params.poolSpc ?? (await this.config.get('prize_pool_spc')));
    if (pot.lte(0)) throw new PrizeError('a prize run needs a pot');

    const standings = await this.prisma.leaderboardSnapshot.findMany({
      where: { period: params.period, board: params.board },
      orderBy: { rank: 'asc' },
      take: places,
      include: { user: { select: { tier: true } } },
    });
    if (standings.length === 0) {
      throw new PrizeError('that board has not been published yet');
    }

    // §2.1's gate, applied at draw time so a reviewer never sees an award that
    // cannot be paid. It is checked again at payment, because a tier can change
    // between drawing a run up and signing it.
    const minTier = await this.config.get('leaderboard_min_tier');
    const winners = standings.filter((row) => row.user.tier >= minTier);
    if (winners.length === 0) {
      throw new PrizeError('nobody on that board is verified — prizes need Tier 1 (§2.1)');
    }

    const amounts = this.shares(winners.length, pot);
    const total = amounts.reduce((acc, amount) => acc.plus(amount), new Decimal(0));

    const run = await this.prisma.$transaction(async (tx) => {
      if (existing !== null) {
        await tx.prizeRun.delete({ where: { id: existing.id } });
      }
      const created = await tx.prizeRun.create({
        data: {
          period: params.period,
          board: params.board,
          state: 'draft',
          totalAmount: new Prisma.Decimal(total.toString()),
          createdBy: params.staffId,
          ...(params.note === undefined ? {} : { note: params.note }),
        },
      });
      await tx.prizeAward.createMany({
        data: winners.map((row, index) => ({
          runId: created.id,
          userId: row.userId,
          rank: row.rank,
          amount: new Prisma.Decimal((amounts[index] ?? new Decimal(0)).toString()),
        })),
      });
      return created;
    });

    await this.audit.record({
      staffId: params.staffId,
      action: 'prize.draft',
      targetRef: `prize_run:${run.id}`,
      after: {
        period: params.period,
        board: params.board,
        awards: winners.length,
        total: total.toString(),
      },
      ip: 'unknown',
    });

    return { runId: run.id, awards: winners.length, total: total.toString() };
  }

  /** Mark a drawn-up run as awaiting its second signature. */
  async submit(runId: string, approvalId: string): Promise<void> {
    const run = await this.prisma.prizeRun.findUnique({ where: { id: runId } });
    if (run === null) throw new PrizeError('no such run');
    if (run.state !== 'draft') throw new PrizeError(`this run is already ${run.state}`);

    await this.prisma.prizeRun.update({
      where: { id: runId },
      data: { state: 'pending_approval', approvalId },
    });

    await this.analytics.record('prize_run_proposed', {
      period: run.period,
      board: run.board,
      total: run.totalAmount.toString(),
      awards: await this.prisma.prizeAward.count({ where: { runId } }),
    });
  }

  /**
   * Pay a run. Called **only** by the approvals executor, inside its
   * transaction, after two people have signed it.
   *
   * Idempotent by state: a redelivered approval cannot pay a run twice, which
   * on a promotional payout is the difference between a competition and a leak.
   */
  async pay(tx: Tx, runId: string): Promise<{ paid: number; total: string }> {
    const run = await tx.prizeRun.findUnique({
      where: { id: runId },
      include: { awards: true },
    });
    if (run === null) throw new PrizeError('no such run');
    if (run.state === 'paid') throw new PrizeError('this run has already been paid');
    if (run.state === 'cancelled') throw new PrizeError('this run was cancelled');

    const winners = await tx.user.findMany({
      where: { id: { in: run.awards.map((award) => award.userId) } },
      select: { id: true, tier: true },
    });
    const tiers = new Map(winners.map((winner) => [winner.id, winner.tier]));

    let paid = 0;
    let total = new Decimal(0);
    for (const award of run.awards) {
      // Re-checked here, not trusted from draw time: §2.1's gate is about who
      // may receive money, and a tier can change between draw and payment.
      if ((tiers.get(award.userId) ?? 0) < 1) continue;

      const amount = new Decimal(award.amount.toString());
      if (amount.lte(0)) continue;

      await this.wallet.issue({
        userId: award.userId,
        amount,
        type: 'prize',
        ref: `prize:${runId}:${award.userId}`,
        tx,
      });
      paid += 1;
      total = total.plus(amount);
    }

    await tx.prizeRun.update({
      where: { id: runId },
      data: {
        state: 'paid',
        paidAt: new Date(),
        totalAmount: new Prisma.Decimal(total.toString()),
      },
    });

    return { paid, total: total.toString() };
  }

  /** Tell the winners, after the money has moved. */
  async announce(runId: string): Promise<number> {
    const run = await this.prisma.prizeRun.findUnique({
      where: { id: runId },
      include: { awards: { orderBy: { rank: 'asc' } } },
    });
    if (run === null || run.state !== 'paid') return 0;

    for (const award of run.awards) {
      await this.notifications.notify({
        userId: award.userId,
        type: 'prize',
        body: `You finished #${award.rank} on the ${run.board} board for ${run.period}. ${new Decimal(
          award.amount.toString(),
        ).toFixed(0)} SPC is in your balance.`,
        data: { period: run.period, board: run.board, rank: String(award.rank) },
      });
    }

    await this.analytics.record('prize_paid', {
      period: run.period,
      board: run.board,
      total: run.totalAmount.toString(),
      awards: run.awards.length,
    });

    return run.awards.length;
  }

  async cancel(runId: string, staffId: string): Promise<void> {
    const run = await this.prisma.prizeRun.findUnique({ where: { id: runId } });
    if (run === null) throw new PrizeError('no such run');
    if (run.state === 'paid') throw new PrizeError('a paid run cannot be cancelled');

    await this.prisma.prizeRun.update({ where: { id: runId }, data: { state: 'cancelled' } });
    await this.audit.record({
      staffId,
      action: 'prize.cancel',
      targetRef: `prize_run:${runId}`,
      before: { state: run.state },
      after: { state: 'cancelled' },
      ip: 'unknown',
    });
  }

  async runs(take = 20) {
    const rows = await this.prisma.prizeRun.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        awards: {
          orderBy: { rank: 'asc' },
          include: { user: { select: { handle: true, displayName: true, tier: true } } },
        },
      },
    });

    return rows.map((run) => ({
      id: run.id,
      period: run.period,
      board: run.board,
      state: run.state,
      total: run.totalAmount.toString(),
      note: run.note,
      paidAt: run.paidAt,
      createdAt: run.createdAt,
      awards: run.awards.map((award) => ({
        rank: award.rank,
        userId: award.userId,
        handle: award.user.handle,
        displayName: award.user.displayName,
        tier: award.user.tier,
        amount: award.amount.toString(),
      })),
    }));
  }
}

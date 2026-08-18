import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { type Tx } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AutopsyService } from '../creator/autopsy.service';
import { CreatorService } from '../creator/creator.service';
import { WalletService } from '../wallet/wallet.service';
import { decideActivation, type ActivationRules, type OutcomeFunding } from './activation';
import { screenTemplate, type MarketTemplate } from './market-template';
import { MarketVoidService } from './void.service';

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
    private readonly voids: MarketVoidService,
    private readonly notifications: NotificationsService,
    private readonly creators: CreatorService,
    private readonly autopsies: AutopsyService,
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
    /**
     * Path A opens a funding window; Path B waits in `draft` for the creator's
     * symmetric seed or a seeding round, and opens the moment one lands (§2.4).
     */
    activationPath?: 'organic' | 'seeded';
    now?: Date;
  }): Promise<{ marketId: string; fundingClosesAt: Date | null }> {
    const now = params.now ?? new Date();
    const problems = screenTemplate(params.template, { now });
    if (problems.length > 0) {
      throw new CommunityMarketError(problems.map((p) => p.message).join(' '));
    }

    // §2.14c's ladder, applied where it costs something. A level is only worth
    // holding if it changes what you may do, so the cap and the bond are read
    // here rather than described on a profile screen.
    // A profile exists from the first market, not from the first settlement:
    // §2.14c's profile is public, and a creator with something live must be
    // followable before anybody has to look them up.
    await this.creators.ensureProfile(params.creatorId);
    const privileges = await this.creators.privilegesOf(params.creatorId);

    const live = await this.prisma.market.count({
      where: {
        creatorId: params.creatorId,
        state: { in: ['draft', 'seeding', 'funding', 'active', 'frozen', 'dispute_window'] },
      },
    });
    if (live >= privileges.maxLiveMarkets) {
      throw new CommunityMarketError(
        `a level ${privileges.level} creator can run ${privileges.maxLiveMarkets} market${
          privileges.maxLiveMarkets === 1 ? '' : 's'
        } at a time — settle one before opening another`,
      );
    }

    const baseBond = new Decimal(await this.config.get('conduct_bond_spc'));
    // Level 2's "reduced bond" (§2.14c). Rounded down to the storage quantum so
    // a multiplier can never produce a bond the wallet cannot hold exactly.
    const bond = baseBond.times(privileges.bondMultiplier).toDecimalPlaces(18, Decimal.ROUND_DOWN);
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

    const path = params.activationPath ?? 'organic';
    // Path B's window still exists — it is what the participation floor is
    // measured against — but it only starts once the seed is in, so the market
    // waits in `draft` until then rather than quietly taking stakes.
    const fundingClosesAt =
      path === 'organic' ? new Date(now.getTime() + windowHours * 3_600_000) : null;

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
          // Fixed now, not read at settlement: §2.14a showed this creator an
          // earnings preview, and the preview is a promise.
          creatorBps: privileges.creatorBps,
          activationPath: path,
          ...(fundingClosesAt === null ? {} : { fundingClosesAt }),
          // Path A: the market takes stakes but does not trade until the window
          // closes and the floors are met.
          state: path === 'organic' ? 'funding' : 'draft',
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
              label:
                path === 'organic'
                  ? `Funding window open for ${windowHours}h`
                  : 'Awaiting the creator’s symmetric seed',
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

      return { marketId: market.id, fundingClosesAt };
    });
  }

  /**
   * A market's window has run out. What that means depends on how it opened.
   *
   * Path A is deciding whether to exist at all — the window either fills or the
   * market voids. Path B already exists and has been trading; its window is the
   * participation floor's deadline. One entry point so the job that fires on a
   * deadline does not have to know which, and cannot pick wrong.
   */
  async closeWindow(marketId: string): Promise<{
    outcome: 'activated' | 'confirmed' | 'voided' | 'skipped';
    reason?: string;
  }> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: { activationPath: true },
    });
    if (market === null) return { outcome: 'skipped' };
    return market.activationPath === 'seeded'
      ? this.closeParticipationWindow(marketId)
      : this.closeFundingWindow(marketId);
  }

  /**
   * Path B's deadline: did anyone else turn up? (§2.4, Rulebook Part 3 §2.)
   *
   * "If fewer than [10] distinct users other than the creator have staked by the
   * end of the Funding Window, the market voids and all stakes — including the
   * full seed — are refunded."
   *
   * A seed is liquidity, not interest, and this is the rule that says so: money
   * the creator put up cannot stand in for a crowd. Sponsors count only for what
   * they staked directionally — their seed contribution is not a stake (§3).
   *
   * Idempotent by `fundingClosesAt`: a market whose floor has already been
   * settled has no window left to close.
   */
  async closeParticipationWindow(marketId: string): Promise<{
    outcome: 'confirmed' | 'voided' | 'skipped';
    reason?: string;
  }> {
    const floor = await this.config.get('participation_floor_users');

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;

      const market = await tx.market.findUniqueOrThrow({ where: { id: marketId } });
      if (market.state !== 'active' || market.fundingClosesAt === null) {
        return { outcome: 'skipped' as const };
      }

      const stakers = await tx.trade.findMany({
        where: {
          marketId,
          side: 'buy',
          ...(market.creatorId === null ? {} : { userId: { not: market.creatorId } }),
        },
        distinct: ['userId'],
        select: { userId: true },
      });

      if (stakers.length >= floor) {
        await tx.market.update({ where: { id: marketId }, data: { fundingClosesAt: null } });
        await tx.marketAnnotation.create({
          data: {
            marketId,
            type: 'activation',
            label: `Participation floor met — ${stakers.length} backers`,
          },
        });
        return { outcome: 'confirmed' as const };
      }

      const reason = `only ${stakers.length} of ${floor} backers staked`;
      const refunded = await this.voids.voidAndRefund(tx, marketId, reason);
      return { outcome: 'voided' as const, reason, refunded };
    });

    await this.announceRefunds(result, marketId);

    // §2.14d's autopsy covers every close, not only the happy one — a creator
    // whose market voided is exactly the one with something to learn. Nothing
    // is announced here: a Path B market has been trading since its seed
    // landed, so its followers were told then.
    if (result.outcome === 'voided') {
      await this.autopsies.record({
        marketId,
        kind: 'voided',
        ...(result.reason === undefined ? {} : { voidReason: result.reason }),
      });
    }
    return result;
  }

  /**
   * Tell everyone their money is back — after the commit, never before.
   *
   * A refund notification that arrives ahead of the transaction it describes is
   * a message that can turn out to be false, and this is the one topic where
   * that is unacceptable.
   */
  private async announceRefunds(
    result: { outcome: string; reason?: string; refunded?: readonly { userId: string }[] },
    marketId: string,
  ): Promise<void> {
    if (result.outcome !== 'voided' || result.refunded === undefined) return;
    for (const row of result.refunded) {
      await this.notifications.notify({
        userId: row.userId,
        type: 'refund',
        body: `A market you backed was voided — ${result.reason ?? 'it did not go ahead'}. Every naira is back in your balance.`,
        data: { marketId },
      });
    }
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

    const result = await this.prisma.$transaction(async (tx) => {
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
        await tx.market.update({
          where: { id: marketId },
          data: { state: 'active', fundingClosesAt: null },
        });
        await tx.marketAnnotation.create({
          data: { marketId, type: 'activation', label: 'Activated — trading is open' },
        });
        return { outcome: 'activated' as const };
      }

      const refunded = await this.voidAndRefund(tx, marketId, decision.reason);
      return { outcome: 'voided' as const, reason: decision.reason, refunded };
    });

    await this.announceRefunds(result, marketId);

    // §2.14c: "followers are notified when a creator opens a market". Opening
    // means trading is open, not that a draft exists — a follower sent to a
    // market that cannot be staked on learns to ignore the next one.
    if (result.outcome === 'activated') {
      await this.creators.announceMarket(marketId);
    }
    if (result.outcome === 'voided') {
      await this.autopsies.record({
        marketId,
        kind: 'voided',
        ...(result.reason === undefined ? {} : { voidReason: result.reason }),
      });
    }
    return result;
  }

  /**
   * Void a market and return every naira in it — stakes, seeds and the bond.
   *
   * The bond comes back because failing to attract stakes is not misconduct.
   * §2.4 says "full refund including seed"; forfeiting a bond is for a creator
   * who resolved dishonestly, which is a `bond.forfeit` proposal through the
   * four-eyes workflow (§2.10) — never a method on this service.
   */
  private async voidAndRefund(tx: Tx, marketId: string, reason: string) {
    return this.voids.voidAndRefund(tx, marketId, reason);
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

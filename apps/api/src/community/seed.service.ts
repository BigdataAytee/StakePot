import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Market, Outcome } from '@prisma/client';
import { Decimal, seed as engineSeed } from '@stakeam/engine';

import { type Tx } from '../ledger/ledger.service';
import { toEngineState } from '../market/market-state';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { SYSTEM_PLATFORM_ACCOUNT } from '../ledger/posting';
import { CreatorService } from '../creator/creator.service';
import { MarketVoidService } from './void.service';

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

const dec = (value: Decimal): Prisma.Decimal => new Prisma.Decimal(value.toString());

/** One sponsor's money, on its way into the seed. */
export interface Contribution {
  readonly userId: string;
  readonly amount: Decimal;
}

export interface SeedApplied {
  readonly total: Decimal;
  readonly perOutcome: Decimal;
  readonly sharesPerOutcome: Decimal;
}

/**
 * Path B activation: symmetric seeds, solo and syndicated (§2.4, Rulebook
 * Part 3 §2–§3).
 *
 * A seed is the one way money enters a market without taking a side. The engine
 * makes that literal — adding the same share count to every outcome costs
 * exactly the money paid and moves no price — and this service's job is to keep
 * it literal all the way down to the ledger: equal money in every pool, every
 * share attributed to whoever paid for it, and a full refund available right up
 * until the participation floor is met.
 *
 * The creator is otherwise barred from staking in their own market (§2.5). The
 * seed is the single exception the rulebook allows, and it is safe precisely
 * because it is symmetric: a creator who holds every outcome equally has nothing
 * to gain from the outcome they themselves will propose.
 */
@Injectable()
export class SeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly wallet: WalletService,
    private readonly voids: MarketVoidService,
    private readonly creators: CreatorService,
  ) {}

  /**
   * Path B, funded by the creator alone. The market opens immediately.
   *
   * The participation floor is not waived by seeding — it is deferred. The
   * window still closes on schedule and still voids a market that never found
   * a crowd, seed included (§2.4).
   */
  async seedSolo(params: {
    marketId: string;
    userId: string;
    /** Money into each pool. Defaults to the configured Symmetric Seed minimum. */
    perOutcome?: string;
  }): Promise<SeedApplied & { fundingClosesAt: Date }> {
    const minimum = new Decimal(await this.config.get('symmetric_seed_per_outcome_spc'));
    const perOutcome = params.perOutcome === undefined ? minimum : new Decimal(params.perOutcome);
    if (perOutcome.lt(minimum)) {
      throw new SeedError(
        `the Symmetric Seed is at least ${minimum.toString()} into each pool — ` +
          `${perOutcome.toString()} is short`,
      );
    }
    const windowHours = await this.config.get('funding_window_hours');

    const result = await this.prisma.$transaction(async (tx) => {
      const market = await this.lockSeedable(tx, params.marketId);
      if (market.creatorId !== params.userId) {
        throw new SeedError('only the creator can post this market’s seed');
      }

      const total = perOutcome.times(market.outcomes.length);
      await this.wallet.escrow({
        userId: params.userId,
        marketId: market.id,
        amount: total,
        type: 'seed',
        ref: `seed:${market.id}`,
        tx,
      });

      const applied = await this.applySeed(tx, market, [{ userId: params.userId, amount: total }]);

      const fundingClosesAt = new Date(Date.now() + windowHours * 3_600_000);
      await this.activate(tx, market.id, fundingClosesAt, 'Seeded — trading is open');
      return { ...applied, fundingClosesAt };
    });

    // §2.14c's follow system, after the commit: a follower told about a market
    // whose seed then rolled back would be sent to something that does not
    // exist.
    await this.creators.announceMarket(params.marketId);
    return result;
  }

  /**
   * The platform's own seed on an official market (§2.4).
   *
   * "Official markets skip funding: platform seeds them and they open active."
   * The house puts equal money on every outcome — the same symmetric grant a
   * creator posts, so it moves no price and takes no side — and the market opens
   * for trading immediately, with no funding window and no participation floor.
   *
   * In points mode the seed is issued rather than taken from fees: SPC is a
   * currency the platform mints anyway (starter balances, bonuses), and the
   * issuance shows up on the proof-of-reserves line like every other. When NGN
   * activates (§9) this must be funded from platform money instead — a house
   * seed backed by nothing is exactly what the fund-tagging rules exist to
   * prevent.
   */
  async seedOfficial(params: { marketId: string; perOutcome?: string }): Promise<SeedApplied> {
    const perOutcome = new Decimal(
      params.perOutcome ?? (await this.config.get('official_seed_per_outcome_spc')),
    );
    if (perOutcome.lte(0)) throw new SeedError('an official seed must be greater than zero');

    return this.prisma.$transaction(async (tx) => {
      const market = await this.lockSeedable(tx, params.marketId, ['draft'], 'official');
      const total = perOutcome.times(market.outcomes.length);

      await this.wallet.issue({
        userId: SYSTEM_PLATFORM_ACCOUNT,
        amount: total,
        type: 'seed',
        ref: `official-seed:${market.id}`,
        tx,
      });
      await this.wallet.escrow({
        userId: SYSTEM_PLATFORM_ACCOUNT,
        marketId: market.id,
        amount: total,
        type: 'seed',
        ref: `official-seed:${market.id}`,
        tx,
      });

      const applied = await this.applySeed(tx, market, [
        { userId: SYSTEM_PLATFORM_ACCOUNT, amount: total },
      ]);

      await tx.market.update({
        where: { id: market.id },
        data: { state: 'active', activationPath: 'seeded' },
      });
      await tx.marketAnnotation.create({
        data: { marketId: market.id, type: 'activation', label: 'Open for trading' },
      });

      return applied;
    });
  }

  /**
   * Open a Seeding Round (Part 3 §3).
   *
   * Every term is written down here and never again: the minimum per pool, the
   * smallest contribution, the sponsor cap, the fee split. "The split is
   * displayed on the market page before any sponsor joins and is locked once the
   * Seeding Round opens" — locked means the row is written before the first
   * contribution can arrive, and nothing updates it afterwards.
   */
  async openSeedingRound(params: {
    marketId: string;
    creatorId: string;
    /** Organiser's cut of the syndicate fee, in basis points. 0 = pure pro-rata. */
    organiserBps?: number;
    roundHours?: number;
  }): Promise<{ syndicateId: string; roundEndsAt: Date; minTotal: Decimal }> {
    const organiserBps = params.organiserBps ?? 0;
    if (!Number.isInteger(organiserBps) || organiserBps < 0 || organiserBps > 10_000) {
      throw new SeedError('the organiser split must be whole basis points within 0–10,000');
    }

    const perOutcomeMin = new Decimal(await this.config.get('symmetric_seed_per_outcome_spc'));
    const minContribution = new Decimal(await this.config.get('syndicate_min_contribution_spc'));
    const maxSponsors = await this.config.get('syndicate_max_sponsors');
    const roundHours = params.roundHours ?? (await this.config.get('syndicate_round_hours'));

    return this.prisma.$transaction(async (tx) => {
      const market = await this.lockSeedable(tx, params.marketId);
      if (market.creatorId !== params.creatorId) {
        throw new SeedError('only the creator can open a seeding round');
      }
      const existing = await tx.syndicate.findUnique({ where: { marketId: market.id } });
      if (existing !== null) {
        throw new SeedError(`this market already has a seeding round (${existing.state})`);
      }

      const roundEndsAt = new Date(Date.now() + roundHours * 3_600_000);
      const minTotal = perOutcomeMin.times(market.outcomes.length);

      const syndicate = await tx.syndicate.create({
        data: {
          marketId: market.id,
          creatorId: params.creatorId,
          roundEndsAt,
          minTotal: dec(minTotal),
          perOutcomeMin: dec(perOutcomeMin),
          minContribution: dec(minContribution),
          maxSponsors,
          organiserBps,
        },
      });

      // The market waits in `seeding` — the one state that exists purely so a
      // round can be open without the market taking stakes (§2.4).
      await tx.market.update({
        where: { id: market.id },
        data: { state: 'seeding', activationPath: 'seeded' },
      });
      await tx.marketAnnotation.create({
        data: {
          marketId: market.id,
          type: 'open',
          label: `Seeding round open — ${minTotal.toString()} needed in ${roundHours}h`,
        },
      });

      return { syndicateId: syndicate.id, roundEndsAt, minTotal };
    });
  }

  /**
   * Join a Seeding Round, and activate the market the moment it fills.
   *
   * The contribution is escrowed as it arrives rather than pledged: a round that
   * fills has the money already, and a round that fails refunds from escrow
   * without having to chase anybody. Filling is checked in the same transaction
   * as the contribution that fills it, under the market's row lock, so two
   * sponsors arriving together cannot both activate the market.
   */
  async contribute(params: {
    marketId: string;
    userId: string;
    amount: string;
  }): Promise<{ total: Decimal; filled: boolean; sponsors: number }> {
    const amount = new Decimal(params.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const market = await this.lockSeedable(tx, params.marketId, ['seeding']);
      const syndicate = await tx.syndicate.findUnique({
        where: { marketId: market.id },
        include: { members: true },
      });
      if (syndicate === null) throw new SeedError('this market has no seeding round');
      if (syndicate.state !== 'open') {
        throw new SeedError(`the seeding round is ${syndicate.state}`);
      }
      if (syndicate.roundEndsAt.getTime() <= Date.now()) {
        throw new SeedError('the seeding round has closed');
      }

      const minContribution = new Decimal(syndicate.minContribution.toString());
      if (amount.lt(minContribution)) {
        throw new SeedError(
          `the smallest contribution is ${minContribution.toString()} — ` +
            `${amount.toString()} is short`,
        );
      }

      const already = syndicate.members.find((m) => m.userId === params.userId);
      if (already === undefined && syndicate.members.length >= syndicate.maxSponsors) {
        throw new SeedError(`this round is full at ${syndicate.maxSponsors} sponsors`);
      }

      await this.wallet.escrow({
        userId: params.userId,
        marketId: market.id,
        amount,
        type: 'seed',
        ref: `syndicate:${syndicate.id}:${params.userId}`,
        tx,
      });

      // A sponsor topping up keeps one row: the sponsor cap counts people, and
      // the fee split is pro-rata to money, so both read off the same total.
      const contribution =
        already === undefined
          ? await tx.syndicateMember.create({
              data: { syndicateId: syndicate.id, userId: params.userId, contribution: dec(amount) },
            })
          : await tx.syndicateMember.update({
              where: { id: already.id },
              data: { contribution: { increment: dec(amount) } },
            });

      const members = syndicate.members
        .filter((m) => m.id !== contribution.id)
        .map((m) => ({ userId: m.userId, amount: new Decimal(m.contribution.toString()) }))
        .concat({
          userId: params.userId,
          amount: new Decimal(contribution.contribution.toString()),
        });

      const total = members.reduce((acc, m) => acc.plus(m.amount), new Decimal(0));
      const minTotal = new Decimal(syndicate.minTotal.toString());
      if (total.lt(minTotal)) {
        return { total, filled: false, sponsors: members.length };
      }

      await this.fill(tx, market, syndicate.id, members, total);
      return { total, filled: true, sponsors: members.length };
    });

    // The contribution that fills the round is the one that opens the market.
    if (result.filled) {
      await this.creators.announceMarket(params.marketId);
    }
    return result;
  }

  /**
   * The round's deadline: fill or refund (Part 3 §3).
   *
   * "If the Seeding Round ends below the minimum, the market voids and all
   * contributions are refunded in full." Idempotent by state, because the job
   * that calls this can fire twice and refunding twice has no clean correction.
   */
  async closeSeedingRound(marketId: string): Promise<{
    outcome: 'filled' | 'voided' | 'skipped';
    reason?: string;
  }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;
      const syndicate = await tx.syndicate.findUnique({
        where: { marketId },
        include: { members: true },
      });
      if (syndicate === null || syndicate.state !== 'open') {
        return { outcome: 'skipped' as const };
      }

      const total = syndicate.members.reduce(
        (acc, m) => acc.plus(new Decimal(m.contribution.toString())),
        new Decimal(0),
      );
      const minTotal = new Decimal(syndicate.minTotal.toString());

      if (total.gte(minTotal)) {
        // Belt and braces: `contribute` fills the round the moment it is reached,
        // so this only runs if that write was lost. It is still cheaper to check
        // than to refund a round that had the money.
        const market = await this.loadMarket(tx, marketId);
        const members = syndicate.members.map((m) => ({
          userId: m.userId,
          amount: new Decimal(m.contribution.toString()),
        }));
        await this.fill(tx, market, syndicate.id, members, total);
        return { outcome: 'filled' as const };
      }

      const reason = `the seeding round reached ${total.toString()} of ${minTotal.toString()}`;
      await this.voids.voidAndRefund(tx, marketId, reason);
      return { outcome: 'voided' as const, reason };
    });

    // A filled round is the moment a syndicated market opens, so it is the
    // moment the creator's followers hear about it (§2.14c).
    if (result.outcome === 'filled') {
      await this.creators.announceMarket(marketId);
    }
    return result;
  }

  /**
   * Turn a filled round into a live market.
   *
   * Fee shares are written here and not one moment earlier: pro-rata is only
   * knowable once the round is closed, and §3 wants a split that is fixed by
   * the terms at open rather than by the order sponsors happened to arrive in.
   */
  private async fill(
    tx: Tx,
    market: MarketWithOutcomes,
    syndicateId: string,
    members: readonly Contribution[],
    total: Decimal,
  ): Promise<void> {
    await this.applySeed(tx, market, members);

    // Shares of the syndicate fee, pro-rata to money in. The last member carries
    // the remainder so the shares sum to exactly 1 — the organiser's separate cut
    // is held on the syndicate row and applied at resolution.
    let allocated = new Decimal(0);
    for (const [index, member] of members.entries()) {
      const last = index === members.length - 1;
      const share = last ? new Decimal(1).minus(allocated) : member.amount.div(total);
      allocated = allocated.plus(share);
      await tx.syndicateMember.updateMany({
        where: { syndicateId, userId: member.userId },
        data: { feeSharePct: dec(share) },
      });
    }

    await tx.syndicate.update({
      where: { id: syndicateId },
      data: { state: 'filled', filledAt: new Date() },
    });

    const windowHours = await this.config.get('funding_window_hours');
    await this.activate(
      tx,
      market.id,
      new Date(Date.now() + windowHours * 3_600_000),
      `Seeded by ${members.length} sponsor${members.length === 1 ? '' : 's'} — trading is open`,
    );
  }

  /**
   * Apply a symmetric seed and hand every sponsor their share of it.
   *
   * The engine decides the arithmetic; the numbers written here are the ones the
   * ledger can prove. `total` is money that has already been escrowed, so the
   * pot and the per-outcome stakes are derived from it exactly — the last
   * outcome carries the division's remainder, so Σ staked === pot to the digit
   * even when the total does not divide by the outcome count.
   */
  private async applySeed(
    tx: Tx,
    market: MarketWithOutcomes,
    contributions: readonly Contribution[],
  ): Promise<SeedApplied> {
    const total = contributions.reduce((acc, c) => acc.plus(c.amount), new Decimal(0));
    if (total.lte(0)) throw new SeedError('a seed must be greater than zero');

    const outcomes = [...market.outcomes].sort((a, b) => a.ordinal - b.ordinal);
    const n = outcomes.length;
    const exitFeeRate = await this.config.get('exit_fee_rate');
    const loaded = toEngineState(market, outcomes, exitFeeRate);

    // The engine refuses a seed on a market that has traded, which is the check
    // that matters — "equal money in every pool" and "equal shares of every
    // outcome" only coincide while prices are flat.
    const result = engineSeed(loaded.state, total.div(n).toString());
    const sharesPerOutcome = result.sharesPerOutcome;

    let stakedAllocated = new Decimal(0);
    for (const [index, outcome] of outcomes.entries()) {
      const last = index === n - 1;
      const staked = last ? total.minus(stakedAllocated) : total.div(n);
      stakedAllocated = stakedAllocated.plus(staked);

      await tx.outcome.update({
        where: { id: outcome.id },
        data: {
          sharesOutstanding: { increment: dec(sharesPerOutcome) },
          stakedTotal: { increment: dec(staked) },
        },
      });
      await tx.priceHistory.create({
        data: {
          marketId: market.id,
          outcomeId: outcome.id,
          // A seed moves no price. The snapshot exists so the chart has a point
          // at the moment the market gained a pot.
          price: outcome.priceCurrent,
          pot: dec(total.plus(new Decimal(market.potTotal.toString()))),
        },
      });
    }

    await tx.market.update({
      where: { id: market.id },
      data: { potTotal: { increment: dec(total) } },
    });

    // Each sponsor holds their pro-rata slice of every outcome. The last sponsor
    // takes the remainder on each outcome, because Σ positions must equal shares
    // outstanding exactly or resolution cannot pay out at all.
    for (const outcome of outcomes) {
      let allocated = new Decimal(0);
      for (const [index, contribution] of contributions.entries()) {
        const last = index === contributions.length - 1;
        const shares = last
          ? sharesPerOutcome.minus(allocated)
          : sharesPerOutcome.times(contribution.amount).div(total);
        allocated = allocated.plus(shares);

        const money = contribution.amount.div(n);
        await this.creditSeedPosition(tx, {
          market,
          outcome,
          userId: contribution.userId,
          shares,
          money,
        });
      }
    }

    return { total, perOutcome: total.div(n), sharesPerOutcome };
  }

  /** One sponsor's slice of one outcome: a position, and a trade for the record. */
  private async creditSeedPosition(
    tx: Tx,
    params: {
      market: MarketWithOutcomes;
      outcome: Outcome;
      userId: string;
      shares: Decimal;
      money: Decimal;
    },
  ): Promise<void> {
    const { market, outcome, userId, shares, money } = params;
    const key = { userId, marketId: market.id, outcomeId: outcome.id };

    const existing = await tx.position.findUnique({ where: { userId_marketId_outcomeId: key } });
    const heldBefore = new Decimal(existing?.shares.toString() ?? '0');
    const avgBefore = new Decimal(existing?.avgPrice.toString() ?? '0');
    const heldAfter = heldBefore.plus(shares);
    const avgAfter = heldAfter.isZero()
      ? new Decimal(0)
      : heldBefore.times(avgBefore).plus(money).div(heldAfter);

    if (existing === null) {
      await tx.position.create({
        data: { ...key, shares: dec(shares), avgPrice: dec(avgAfter), realizedPnl: 0 },
      });
    } else {
      await tx.position.update({
        where: { userId_marketId_outcomeId: key },
        data: { shares: { increment: dec(shares) }, avgPrice: dec(avgAfter) },
      });
    }

    await tx.trade.create({
      data: {
        marketId: market.id,
        outcomeId: outcome.id,
        userId,
        side: 'seed',
        shares: dec(shares),
        cost: dec(money),
        fee: 0,
        priceAfter: outcome.priceCurrent,
        requestId: `seed:${market.id}:${userId}:${outcome.id}`,
      },
    });
  }

  private async activate(
    tx: Tx,
    marketId: string,
    fundingClosesAt: Date,
    label: string,
  ): Promise<void> {
    await tx.market.update({
      where: { id: marketId },
      data: { state: 'active', activationPath: 'seeded', fundingClosesAt },
    });
    await tx.marketAnnotation.create({
      data: { marketId, type: 'activation', label },
    });
  }

  private async loadMarket(tx: Tx, marketId: string): Promise<MarketWithOutcomes> {
    return tx.market.findUniqueOrThrow({
      where: { id: marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
  }

  /**
   * Lock the market and check it can still be seeded.
   *
   * The row lock is the same one the trade path takes: a seed and a trade must
   * never price off the same state, and neither must two seeds.
   */
  private async lockSeedable(
    tx: Tx,
    marketId: string,
    allowed: readonly string[] = ['draft', 'funding', 'seeding'],
    shelf: 'community' | 'official' = 'community',
  ): Promise<MarketWithOutcomes> {
    await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;
    const market = await this.loadMarket(tx, marketId);

    if (!allowed.includes(market.state)) {
      throw new SeedError(`market is ${market.state} — it cannot be seeded`);
    }
    if (market.shelf !== shelf) {
      throw new SeedError(`this path seeds ${shelf} markets, and that one is ${market.shelf}`);
    }
    const traded = await tx.trade.count({ where: { marketId, side: { not: 'seed' } } });
    if (traded > 0) {
      throw new SeedError('this market has already traded — a symmetric seed is no longer defined');
    }
    return market;
  }
}

type MarketWithOutcomes = Market & { outcomes: Outcome[] };

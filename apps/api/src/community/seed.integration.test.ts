import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { resetDatabase } from '../testing/reset';
import { ResolutionService } from '../trade/resolution.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { CommunityService } from './community.service';
import { SeedService } from './seed.service';
import { MarketVoidService } from './void.service';
import type { MarketTemplate } from './market-template';

/**
 * Path B seeds, Sponsor Syndicates and conduct bonds against a real database
 * (§2.4, Rulebook Part 3 §2–§3, §5).
 *
 * Every test here is about money that must come back. A seeded market that
 * never finds a crowd, a seeding round that falls short, a bond on a market
 * that resolved cleanly — in all three the platform is holding somebody else's
 * points and the only acceptable outcome is that they are returned to the digit.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('Path B seeds and syndicates (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let wallet: WalletService;
  let auth: AuthService;
  let community: CommunityService;
  let seeds: SeedService;
  let trades: TradeService;
  let resolution: ResolutionService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();
    const ledger = new LedgerService(prisma);
    const voids = new MarketVoidService(ledger);
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
    );
    community = new CommunityService(prisma, config, wallet, voids);
    seeds = new SeedService(prisma, config, wallet, voids);
    trades = new TradeService(prisma, ledger, wallet, config, {
      publish: async () => undefined,
    } as unknown as PriceCacheService);
    resolution = new ResolutionService(prisma, ledger, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    // Production floors are sized for real money; these are sized for a test
    // account's starter balance. The rules under test are the same either way.
    const overrides: Record<string, number> = {
      symmetric_seed_per_outcome_spc: 2_000,
      syndicate_min_contribution_spc: 500,
      syndicate_max_sponsors: 3,
      participation_floor_users: 2,
    };
    for (const [key, value] of Object.entries(overrides)) {
      await prisma.platformConfig.updateMany({ where: { key }, data: { valueJson: value } });
    }
    await config.refresh();
  });

  const template: MarketTemplate = {
    question: 'Will the Super Eagles qualify from their group at the next AFCON?',
    outcomes: [
      { label: 'YES', criteria: 'CAF lists Nigeria among the qualified teams.' },
      { label: 'NO', criteria: 'Nigeria is eliminated at the group stage.' },
    ],
    sourceName: 'CAF official site',
    sourceUrl: 'https://www.cafonline.com/',
    eventDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    voidDate: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    edgeCases: { abandoned: 'Void if the group is not completed.' },
  };

  async function trader(email: string, topUp = '0') {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
    if (new Decimal(topUp).gt(0)) {
      await wallet.issue({
        userId,
        amount: new Decimal(topUp),
        type: 'prize',
        ref: `topup:${userId}`,
      });
    }
    return userId;
  }

  async function seededMarket(creatorId: string) {
    return community.create({
      creatorId,
      template,
      liquidityParam: '50000',
      activationPath: 'seeded',
    });
  }

  /**
   * Every posting for this market, summed. Zero, or money was invented.
   *
   * Each transaction is asserted to balance at 40 digits before it is written;
   * the columns then hold 18 decimal places, so a payout that does not land on
   * that scale is rounded on the way in. The sum of what is *stored* can
   * therefore sit one storage quantum (1e-18 SPC) off zero per row — sixteen
   * orders of magnitude below one kobo. `quantumsOf` is that bound, made
   * explicit so a real discrepancy still fails the test.
   */
  async function ledgerResidual(
    marketId: string,
  ): Promise<{ residual: Decimal; quantumsOf: Decimal }> {
    const rows = await prisma.ledgerEntry.findMany({ where: { marketId } });
    const residual = rows.reduce(
      (acc, row) => acc.plus(new Decimal(row.amount.toString())),
      new Decimal(0),
    );
    return { residual, quantumsOf: new Decimal('1e-18').times(rows.length) };
  }

  async function expectLedgerBalances(marketId: string): Promise<void> {
    const { residual, quantumsOf } = await ledgerResidual(marketId);
    expect(
      residual.abs().lte(quantumsOf),
      `ledger for ${marketId} is off by ${residual.toString()}`,
    ).toBe(true);
  }

  it('opens a seeded market flat: equal money in every pool and no price moved', async () => {
    const creator = await trader('seeder@example.ng');
    const { marketId, fundingClosesAt } = await seededMarket(creator);
    expect(fundingClosesAt).toBeNull();

    const before = await wallet.balanceOf(creator);
    const applied = await seeds.seedSolo({ marketId, userId: creator });

    expect(applied.total.eq(4_000)).toBe(true);
    expect(applied.perOutcome.eq(2_000)).toBe(true);

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('active');
    expect(market.activationPath).toBe('seeded');
    expect(market.fundingClosesAt).not.toBeNull();
    expect(new Decimal(market.potTotal.toString()).eq(4_000)).toBe(true);

    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    for (const outcome of outcomes) {
      expect(new Decimal(outcome.stakedTotal.toString()).eq(2_000)).toBe(true);
      // The seed moves no price — that is what makes it symmetric.
      expect(new Decimal(outcome.priceCurrent.toString()).eq('0.5')).toBe(true);
      expect(new Decimal(outcome.sharesOutstanding.toString()).eq(4_000)).toBe(true);
    }

    // The creator holds every outcome equally: no side, in either direction.
    const positions = await prisma.position.findMany({ where: { marketId, userId: creator } });
    expect(positions).toHaveLength(2);
    for (const position of positions) {
      expect(new Decimal(position.shares.toString()).eq(4_000)).toBe(true);
    }

    const after = await wallet.balanceOf(creator);
    expect(before.available.minus(after.available).eq(4_000)).toBe(true);
    await expectLedgerBalances(marketId);
  });

  it('refuses a seed below the Symmetric Seed minimum, and one from a stranger', async () => {
    const creator = await trader('short@example.ng');
    const outsider = await trader('outsider@example.ng');
    const { marketId } = await seededMarket(creator);

    await expect(seeds.seedSolo({ marketId, userId: creator, perOutcome: '1999' })).rejects.toThrow(
      /at least 2000/,
    );
    await expect(seeds.seedSolo({ marketId, userId: outsider })).rejects.toThrow(
      /only the creator/,
    );
    expect(await prisma.trade.count({ where: { marketId } })).toBe(0);
  });

  it('holds the participation floor open, then confirms it once the crowd arrives', async () => {
    const creator = await trader('floor-ok@example.ng');
    const { marketId } = await seededMarket(creator);
    await seeds.seedSolo({ marketId, userId: creator });

    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    for (const [i, email] of ['p1@example.ng', 'p2@example.ng'].entries()) {
      const userId = await trader(email);
      await trades.buy({
        marketId,
        outcomeId: outcomes[i % outcomes.length]?.id ?? '',
        userId,
        amount: '1500',
        requestId: `stake-${i}`,
      });
    }

    const result = await community.closeWindow(marketId);
    expect(result.outcome).toBe('confirmed');

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('active');
    // The deadline is spent: a second firing of the job has nothing left to do.
    expect(market.fundingClosesAt).toBeNull();
    expect((await community.closeWindow(marketId)).outcome).toBe('skipped');
  });

  it('voids a seeded market that never found a crowd, refunding the seed in full', async () => {
    const creator = await trader('floor-fail@example.ng');
    const before = await wallet.balanceOf(creator);
    const { marketId } = await seededMarket(creator);
    await seeds.seedSolo({ marketId, userId: creator });

    const punter = await trader('lonely@example.ng');
    const outcome = await prisma.outcome.findFirstOrThrow({ where: { marketId, ordinal: 0 } });
    const punterBefore = await wallet.balanceOf(punter);
    await trades.buy({
      marketId,
      outcomeId: outcome.id,
      userId: punter,
      amount: '900',
      requestId: 'lonely-stake',
    });

    // One backer, floor of two.
    const result = await community.closeWindow(marketId);
    expect(result.outcome).toBe('voided');
    expect(result.reason).toMatch(/only 1 of 2/);

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('voided');

    // Seed, stake and bond all home. §2.4: "all stakes — including the full seed
    // — are refunded".
    const creatorAfter = await wallet.balanceOf(creator);
    expect(creatorAfter.available.eq(before.available)).toBe(true);
    expect(creatorAfter.escrowed.isZero()).toBe(true);

    const punterAfter = await wallet.balanceOf(punter);
    expect(punterAfter.available.eq(punterBefore.available)).toBe(true);

    const bond = await prisma.bond.findUniqueOrThrow({ where: { marketId } });
    expect(bond.state).toBe('refunded');
    await expectLedgerBalances(marketId);
  });

  it('fills a seeding round on the contribution that reaches the minimum', async () => {
    const creator = await trader('organiser@example.ng');
    const { marketId } = await seededMarket(creator);
    const round = await seeds.openSeedingRound({ marketId, creatorId: creator });
    expect(new Decimal(round.minTotal.toString()).eq(4_000)).toBe(true);

    const waiting = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(waiting.state).toBe('seeding');

    const alice = await trader('alice@example.ng');
    const bob = await trader('bob@example.ng');

    const first = await seeds.contribute({ marketId, userId: alice, amount: '3000' });
    expect(first.filled).toBe(false);
    expect((await prisma.market.findUniqueOrThrow({ where: { id: marketId } })).state).toBe(
      'seeding',
    );

    const second = await seeds.contribute({ marketId, userId: bob, amount: '1000' });
    expect(second.filled).toBe(true);
    expect(second.sponsors).toBe(2);

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('active');
    expect(new Decimal(market.potTotal.toString()).eq(4_000)).toBe(true);

    // Each sponsor holds their slice of *every* outcome — a sponsor can never
    // hold a directional position through the seed (§3).
    const outcomes = await prisma.outcome.findMany({ where: { marketId } });
    for (const outcome of outcomes) {
      const positions = await prisma.position.findMany({ where: { outcomeId: outcome.id } });
      const held = positions.reduce(
        (acc, p) => acc.plus(new Decimal(p.shares.toString())),
        new Decimal(0),
      );
      // Σ positions === shares outstanding, exactly. Resolution refuses anything less.
      expect(held.eq(new Decimal(outcome.sharesOutstanding.toString()))).toBe(true);

      const aliceShares = positions.find((p) => p.userId === alice);
      const bobShares = positions.find((p) => p.userId === bob);
      expect(new Decimal(aliceShares?.shares.toString() ?? '0').eq(3_000)).toBe(true);
      expect(new Decimal(bobShares?.shares.toString() ?? '0').eq(1_000)).toBe(true);
    }

    const members = await prisma.syndicateMember.findMany({
      where: { syndicateId: round.syndicateId },
    });
    const shares = members.map((m) => new Decimal(m.feeSharePct.toString()));
    expect(shares.reduce((a, b) => a.plus(b), new Decimal(0)).eq(1)).toBe(true);
    await expectLedgerBalances(marketId);
  });

  it('enforces the round terms: minimum contribution, sponsor cap, closed rounds', async () => {
    const creator = await trader('terms@example.ng');
    const { marketId } = await seededMarket(creator);
    await seeds.openSeedingRound({ marketId, creatorId: creator });

    const small = await trader('small@example.ng');
    await expect(seeds.contribute({ marketId, userId: small, amount: '499' })).rejects.toThrow(
      /smallest contribution/,
    );

    for (const [i, email] of ['s1@example.ng', 's2@example.ng', 's3@example.ng'].entries()) {
      const userId = await trader(email);
      await seeds.contribute({ marketId, userId, amount: i === 2 ? '600' : '500' });
    }
    const fourth = await trader('s4@example.ng');
    await expect(seeds.contribute({ marketId, userId: fourth, amount: '500' })).rejects.toThrow(
      /full at 3 sponsors/,
    );
  });

  it('refunds every contribution when the round ends short', async () => {
    const creator = await trader('short-round@example.ng');
    const creatorBefore = await wallet.balanceOf(creator);
    const { marketId } = await seededMarket(creator);
    await seeds.openSeedingRound({ marketId, creatorId: creator, roundHours: 1 });

    const alice = await trader('alice-short@example.ng');
    const aliceBefore = await wallet.balanceOf(alice);
    await seeds.contribute({ marketId, userId: alice, amount: '1500' });

    const result = await seeds.closeSeedingRound(marketId);
    expect(result.outcome).toBe('voided');
    expect(result.reason).toMatch(/1500 of 4000/);

    expect((await wallet.balanceOf(alice)).available.eq(aliceBefore.available)).toBe(true);
    expect((await wallet.balanceOf(creator)).available.eq(creatorBefore.available)).toBe(true);

    const syndicate = await prisma.syndicate.findUniqueOrThrow({ where: { marketId } });
    expect(syndicate.state).toBe('refunded');
    expect((await prisma.market.findUniqueOrThrow({ where: { id: marketId } })).state).toBe(
      'voided',
    );
    // Closing twice must not refund twice.
    expect((await seeds.closeSeedingRound(marketId)).outcome).toBe('skipped');
    await expectLedgerBalances(marketId);
  });

  it('pays the syndicate fee pro-rata and returns the bond on a clean resolution', async () => {
    const creator = await trader('res-organiser@example.ng');
    const alice = await trader('res-alice@example.ng');
    const bob = await trader('res-bob@example.ng');
    const punter = await trader('res-punter@example.ng');

    const { marketId } = await seededMarket(creator);
    // 40% organiser cut, remainder pro-rata — Part 3 §3's worked example.
    await seeds.openSeedingRound({ marketId, creatorId: creator, organiserBps: 4_000 });
    await seeds.contribute({ marketId, userId: alice, amount: '3000' });
    await seeds.contribute({ marketId, userId: bob, amount: '1000' });

    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    const yes = outcomes[0];
    const no = outcomes[1];
    if (yes === undefined || no === undefined) throw new Error('binary market expected');

    await trades.buy({
      marketId,
      outcomeId: yes.id,
      userId: punter,
      amount: '2000',
      requestId: 'res-yes',
    });
    await trades.buy({
      marketId,
      outcomeId: no.id,
      userId: alice,
      amount: '1000',
      requestId: 'res-no',
    });

    const bondAmount = new Decimal(await config.get('conduct_bond_spc'));
    const creatorBefore = await wallet.balanceOf(creator);

    const result = await resolution.resolve({
      marketId,
      winningOutcomeId: yes.id,
      resolvedBy: creator,
      evidenceUrl: 'https://www.cafonline.com/results',
    });

    // The creator fee is the syndicate's: organiser cut first, rest pro-rata.
    const legs = new Map(result.creatorLegs.map((leg) => [leg.userId, leg.amount]));
    const summed = result.creatorLegs.reduce((acc, leg) => acc.plus(leg.amount), new Decimal(0));
    expect(summed.eq(result.creatorFee)).toBe(true);

    const organiserCut = result.creatorFee.times(0.4);
    const pool = result.creatorFee.minus(organiserCut);
    expect(legs.get(creator)?.eq(organiserCut)).toBe(true);
    expect(legs.get(alice)?.minus(pool.times('0.75')).abs().lt('1e-12')).toBe(true);
    expect(legs.get(bob)?.minus(pool.times('0.25')).abs().lt('1e-12')).toBe(true);

    // Part 3 §5: the bond comes back after a clean resolution.
    expect(result.bondRefunded.eq(bondAmount)).toBe(true);
    const bond = await prisma.bond.findUniqueOrThrow({ where: { marketId } });
    expect(bond.state).toBe('refunded');

    const creatorAfter = await wallet.balanceOf(creator);
    expect(creatorAfter.escrowed.isZero()).toBe(true);
    expect(creatorAfter.available.gte(creatorBefore.available.plus(bondAmount))).toBe(true);

    await expectLedgerBalances(marketId);
  });

  it('refuses to seed a market that has already traded', async () => {
    const creator = await trader('late-seed@example.ng');
    const { marketId } = await seededMarket(creator);
    await seeds.seedSolo({ marketId, userId: creator });

    const punter = await trader('early-bird@example.ng');
    const outcome = await prisma.outcome.findFirstOrThrow({ where: { marketId, ordinal: 0 } });
    await trades.buy({
      marketId,
      outcomeId: outcome.id,
      userId: punter,
      amount: '500',
      requestId: 'first-trade',
    });

    await expect(seeds.seedSolo({ marketId, userId: creator })).rejects.toThrow(
      /active — it cannot be seeded/,
    );
  });
});

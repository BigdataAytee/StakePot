import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketHealthService } from '../market/health.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { testOrderBook } from '../testing/order-book';
import { resetDatabase } from '../testing/reset';
import { ResolutionService } from '../trade/resolution.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { CommunityService } from './community.service';
import { SeedService } from './seed.service';
import { MarketVoidService } from './void.service';
import type { MarketTemplate } from './market-template';
import { approvalAnswers, compliantTemplate } from '../testing/templates';
import { CreatorAnalyticsService } from '../creator/analytics.service';
import { AutopsyService } from '../creator/autopsy.service';
import { CreatorService } from '../creator/creator.service';
import { AnalyticsService } from '../analytics/analytics.service';

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
    // Notifications are best-effort by design; in tests they run against the
    // same database with every channel unconfigured, so they record and move on.
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );
    // §2.14's creator platform: the ladder, the analytics it reads, and
    // the autopsy that moves a creator's record when a market closes.
    const creators = new CreatorService(prisma, config, notifications);
    const creatorAnalytics = new CreatorAnalyticsService(prisma);
    const autopsies = new AutopsyService(
      prisma,
      creatorAnalytics,
      creators,
      notifications,
      new MarketHealthService(prisma),
    );
    const analytics = new AnalyticsService(prisma);
    community = new CommunityService(
      prisma,
      config,
      wallet,
      voids,
      notifications,
      creators,
      autopsies,
      analytics,
    );
    seeds = new SeedService(prisma, config, wallet, voids, creators);
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      { publish: async () => undefined } as unknown as PriceCacheService,
      new RgService(prisma, config),
      testOrderBook(prisma, ledger, wallet),
    );
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

  const template: MarketTemplate = compliantTemplate({
    question: 'Will the Super Eagles qualify from their group at the next AFCON?',
    outcomes: [
      {
        label: 'YES',
        criteria: 'CAF lists Nigeria among the qualified teams at 23:59 WAT on the stated date.',
      },
      {
        label: 'NO',
        criteria: 'CAF lists Nigeria as eliminated at the group stage, read at 23:59 WAT.',
      },
    ],
    sourceName: 'CAF official site',
    sourceUrl: 'https://www.cafonline.com/africa-cup-of-nations/standings/',
    eventDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    voidDate: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    edgeCases: {
      abandoned: 'Void if the group is not completed.',
      'no publication': 'If CAF publishes no standings by the void date, the market voids.',
    },
  });

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
      ...approvalAnswers(),
      liquidityParam: '50000',
      activationPath: 'seeded',
    });
  }

  /**
   * Every posting for this market, summed. Zero, or money was invented.
   *
   * Exactly zero, since step 13. The resolution path now brings its postings to
   * the storage scale (18 dp) *before* balancing them rather than letting
   * Postgres round them on the way in, so what the ledger asserts and what the
   * database holds are the same numbers. Previously this could sit one quantum
   * off zero per row and the test had to allow for it.
   */
  async function ledgerResidual(marketId: string): Promise<{ residual: Decimal }> {
    const rows = await prisma.ledgerEntry.findMany({ where: { marketId } });
    const residual = rows.reduce(
      (acc, row) => acc.plus(new Decimal(row.amount.toString())),
      new Decimal(0),
    );
    return { residual };
  }

  async function expectLedgerBalances(marketId: string): Promise<void> {
    const { residual } = await ledgerResidual(marketId);
    expect(residual.isZero(), `ledger for ${marketId} is off by ${residual.toString()}`).toBe(true);
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
  /**
   * The platform's own top-up on a live official market.
   *
   * The claim under test is the one an operator will not take on trust: money
   * can go into a market that is already trading without moving a single
   * price. It holds because the money is spread equally and the cost function
   * is translation-invariant — C(q + δ·1) = C(q) + δ at any q, traded or not.
   * `seed` refuses a traded market because a *creator's* seed is supposed to
   * be the opening stake; the arithmetic never had the objection.
   */
  describe('platform top-up on an official market', () => {
    /** A live market on the official shelf, with a trade already through it. */
    async function tradedOfficialMarket(): Promise<{ marketId: string }> {
      const creator = await trader('official-owner@example.ng');
      const { marketId } = await seededMarket(creator);
      await seeds.seedSolo({ marketId, userId: creator });
      await prisma.market.update({ where: { id: marketId }, data: { shelf: 'official' } });

      const punter = await trader('official-punter@example.ng');
      const outcome = await prisma.outcome.findFirstOrThrow({ where: { marketId, ordinal: 0 } });
      await trades.buy({
        marketId,
        outcomeId: outcome.id,
        userId: punter,
        amount: '750',
        requestId: `tilt:${marketId}`,
      });
      return { marketId };
    }

    it('adds exactly what it costs and leaves every price untouched', async () => {
      const { marketId } = await tradedOfficialMarket();

      const before = await prisma.outcome.findMany({
        where: { marketId },
        orderBy: { ordinal: 'asc' },
      });
      const potBefore = new Decimal(
        (await prisma.market.findUniqueOrThrow({ where: { id: marketId } })).potTotal.toString(),
      );
      // The trade tilted it: this is not the flat market `seed` would accept.
      expect(new Decimal(before[0]!.priceCurrent.toString()).eq('0.5')).toBe(false);

      const applied = await seeds.topUpOfficial({
        marketId,
        perOutcome: '1500',
        requestId: 'top-up-1',
      });

      expect(applied.total.eq(3_000)).toBe(true);
      expect(applied.perOutcome.eq(1_500)).toBe(true);

      const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
      expect(new Decimal(market.potTotal.toString()).minus(potBefore).eq(3_000)).toBe(true);
      expect(applied.potAfter.eq(new Decimal(market.potTotal.toString()))).toBe(true);
      // Still active: a top-up is not a lifecycle event.
      expect(market.state).toBe('active');

      const after = await prisma.outcome.findMany({
        where: { marketId },
        orderBy: { ordinal: 'asc' },
      });
      for (const [index, outcome] of after.entries()) {
        const moved = new Decimal(outcome.priceCurrent.toString())
          .minus(new Decimal(before[index]!.priceCurrent.toString()))
          .abs();
        expect(moved.lt('1e-12'), `outcome ${index} moved by ${moved.toString()}`).toBe(true);
        // Equal money on every side, which is what makes it move no price.
        const staked = new Decimal(outcome.stakedTotal.toString()).minus(
          new Decimal(before[index]!.stakedTotal.toString()),
        );
        expect(staked.eq(1_500)).toBe(true);
      }

      // It is real money through the real ledger, not a number written on the
      // market row — and it balances.
      await expectLedgerBalances(marketId);
      const postings = await prisma.ledgerEntry.findMany({
        where: { marketId, ref: 'official-topup:top-up-1' },
      });
      expect(postings.length).toBeGreaterThan(0);

      const annotation = await prisma.marketAnnotation.findFirst({
        where: { marketId, type: 'seed' },
      });
      expect(annotation).not.toBeNull();
    });

    it('seeds once however many times the click is retried', async () => {
      const { marketId } = await tradedOfficialMarket();

      const first = await seeds.topUpOfficial({
        marketId,
        perOutcome: '1000',
        requestId: 'same-click',
      });
      const second = await seeds.topUpOfficial({
        marketId,
        perOutcome: '1000',
        requestId: 'same-click',
      });

      expect(first.total.eq(2_000)).toBe(true);
      expect(second.total.isZero()).toBe(true);
      expect(second.potAfter.eq(first.potAfter)).toBe(true);

      const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
      expect(new Decimal(market.potTotal.toString()).eq(first.potAfter)).toBe(true);
      await expectLedgerBalances(marketId);
    });

    it('refuses a community market — that seed is its creator’s, not ours', async () => {
      const creator = await trader('community-owner@example.ng');
      const { marketId } = await seededMarket(creator);
      await seeds.seedSolo({ marketId, userId: creator });

      await expect(
        seeds.topUpOfficial({ marketId, perOutcome: '500', requestId: 'wrong-shelf' }),
      ).rejects.toThrow(/only official markets/);
      await expectLedgerBalances(marketId);
    });

    it('refuses once the market has frozen, with no staff-shaped exception', async () => {
      const { marketId } = await tradedOfficialMarket();
      await prisma.market.update({
        where: { id: marketId },
        data: { state: 'frozen', frozenAt: new Date() },
      });

      await expect(
        seeds.topUpOfficial({ marketId, perOutcome: '500', requestId: 'too-late' }),
      ).rejects.toThrow(/cannot be seeded|frozen/);
      expect(await prisma.ledgerEntry.count({ where: { ref: 'official-topup:too-late' } })).toBe(0);
    });

    it('refuses an amount over the ceiling, and one of nothing', async () => {
      const { marketId } = await tradedOfficialMarket();
      const ceiling = new Decimal(
        (await config.get('official_seed_max_per_outcome_spc')).toString(),
      );

      await expect(
        seeds.topUpOfficial({
          marketId,
          perOutcome: ceiling.plus(1).toString(),
          requestId: 'too-big',
        }),
      ).rejects.toThrow(/capped at/);
      await expect(
        seeds.topUpOfficial({ marketId, perOutcome: '0', requestId: 'nothing' }),
      ).rejects.toThrow(/greater than zero/);
      await expectLedgerBalances(marketId);
    });
  });
});

import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketService } from '../market/market.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { WalletService } from '../wallet/wallet.service';
import { RgService } from '../rg/rg.service';
import { resetDatabase } from '../testing/reset';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { ResolutionService } from './resolution.service';
import { TradeService } from './trade.service';

/**
 * Step 2's deliverable: "one binary official market end-to-end (trade → escrow
 * → early exit → resolve → per-share payout)".
 *
 * The engine's arithmetic is already property-tested in packages/engine. What
 * these check is the join: that what the engine computes is exactly what the
 * ledger records, that nothing leaks between the two, and that the pot is fully
 * distributed with no platform cost.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('binary official market, end to end', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let ledger: LedgerService;
  let wallet: WalletService;
  let auth: AuthService;
  let markets: MarketService;
  let trades: TradeService;
  let resolution: ResolutionService;
  let reconciliation: ReconciliationService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();
    ledger = new LedgerService(prisma);
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );
    markets = new MarketService(prisma, config);
    // The live feed is a fan-out concern, not a money concern: a tick that
    // never publishes must not change what a trade did. Stubbed so these tests
    // stay off Redis and prove exactly that.
    const priceFeed = { publish: async () => undefined } as unknown as PriceCacheService;
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      priceFeed,
      new RgService(prisma, config),
    );
    resolution = new ResolutionService(prisma, ledger, config);
    reconciliation = new ReconciliationService(prisma, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function makeMarket() {
    return markets.create({
      shelf: 'official',
      question: 'Will the Super Eagles win their next match?',
      sourceName: 'CAF official results',
      sourceUrl: 'https://www.cafonline.com/',
      criteria: { yes: 'Eagles win in regulation or extra time', no: 'Draw or loss' },
      edgeCases: { abandoned: 'void' },
      eventDate: new Date(Date.now() + 86_400_000),
      voidDate: new Date(Date.now() + 172_800_000),
      // §2.3: ~50× the typical stake for ~1-point moves at even odds.
      liquidityParam: '100000',
      outcomeLabels: ['YES', 'NO'],
    });
  }

  async function makeTrader(email: string) {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
    return userId;
  }

  it('opens flat at 50/50 with an empty pot', async () => {
    const market = await makeMarket();
    expect(market.outcomes).toHaveLength(2);
    expect(market.outcomes.map((o) => o.ordinal)).toEqual([0, 1]);
    expect(new Decimal(market.potTotal.toString()).isZero()).toBe(true);
    for (const outcome of market.outcomes) {
      expect(new Decimal(outcome.priceCurrent.toString()).eq('0.5')).toBe(true);
    }
  });

  it('a buy escrows the stake, moves the price, and grows the pot by exactly what was spent', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('trader1@example.ng');
    const before = await wallet.balanceOf(userId);

    const trade = await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      amount: '2000',
      requestId: 'req-buy-1',
    });

    const after = await wallet.balanceOf(userId);
    expect(before.available.minus(after.available).eq(2000)).toBe(true);
    expect(after.escrowed.eq(2000)).toBe(true);

    const updated = await prisma.market.findUniqueOrThrow({
      where: { id: market.id },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    expect(new Decimal(updated.potTotal.toString()).eq(2000)).toBe(true);
    expect(new Decimal(updated.outcomes[0]!.stakedTotal.toString()).eq(2000)).toBe(true);

    // Prices still sum to 1, and the bought side is now the favourite.
    const sum = updated.outcomes.reduce(
      (acc, o) => acc.plus(new Decimal(o.priceCurrent.toString())),
      new Decimal(0),
    );
    expect(sum.minus(1).abs().lt('1e-9')).toBe(true);
    expect(new Decimal(updated.outcomes[0]!.priceCurrent.toString()).gt('0.5')).toBe(true);

    // §2.3's tuning rule, on a real market: L = 50× a 2,000 stake ≈ 1 point.
    const move = new Decimal(updated.outcomes[0]!.priceCurrent.toString()).minus('0.5');
    expect(move.gt('0.009') && move.lt('0.011')).toBe(true);

    expect(new Decimal(trade.shares.toString()).gt(0)).toBe(true);
    const price = await prisma.priceHistory.count({ where: { marketId: market.id } });
    expect(price).toBe(2); // one snapshot per outcome
  });

  it('replays a repeated request_id instead of filling twice', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('trader2@example.ng');

    const first = await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      amount: '1000',
      requestId: 'req-idem-1',
    });
    const second = await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      amount: '1000',
      requestId: 'req-idem-1',
    });

    expect(second.id).toBe(first.id);
    expect(await prisma.trade.count({ where: { marketId: market.id } })).toBe(1);
    const updated = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(new Decimal(updated.potTotal.toString()).eq(1000)).toBe(true);
  });

  it('refuses a stake the trader cannot fund, leaving the market untouched', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('trader3@example.ng');

    await expect(
      trades.buy({
        marketId: market.id,
        outcomeId: yes.id,
        userId,
        // Under the platform's daily stake cap (§2.12) and far above the
        // trader's balance, so this exercises funding rather than the RG gate.
        amount: '900000',
        requestId: 'req-broke',
      }),
    ).rejects.toThrow(/insufficient funds/);

    const updated = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(new Decimal(updated.potTotal.toString()).isZero()).toBe(true);
    expect(await prisma.trade.count()).toBe(0);
  });

  it('an early exit refunds along the same curve, less the 1% exit fee', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('trader4@example.ng');

    const bought = await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      amount: '2000',
      requestId: 'req-buy-exit',
    });

    const beforeExit = await wallet.balanceOf(userId);
    const sold = await trades.sell({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      shares: bought.shares.toString(),
      requestId: 'req-sell-exit',
    });

    // A lone round trip returns the stake exactly, so the fee is the whole cost.
    expect(new Decimal(sold.fee.toString()).minus(20).abs().lt('1e-6')).toBe(true);

    const afterExit = await wallet.balanceOf(userId);
    expect(afterExit.escrowed.abs().lt('1e-9')).toBe(true);
    expect(afterExit.available.minus(beforeExit.available).minus(1980).abs().lt('1e-6')).toBe(true);

    // Pot back to zero, and the exit fee sits in platform_fees — not the pot.
    const updated = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(new Decimal(updated.potTotal.toString()).abs().lt('1e-9')).toBe(true);
    const platform = await wallet.balanceOf('sys_platform');
    expect(platform.available.minus(20).abs().lt('1e-6')).toBe(true);
  });

  it('refuses to sell shares the position does not hold', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('trader5@example.ng');
    await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      amount: '500',
      requestId: 'req-small-buy',
    });

    await expect(
      trades.sell({
        marketId: market.id,
        outcomeId: yes.id,
        userId,
        shares: '999999',
        requestId: 'req-oversell',
      }),
    ).rejects.toThrow(/position holds/);
  });

  it('refuses to trade once the market freezes at event start', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('trader6@example.ng');
    await markets.freeze(market.id, 'Kickoff');

    await expect(
      trades.buy({
        marketId: market.id,
        outcomeId: yes.id,
        userId,
        amount: '100',
        requestId: 'req-frozen',
      }),
    ).rejects.toThrow(/Trading closed/);
  });

  it('resolves: fee on the losing pool, payouts per share, platform cost zero', async () => {
    const market = await makeMarket();
    const [yes, no] = [market.outcomes[0]!, market.outcomes[1]!];

    const ada = await makeTrader('ada@example.ng');
    const bola = await makeTrader('bola@example.ng');
    const chidi = await makeTrader('chidi@example.ng');

    await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId: ada,
      amount: '3000',
      requestId: 'r1',
    });
    await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId: bola,
      amount: '2000',
      requestId: 'r2',
    });
    await trades.buy({
      marketId: market.id,
      outcomeId: no.id,
      userId: chidi,
      amount: '4000',
      requestId: 'r3',
    });

    const potBefore = new Decimal(
      (await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).potTotal.toString(),
    );
    expect(potBefore.eq(9000)).toBe(true);

    const balancesBefore = await Promise.all([ada, bola, chidi].map((id) => wallet.balanceOf(id)));

    await markets.freeze(market.id, 'Kickoff');
    const result = await resolution.resolve({
      marketId: market.id,
      winningOutcomeId: yes.id,
      resolvedBy: 'sys_platform',
      evidenceUrl: 'https://www.cafonline.com/result',
    });

    // Official markets: 3% of the losing pool, which is Chidi's ₦4,000 alone.
    expect(result.losingPool.eq(4000)).toBe(true);
    expect(result.fee.minus(120).abs().lt('1e-9')).toBe(true);
    expect(result.creatorFee.isZero()).toBe(true);
    expect(result.platformFee.minus(120).abs().lt('1e-9')).toBe(true);

    // Everything the pot held went out: payouts + fee === pot, to the kobo.
    const paid = result.payouts.reduce((acc, p) => acc.plus(p.payout), new Decimal(0));
    expect(paid.plus(result.fee).minus(potBefore).abs().lt('1e-9')).toBe(true);

    // Winners split pro-rata by shares; the loser gets nothing back.
    const afterBalances = await Promise.all([ada, bola, chidi].map((id) => wallet.balanceOf(id)));
    const [adaAfter, bolaAfter, chidiAfter] = afterBalances as [
      (typeof afterBalances)[number],
      (typeof afterBalances)[number],
      (typeof afterBalances)[number],
    ];
    expect(adaAfter.available.gt(balancesBefore[0]!.available)).toBe(true);
    expect(bolaAfter.available.gt(balancesBefore[1]!.available)).toBe(true);
    expect(chidiAfter.available.eq(balancesBefore[2]!.available)).toBe(true);

    // Ada bought earlier and cheaper, so she holds more shares and wins more.
    const adaGain = adaAfter.available.minus(balancesBefore[0]!.available);
    const bolaGain = bolaAfter.available.minus(balancesBefore[1]!.available);
    expect(adaGain.gt(bolaGain)).toBe(true);

    // Nobody is left holding escrow, and no pot remains.
    for (const balance of afterBalances) {
      expect(balance.escrowed.abs().lt('1e-9')).toBe(true);
    }
    const resolved = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(resolved.state).toBe('resolved');
    expect(new Decimal(resolved.potTotal.toString()).abs().lt('1e-9')).toBe(true);

    // And the whole thing still reconciles.
    const check = await reconciliation.run('SPC', new Date());
    expect(check.status).toBe('clean');
  });

  it('releases a hedged trader once, not once per position', async () => {
    // The minimal shape of a bug that four-way markets exposed: escrow was
    // released per position while the amount was read per holder, so anyone on
    // both sides was released twice. Legal to hedge, and every other test here
    // has one trader on one outcome, which is exactly why it hid.
    const market = await makeMarket();
    const [yes, no] = [market.outcomes[0]!, market.outcomes[1]!];
    const hedger = await makeTrader('hedger@example.ng');

    const onYes = await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId: hedger,
      amount: '1000',
      requestId: 'h1',
    });
    await trades.buy({
      marketId: market.id,
      outcomeId: no.id,
      userId: hedger,
      amount: '600',
      requestId: 'h2',
    });

    const before = await wallet.balanceOf(hedger);
    expect(before.escrowed.eq(1600)).toBe(true);

    const result = await resolution.resolve({
      marketId: market.id,
      winningOutcomeId: yes.id,
      resolvedBy: 'sys_platform',
      evidenceUrl: 'https://example.ng/evidence',
    });

    // Sole holder of the winner: everything but the fee comes back.
    expect(result.losingPool.eq(600)).toBe(true);
    const paid = result.payouts.reduce((acc, p) => acc.plus(p.payout), new Decimal(0));
    expect(paid.plus(result.fee).minus(1600).abs().lt('1e-9')).toBe(true);
    expect(new Decimal(onYes.shares.toString()).gt(0)).toBe(true);

    const after = await wallet.balanceOf(hedger);
    expect(after.escrowed.abs().lt('1e-9')).toBe(true);
    expect(after.available.minus(before.available).minus(paid).abs().lt('1e-9')).toBe(true);
  });

  it('refuses to resolve the same market twice', async () => {
    const market = await makeMarket();
    const yes = market.outcomes[0]!;
    const userId = await makeTrader('once@example.ng');
    await trades.buy({
      marketId: market.id,
      outcomeId: yes.id,
      userId,
      amount: '1000',
      requestId: 'r-once',
    });

    const args = {
      marketId: market.id,
      winningOutcomeId: yes.id,
      resolvedBy: 'sys_platform',
      evidenceUrl: 'https://example.ng/evidence',
    };
    await resolution.resolve(args);
    await expect(resolution.resolve(args)).rejects.toThrow(/already resolved/);
  });
  describe('multi-outcome markets', () => {
    async function makeElection() {
      return markets.create({
        shelf: 'official',
        question: 'Who wins the governorship?',
        sourceName: 'INEC declared result',
        sourceUrl: 'https://inecnigeria.org/',
        criteria: {
          Adeyemi: 'Declared winner.',
          Bello: 'Declared winner.',
          Chukwu: 'Declared winner.',
        },
        edgeCases: { rerun: 'Void, full refund.' },
        eventDate: new Date(Date.now() + 86_400_000),
        voidDate: new Date(Date.now() + 172_800_000),
        liquidityParam: '100000',
        outcomeLabels: ['Adeyemi', 'Bello', 'Chukwu'],
        otherLabel: 'Any other',
      });
    }

    it('opens with the catch-all last and every outcome priced evenly', async () => {
      const market = await makeElection();

      expect(market.outcomes).toHaveLength(4);
      expect(market.outcomes.map((o) => o.ordinal)).toEqual([0, 1, 2, 3]);

      const other = market.outcomes[3]!;
      expect(other.label).toBe('Any other');
      expect(other.isOther).toBe(true);
      expect(market.outcomes.filter((o) => o.isOther)).toHaveLength(1);

      for (const outcome of market.outcomes) {
        expect(new Decimal(outcome.priceCurrent.toString()).minus('0.25').abs().lt('1e-9')).toBe(
          true,
        );
      }
    });

    it('rejects a duplicated outcome label', async () => {
      await expect(
        markets.create({
          shelf: 'official',
          question: 'Duplicate outcomes?',
          sourceName: 'x',
          sourceUrl: 'https://example.ng/',
          criteria: {},
          edgeCases: {},
          eventDate: new Date(Date.now() + 86_400_000),
          voidDate: new Date(Date.now() + 172_800_000),
          liquidityParam: '1000',
          outcomeLabels: ['Adeyemi', 'Adeyemi'],
        }),
      ).rejects.toThrow(/listed twice/);
    });

    it('keeps prices summing to 1 across four outcomes as they trade', async () => {
      const market = await makeElection();
      const voter = await makeTrader('voter1@example.ng');

      for (const [index, amount] of [
        [0, '2000'],
        [2, '900'],
        [1, '1400'],
        [3, '300'],
      ] as const) {
        await trades.buy({
          marketId: market.id,
          outcomeId: market.outcomes[index]!.id,
          userId: voter,
          amount,
          requestId: `multi-${index}`,
        });
      }

      const after = await prisma.market.findUniqueOrThrow({
        where: { id: market.id },
        include: { outcomes: { orderBy: { ordinal: 'asc' } } },
      });

      const sum = after.outcomes.reduce(
        (acc, o) => acc.plus(new Decimal(o.priceCurrent.toString())),
        new Decimal(0),
      );
      expect(sum.minus(1).abs().lt('1e-9')).toBe(true);

      // The most-backed candidate leads; the catch-all, least backed, trails.
      const byOrdinal = after.outcomes;
      expect(
        new Decimal(byOrdinal[0]!.priceCurrent.toString()).gt(
          new Decimal(byOrdinal[3]!.priceCurrent.toString()),
        ),
      ).toBe(true);

      // Σ staked === pot, which is what makes the losing pool well defined.
      const staked = after.outcomes.reduce(
        (acc, o) => acc.plus(new Decimal(o.stakedTotal.toString())),
        new Decimal(0),
      );
      expect(staked.minus(new Decimal(after.potTotal.toString())).abs().lt('1e-9')).toBe(true);
    });

    it('settles a four-way race: fee on everything staked off the winner', async () => {
      const market = await makeElection();
      const [adeyemi, bello, chukwu, other] = market.outcomes as [
        (typeof market.outcomes)[number],
        (typeof market.outcomes)[number],
        (typeof market.outcomes)[number],
        (typeof market.outcomes)[number],
      ];

      const ada = await makeTrader('ada-multi@example.ng');
      const bola = await makeTrader('bola-multi@example.ng');
      const chidi = await makeTrader('chidi-multi@example.ng');

      await trades.buy({
        marketId: market.id,
        outcomeId: adeyemi.id,
        userId: ada,
        amount: '3000',
        requestId: 'm1',
      });
      await trades.buy({
        marketId: market.id,
        outcomeId: adeyemi.id,
        userId: bola,
        amount: '1000',
        requestId: 'm2',
      });
      await trades.buy({
        marketId: market.id,
        outcomeId: bello.id,
        userId: chidi,
        amount: '2000',
        requestId: 'm3',
      });
      await trades.buy({
        marketId: market.id,
        outcomeId: chukwu.id,
        userId: chidi,
        amount: '1500',
        requestId: 'm4',
      });
      await trades.buy({
        marketId: market.id,
        outcomeId: other.id,
        userId: bola,
        amount: '500',
        requestId: 'm5',
      });

      const potBefore = new Decimal(
        (await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).potTotal.toString(),
      );
      expect(potBefore.eq(8000)).toBe(true);

      const before = await Promise.all([ada, bola, chidi].map((id) => wallet.balanceOf(id)));

      await markets.freeze(market.id, 'Polls closed');
      const result = await resolution.resolve({
        marketId: market.id,
        winningOutcomeId: adeyemi.id,
        resolvedBy: 'sys_platform',
        evidenceUrl: 'https://inecnigeria.org/result',
      });

      // Losing pool is every naira staked on the three non-winning outcomes.
      expect(result.losingPool.eq(4000)).toBe(true);
      expect(result.fee.minus(120).abs().lt('1e-9')).toBe(true);

      const paid = result.payouts.reduce((acc, p) => acc.plus(p.payout), new Decimal(0));
      expect(paid.plus(result.fee).minus(potBefore).abs().lt('1e-9')).toBe(true);

      const after = await Promise.all([ada, bola, chidi].map((id) => wallet.balanceOf(id)));

      // Ada backed only the winner and gains; Chidi backed only losers and is
      // out everything he staked; Bola split and lands in between.
      expect(after[0]!.available.gt(before[0]!.available)).toBe(true);
      expect(after[2]!.available.eq(before[2]!.available)).toBe(true);

      for (const balance of after) {
        expect(balance.escrowed.abs().lt('1e-9')).toBe(true);
      }

      const check = await reconciliation.run('SPC', new Date());
      expect(check.status).toBe('clean');
    });
  });
});
import { AnalyticsService } from '../analytics/analytics.service';

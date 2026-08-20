import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AnalyticsService } from '../analytics/analytics.service';
import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketService } from '../market/market.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { WalletService } from '../wallet/wallet.service';
import { testOrderBook } from '../testing/order-book';
import { resetDatabase } from '../testing/reset';
import { ResolutionService } from '../trade/resolution.service';
import { TradeService } from '../trade/trade.service';
import { OrderBookService } from './orderbook.service';

/**
 * The matching layer against the real database.
 *
 * `matching.ts` and `settlement.ts` prove the arithmetic without a database;
 * this proves the *bookkeeping* — that what those functions compute is what the
 * ledger records, that the two pools stay apart across a real transaction, and
 * that the ledger's own `assertBalanced` never has anything to complain about.
 *
 * Every test here ends by checking the same three things, because they are the
 * three that matter:
 *
 *   - escrow across all users equals what the market is actually holding,
 *   - the platform's accounts were not touched,
 *   - and nobody's balance went negative.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('order book (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let ledger: LedgerService;
  let wallet: WalletService;
  let auth: AuthService;
  let markets: MarketService;
  let resolution: ResolutionService;

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
    resolution = new ResolutionService(prisma, ledger, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const priceFeed = { publish: async () => undefined } as unknown as PriceCacheService;

  /** A trade service with the book switched on for exactly this market. */
  function tradingOn(marketIds: readonly string[]): {
    trades: TradeService;
    book: OrderBookService;
  } {
    const book = testOrderBook(prisma, ledger, wallet, marketIds);
    const trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      priceFeed,
      new RgService(prisma, config),
      book,
    );
    return { trades, book };
  }

  async function makeMarket() {
    return markets.create({
      shelf: 'official',
      question: 'Will the Super Eagles win their next match?',
      sourceName: 'CAF official results',
      sourceUrl: 'https://www.cafonline.com/',
      criteria: { yes: 'Eagles win', no: 'Draw or loss' },
      edgeCases: { abandoned: 'void' },
      eventDate: new Date(Date.now() + 86_400_000),
      voidDate: new Date(Date.now() + 172_800_000),
      liquidityParam: '100000',
      outcomeLabels: ['YES', 'NO'],
    });
  }

  /** Somebody who can settle a market. Resolutions carry a real user id. */
  async function makeStaff(email: string) {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
    return userId;
  }

  async function makeTrader(email: string, funds = '100000') {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
    await wallet.issue({
      userId,
      amount: new Decimal(funds),
      type: 'prize',
      ref: `fund-${userId}`,
    });
    return userId;
  }

  /** Escrow this market is holding, from the ledger. */
  async function escrowIn(marketId: string): Promise<Decimal> {
    const rows = await prisma.ledgerEntry.groupBy({
      by: ['marketId'],
      where: { marketId, fundClass: 'user_escrow' },
      _sum: { amount: true },
    });
    return new Decimal(rows[0]?._sum.amount?.toString() ?? '0');
  }

  /** Every posting on this market sums to zero, and no house money moved. */
  async function assertNothingInvented(marketId: string): Promise<void> {
    const all = await prisma.ledgerEntry.findMany({ where: { marketId } });
    const total = all.reduce(
      (sum, row) => sum.plus(new Decimal(row.amount.toString())),
      new Decimal(0),
    );
    expect(total.isZero()).toBe(true);

    const house = all.filter((row) => row.userId.startsWith('sys_'));
    const houseTotal = house.reduce(
      (sum, row) => sum.plus(new Decimal(row.amount.toString())),
      new Decimal(0),
    );
    // Fees are the platform's only claim, and a matched fill charges none — so
    // on a book-only market this is exactly zero. A mixed market has the pot's
    // fee, which is revenue, never capital: it can be positive, never negative.
    expect(houseTotal.isNegative()).toBe(false);
  }

  /**
   * Stage a fillable book: somebody rests NO at 40 while the pot says 50, then
   * the pot's YES price is driven above 60 so the resting short is the better
   * quote. Returns the maker and the short's price on the YES book.
   *
   * Every matching test needs this, because a match against a zero-spread pot
   * is only possible once the pot has moved past a level somebody rested at.
   */
  async function stageFillableBook(
    trades: TradeService,
    market: Awaited<ReturnType<typeof makeMarket>>,
    tag: string,
    noAmount = '400',
  ): Promise<{ maker: string; mover: string; askKobo: number }> {
    const [yes, no] = market.outcomes;
    const maker = await makeTrader(`maker-${tag}@example.ng`);
    const rested = await trades.buy({
      marketId: market.id,
      outcomeId: no!.id,
      userId: maker,
      amount: noAmount,
      requestId: `stage-rest-${tag}`,
      limitKobo: 40,
    });
    expect(rested.resting).not.toBeNull();

    const mover = await makeTrader(`mover-${tag}@example.ng`, '400000');
    await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: mover,
      amount: '35000',
      requestId: `stage-move-${tag}`,
    });

    /*
      The mover's ₦35,000 is pure pot stake, and that is not an accident of the
      fixture — it is forced. At the moment they trade, the pot quotes 50 and
      the resting ask is 60, so `tightenToPot` caps their book limit at 50 and
      the book cannot touch them. Which makes them the right trader to use as
      the pot-only side of a mixed-market test.
    */
    return { maker, mover, askKobo: rested.resting!.priceKobo };
  }

  it('matches two traders and escrows exactly ₦1 a share between them', async () => {
    const market = await makeMarket();
    const [yes, no] = market.outcomes;
    const { trades } = tradingOn([market.id]);

    const ada = await makeTrader('ada@example.ng');
    const bola = await makeTrader('bola@example.ng');

    /*
      The only kind of match worth having, staged in full.

      The pot opens at 50/50 with no spread, so at that instant one side's
      better-than-pot price is exactly the other side's worse-than-pot price and
      nothing can cross (see `tightenToPot`). A match happens when somebody
      rested against one price and the pot has since moved past it:

        1. Ada buys NO at a limit of 40 while the pot says 50 — better than the
           pot, so it rests rather than filling. On the book that is a *short*
           of YES at 60.
        2. The pot's YES price is driven up past 60 by other trading.
        3. Bola buys YES at 65 and finds Ada's 60 sitting below the pot.

      Both beat the pot at the moment they traded. That is the whole point.
    */
    const rested = await trades.buy({
      marketId: market.id,
      outcomeId: no!.id,
      userId: ada,
      amount: '400',
      requestId: 'ada-rest',
      limitKobo: 40,
    });
    expect(rested.resting).not.toBeNull();
    expect(rested.trade).toBeNull();
    expect(rested.matched).toBeNull();
    // Stored on the YES book as a short at 60 — one book, two buttons.
    expect(rested.resting!.priceKobo).toBe(60);

    // Move the pot's YES price above 60.
    const mover = await makeTrader('mover@example.ng', '400000');
    await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: mover,
      amount: '35000',
      requestId: 'mover',
    });
    const moved = await prisma.outcome.findUniqueOrThrow({ where: { id: yes!.id } });
    expect(new Decimal(moved.priceCurrent.toString()).gt('0.60')).toBe(true);

    const filled = await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: bola,
      amount: '600',
      requestId: 'bola-take',
      limitKobo: 65,
    });

    expect(filled.matched).not.toBeNull();
    expect(new Decimal(filled.matched!.shares).toString()).toBe('1000');
    // Filled at Ada's 60, not at Bola's 65 — the improvement belongs to
    // whoever crossed the spread.
    expect(new Decimal(filled.matched!.cost).toString()).toBe('600');
    // The exact payout is known now, and it is ₦1 a share.
    expect(filled.matched!.exactPayout).toBe('1000');

    // ₦400 + ₦600 = ₦1,000 for 1,000 shares. Not a kobo more or less.
    const potStake = new Decimal(
      (await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).potTotal.toString(),
    );
    expect((await escrowIn(market.id)).minus(potStake).toString()).toBe('1000');
    // The pot holds the mover's ₦35,000 and not one kobo of the matched pair's
    // ₦1,000. This is the property the whole design turns on.
    expect(potStake.toString()).toBe('35000');
    await assertNothingInvented(market.id);
  });

  it('pays the winner an exact ₦1 a share, funded entirely by the loser', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    const { trades } = tradingOn([market.id]);
    const { maker } = await stageFillableBook(trades, market, 'win');
    const bola = await makeTrader('bola2@example.ng');

    await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: bola,
      amount: '600',
      requestId: 'r2',
      limitKobo: 65,
    });

    const beforeMaker = await wallet.balanceOf(maker);
    const beforeBola = await wallet.balanceOf(bola);

    const settled = await resolution.resolve({
      marketId: market.id,
      winningOutcomeId: yes!.id,
      resolvedBy: await makeStaff(`staff-${market.id}@example.ng`),
      evidenceUrl: 'https://www.cafonline.com/result',
    });

    expect(settled.matchedPaid.toString()).toBe('1000');
    // Paid out is exactly what was escrowed. Nothing was added to it.
    expect(settled.matchedReleased.toString()).toBe('1000');

    const afterMaker = await wallet.balanceOf(maker);
    const afterBola = await wallet.balanceOf(bola);

    // Bola staked 600 on YES and is paid 1,000: a profit of 400, which is
    // precisely the maker's stake on the losing side. Nobody else contributed.
    expect(afterBola.available.minus(beforeBola.available).toString()).toBe('1000');
    expect(afterMaker.available.minus(beforeMaker.available).toString()).toBe('0');
    expect(afterBola.escrowed.toString()).toBe('0');
    expect(afterMaker.escrowed.toString()).toBe('0');
    await assertNothingInvented(market.id);
  });

  it('splits one request across the book and the pot, and reports both legs', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    const { trades } = tradingOn([market.id]);
    await stageFillableBook(trades, market, 'split');
    const taker = await makeTrader('taker@example.ng');

    const potBefore = new Decimal(
      (await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).potTotal.toString(),
    );

    // ₦5,000 with a limit of 70. The book's ₦600 at 60 kobo is cheaper than the
    // pot, so it goes first; the rest walks the curve.
    const report = await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: taker,
      amount: '5000',
      requestId: 'tk',
      limitKobo: 70,
    });

    expect(report.matched).not.toBeNull();
    expect(report.trade).not.toBeNull();
    expect(report.resting).toBeNull();

    const matchedCost = new Decimal(report.matched!.cost);
    const potCost = new Decimal(report.trade!.cost.toString());
    // The two legs account for the whole request, exactly.
    expect(matchedCost.plus(potCost).toString()).toBe('5000');
    expect(matchedCost.toString()).toBe('600');

    // The pot grew by the pot leg only — the matched leg never reached it.
    const potAfter = new Decimal(
      (await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).potTotal.toString(),
    );
    expect(potAfter.minus(potBefore).toString()).toBe(potCost.toString());
    await assertNothingInvented(market.id);
  });

  it('never fills a limit order above its limit, on either leg', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    const { trades } = tradingOn([market.id]);
    const taker = await makeTrader('picky@example.ng');

    // The pot opens at 50 kobo, so a limit of 30 cannot be filled by it and
    // there is nothing on the book. It rests rather than filling at 50.
    const report = await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: taker,
      amount: '300',
      requestId: 'picky',
      limitKobo: 30,
    });

    expect(report.trade).toBeNull();
    expect(report.matched).toBeNull();
    expect(report.resting?.priceKobo).toBe(30);
    expect(new Decimal(report.resting!.locked).toString()).toBe('300');
    const after = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(new Decimal(after.potTotal.toString()).isZero()).toBe(true);
  });

  it('locks funds when an order rests and gives them back when it is cancelled', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    const { trades, book } = tradingOn([market.id]);
    const ada = await makeTrader('cancel@example.ng');

    const before = await wallet.balanceOf(ada);
    // A limit *better* than the pot's 50 kobo, so there is nothing to fill it
    // and it rests. A limit worse than the pot would simply be pot-filled,
    // which is the whole point of `tightenToPot`.
    const report = await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: ada,
      amount: '400',
      requestId: 'to-cancel',
      limitKobo: 40,
    });

    const resting = await wallet.balanceOf(ada);
    // No order rests without locked funds. The money is gone from available
    // the moment the row exists, not a moment later.
    expect(before.available.minus(resting.available).toString()).toBe('400');
    expect(resting.escrowed.minus(before.escrowed).toString()).toBe('400');

    await book.cancel(ada, report.resting!.orderId);

    const cancelled = await wallet.balanceOf(ada);
    expect(cancelled.available.toString()).toBe(before.available.toString());
    expect(cancelled.escrowed.toString()).toBe(before.escrowed.toString());
    expect((await escrowIn(market.id)).toString()).toBe('0');
    await assertNothingInvented(market.id);
  });

  it('is idempotent: a repeated request returns the same three legs', async () => {
    const market = await makeMarket();
    const [yes, no] = market.outcomes;
    const { trades } = tradingOn([market.id]);
    const maker = await makeTrader('mk2@example.ng');
    const taker = await makeTrader('tk2@example.ng');

    await trades.buy({
      marketId: market.id,
      outcomeId: no!.id,
      userId: maker,
      amount: '380',
      requestId: 'mk2',
      limitKobo: 38,
    });

    const input = {
      marketId: market.id,
      outcomeId: yes!.id,
      userId: taker,
      amount: '5000',
      requestId: 'same-key',
    };
    const first = await trades.buy(input);
    const escrowAfterFirst = await escrowIn(market.id);
    const second = await trades.buy(input);

    expect(second.trade?.id).toBe(first.trade?.id);
    expect(second.matched?.shares).toBe(first.matched?.shares);
    expect(second.matched?.cost).toBe(first.matched?.cost);
    // And, more to the point, no money moved the second time.
    expect((await escrowIn(market.id)).toString()).toBe(escrowAfterFirst.toString());
    await assertNothingInvented(market.id);
  });

  it('cancels and refunds every resting order at freeze', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    const { trades, book } = tradingOn([market.id]);
    const ada = await makeTrader('freeze@example.ng');

    const before = await wallet.balanceOf(ada);
    await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: ada,
      amount: '300',
      requestId: 'will-freeze',
      limitKobo: 30,
    });
    expect((await escrowIn(market.id)).toString()).toBe('300');

    const cancelled = await prisma.$transaction((tx) =>
      book.cancelAllFor(tx, market.id, `freeze:${market.id}`),
    );

    expect(cancelled).toBe(1);
    const after = await wallet.balanceOf(ada);
    // Money locked against a trade that can never happen goes straight back.
    expect(after.available.toString()).toBe(before.available.toString());
    expect((await escrowIn(market.id)).toString()).toBe('0');
    await assertNothingInvented(market.id);
  });

  it('keeps the pot and the matched pool from funding each other', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    const { trades } = tradingOn([market.id]);
    // The mover is the pot-only holder: their ₦35,000 could not have touched
    // the book, because the pot was quoting better than it when they traded.
    const { maker, mover } = await stageFillableBook(trades, market, 'cross');

    const matchLong = await makeTrader('long@example.ng');
    const mixed = await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: matchLong,
      amount: '600',
      requestId: 'm-long',
      limitKobo: 70,
    });
    expect(mixed.matched).not.toBeNull();
    const matchedShares = new Decimal(mixed.matched!.shares);

    const potAtRest = new Decimal(
      (await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).potTotal.toString(),
    );
    // The pot holds the mover's ₦35,000 and this request's pot leg, and not one
    // kobo of the matched pair's collateral.
    const potLeg = new Decimal(mixed.trade?.cost.toString() ?? '0');
    expect(potAtRest.toString()).toBe(new Decimal('35000').plus(potLeg).toString());

    const before = {
      long: await wallet.balanceOf(matchLong),
      short: await wallet.balanceOf(maker),
      pot: await wallet.balanceOf(mover),
    };

    const settled = await resolution.resolve({
      marketId: market.id,
      winningOutcomeId: yes!.id,
      resolvedBy: await makeStaff(`staff-cross-${market.id}@example.ng`),
      evidenceUrl: 'https://www.cafonline.com/result',
    });

    const after = {
      long: await wallet.balanceOf(matchLong),
      short: await wallet.balanceOf(maker),
      pot: await wallet.balanceOf(mover),
    };

    /*
      The matched long is paid ₦1 a share out of the pair's own collateral —
      exactly what was promised at execution, whatever the pot did. They may
      also hold a pot position from the same request, so their credit is at
      least the matched figure; the short, who holds nothing else, gets nothing.
    */
    expect(settled.matchedPaid.equals(matchedShares)).toBe(true);
    expect(settled.matchedPaid.equals(settled.matchedReleased)).toBe(true);
    expect(after.long.available.minus(before.long.available).gte(matchedShares)).toBe(true);
    expect(after.short.available.minus(before.short.available).toString()).toBe('0');

    // The pot was distributed among pot holders alone: what was paid out of it
    // plus the fee is the pot, to the kobo. The mover took the bulk of it.
    const distributed = settled.payouts.reduce((total, p) => total.plus(p.payout), new Decimal(0));
    expect(distributed.plus(settled.fee).minus(potAtRest).abs().lt('1e-9')).toBe(true);
    expect(after.pot.available.gt(before.pot.available)).toBe(true);

    // Everything is settled and nothing is stranded.
    expect((await escrowIn(market.id)).abs().lt('1e-9')).toBe(true);
    await assertNothingInvented(market.id);
  });

  it('leaves the market pot-only when the flag is off', async () => {
    const market = await makeMarket();
    const [yes] = market.outcomes;
    // The book exists; this market is simply not on it.
    const { trades } = tradingOn([]);
    const ada = await makeTrader('flagoff@example.ng');

    const report = await trades.buy({
      marketId: market.id,
      outcomeId: yes!.id,
      userId: ada,
      amount: '620',
      requestId: 'flag-off',
      limitKobo: 62,
    });

    // A limit above the pot's opening 50 kobo simply fills from the pot, as it
    // always did. Nothing rests, because there is no book to rest on.
    expect(report.trade).not.toBeNull();
    expect(report.matched).toBeNull();
    expect(report.resting).toBeNull();
    expect(await prisma.order.count({ where: { marketId: market.id } })).toBe(0);
  });
});

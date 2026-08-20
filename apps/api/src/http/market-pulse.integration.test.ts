import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PriceWindowService } from '../market/price-window.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { resetDatabase } from '../testing/reset';
import { MarketsController } from './markets.controller';

/**
 * The pulse endpoint, from the database up.
 *
 * `pulse.ts` is unit-tested on its arithmetic; what is worth an integration
 * test is the boundary this endpoint has to hold. Everything it reports is
 * counted from executed trades — so the tests that matter are the ones that
 * would catch it starting to report something else: a seed counted as
 * activity, a user id leaking into a public stream, or a market whose last
 * trade is older than the window losing the one figure it most needs.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const MINUTE = 60_000;

describe.skipIf(!TEST_DATABASE_URL)('market pulse (integration)', () => {
  let prisma: PrismaService;
  let controller: MarketsController;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    controller = new MarketsController(
      prisma,
      { read: async () => null } as unknown as PriceCacheService,
      new PriceWindowService(prisma),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.market.create({
      data: {
        id: 'pulse',
        shelf: 'official',
        question: 'Will the pulse count only what executed?',
        sourceName: 'CBN',
        sourceUrl: 'https://www.cbn.gov.ng/',
        criteriaJson: { Yes: 'it does', No: 'it does not' },
        edgeCasesJson: {},
        eventDate: new Date(Date.now() + 72 * 60 * MINUTE),
        voidDate: new Date(Date.now() + 96 * 60 * MINUTE),
        liquidityParam: '50000',
        feeBps: 700,
        state: 'active',
        outcomes: {
          create: [
            { id: 'pulse-yes', label: 'Yes', ordinal: 0, priceCurrent: '0.62' },
            { id: 'pulse-no', label: 'No', ordinal: 1, priceCurrent: '0.38' },
          ],
        },
      },
    });
  });

  async function trader(suffix: string) {
    return prisma.user.create({
      data: { email: `pulse-${suffix}@example.com`, pwHash: 'x' },
    });
  }

  async function trade(
    userId: string,
    side: 'buy' | 'sell' | 'seed',
    minutesAgo: number,
    ref: string,
  ) {
    await prisma.trade.create({
      data: {
        marketId: 'pulse',
        outcomeId: 'pulse-yes',
        userId,
        side,
        shares: '10',
        cost: '5',
        priceAfter: '0.5',
        requestId: `pulse-${ref}`,
        createdAt: new Date(Date.now() - minutesAgo * MINUTE),
      },
    });
  }

  it('reports a market that has never traded without inventing anything', async () => {
    const pulse = await controller.pulse('pulse');

    expect(pulse.tradesPerHour).toBe(0);
    expect(pulse.tradersActive).toBe(0);
    expect(pulse.lastTradeAt).toBeNull();
    expect(pulse.ticker).toHaveLength(0);
    // Not 0.5. A bar drawn at the halfway mark is a claim that buying and
    // selling are evenly matched in a market where neither has happened.
    expect(pulse.pressure.buyShare).toBeNull();
  });

  it('counts executed trades in the window as a rate', async () => {
    const user = await trader('rate');
    await trade(user.id, 'buy', 5, 'a');
    await trade(user.id, 'buy', 40, 'b');
    await trade(user.id, 'sell', 90, 'c');

    const pulse = await controller.pulse('pulse');

    expect(pulse.tradesPerHour).toBe(2);
  });

  it('still says when the last trade was, however far outside the window', async () => {
    const user = await trader('stale');
    await trade(user.id, 'buy', 400, 'old');

    const pulse = await controller.pulse('pulse');

    // The quiet case is the one this whole block exists for: a chart that has
    // not moved in seven hours has to be able to say so.
    expect(pulse.tradesPerHour).toBe(0);
    expect(pulse.lastTradeAt).not.toBeNull();
    expect(pulse.ticker).toHaveLength(1);
  });

  it('leaves seeding out — a seed takes no side and moves no price', async () => {
    const user = await trader('seeder');
    await trade(user.id, 'seed', 2, 'seed');

    const pulse = await controller.pulse('pulse');

    expect(pulse.tradesPerHour).toBe(0);
    expect(pulse.lastTradeAt).toBeNull();
    expect(pulse.ticker).toHaveLength(0);
  });

  it('counts a trader once however many times they traded', async () => {
    const [ada, bola] = await Promise.all([trader('ada'), trader('bola')]);
    await trade(ada.id, 'buy', 1, 'a1');
    await trade(ada.id, 'buy', 2, 'a2');
    await trade(bola.id, 'sell', 3, 'b1');

    const pulse = await controller.pulse('pulse');

    expect(pulse.tradersActive).toBe(2);
    expect(pulse.pressure).toMatchObject({ buys: 2, sells: 1 });
  });

  it('streams trades under the same per-market alias the activity feed uses', async () => {
    const user = await trader('alias');
    await trade(user.id, 'buy', 1, 'x');

    const [pulse, context] = await Promise.all([
      controller.pulse('pulse'),
      controller.context('pulse'),
    ]);

    expect(pulse.ticker[0]?.actor).toBe(context.activity[0]?.actor);
    // A ticker is more public than a feed, not less: it updates on its own and
    // sits above the fold. The same rule applies, and it applies here too.
    expect(JSON.stringify(pulse.ticker)).not.toContain(user.id);
  });

  it('buckets executed trades to the chart grid, with sides and money', async () => {
    const user = await trader('flow');
    // Two trades inside one 15-minute bucket, one in another.
    await trade(user.id, 'buy', 2, 'f1');
    await trade(user.id, 'sell', 3, 'f2');
    await trade(user.id, 'buy', 40, 'f3');

    const flow = await controller.flow('pulse', '1D');

    expect(flow.bucketSeconds).toBe(900);
    expect(flow.buckets).toHaveLength(2);

    const total = flow.buckets.reduce((sum, b) => sum + b.buys + b.sells, 0);
    expect(total).toBe(3);
    // Money, not shares: the bar's height is what changed hands.
    expect(flow.buckets.reduce((sum, b) => sum + Number(b.volume), 0)).toBe(15);
  });

  it('keeps seeds out of the bars', async () => {
    const user = await trader('flowseed');
    await trade(user.id, 'seed', 2, 'fs');

    // §2.4 again, and it matters more here than in a list: a bar for the
    // opening liquidity would draw the market as busy on the day it opened,
    // when nobody had yet taken a view on anything.
    expect((await controller.flow('pulse', '1D')).buckets).toHaveLength(0);
  });

  it('honours the timeframe, and widens with it', async () => {
    const user = await trader('flowtf');
    await trade(user.id, 'buy', 5, 'w1');
    await trade(user.id, 'buy', 300, 'w2');

    // The five-hour-old trade is outside an hour and inside a day.
    expect((await controller.flow('pulse', '1H')).buckets).toHaveLength(1);
    expect((await controller.flow('pulse', '1D')).buckets).toHaveLength(2);
    expect((await controller.flow('pulse', '1H')).bucketSeconds).toBe(60);
  });

  it('carries no price of its own — every figure is a count of trades', async () => {
    const user = await trader('shape');
    await trade(user.id, 'buy', 1, 'p1');

    const pulse = await controller.pulse('pulse');

    // The ticker quotes the price each trade executed at, which is a fact
    // about that trade. Nothing at the top level is a price, and nothing at
    // the top level may become one: a "current" or "implied" field here would
    // be a second price on a screen that already has the real one.
    const summary = Object.keys(pulse).filter((key) => key !== 'ticker');
    expect(summary).toEqual(
      expect.arrayContaining([
        'now',
        'windowMinutes',
        'tradesPerHour',
        'trend',
        'tradersActive',
        'activeMinutes',
        'lastTradeAt',
        'pressure',
      ]),
    );
    expect(summary).toHaveLength(8);
  });
});

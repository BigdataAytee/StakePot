import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PriceWindowService } from '../market/price-window.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { resetDatabase } from '../testing/reset';
import { MarketsController } from './markets.controller';

/**
 * The ticket's context panel, from the database up.
 *
 * Worth an integration test rather than a unit one because every interesting
 * thing it reports is a claim about SQL: the biggest move is a window function,
 * the holder counts are a grouped aggregate over live positions only, and the
 * lifetime high has to survive a market older than any window. None of that is
 * exercised by mocking the client.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const HOUR = 3_600_000;

describe.skipIf(!TEST_DATABASE_URL)('market context (integration)', () => {
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
  });

  /** A market with two outcomes and a price that has been somewhere. */
  async function scenario() {
    const now = Date.now();
    const market = await prisma.market.create({
      data: {
        id: 'ctx',
        shelf: 'official',
        question: 'Will the context panel report what happened?',
        sourceName: 'CBN',
        sourceUrl: 'https://www.cbn.gov.ng/',
        criteriaJson: { Yes: 'it does', No: 'it does not' },
        edgeCasesJson: {},
        eventDate: new Date(now + 72 * HOUR),
        voidDate: new Date(now + 96 * HOUR),
        liquidityParam: '50000',
        feeBps: 700,
        state: 'active',
        // Older than any window the panel could ask for.
        createdAt: new Date(now - 240 * HOUR),
        outcomes: {
          create: [
            { id: 'ctx-yes', label: 'Yes', ordinal: 0, priceCurrent: '0.62' },
            { id: 'ctx-no', label: 'No', ordinal: 1, priceCurrent: '0.38' },
          ],
        },
      },
    });

    // 0.40 → 0.44 → 0.71 → 0.62. The jump to 0.71 is the biggest move, and the
    // 0.71 is a high nothing since has matched — a 24h window would miss both.
    const path: [number, number][] = [
      [200, 0.4],
      [150, 0.44],
      [100, 0.71],
      [2, 0.62],
    ];
    await prisma.priceHistory.createMany({
      data: path.flatMap(([hoursAgo, price]) => [
        {
          marketId: market.id,
          outcomeId: 'ctx-yes',
          price: String(price),
          pot: '1000',
          ts: new Date(now - hoursAgo * HOUR),
        },
        {
          marketId: market.id,
          outcomeId: 'ctx-no',
          price: String(1 - price),
          pot: '1000',
          ts: new Date(now - hoursAgo * HOUR),
        },
      ]),
    });

    return market;
  }

  async function trader(suffix: string) {
    return prisma.user.create({
      data: { email: `ctx-${suffix}@example.com`, pwHash: 'x' },
    });
  }

  it('reports the lifetime open, high and low, not the last day of them', async () => {
    await scenario();

    const context = await controller.context('ctx');
    const yes = context.stats.find((row) => row.outcomeId === 'ctx-yes');

    expect(yes?.opened).toBeCloseTo(0.4, 6);
    expect(yes?.high).toBeCloseTo(0.71, 6);
    expect(yes?.low).toBeCloseTo(0.4, 6);
    expect(yes?.latest).toBeCloseTo(0.62, 6);
  });

  it('names the single biggest move and the side it moved', async () => {
    await scenario();

    const context = await controller.context('ctx');

    // 0.44 → 0.71 is 0.27; the 0.71 → 0.62 retrace is only 0.09. Both sides
    // moved by the same amount at the same instant, so either label is right —
    // what must not happen is the retrace winning.
    expect(context.biggestMove).not.toBeNull();
    expect(Math.abs((context.biggestMove?.to ?? 0) - (context.biggestMove?.from ?? 0))).toBeCloseTo(
      0.27,
      6,
    );
  });

  it('counts only the accounts still holding a side', async () => {
    await scenario();
    const [held, sold] = await Promise.all([trader('held'), trader('sold')]);
    await prisma.position.createMany({
      data: [
        { userId: held.id, marketId: 'ctx', outcomeId: 'ctx-yes', shares: '120' },
        // Bought and closed out. The row survives; the holder did not.
        { userId: sold.id, marketId: 'ctx', outcomeId: 'ctx-yes', shares: '0' },
      ],
    });

    const context = await controller.context('ctx');

    expect(context.stats.find((row) => row.outcomeId === 'ctx-yes')?.holders).toBe(1);
    expect(context.stats.find((row) => row.outcomeId === 'ctx-no')?.holders).toBe(0);
  });

  it('shows trades under a stable per-market alias, and never a user id', async () => {
    await scenario();
    const user = await trader('feed');
    await prisma.trade.createMany({
      data: [0, 1].map((index) => ({
        marketId: 'ctx',
        outcomeId: 'ctx-yes',
        userId: user.id,
        side: 'buy' as const,
        shares: '10',
        cost: '5',
        priceAfter: '0.5',
        requestId: `ctx-req-${index}`,
      })),
    });

    const context = await controller.context('ctx');

    expect(context.activity).toHaveLength(2);
    // Same person, same alias — a feed that renamed them between rows would
    // read as two traders agreeing rather than one doubling down.
    expect(context.activity[0]?.actor).toBe(context.activity[1]?.actor);
    expect(context.activity[0]?.actor).not.toContain(user.id);
    expect(JSON.stringify(context.activity)).not.toContain(user.id);
  });

  it('leaves seeding out of the feed', async () => {
    await scenario();
    const user = await trader('seeder');
    await prisma.trade.create({
      data: {
        marketId: 'ctx',
        outcomeId: 'ctx-yes',
        userId: user.id,
        side: 'seed',
        shares: '10',
        cost: '5',
        priceAfter: '0.5',
        requestId: 'ctx-seed',
      },
    });

    const context = await controller.context('ctx');

    // §2.4: a seed takes no side and moves no price. Listed as activity it
    // would read as conviction that nobody actually expressed.
    expect(context.activity).toHaveLength(0);
  });
});

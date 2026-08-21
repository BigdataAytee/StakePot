import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import { AuthService } from '../auth/auth.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerService } from '../ledger/ledger.service';
import { SYSTEM_PLATFORM_ACCOUNT } from '../ledger/posting';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { testOrderBook } from '../testing/order-book';
import { WalletService } from '../wallet/wallet.service';
import { MarketMakerService } from './market-maker.service';
import { LiquidityModeService } from './mode.service';
import type { FlagsService } from '../flags/flags.service';

/**
 * The market maker against a real database.
 *
 * `quoting.test.ts` proves the rules; this proves the service obeys them when
 * there are rows involved — that a budget bounds real escrow, that a kill
 * switch takes real orders off a real book, and that the money it locks comes
 * back when it stops. Every one of these is a claim about money, and money
 * claims are not settled by unit tests over a plain object.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('platform liquidity (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let wallet: WalletService;
  let auth: AuthService;
  let makers: MarketMakerService;

  const STAFF = 'staff-liquidity';

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();

    config = new PlatformConfigService(prisma);
    await config.refresh();
    const ledger = new LedgerService(prisma);
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );

    const book = testOrderBook(prisma, ledger, wallet);
    const modes = new LiquidityModeService(config, {
      on: async () => false,
    } as unknown as FlagsService);
    makers = new MarketMakerService(prisma, book, config, modes, new AdminAuditService(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await config.refresh();
    await prisma.user.upsert({
      where: { id: STAFF },
      create: {
        id: STAFF,
        role: 'admin',
        status: 'active',
        tier: 2,
        pwHash: '!test-staff-no-login!',
      },
      update: {},
    });
  });

  /** A live official market with a flat book and money in the platform account. */
  async function market(over: { freezeAt?: Date } = {}): Promise<string> {
    const id = `mm-${Math.random().toString(36).slice(2, 10)}`;
    await prisma.market.create({
      data: {
        id,
        shelf: 'official',
        question: 'Will the maker quote this market?',
        state: 'active',
        sourceName: 'A registry',
        sourceUrl: 'https://example.ng/page',
        criteriaJson: { Yes: 'The registry says so', No: 'The registry does not' },
        edgeCasesJson: { 'no publication': 'voids' },
        eventDate: new Date(Date.now() + 30 * 86_400_000),
        voidDate: new Date(Date.now() + 45 * 86_400_000),
        freezeAt: over.freezeAt ?? new Date(Date.now() + 20 * 86_400_000),
        liquidityParam: new Decimal(50_000).toString(),
        feeBps: 700,
        potTotal: '0',
        outcomes: {
          create: [
            {
              label: 'Yes',
              ordinal: 0,
              sharesOutstanding: '0',
              priceCurrent: '0.5',
              stakedTotal: '0',
            },
            {
              label: 'No',
              ordinal: 1,
              sharesOutstanding: '0',
              priceCurrent: '0.5',
              stakedTotal: '0',
            },
          ],
        },
      },
    });
    // The maker spends the platform's own money, so it has to have some.
    await wallet.issue({
      userId: SYSTEM_PLATFORM_ACCOUNT,
      amount: new Decimal(1_000_000),
      type: 'seed',
      ref: `float:${id}`,
    });
    return id;
  }

  async function configure(marketId: string, over: Record<string, unknown> = {}) {
    return makers.configure({
      marketId,
      budget: '10000',
      quoteSize: '1000',
      spreadKobo: 3,
      staffId: STAFF,
      ip: '127.0.0.1',
      ...over,
    });
  }

  /** What the maker currently has locked behind open quotes on the book. */
  async function lockedOnBook(marketId: string): Promise<Decimal> {
    const rows = await prisma.order.aggregate({
      where: { marketId, maker: true, state: 'open' },
      _sum: { locked: true },
    });
    return new Decimal((rows._sum.locked ?? 0).toString());
  }

  it('quotes both sides, tagged as the platform, and locks real escrow', async () => {
    const marketId = await market();
    await configure(marketId);
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });

    const result = await makers.cycle(marketId);
    expect(result.status).toBe('quoting');
    expect(result.quotes).toBe(2);

    const orders = await prisma.order.findMany({ where: { marketId }, orderBy: { side: 'asc' } });
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      // The tag the disclosure and the reconciliation both key off.
      expect(order.maker).toBe(true);
      expect(order.userId).toBe(SYSTEM_PLATFORM_ACCOUNT);
    }
    // Symmetric: same size both ways, mirrored around the 50k price.
    const [buyOrder, sellOrder] = orders;
    expect(buyOrder?.shares.toString()).toBe(sellOrder?.shares.toString());
    expect(50 - (buyOrder?.priceKobo ?? 0)).toBe((sellOrder?.priceKobo ?? 0) - 50);

    expect((await lockedOnBook(marketId)).gt(0)).toBe(true);
  });

  it('never locks more than the budget, however many cycles run', async () => {
    const marketId = await market();
    // A budget far smaller than a full quote would want, so the ceiling binds.
    await configure(marketId, { budget: '500', quoteSize: '100000' });
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await makers.cycle(marketId);
      const locked = await lockedOnBook(marketId);
      expect(locked.lte(500), `cycle ${cycle} locked ${locked.toString()} of 500`).toBe(true);
    }
  });

  it('replaces its quotes each cycle rather than stacking them', async () => {
    // The failure this catches: a maker that posts a fresh pair every minute
    // and never cancels the last one has committed its whole budget by
    // teatime, at prices from an hour ago.
    const marketId = await market();
    await configure(marketId);
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });

    await makers.cycle(marketId);
    await makers.cycle(marketId);
    await makers.cycle(marketId);

    expect(await prisma.order.count({ where: { marketId, state: 'open' } })).toBe(2);
  });

  it('stops quoting above the depth threshold', async () => {
    const marketId = await market();
    await configure(marketId, { depthStop: '1000' });
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });

    const outcome = await prisma.outcome.findFirstOrThrow({ where: { marketId, ordinal: 0 } });
    const punter = await trader('depth@example.ng');
    // Real depth, on both sides, from somebody who is not the maker.
    for (const [side, price] of [
      ['buy', 45],
      ['sell', 55],
    ] as const) {
      await prisma.order.create({
        data: {
          marketId,
          outcomeId: outcome.id,
          userId: punter,
          side,
          priceKobo: price,
          shares: '5000',
          locked: '0',
          requestId: `real-${side}`,
        },
      });
    }

    const result = await makers.cycle(marketId);
    expect(result.status).toBe('depth_reached');
    expect(await prisma.order.count({ where: { marketId, maker: true, state: 'open' } })).toBe(0);
  });

  it('stands down before the freeze', async () => {
    const marketId = await market({ freezeAt: new Date(Date.now() + 10 * 60_000) });
    await configure(marketId);
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });

    const result = await makers.cycle(marketId);
    expect(result.status).toBe('market_closing');
    expect(await prisma.order.count({ where: { marketId, maker: true, state: 'open' } })).toBe(0);
  });

  it('halts within one cycle when killed, and gives the escrow back', async () => {
    const marketId = await market();
    await configure(marketId);
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });
    await makers.cycle(marketId);
    expect((await lockedOnBook(marketId)).gt(0)).toBe(true);

    const before = await wallet.balanceOf(SYSTEM_PLATFORM_ACCOUNT);
    const killed = await makers.kill({
      marketId,
      staffId: STAFF,
      ip: '127.0.0.1',
      reason: 'pulling it for a look',
    });

    // Immediately: the quotes are off the book, not merely marked.
    expect(killed.cancelled).toBe(2);
    expect(await prisma.order.count({ where: { marketId, maker: true, state: 'open' } })).toBe(0);
    const after = await wallet.balanceOf(SYSTEM_PLATFORM_ACCOUNT);
    expect(after.available.gt(before.available)).toBe(true);

    // And it stays down: the next sweep must not quietly restart it.
    const next = await makers.cycle(marketId);
    expect(next.status).toBe('killed');
    expect(next.quotes).toBe(0);
  });

  it('kills every market at once', async () => {
    const first = await market();
    const second = await market();
    for (const marketId of [first, second]) {
      await configure(marketId);
      await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });
      await makers.cycle(marketId);
    }

    const result = await makers.killAll({
      staffId: STAFF,
      ip: '127.0.0.1',
      reason: 'incident — everything down',
    });
    expect(result.markets).toBe(2);
    expect(result.cancelled).toBe(4);
    expect(await prisma.order.count({ where: { maker: true, state: 'open' } })).toBe(0);
  });

  it('refuses to run on a market it seeded without an explicit confirm', async () => {
    const marketId = await market();
    await configure(marketId);
    await makers.noteSeed(marketId, STAFF);

    await expect(makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' })).rejects.toThrow(
      /stacks platform exposure/,
    );
    // And goes ahead once somebody says they mean it.
    const started = await makers.start({
      marketId,
      staffId: STAFF,
      ip: '127.0.0.1',
      confirmStacking: true,
    });
    expect(started.enabled).toBe(true);
  });

  it('refuses a budget above the configured ceiling', async () => {
    const marketId = await market();
    await expect(configure(marketId, { budget: '99999999' })).rejects.toThrow(/capped at/);
  });

  it('writes an audit row for every action', async () => {
    const marketId = await market();
    await configure(marketId);
    await makers.start({ marketId, staffId: STAFF, ip: '127.0.0.1' });
    await makers.kill({ marketId, staffId: STAFF, ip: '127.0.0.1', reason: 'done looking' });

    const rows = await prisma.adminAudit.findMany({
      where: { targetRef: `market:${marketId}` },
      orderBy: { ts: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual([
      'liquidity.maker:configure',
      'liquidity.maker:start',
      'liquidity.maker:kill',
    ]);
    // The mode is on the record, not merely in config at the time.
    expect(JSON.stringify(rows[0]?.afterJson)).toContain('"mode":"test"');
  });

  async function trader(email: string): Promise<string> {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    return userId;
  }
});

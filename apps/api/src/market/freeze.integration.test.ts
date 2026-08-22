import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { AnalyticsService } from '../analytics/analytics.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { testOrderBook } from '../testing/order-book';
import { resetDatabase } from '../testing/reset';
import { ThreadService } from '../community-layer/thread.service';
import { TradeQueueService } from '../trade/trade-queue.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { MarketFreezeService } from './freeze.service';
import { MarketService } from './market.service';

/**
 * Trading stops when the event starts (§2.3, checklist rule 22).
 *
 * The rule protects the slower trader in both directions, and the two tests
 * that matter here are the two ways a platform gets this wrong: refusing at the
 * endpoint but not at execution, and stopping buys while still allowing exits.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** Deliveries go nowhere; a market must freeze whether or not a gateway is up. */
const silentNotifications = {
  notify: async () => ({ delivered: [], failed: [] }),
} as unknown as NotificationsService;

describe.skipIf(!TEST_DATABASE_URL)('market freeze (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let markets: MarketService;
  let trades: TradeService;
  let freezes: MarketFreezeService;
  let auth: AuthService;
  let wallet: WalletService;
  let queue: TradeQueueService;
  let redis: Redis;

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
    markets = new MarketService(prisma, config);
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      { publish: async () => undefined } as unknown as PriceCacheService,
      new RgService(prisma, config),
      testOrderBook(prisma, ledger, wallet),
    );
    freezes = new MarketFreezeService(
      prisma,
      new AdminAuditService(prisma),
      silentNotifications,
      config,
      testOrderBook(prisma, ledger, wallet),
    );
    queue = new TradeQueueService(
      trades,
      prisma,
      new ThreadService(prisma, config),
      silentNotifications,
    );
    await queue.onModuleInit();
    redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  });

  afterAll(async () => {
    await queue.onModuleDestroy();
    redis.disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    // Postgres is reset; Redis is not. Entries left on a market's stream by an
    // earlier run refer to markets that no longer exist.
    const streams = await redis.keys('stakeam:trades:*');
    if (streams.length > 0) await redis.del(...streams);
  });

  async function liveMarket(minutesToEvent = 60) {
    const eventDate = new Date(Date.now() + minutesToEvent * 60_000);
    const market = await markets.create({
      shelf: 'official',
      question: 'Will the Super Eagles beat Ghana?',
      sourceName: 'CAF official results',
      sourceUrl: 'https://www.cafonline.com/',
      criteria: { Yes: 'Nigeria ahead at full time', No: 'Any other full-time result' },
      edgeCases: { abandoned: 'void' },
      eventDate,
      voidDate: new Date(eventDate.getTime() + 7 * 86_400_000),
      liquidityParam: '50000',
      outcomeLabels: ['Yes', 'No'],
    });
    await prisma.market.update({ where: { id: market.id }, data: { state: 'active' } });
    return market;
  }

  async function punter(email: string) {
    const account = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await wallet.issue({
      userId: account.userId,
      amount: new Decimal('100000'),
      type: 'adjustment',
      ref: `fund:${account.userId}`,
    });
    return account;
  }

  it('writes a freeze time at creation, ahead of the event by the buffer', async () => {
    const market = await liveMarket();
    const row = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });

    expect(row.freezeAt).not.toBeNull();
    const gap = row.eventDate.getTime() - (row.freezeAt as Date).getTime();
    // Two minutes, the seeded `freeze_buffer_seconds`. Not zero: a trade sent
    // just before kick-off can otherwise execute just after it.
    expect(gap).toBe(120_000);
  });

  it('refuses a trade after the freeze time even while the sweep has not run', async () => {
    const market = await liveMarket();
    const buyer = await punter('freeze-buyer@example.ng');
    const [yes] = await prisma.outcome.findMany({
      where: { marketId: market.id },
      orderBy: { ordinal: 'asc' },
    });

    // The clock has passed. The state has not been swept — this is exactly the
    // window a check that trusted the flag would wave a trade through.
    await prisma.market.update({
      where: { id: market.id },
      data: { freezeAt: new Date(Date.now() - 1000) },
    });
    expect((await prisma.market.findUniqueOrThrow({ where: { id: market.id } })).state).toBe(
      'active',
    );

    await expect(
      trades.buy({
        marketId: market.id,
        outcomeId: yes?.id as string,
        userId: buyer.userId,
        amount: '500',
        requestId: 'after-freeze-buy',
      }),
    ).rejects.toThrow(/Trading closed/);
  });

  it('blocks selling out as firmly as buying in', async () => {
    const market = await liveMarket();
    const holder = await punter('freeze-holder@example.ng');
    const [yes] = await prisma.outcome.findMany({
      where: { marketId: market.id },
      orderBy: { ordinal: 'asc' },
    });

    const opened = await trades.buy({
      marketId: market.id,
      outcomeId: yes?.id as string,
      userId: holder.userId,
      amount: '5000',
      requestId: 'pre-freeze-buy',
    });
    expect(opened.trade!.id).toBeTruthy();

    await freezes.freeze({ marketId: market.id, reason: 'the event started' });

    // The asymmetry this closes: somebody who has seen the score dumping a
    // losing position on somebody who has not. A freeze that stopped buys and
    // allowed exits would look protective and move the loss onto the slower
    // trader.
    await expect(
      trades.sell({
        marketId: market.id,
        outcomeId: yes?.id as string,
        userId: holder.userId,
        shares: '1',
        requestId: 'after-freeze-sell',
      }),
    ).rejects.toThrow(/Trading closed/);
  });

  /**
   * Note for whoever sees this fail locally: a dev API left running on this
   * machine has its own trade worker on the same Redis, and it will drain this
   * market's stream against the *dev* database — where the market does not
   * exist — recording a generic failure under the request id this test is
   * waiting on. `fuser -k 3001/tcp` before running the suite.
   */
  it('rejects a trade that queued before the freeze and reached the front after it', async () => {
    const market = await liveMarket();
    const buyer = await punter('freeze-queued@example.ng');
    const [yes] = await prisma.outcome.findMany({
      where: { marketId: market.id },
      orderBy: { ordinal: 'asc' },
    });

    // Submitted while the market is open, and put on the market's stream
    // exactly as `submit` does. It sits there behind whatever else is queued.
    const request = {
      kind: 'buy' as const,
      marketId: market.id,
      outcomeId: yes?.id as string,
      userId: buyer.userId,
      amount: '500',
      // Unique per run. A fixed id is a trap here: the stream survives
      // `resetDatabase`, so an entry left by the previous run is replayed
      // against a market that no longer exists, and its rejection lands under
      // the very id this run is waiting on.
      requestId: `queued-then-frozen-${process.hrtime.bigint()}`,
    };
    await redis.xadd(`stakeam:trades:{${market.id}}`, '*', 'payload', JSON.stringify(request));

    // The event starts while it is waiting its turn. This is the case a check
    // at the endpoint waves through and a check at execution refuses — and it
    // is not hypothetical: a burst on a popular market is exactly when the
    // queue is deepest, which is the last minute before kick-off.
    await freezes.freeze({ marketId: market.id, reason: 'the event started' });
    await redis.sadd('stakeam:trades:active', market.id);

    const deadline = Date.now() + 10_000;
    let outcome = await queue.outcomeOf(request.requestId);
    while (outcome.status === 'queued' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      outcome = await queue.outcomeOf(request.requestId);
    }

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toMatch(/Trading closed/);
    // And nothing was written. A refusal that still left a trade row would be
    // the worst of both.
    expect(await prisma.trade.count({ where: { marketId: market.id } })).toBe(0);
  });

  it('freezes what is due, and does nothing at all the second time', async () => {
    const soon = await liveMarket(-1);
    const later = await liveMarket(600);

    const first = await freezes.sweep();
    expect(first.frozen).toBe(1);

    const frozen = await prisma.market.findUniqueOrThrow({ where: { id: soon.id } });
    expect(frozen.state).toBe('frozen');
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.freezeReason).toBe('the event started');
    expect((await prisma.market.findUniqueOrThrow({ where: { id: later.id } })).state).toBe(
      'active',
    );

    const annotations = await prisma.marketAnnotation.count({
      where: { marketId: soon.id, type: 'freeze' },
    });
    expect(annotations).toBe(1);
    const audits = await prisma.adminAudit.count({ where: { targetRef: soon.id } });
    expect(audits).toBe(1);

    // A schedule can fire twice and a late job can arrive after a manual
    // freeze. Neither may re-annotate the chart or re-notify every holder —
    // the whole point of `frozenAt` is that everything downstream of the flip
    // happens on the transition only.
    const second = await freezes.sweep();
    expect(second.frozen).toBe(0);
    expect(
      await prisma.marketAnnotation.count({ where: { marketId: soon.id, type: 'freeze' } }),
    ).toBe(1);
    expect(await prisma.adminAudit.count({ where: { targetRef: soon.id } })).toBe(1);
    const again = await prisma.market.findUniqueOrThrow({ where: { id: soon.id } });
    expect(again.frozenAt?.toISOString()).toBe(frozen.frozenAt?.toISOString());
  });

  it('records who froze a market by hand, and why', async () => {
    const market = await liveMarket(600);

    const result = await freezes.freeze({
      marketId: market.id,
      reason: 'the result leaked on the wire',
      actor: { userId: 'staff-1', ip: '10.0.0.1' },
    });
    expect(result.froze).toBe(true);

    const audit = await prisma.adminAudit.findFirstOrThrow({ where: { targetRef: market.id } });
    expect(audit.action).toBe('market.freeze:manual');
    expect(audit.staffId).toBe('staff-1');
    expect(JSON.stringify(audit.afterJson)).toContain('leaked');

    // An emergency freeze beats the clock: the market had ten hours left.
    const row = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
    expect(row.state).toBe('frozen');
    expect(row.freezeReason).toBe('the result leaked on the wire');
  });

  it('refuses a freeze with no reason behind it', async () => {
    const market = await liveMarket(600);
    await expect(
      freezes.freeze({ marketId: market.id, reason: ' ', actor: { userId: 's', ip: 'ip' } }),
    ).rejects.toThrow(/needs a reason/);
  });

  describe('amending the time', () => {
    it('moves a freeze that has not happened yet', async () => {
      const market = await liveMarket(60);
      const moved = new Date(Date.now() + 5 * 3_600_000);

      const result = await freezes.amend({
        marketId: market.id,
        freezeAt: moved,
        eventDate: new Date(moved.getTime() + 120_000),
        reason: 'the fixture was rescheduled to the evening',
        actor: { userId: 'staff-1', ip: '10.0.0.1' },
      });

      expect(result.freezeAt).toBe(moved.toISOString());
      const audit = await prisma.adminAudit.findFirstOrThrow({
        where: { targetRef: market.id, action: 'market.freeze:amend' },
      });
      expect(JSON.stringify(audit.beforeJson)).toContain('freezeAt');
    });

    it('will not leave trading open past the event, or past the void date', async () => {
      const market = await liveMarket(60);
      await expect(
        freezes.amend({
          marketId: market.id,
          freezeAt: new Date(Date.now() + 10 * 86_400_000),
          reason: 'the fixture was rescheduled to next week',
          actor: { userId: 'staff-1', ip: '10.0.0.1' },
        }),
      ).rejects.toThrow(/cannot still be open once the event has started/);
    });

    it('refuses to amend a market that is already frozen — that is an unfreeze', async () => {
      const market = await liveMarket(60);
      await freezes.freeze({ marketId: market.id, reason: 'the event started' });

      await expect(
        freezes.amend({
          marketId: market.id,
          freezeAt: new Date(Date.now() + 3_600_000),
          reason: 'actually it has not started yet',
          actor: { userId: 'staff-1', ip: '10.0.0.1' },
        }),
      ).rejects.toThrow(/needs two approvals/);
    });
  });
});

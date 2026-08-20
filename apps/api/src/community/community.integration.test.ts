import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { RgService } from '../rg/rg.service';
import { resetDatabase } from '../testing/reset';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { CommunityService } from './community.service';
import { MarketVoidService } from './void.service';
import type { MarketTemplate } from './market-template';
import { approvalAnswers, compliantTemplate } from '../testing/templates';
import { CreatorAnalyticsService } from '../creator/analytics.service';
import { AutopsyService } from '../creator/autopsy.service';
import { CreatorService } from '../creator/creator.service';
import { AnalyticsService } from '../analytics/analytics.service';

/**
 * The community shelf against a real database.
 *
 * These are the paths where a mistake takes somebody's money and does not give
 * it back: the bond, the funding window, and the void refund.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('community shelf (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let wallet: WalletService;
  let auth: AuthService;
  let community: CommunityService;
  let trades: TradeService;
  let reconciliation: ReconciliationService;

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
    const voids = new MarketVoidService(ledger);
    // Notifications are best-effort by design; in tests they run against the
    // same database with every channel unconfigured, so they record and move on.
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    // §2.14's creator platform: the ladder, the analytics it reads, and
    // the autopsy that moves a creator's record when a market closes.
    const creators = new CreatorService(prisma, config, notifications);
    const creatorAnalytics = new CreatorAnalyticsService(prisma);
    const autopsies = new AutopsyService(prisma, creatorAnalytics, creators, notifications);
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
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      { publish: async () => undefined } as unknown as PriceCacheService,
      new RgService(prisma, config),
    );
    reconciliation = new ReconciliationService(prisma, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    // These tests turn on small floors; the seeded values are production-sized.
    await prisma.platformConfig.updateMany({
      where: { key: 'community_activation_pool_spc' },
      data: { valueJson: 1000 },
    });
    await prisma.platformConfig.updateMany({
      where: { key: 'community_activation_backers' },
      data: { valueJson: 2 },
    });
    await config.refresh();
  });

  // One compliant fixture, from the shared builder. Each test that wants a
  // refusal overrides the one field it is about, so the reason a call was
  // refused is never ambiguous.
  const template: MarketTemplate = compliantTemplate({
    question: 'Will the Lagos okada ban still hold at 23:59 WAT on the last day of the quarter?',
    outcomes: [
      {
        label: 'YES',
        criteria:
          'The Lagos State Government gazette shows the ban still in force at 23:59 WAT on the stated date.',
      },
      {
        label: 'NO',
        criteria: 'The gazette shows the ban lifted or suspended by 23:59 WAT on the stated date.',
      },
    ],
    sourceName: 'Lagos State Government gazette',
    sourceUrl: 'https://lagosstate.gov.ng/gazette/transport-notices/',
    eventDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    voidDate: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    edgeCases: {
      'partial lift': 'A partial lift counts as lifted.',
      'no publication': 'If the gazette publishes nothing by the void date, the market voids.',
    },
  });

  async function trader(email: string) {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
    return userId;
  }

  it('escrows the conduct bond when the market is created', async () => {
    const creator = await trader('creator@example.ng');
    const before = await wallet.balanceOf(creator);
    const bond = new Decimal(await config.get('conduct_bond_spc'));

    const { marketId } = await community.create({
      creatorId: creator,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    const after = await wallet.balanceOf(creator);
    expect(before.available.minus(after.available).eq(bond)).toBe(true);
    expect(after.escrowed.eq(bond)).toBe(true);

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('funding');
    expect(market.shelf).toBe('community');

    const held = await prisma.bond.findFirstOrThrow({ where: { marketId } });
    expect(held.state).toBe('held');
  });

  it('refuses a template that fails the screen, and takes no bond', async () => {
    const creator = await trader('blocked@example.ng');
    const before = await wallet.balanceOf(creator);

    await expect(
      community.create({
        creatorId: creator,
        template: { ...template, question: 'Will the governor die in office?' },
        ...approvalAnswers(),
        liquidityParam: '50000',
      }),
    ).rejects.toThrow(/Rule 13: Markets on death/);

    const after = await wallet.balanceOf(creator);
    expect(after.available.eq(before.available)).toBe(true);
    expect(await prisma.market.count()).toBe(0);
  });

  it('will not let the creator take a side in their own market', async () => {
    const creator = await trader('conflicted@example.ng');
    const { marketId } = await community.create({
      creatorId: creator,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    await prisma.market.update({ where: { id: marketId }, data: { state: 'active' } });
    const outcome = await prisma.outcome.findFirstOrThrow({ where: { marketId, ordinal: 0 } });

    await expect(
      trades.buy({
        marketId,
        outcomeId: outcome.id,
        userId: creator,
        amount: '500',
        requestId: 'creator-stake',
      }),
    ).rejects.toThrow(/cannot take a side/);
  });

  it('activates when both floors are met at window close', async () => {
    const creator = await trader('c-activate@example.ng');
    const { marketId } = await community.create({
      creatorId: creator,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    await prisma.market.update({ where: { id: marketId }, data: { state: 'active' } });

    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    for (const [i, email] of ['a@example.ng', 'b@example.ng'].entries()) {
      const userId = await trader(email);
      for (const outcome of outcomes) {
        await trades.buy({
          marketId,
          outcomeId: outcome.id,
          userId,
          amount: '1200',
          requestId: `fund-${i}-${outcome.ordinal}`,
        });
      }
    }

    await prisma.market.update({ where: { id: marketId }, data: { state: 'funding' } });
    const result = await community.closeFundingWindow(marketId);

    expect(result.outcome).toBe('activated');
    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('active');
  });

  it('voids an under-funded market and returns every naira, bond included', async () => {
    const creator = await trader('c-void@example.ng');
    const bondBefore = await wallet.balanceOf(creator);

    const { marketId } = await community.create({
      creatorId: creator,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    await prisma.market.update({ where: { id: marketId }, data: { state: 'active' } });

    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    const backer = await trader('lonely@example.ng');
    const staked = await wallet.balanceOf(backer);
    await trades.buy({
      marketId,
      outcomeId: outcomes[0]!.id,
      userId: backer,
      amount: '300',
      requestId: 'thin-funding',
    });

    await prisma.market.update({ where: { id: marketId }, data: { state: 'funding' } });
    const result = await community.closeFundingWindow(marketId);

    expect(result.outcome).toBe('voided');
    expect(result.reason).toBeDefined();

    // Everybody whole: the backer's stake and the creator's bond both come back.
    const backerAfter = await wallet.balanceOf(backer);
    const creatorAfter = await wallet.balanceOf(creator);
    expect(backerAfter.available.eq(staked.available)).toBe(true);
    expect(backerAfter.escrowed.abs().lt('1e-9')).toBe(true);
    expect(creatorAfter.available.eq(bondBefore.available)).toBe(true);
    expect(creatorAfter.escrowed.abs().lt('1e-9')).toBe(true);

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('voided');
    expect(new Decimal(market.potTotal.toString()).isZero()).toBe(true);

    const bond = await prisma.bond.findFirstOrThrow({ where: { marketId } });
    expect(bond.state).toBe('refunded');

    const check = await reconciliation.run('SPC', new Date());
    expect(check.status).toBe('clean');
  });

  it('closing the window twice does not refund twice', async () => {
    const creator = await trader('c-twice@example.ng');
    const { marketId } = await community.create({
      creatorId: creator,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    await prisma.market.update({ where: { id: marketId }, data: { state: 'funding' } });

    const first = await community.closeFundingWindow(marketId);
    expect(first.outcome).toBe('voided');

    const balanceAfterFirst = await wallet.balanceOf(creator);
    // At-least-once delivery is the normal case for a queue, not the edge case.
    const second = await community.closeFundingWindow(marketId);
    expect(second.outcome).toBe('skipped');

    const balanceAfterSecond = await wallet.balanceOf(creator);
    expect(balanceAfterSecond.available.eq(balanceAfterFirst.available)).toBe(true);

    const check = await reconciliation.run('SPC', new Date());
    expect(check.status).toBe('clean');
  });
});

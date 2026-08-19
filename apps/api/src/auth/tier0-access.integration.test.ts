import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerService } from '../ledger/ledger.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { resetDatabase } from '../testing/reset';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { AuthService } from './auth.service';

/**
 * What an unverified account can do.
 *
 * §2.1's Tier 0 is "friction-free entry": an email or phone and a password, a
 * starter balance, and the markets. Verification is what money leaving requires
 * — it is not the price of getting in, and nothing here may quietly become a
 * gate on the way to one.
 *
 * These are written as a fence rather than as a feature. Tier gates are easy to
 * add one endpoint at a time, each defensible on its own, until a stranger
 * cannot use the product they just signed up for; this fails the moment one
 * lands in front of trading.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('tier 0 access (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let trades: TradeService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();

    config = new PlatformConfigService(prisma);
    await config.refresh();
    const ledger = new LedgerService(prisma);
    const wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      { publish: async () => undefined } as unknown as PriceCacheService,
      new RgService(prisma, config),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await config.refresh();
  });

  async function unverified(email: string) {
    const account = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: account.userId } });
    // The state a real signup leaves behind: no code entered, no contact proven.
    expect(user.tier).toBe(0);
    expect(user.contactVerified).toBe(false);
    return account.userId;
  }

  async function market(shelf: 'official' | 'community', question: string) {
    return prisma.market.create({
      data: {
        shelf,
        question,
        sourceName: 'Source',
        sourceUrl: 'https://example.ng/',
        criteriaJson: {},
        edgeCasesJson: {},
        eventDate: new Date(Date.now() + 10 * 86_400_000),
        voidDate: new Date(Date.now() + 17 * 86_400_000),
        liquidityParam: '50000',
        feeBps: 700,
        state: 'active',
        outcomes: {
          create: [
            { label: 'Yes', ordinal: 0, priceCurrent: '0.5' },
            { label: 'No', ordinal: 1, priceCurrent: '0.5' },
          ],
        },
      },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
  }

  it('stakes on an official market with nothing but a starter balance', async () => {
    const userId = await unverified('tier0-official@example.com');
    const m = await market('official', 'Will the Super Eagles win?');

    const trade = await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '1000',
      requestId: `t0-official-${userId}`,
    });

    expect(trade.cost.toString()).toBe('1000');
    expect(new Decimal(trade.shares.toString()).gt(0)).toBe(true);
  });

  it('stakes on a community market too — the shelf makes no difference', async () => {
    const userId = await unverified('tier0-community@example.com');
    const m = await market('community', 'Will this community market take a stake?');

    const trade = await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '1000',
      requestId: `t0-community-${userId}`,
    });

    expect(trade.cost.toString()).toBe('1000');
  });

  it('can get out again — entry without an exit would be the same trap', async () => {
    const userId = await unverified('tier0-exit@example.com');
    const m = await market('official', 'Can an unverified account sell?');

    const bought = await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '2000',
      requestId: `t0-buy-${userId}`,
    });

    const sold = await trades.sell({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      shares: bought.shares.toString(),
      requestId: `t0-sell-${userId}`,
    });

    // Out at a loss, because §2.3's early-exit fee is withheld from the seller —
    // but out.
    expect(new Decimal(sold.cost.toString()).abs().gt(0)).toBe(true);
  });

  it('holds a position and sees the market like anybody else', async () => {
    const userId = await unverified('tier0-position@example.com');
    const m = await market('official', 'Does an unverified position exist?');

    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '1500',
      requestId: `t0-pos-${userId}`,
    });

    const positions = await prisma.position.findMany({ where: { userId, marketId: m.id } });
    expect(positions).toHaveLength(1);
    expect(new Decimal(positions[0]!.shares.toString()).gt(0)).toBe(true);
  });

  it('was paid the starter balance and not the verification bonus', async () => {
    // The two are separate on purpose: entry is free, and the bonus is what
    // proving a contact buys. Paying both at signup would make Tier 1 pointless
    // and hand a farm two balances per throwaway address.
    const userId = await unverified('tier0-balance@example.com');

    const starter = await config.get('starter_balance_spc');
    const credited = await prisma.ledgerEntry.aggregate({
      where: { userId, fundClass: 'user_available' },
      _sum: { amount: true },
    });

    expect(new Decimal(credited._sum.amount?.toString() ?? '0').eq(starter)).toBe(true);
  });
});

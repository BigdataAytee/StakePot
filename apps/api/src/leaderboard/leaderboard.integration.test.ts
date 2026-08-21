import { JwtService } from '@nestjs/jwt';
import { generateSync } from 'otplib';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AnalyticsService } from '../analytics/analytics.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthService } from '../auth/auth.service';
import { TotpService } from '../auth/totp.service';
import { SeedService } from '../community/seed.service';
import { MarketVoidService } from '../community/void.service';
import { CreatorService } from '../creator/creator.service';
import { LedgerService } from '../ledger/ledger.service';
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
import { LeaderboardService } from './leaderboard.service';
import { PrizeError, PrizeService } from './prize.service';
import { ALL_TIME, isoWeekOf } from './scoring';

/**
 * §2.8's engagement layer against a real database.
 *
 * The scoring rules are tested next door. What needs a database is everything
 * they cannot see: that a board is built from what actually settled, that money
 * only moves when two people have signed, that a run cannot pay twice however
 * many times the approval is delivered, and that Tier 0 is kept out at the
 * moment of payment and not merely at the moment of drawing up.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('leaderboards and prizes (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let wallet: WalletService;
  let trades: TradeService;
  let payouts: ResolutionService;
  let leaderboards: LeaderboardService;
  let prizes: PrizeService;
  let approvals: ApprovalsService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();

    const ledger = new LedgerService(prisma);
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    const audit = new AdminAuditService(prisma);
    const analytics = new AnalyticsService(prisma);
    wallet = new WalletService(prisma, ledger);
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
      testOrderBook(prisma, ledger, wallet),
    );
    payouts = new ResolutionService(prisma, ledger, config);
    leaderboards = new LeaderboardService(prisma, config, analytics);
    prizes = new PrizeService(prisma, config, wallet, notifications, audit, analytics);
    const voids = new MarketVoidService(ledger);
    approvals = new ApprovalsService(
      prisma,
      ledger,
      voids,
      config,
      audit,
      new TotpService(prisma),
      prizes,
      // The approvals service executes a LIVE-mode platform seed through the
      // one place a symmetric top-up happens. This board never proposes one;
      // it is wired because the constructor is the contract.
      new SeedService(
        prisma,
        config,
        wallet,
        voids,
        new CreatorService(
          prisma,
          config,
          new NotificationsService(
            prisma,
            new PushSender(prisma),
            new EmailSender(),
            new SmsSender(),
          ),
        ),
      ),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.platformConfig.updateMany({
      where: { key: 'leaderboard_min_markets_accuracy' },
      data: { valueJson: 1 },
    });
    await prisma.platformConfig.updateMany({
      where: { key: 'leaderboard_min_staked_profit' },
      data: { valueJson: 1 },
    });
    await config.refresh();
  });

  async function person(email: string, tier = 1, topUp = '500000') {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    if (tier >= 1) await auth.markContactVerified(userId);
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

  /**
   * A staff account with 2FA live, because §2.11 requires a step-up code before
   * anybody signs a money action — and a prize run is one.
   */
  async function staff(email: string, role: 'finance' | 'admin') {
    const userId = await person(email, 1, '0');
    await prisma.user.update({ where: { id: userId }, data: { role } });

    const totp = new TotpService(prisma);
    const enrolment = await totp.beginEnrolment(userId);
    await totp.confirmEnrolment(userId, generateSync({ secret: enrolment.secret }));

    return {
      userId,
      role,
      ip: '127.0.0.1',
      code: () => generateSync({ secret: enrolment.secret }),
    } as const;
  }

  /** A market that settles on the given outcome, with the given stakers. */
  async function settledMarket(params: {
    label: string;
    stakes: readonly { userId: string; outcome: 0 | 1; amount: string }[];
    winner: 0 | 1;
  }) {
    const market = await prisma.market.create({
      data: {
        shelf: 'official',
        question: `Will ${params.label} happen?`,
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

    for (const stake of params.stakes) {
      await trades.buy({
        marketId: market.id,
        outcomeId: market.outcomes[stake.outcome]!.id,
        userId: stake.userId,
        amount: stake.amount,
        requestId: `buy-${market.id}-${stake.userId}`,
      });
    }

    await payouts.resolve({
      marketId: market.id,
      winningOutcomeId: market.outcomes[params.winner]!.id,
      resolvedBy: params.stakes[0]!.userId,
      evidenceUrl: 'https://example.ng/result',
    });

    return market;
  }

  // ------------------------------------------------------------------ boards

  it('builds a board from what actually settled', async () => {
    const winner = await person('winner@example.com');
    const loser = await person('loser@example.com');

    await settledMarket({
      label: 'the first thing',
      stakes: [
        { userId: winner, outcome: 0, amount: '20000' },
        { userId: loser, outcome: 1, amount: '20000' },
      ],
      winner: 0,
    });

    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });
    const board = await leaderboards.board({ period: ALL_TIME, board: 'profit' });

    expect(board[0]?.userId).toBe(winner);
    expect(Number(board[0]?.profit)).toBeGreaterThan(0);
    // The loser is on the board too — a leaderboard that hides losses is a
    // marketing page, not a record.
    const loserRow = board.find((row) => row.userId === loser);
    expect(Number(loserRow?.profit)).toBeLessThan(0);
  });

  it('ignores open markets entirely', async () => {
    const punter = await person('open@example.com');
    const market = await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will this still be open?',
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
      include: { outcomes: true },
    });
    await trades.buy({
      marketId: market.id,
      outcomeId: market.outcomes[0]!.id,
      userId: punter,
      amount: '20000',
      requestId: `buy-open-${punter}`,
    });

    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });
    const board = await leaderboards.board({ period: ALL_TIME, board: 'profit' });

    // Paper gains are not a standing. A board that counted them would change
    // every time a price moved.
    expect(board).toHaveLength(0);
  });

  it('keeps Tier 0 off the board', async () => {
    const unverified = await person('unverified@example.com', 0);
    const verified = await person('verified@example.com');

    await settledMarket({
      label: 'a tiered thing',
      stakes: [
        // Inside §2.1's Tier 0 exposure cap, because that is now enforced and
        // an unverified account cannot hold 20,000 across open markets. The
        // amount does not weaken the assertion: `beforeEach` drops
        // `leaderboard_min_staked_profit` to 1, so tier is the only thing
        // keeping this account off the board — which is what the test is for.
        { userId: unverified, outcome: 0, amount: '4000' },
        { userId: verified, outcome: 1, amount: '20000' },
      ],
      winner: 0,
    });

    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });
    const board = await leaderboards.board({ period: ALL_TIME, board: 'profit' });

    expect(board.map((row) => row.userId)).not.toContain(unverified);
    expect(board.map((row) => row.userId)).toContain(verified);
  });

  it('replaces a snapshot wholesale rather than patching it', async () => {
    const punter = await person('replaced@example.com');
    const other = await person('other@example.com');
    await settledMarket({
      label: 'a replaceable thing',
      stakes: [
        { userId: punter, outcome: 0, amount: '20000' },
        { userId: other, outcome: 1, amount: '20000' },
      ],
      winner: 0,
    });

    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });
    const first = await prisma.leaderboardSnapshot.count({
      where: { period: ALL_TIME, board: 'profit' },
    });
    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });
    const second = await prisma.leaderboardSnapshot.count({
      where: { period: ALL_TIME, board: 'profit' },
    });

    // A row surviving from a computation whose inputs have changed is exactly
    // how a published standing stops being reproducible.
    expect(second).toBe(first);
  });

  it('counts a streak from settled markets', async () => {
    const punter = await person('streaky@example.com');
    const foil = await person('foil@example.com');

    for (const label of ['one', 'two']) {
      await settledMarket({
        label,
        stakes: [
          { userId: punter, outcome: 0, amount: '10000' },
          { userId: foil, outcome: 1, amount: '10000' },
        ],
        winner: 0,
      });
    }

    const streak = await leaderboards.streakOf(punter);
    expect(streak.current).toBe(2);
    expect(streak.best).toBe(2);
    expect((await leaderboards.streakOf(foil)).current).toBe(0);
  });

  it('files the current week under an ISO week key', async () => {
    const punter = await person('weekly@example.com');
    const foil = await person('weeklyfoil@example.com');
    await settledMarket({
      label: 'a weekly thing',
      stakes: [
        { userId: punter, outcome: 0, amount: '10000' },
        { userId: foil, outcome: 1, amount: '10000' },
      ],
      winner: 0,
    });

    await leaderboards.snapshotAll();
    const week = isoWeekOf(new Date());
    const board = await leaderboards.board({ period: week, board: 'profit' });
    expect(board.length).toBeGreaterThan(0);
    expect(await leaderboards.periods()).toContain(week);
  });

  // ------------------------------------------------------------------ prizes

  it('refuses to draw a run against a board nobody published', async () => {
    const growth = await staff('growth@example.com', 'finance');
    await expect(
      prizes.draft({ period: ALL_TIME, board: 'profit', staffId: growth.userId }),
    ).rejects.toThrow(/not been published/);
  });

  it('draws up a run that sums to the pot exactly', async () => {
    const growth = await staff('growth2@example.com', 'finance');
    const a = await person('a@example.com');
    const b = await person('b@example.com');
    await settledMarket({
      label: 'a prize thing',
      stakes: [
        { userId: a, outcome: 0, amount: '20000' },
        { userId: b, outcome: 1, amount: '10000' },
      ],
      winner: 0,
    });
    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });

    const run = await prizes.draft({
      period: ALL_TIME,
      board: 'profit',
      staffId: growth.userId,
      poolSpc: '100000',
    });

    const awards = await prisma.prizeAward.findMany({ where: { runId: run.runId } });
    const total = awards.reduce(
      (acc, award) => acc.plus(new Decimal(award.amount.toString())),
      new Decimal(0),
    );
    // The last place carries the division's remainder, so the awards sum to the
    // pot to the digit rather than to within a rounding error.
    expect(total.toString()).toBe('100000');
    // And first place beats last: a competition that pays everyone the same is
    // not a competition.
    const sorted = [...awards].sort((left, right) => left.rank - right.rank);
    expect(
      new Decimal(sorted[0]!.amount.toString()).gt(
        new Decimal(sorted[sorted.length - 1]!.amount.toString()),
      ),
    ).toBe(true);
  });

  it('moves no money until two people have signed', async () => {
    const growth = await staff('growth3@example.com', 'finance');
    const approver = await staff('approver@example.com', 'admin');
    const a = await person('c@example.com');
    const b = await person('d@example.com');

    await settledMarket({
      label: 'a signed thing',
      stakes: [
        { userId: a, outcome: 0, amount: '20000' },
        { userId: b, outcome: 1, amount: '10000' },
      ],
      winner: 0,
    });
    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });

    const run = await prizes.draft({
      period: ALL_TIME,
      board: 'profit',
      staffId: growth.userId,
      poolSpc: '50000',
    });

    const before = await wallet.balanceOf(a);

    const approval = await approvals.propose({
      actionType: 'prize.run',
      payload: { runId: run.runId },
      reason: 'Weekly prize run for the all-time board.',
      actor: growth,
    });
    await prizes.submit(run.runId, approval.id);

    // Proposed but unsigned: nothing has moved.
    const midway = await wallet.balanceOf(a);
    expect(midway.available.toString()).toBe(before.available.toString());

    await approvals.approve({
      approvalId: approval.id,
      actor: approver,
      totpCode: approver.code(),
    });

    const after = await wallet.balanceOf(a);
    expect(after.available.gt(before.available)).toBe(true);

    const paid = await prisma.prizeRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(paid.state).toBe('paid');
    expect(paid.paidAt).not.toBeNull();
  });

  it('cannot be paid twice', async () => {
    const growth = await staff('growth4@example.com', 'finance');
    const a = await person('e@example.com');
    const b = await person('f@example.com');
    await settledMarket({
      label: 'a double thing',
      stakes: [
        { userId: a, outcome: 0, amount: '20000' },
        { userId: b, outcome: 1, amount: '10000' },
      ],
      winner: 0,
    });
    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });

    const run = await prizes.draft({
      period: ALL_TIME,
      board: 'profit',
      staffId: growth.userId,
      poolSpc: '50000',
    });

    await prisma.$transaction(async (tx) => {
      await prizes.pay(tx, run.runId);
    });

    // At-least-once delivery is the norm; on a promotional payout, paying twice
    // is the difference between a competition and a leak.
    await expect(
      prisma.$transaction(async (tx) => prizes.pay(tx, run.runId)),
    ).rejects.toBeInstanceOf(PrizeError);
  });

  it('will not pay somebody who dropped to Tier 0 after the draw', async () => {
    const growth = await staff('growth5@example.com', 'finance');
    const a = await person('g@example.com');
    const b = await person('h@example.com');
    await settledMarket({
      label: 'a demoted thing',
      stakes: [
        { userId: a, outcome: 0, amount: '20000' },
        { userId: b, outcome: 1, amount: '10000' },
      ],
      winner: 0,
    });
    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });

    const run = await prizes.draft({
      period: ALL_TIME,
      board: 'profit',
      staffId: growth.userId,
      poolSpc: '50000',
    });

    // §2.1's gate is about who may *receive* money, so it is re-checked at
    // payment rather than trusted from draw time.
    await prisma.user.update({ where: { id: a }, data: { tier: 0 } });
    const before = await wallet.balanceOf(a);

    await prisma.$transaction(async (tx) => {
      await prizes.pay(tx, run.runId);
    });

    const after = await wallet.balanceOf(a);
    expect(after.available.toString()).toBe(before.available.toString());
  });

  it('tells the winners only after the money has moved', async () => {
    const growth = await staff('growth6@example.com', 'finance');
    const a = await person('i@example.com');
    const b = await person('j@example.com');
    await settledMarket({
      label: 'an announced thing',
      stakes: [
        { userId: a, outcome: 0, amount: '20000' },
        { userId: b, outcome: 1, amount: '10000' },
      ],
      winner: 0,
    });
    await leaderboards.snapshot({ period: ALL_TIME, board: 'profit' });

    const run = await prizes.draft({
      period: ALL_TIME,
      board: 'profit',
      staffId: growth.userId,
      poolSpc: '50000',
    });

    // Unpaid: nothing is announced.
    expect(await prizes.announce(run.runId)).toBe(0);

    await prisma.$transaction(async (tx) => {
      await prizes.pay(tx, run.runId);
    });
    expect(await prizes.announce(run.runId)).toBeGreaterThan(0);

    const told = await prisma.notification.count({ where: { userId: a, type: 'prize' } });
    expect(told).toBeGreaterThan(0);
  });
});

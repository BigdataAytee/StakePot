import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { testOrderBook } from '../testing/order-book';
import { resetDatabase } from '../testing/reset';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { ChallengeService } from './challenge.service';
import { ThreadError, ThreadService } from './thread.service';

/**
 * §2.15's community layer against a real database.
 *
 * The rules are tested next door. What needs a database is everything that
 * makes an argument accountable: that a badge is fixed at the moment somebody
 * spoke and survives them closing out, that the gate actually keeps a Tier 0
 * account out, that a held comment never appears in the thread, that reports
 * count people rather than clicks, and that one challenge cannot be answered
 * twice.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('community layer (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let wallet: WalletService;
  let trades: TradeService;
  let threads: ThreadService;
  let challenges: ChallengeService;

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
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      { publish: async () => undefined } as unknown as PriceCacheService,
      new RgService(prisma, config),
      testOrderBook(prisma, ledger, wallet),
    );
    threads = new ThreadService(prisma, config);
    challenges = new ChallengeService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    // The gap between comments would otherwise make every test sleep.
    await prisma.platformConfig.updateMany({
      where: { key: 'comment_min_seconds_between' },
      data: { valueJson: 0 },
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

  async function market() {
    const created = await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will the Super Eagles beat Ghana?',
        sourceName: 'CAF',
        sourceUrl: 'https://www.cafonline.com/',
        criteriaJson: {},
        edgeCasesJson: {},
        eventDate: new Date(Date.now() + 20 * 86_400_000),
        voidDate: new Date(Date.now() + 27 * 86_400_000),
        liquidityParam: new Decimal('50000').toString(),
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
    return created;
  }

  // ------------------------------------------------------------------ badges

  it('badges a comment with the position held at the time', async () => {
    const userId = await person('holder@example.com');
    const m = await market();

    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId: `buy-${userId}`,
    });

    const posted = await threads.post({ marketId: m.id, userId, text: 'Eagles all day' });
    expect(posted.badge).toMatch(/^YES@\d+$/);
  });

  it('keeps the badge after the commenter closes out', async () => {
    const userId = await person('flipflop@example.com');
    const m = await market();

    const bought = await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId: `buy-${userId}`,
    });
    const posted = await threads.post({ marketId: m.id, userId, text: 'Locked in on Yes' });

    await trades.sell({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      shares: bought.trade!.shares.toString(),
      requestId: `sell-${userId}`,
    });

    // The whole mechanism: arguing a side then closing out must not turn the
    // comment into disinterested commentary.
    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: posted.id } });
    expect(stored.positionSnapshot).toBe(posted.badge);
    expect(stored.positionSnapshot).toMatch(/^YES@/);
  });

  it('says "none" for somebody with no position', async () => {
    const userId = await person('spectator@example.com');
    const m = await market();
    const posted = await threads.post({ marketId: m.id, userId, text: 'Watching this one' });
    expect(posted.badge).toBe('none');
  });

  // -------------------------------------------------------------- the gate

  it('keeps an unverified account out of the thread', async () => {
    const userId = await person('tier0@example.com', 0, '0');
    const m = await market();
    await expect(threads.post({ marketId: m.id, userId, text: 'let me in' })).rejects.toThrow(
      /verify/,
    );
  });

  it('keeps a self-excluded account out of the argument as well as the market', async () => {
    const userId = await person('excluded@example.com');
    const m = await market();
    await prisma.rgSettings.create({
      data: { userId, selfExcluded: true, selfExcludedAt: new Date() },
    });
    await expect(threads.post({ marketId: m.id, userId, text: 'still here' })).rejects.toThrow(
      /self-excluded/,
    );
  });

  it('enforces the hourly cap', async () => {
    const userId = await person('flooder@example.com');
    const m = await market();
    await prisma.platformConfig.updateMany({
      where: { key: 'comment_rate_per_hour' },
      data: { valueJson: 3 },
    });
    await config.refresh();

    for (let index = 0; index < 3; index += 1) {
      await threads.post({ marketId: m.id, userId, text: `take number ${index}` });
    }
    await expect(threads.post({ marketId: m.id, userId, text: 'one more' })).rejects.toThrow(
      /take a break/,
    );
  });

  it('enforces the gap between comments', async () => {
    const userId = await person('rapid@example.com');
    const m = await market();
    await prisma.platformConfig.updateMany({
      where: { key: 'comment_min_seconds_between' },
      data: { valueJson: 60 },
    });
    await config.refresh();

    await threads.post({ marketId: m.id, userId, text: 'first' });
    await expect(threads.post({ marketId: m.id, userId, text: 'second' })).rejects.toThrow(
      /wait 60 seconds/,
    );
  });

  // ---------------------------------------------------------- moderation

  it('holds a tipster pitch out of the thread entirely', async () => {
    const tipster = await person('tipster@example.com');
    const reader = await person('reader@example.com');
    const m = await market();

    const posted = await threads.post({
      marketId: m.id,
      userId: tipster,
      text: 'DM me for sure odds, booking code 5XY2A',
    });
    expect(posted.state).toBe('held');
    expect(posted.notice).not.toBeNull();

    // A reader never sees it...
    const asReader = await threads.thread({ marketId: m.id, viewerId: reader });
    expect(asReader).toHaveLength(0);

    // ...but its author does, so they are not left wondering where it went.
    const asAuthor = await threads.thread({ marketId: m.id, viewerId: tipster });
    expect(asAuthor).toHaveLength(1);
    expect(asAuthor[0]?.state).toBe('held');
  });

  it('publishes ordinary argument untouched', async () => {
    const userId = await person('normal@example.com');
    const m = await market();
    const posted = await threads.post({
      marketId: m.id,
      userId,
      text: 'Ghana away form is terrible, this is free money',
    });
    expect(posted.state).toBe('live');
    expect(posted.notice).toBeNull();
  });

  it('counts reporters, not clicks, and flags at the threshold', async () => {
    const author = await person('loud@example.com');
    const m = await market();
    const posted = await threads.post({ marketId: m.id, userId: author, text: 'a hot take' });

    const reporters = [];
    for (let index = 0; index < 3; index += 1) {
      reporters.push(await person(`reporter${index}@example.com`));
    }

    // The same person reporting twice is one report.
    await threads.report({ commentId: posted.id, reporterId: reporters[0]!, reason: 'spam' });
    const repeat = await threads.report({
      commentId: posted.id,
      reporterId: reporters[0]!,
      reason: 'spam again',
    });
    expect(repeat.reports).toBe(1);
    expect(repeat.flagged).toBe(false);

    await threads.report({ commentId: posted.id, reporterId: reporters[1]!, reason: 'spam' });
    const third = await threads.report({
      commentId: posted.id,
      reporterId: reporters[2]!,
      reason: 'spam',
    });
    expect(third.reports).toBe(3);
    expect(third.flagged).toBe(true);
  });

  it('will not let somebody report their own comment', async () => {
    const userId = await person('selfreport@example.com');
    const m = await market();
    const posted = await threads.post({ marketId: m.id, userId, text: 'my own words' });
    await expect(
      threads.report({ commentId: posted.id, reporterId: userId, reason: 'I regret this' }),
    ).rejects.toBeInstanceOf(ThreadError);
  });

  it('only a moderator can remove or restore words', async () => {
    const author = await person('held@example.com');
    const staff = await person('staff@example.com');
    const m = await market();

    const posted = await threads.post({
      marketId: m.id,
      userId: author,
      text: 'guaranteed win, 100% sure',
    });
    expect(posted.state).toBe('held');

    const queue = await threads.queue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.flags.length).toBeGreaterThan(0);

    const decided = await threads.moderate({
      commentId: posted.id,
      staffId: staff,
      decision: 'publish',
    });
    expect(decided.state).toBe('live');

    const visible = await threads.thread({ marketId: m.id });
    expect(visible).toHaveLength(1);
  });

  it('leaves the shape of a removed comment in the thread', async () => {
    const author = await person('removed@example.com');
    const staff = await person('mod@example.com');
    const m = await market();

    const posted = await threads.post({ marketId: m.id, userId: author, text: 'something rude' });
    await threads.moderate({ commentId: posted.id, staffId: staff, decision: 'remove' });

    const visible = await threads.thread({ marketId: m.id });
    // A thread with holes cut out of it reads as tampered with.
    expect(visible).toHaveLength(1);
    expect(visible[0]?.removed).toBe(true);
    expect(visible[0]?.text).toBeNull();
  });

  // ----------------------------------------------------------- receipts

  it('stamps who called it when the market settles', async () => {
    const right = await person('right@example.com');
    const wrong = await person('wrong@example.com');
    const quiet = await person('quiet@example.com');
    const m = await market();

    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId: right,
      amount: '10000',
      requestId: `buy-${right}`,
    });
    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[1]!.id,
      userId: wrong,
      amount: '10000',
      requestId: `buy-${wrong}`,
    });

    const rightComment = await threads.post({ marketId: m.id, userId: right, text: 'Yes wins' });
    const wrongComment = await threads.post({ marketId: m.id, userId: wrong, text: 'No wins' });
    const quietComment = await threads.post({ marketId: m.id, userId: quiet, text: 'no idea' });

    await prisma.market.update({
      where: { id: m.id },
      data: { state: 'resolved', resolvedOutcomeId: m.outcomes[0]!.id },
    });

    const stamped = await threads.stampReceipts(m.id);
    expect(stamped.stamped).toBe(2);

    const rows = await prisma.comment.findMany({ where: { marketId: m.id } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(rightComment.id)?.calledIt).toBe(true);
    expect(byId.get(wrongComment.id)?.calledIt).toBe(false);
    // No position is not a wrong call — it is not a call.
    expect(byId.get(quietComment.id)?.calledIt).toBeNull();

    // Running twice must not double-count anything.
    expect((await threads.stampReceipts(m.id)).stamped).toBe(0);
  });

  // ---------------------------------------------------------- challenges

  it('refuses a challenge from somebody holding nothing', async () => {
    const userId = await person('mouth@example.com');
    const m = await market();
    await expect(challenges.create({ marketId: m.id, userId })).rejects.toThrow(
      /take a position first/,
    );
  });

  it('carries the challenger’s position to a signed-out recipient', async () => {
    const challenger = await person('challenger@example.com');
    const m = await market();
    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId: challenger,
      amount: '20000',
      requestId: `buy-${challenger}`,
    });

    const { token } = await challenges.create({ marketId: m.id, userId: challenger });
    const opened = await challenges.open(token);

    expect(opened?.outcomeLabel).toBe('YES');
    expect(opened?.pricePct).toBeGreaterThan(0);
    expect(opened?.accepted).toBe(false);

    // §2.15d claims challenge links are the strongest signup motivator, so the
    // opens are counted rather than assumed.
    const row = await prisma.challenge.findUniqueOrThrow({ where: { linkToken: token } });
    expect(row.opens).toBe(1);
  });

  it('lets exactly one person answer a challenge, and only from the other side', async () => {
    const challenger = await person('a@example.com');
    const agreeing = await person('b@example.com');
    const disagreeing = await person('c@example.com');
    const alsoDisagreeing = await person('d@example.com');
    const m = await market();

    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId: challenger,
      amount: '20000',
      requestId: `buy-${challenger}`,
    });
    const { token } = await challenges.create({ marketId: m.id, userId: challenger });

    // Same side is agreement, not a challenge.
    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId: agreeing,
      amount: '5000',
      requestId: `buy-${agreeing}`,
    });
    await expect(challenges.accept({ token, userId: agreeing })).rejects.toThrow(/same side/);

    // Nobody can answer their own.
    await expect(challenges.accept({ token, userId: challenger })).rejects.toThrow(/your own/);

    for (const userId of [disagreeing, alsoDisagreeing]) {
      await trades.buy({
        marketId: m.id,
        outcomeId: m.outcomes[1]!.id,
        userId,
        amount: '5000',
        requestId: `buy-${userId}`,
      });
    }

    expect(await challenges.accept({ token, userId: disagreeing })).toEqual({ accepted: true });
    await expect(challenges.accept({ token, userId: alsoDisagreeing })).rejects.toThrow(
      /already answered/,
    );
  });

  it('records a reason from the trade ticket as a badged comment', async () => {
    const userId = await person('reasoner@example.com');
    const m = await market();

    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId: `buy-${userId}`,
    });

    const posted = await threads.post({
      marketId: m.id,
      userId,
      text: 'Ghana have three players out',
      fromTrade: true,
    });

    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: posted.id } });
    expect(stored.fromTrade).toBe(true);
    expect(stored.positionSnapshot).toMatch(/^YES@/);
  });
});
import { AnalyticsService } from '../analytics/analytics.service';

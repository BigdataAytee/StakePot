import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { CommunityService } from '../community/community.service';
import { SeedService } from '../community/seed.service';
import { MarketVoidService } from '../community/void.service';
import type { MarketTemplate } from '../community/market-template';
import { approvalAnswers, compliantTemplate } from '../testing/templates';
import { LedgerService } from '../ledger/ledger.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { WalletService } from '../wallet/wallet.service';
import { CreatorAnalyticsService } from './analytics.service';
import { AutopsyService } from './autopsy.service';
import { CreatorError, CreatorService } from './creator.service';
import { NudgeService } from './nudge.service';
import { OpportunityError, OpportunityService } from './opportunity.service';
import { AnalyticsService } from '../analytics/analytics.service';

/**
 * §2.14's creator platform against a real database.
 *
 * The pure rules are tested next door. What needs a database is everything the
 * rules cannot see: that a level actually stops somebody opening a third
 * market, that a follower count and its rows never disagree, that two creators
 * cannot both claim one opportunity, and that a market closing moves the
 * creator's record exactly once however many times the job fires.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('creator platform (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let wallet: WalletService;
  let creators: CreatorService;
  let analytics: CreatorAnalyticsService;
  let autopsies: AutopsyService;
  let nudges: NudgeService;
  let opportunities: OpportunityService;
  let community: CommunityService;

  const template: MarketTemplate = compliantTemplate({
    question: 'Will the Super Eagles beat Ghana in the next qualifier?',
    outcomes: [
      {
        label: 'Yes',
        criteria: 'The CAF match report records a Nigeria win at full time, read at 23:59 WAT.',
      },
      {
        label: 'No',
        criteria:
          'The CAF match report records a draw or a Ghana win at full time, read at 23:59 WAT.',
      },
    ],
    sourceName: 'CAF',
    sourceUrl: 'https://www.cafonline.com/africa-cup-of-nations/matches/',
    eventDate: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    voidDate: new Date(Date.now() + 27 * 86_400_000).toISOString(),
    edgeCases: {
      abandoned: 'Void if the match is abandoned.',
      'no publication': 'If CAF publishes no match report by the void date, the market voids.',
    },
  });

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();

    const ledger = new LedgerService(prisma);
    const voids = new MarketVoidService(ledger);
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );
    creators = new CreatorService(prisma, config, notifications);
    analytics = new CreatorAnalyticsService(prisma);
    autopsies = new AutopsyService(prisma, analytics, creators, notifications);
    nudges = new NudgeService(prisma, config, notifications, analytics);
    opportunities = new OpportunityService(prisma, config, analytics);
    const seeds = new SeedService(prisma, config, wallet, voids, creators);
    const events = new AnalyticsService(prisma);
    community = new CommunityService(
      prisma,
      config,
      wallet,
      voids,
      notifications,
      creators,
      autopsies,
      events,
    );
    void seeds;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await config.refresh();
  });

  async function person(email: string, topUp = '1000000') {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
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

  // -------------------------------------------------------------- the ladder

  it('starts a creator at level 1 with two live markets', async () => {
    const creatorId = await person('level1@example.com');
    const standing = await creators.standing(creatorId);

    expect(standing.level).toBe(1);
    expect(standing.privileges.maxLiveMarkets).toBe(2);
    expect(standing.privileges.badge).toBeNull();
    expect(standing.progress?.target).toBe(2);
  });

  it('refuses a third market at level 1 — the cap is enforced, not described', async () => {
    const creatorId = await person('capped@example.com');

    await community.create({ creatorId, template, liquidityParam: '50000', ...approvalAnswers() });
    await community.create({ creatorId, template, liquidityParam: '50000', ...approvalAnswers() });

    await expect(
      community.create({ creatorId, template, liquidityParam: '50000', ...approvalAnswers() }),
    ).rejects.toThrow(/2 markets at a time/);
  });

  it('charges a level 2 creator half the bond', async () => {
    const standard = await person('standard@example.com');
    const promoted = await person('promoted@example.com');

    await creators.ensureProfile(promoted);
    await prisma.creatorProfile.update({
      where: { userId: promoted },
      data: { level: 2, cleanResolutions: 5 },
    });

    const first = await community.create({
      creatorId: standard,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    const second = await community.create({
      creatorId: promoted,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    const standardBond = await prisma.bond.findUniqueOrThrow({
      where: { marketId: first.marketId },
    });
    const reducedBond = await prisma.bond.findUniqueOrThrow({
      where: { marketId: second.marketId },
    });

    expect(new Decimal(reducedBond.amount.toString()).toString()).toBe(
      new Decimal(standardBond.amount.toString()).div(2).toString(),
    );
  });

  it('stamps the creator fee on the market so a later promotion cannot rewrite it', async () => {
    const creatorId = await person('stamped@example.com');
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    const atCreation = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(atCreation.creatorBps).toBe(400);

    // Promote them afterwards. The market they already opened keeps its terms.
    await prisma.creatorProfile.update({
      where: { userId: creatorId },
      data: {
        level: 3,
        cleanResolutions: 20,
        totalVolumeHosted: new Decimal('9000000').toString(),
      },
    });

    const unchanged = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(unchanged.creatorBps).toBe(400);
    expect((await creators.privilegesOf(creatorId)).creatorBps).toBe(450);
  });

  it('promotes on the fifth clean resolution and says what it unlocked', async () => {
    const creatorId = await person('climbing@example.com');
    await creators.ensureProfile(creatorId);

    for (let index = 0; index < 4; index += 1) {
      await creators.recordSettlement({ creatorId, kind: 'clean', volume: '10000' });
    }
    expect((await creators.standing(creatorId)).level).toBe(1);

    const moved = await creators.recordSettlement({ creatorId, kind: 'clean', volume: '10000' });
    expect(moved).toEqual({ from: 1, to: 2 });

    const told = await prisma.notification.findFirst({
      where: { userId: creatorId, type: 'creator_level' },
    });
    expect(told?.payloadJson).toBeDefined();
    expect(JSON.stringify(told?.payloadJson)).toContain('Level 2');
  });

  it('does not count a void before activation against the record', async () => {
    const creatorId = await person('unlucky@example.com');
    await creators.ensureProfile(creatorId);

    await creators.recordSettlement({
      creatorId,
      kind: 'voided_before_activation',
      volume: '0',
    });

    const record = await creators.recordOf(creatorId);
    expect(record.voidedAfterActivation).toBe(0);
    expect(record.disputedResolutions).toBe(0);
  });

  // -------------------------------------------------------------- the follows

  it('keeps the follower count and the follower rows in step', async () => {
    const creatorId = await person('followed@example.com');
    const fan = await person('fan@example.com');

    await creators.follow({ followerId: fan, creatorId });
    // Following twice is not an error, and must not double the count.
    await creators.follow({ followerId: fan, creatorId });

    const after = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creatorId } });
    const rows = await prisma.follower.count({ where: { creatorId } });
    expect(after.followerCount).toBe(1);
    expect(rows).toBe(1);

    await creators.unfollow({ followerId: fan, creatorId });
    // Unfollowing twice must not take the count negative.
    await creators.unfollow({ followerId: fan, creatorId });

    const cleared = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creatorId } });
    expect(cleared.followerCount).toBe(0);
    expect(await prisma.follower.count({ where: { creatorId } })).toBe(0);
  });

  it('refuses to let somebody follow themselves', async () => {
    const creatorId = await person('narcissus@example.com');
    await expect(creators.follow({ followerId: creatorId, creatorId })).rejects.toBeInstanceOf(
      CreatorError,
    );
  });

  it('tells followers when a market opens, and only those who asked', async () => {
    const creatorId = await person('broadcaster@example.com');
    const keen = await person('keen@example.com');
    const quiet = await person('quiet@example.com');

    await creators.claimHandle({ userId: creatorId, handle: 'broadcaster' });
    await creators.follow({ followerId: keen, creatorId });
    await creators.follow({ followerId: quiet, creatorId, notify: false });

    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    const told = await creators.announceMarket(marketId);
    expect(told).toBe(1);

    const keenHeard = await prisma.notification.count({
      where: { userId: keen, type: 'creator_new_market' },
    });
    const quietHeard = await prisma.notification.count({
      where: { userId: quiet, type: 'creator_new_market' },
    });
    expect(keenHeard).toBeGreaterThan(0);
    expect(quietHeard).toBe(0);
  });

  // --------------------------------------------------------------- the handle

  it('enforces handle shape, reserved words and uniqueness', async () => {
    const first = await person('handle1@example.com');
    const second = await person('handle2@example.com');

    await expect(creators.claimHandle({ userId: first, handle: 'no' })).rejects.toThrow(/3–20/);
    await expect(creators.claimHandle({ userId: first, handle: 'admin' })).rejects.toThrow(
      /reserved/,
    );

    await creators.claimHandle({ userId: first, handle: 'Tunde_01', displayName: 'Tunde' });
    const profile = await creators.profileByHandle('tunde_01');
    expect(profile?.displayName).toBe('Tunde');

    await expect(creators.claimHandle({ userId: second, handle: 'tunde_01' })).rejects.toThrow(
      /taken/,
    );
  });

  // ------------------------------------------------------------- the autopsy

  it('writes one autopsy per market however many times the job fires', async () => {
    const creatorId = await person('settled@example.com');
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    await creators.ensureProfile(creatorId);

    const first = await autopsies.record({ marketId, kind: 'voided', voidReason: 'nobody came' });
    const second = await autopsies.record({ marketId, kind: 'voided', voidReason: 'nobody came' });

    expect(first.written).toBe(true);
    // At-least-once delivery is the norm; counting one resolution twice would
    // hand out a level nobody earned.
    expect(second.written).toBe(false);
    expect(await prisma.marketAutopsy.count({ where: { marketId } })).toBe(1);

    const record = await creators.recordOf(creatorId);
    expect(record.cleanResolutions).toBe(0);
    expect(record.voidedAfterActivation).toBe(0);
  });

  it('reads its numbers off the market, and tells the creator', async () => {
    const creatorId = await person('reviewed@example.com');
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    await analytics.recordView({ marketId, source: 'share' });
    await analytics.recordView({ marketId, source: 'share' });
    await analytics.recordView({ marketId });

    await autopsies.record({ marketId, kind: 'voided', voidReason: 'the window closed empty' });

    const written = await autopsies.forMarket(marketId);
    expect(written?.views).toBe(3);
    expect(written?.kind).toBe('voided');
    expect(written?.summary).toContain('every naira went back');
    expect(written?.tip).not.toBeNull();

    const told = await prisma.notification.findFirst({
      where: { userId: creatorId, type: 'market_autopsy' },
    });
    expect(told).not.toBeNull();
  });

  // ------------------------------------------------------------- analytics

  it('counts views by source and refuses to invent a conversion rate', async () => {
    const creatorId = await person('measured@example.com');
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    const cold = await analytics.forMarket(marketId);
    // Nobody has looked. That is not a zero percent conversion rate.
    expect(cold?.conversion).toBeNull();

    await analytics.recordView({ marketId, source: 'whatsapp' });
    await analytics.recordView({ marketId, source: 'whatsapp' });
    await analytics.recordView({ marketId, source: 'nonsense' });

    const warm = await analytics.forMarket(marketId);
    expect(warm?.views).toBe(3);
    expect(warm?.sources[0]).toEqual({ source: 'whatsapp', views: 2 });
    // An unknown source is recorded as direct rather than trusted into the data.
    expect(warm?.sources.map((entry) => entry.source)).toContain('direct');
    expect(warm?.conversion).toBe(0);
  });

  // ---------------------------------------------------------------- nudges

  it('nudges a lopsided funding window once, then holds its tongue', async () => {
    const creatorId = await person('nudged@example.com');
    const backer = await person('backer@example.com');
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    // Put money on one side only, so the market reads as lopsided.
    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    await prisma.outcome.update({
      where: { id: outcomes[0]!.id },
      data: { stakedTotal: new Decimal('100000').toString() },
    });
    void backer;

    const first = await nudges.nudge(marketId);
    expect(first?.kind).toBe('funding_lopsided');

    // The throttle is the point: a creator who gets the same message hourly
    // stops reading any of them.
    const second = await nudges.nudge(marketId);
    expect(second).toBeNull();

    // One row per channel is by design, so the in-app row is the message count.
    const sent = await prisma.notification.count({
      where: { userId: creatorId, type: 'creator_nudge', channel: 'in_app' },
    });
    expect(sent).toBe(1);
  });

  // --------------------------------------------------------- opportunities

  it('surfaces a search nobody could answer, and suppresses one already live', async () => {
    const asker = await person('asker@example.com');
    const creatorId = await person('server@example.com');

    // Six distinct people ask about something with no market.
    for (let index = 0; index < 6; index += 1) {
      const person_ = index === 0 ? asker : await person(`asker${index}@example.com`, '0');
      await analytics.recordSearch({
        query: 'BBNaija eviction this week',
        userId: person_,
        resultCount: 0,
      });
    }

    // And six ask about something that is already trading.
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    await prisma.market.update({ where: { id: marketId }, data: { state: 'active' } });
    for (let index = 0; index < 6; index += 1) {
      await analytics.recordSearch({
        query: 'Super Eagles beat Ghana qualifier',
        userId: await person(`fan${index}@example.com`, '0'),
        resultCount: 0,
      });
    }

    const result = await opportunities.detectSearchGaps({
      since: new Date(Date.now() - 86_400_000),
    });

    expect(result.surfaced).toBe(1);
    // §2.14e: pointing a creator at a market that already exists splits its
    // liquidity, which is worse than saying nothing.
    expect(result.suppressed).toBe(1);

    const feed = await opportunities.feed();
    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toContain('BBNaija');
    expect(feed[0]?.evidence).toMatchObject({ searchers: 6 });
  });

  it('ignores a question only one person asked', async () => {
    const asker = await person('lonely@example.com');
    for (let index = 0; index < 4; index += 1) {
      // The same person asking four times is one person, not four.
      await analytics.recordSearch({ query: 'naira to dollar', userId: asker, resultCount: 0 });
    }

    const result = await opportunities.detectSearchGaps({
      since: new Date(Date.now() - 86_400_000),
    });
    expect(result.surfaced).toBe(0);
  });

  it('lets exactly one creator claim an opportunity', async () => {
    const first = await person('first@example.com');
    const second = await person('second@example.com');

    const { id } = await opportunities.upsert({
      dedupeKey: 'calendar:eagles-ghana',
      source: 'calendar',
      title: 'Super Eagles v Ghana',
      daysToEvent: 5,
      expiresAt: new Date(Date.now() + 5 * 86_400_000),
    });

    const firstMarket = await community.create({
      creatorId: first,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });
    const secondMarket = await community.create({
      creatorId: second,
      template,
      ...approvalAnswers(),
      liquidityParam: '50000',
    });

    await opportunities.claim({
      opportunityId: id,
      userId: first,
      marketId: firstMarket.marketId,
    });

    await expect(
      opportunities.claim({
        opportunityId: id,
        userId: second,
        marketId: secondMarket.marketId,
      }),
    ).rejects.toBeInstanceOf(OpportunityError);

    // A claimed opportunity leaves the feed — the volume is gone.
    expect(await opportunities.feed()).toHaveLength(0);
  });

  it('refreshes an opportunity rather than posting it twice', async () => {
    const key = 'calendar:afcon-final';
    await opportunities.upsert({
      dedupeKey: key,
      source: 'calendar',
      title: 'AFCON final',
      daysToEvent: 30,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const refreshed = await opportunities.upsert({
      dedupeKey: key,
      source: 'calendar',
      title: 'AFCON final',
      daysToEvent: 2,
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
    });

    const feed = await opportunities.feed();
    expect(feed).toHaveLength(1);
    // Closer to the event means a higher score, on the same row.
    expect(refreshed.score).toBeGreaterThan(0.5);
  });
});

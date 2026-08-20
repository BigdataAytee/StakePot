import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AnalyticsService } from '../analytics/analytics.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { ThreadService } from '../community-layer/thread.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { EmailSender } from '../notifications/email.sender';
import { SmsSender } from '../notifications/sms.sender';
import { TokenRevocationService } from '../auth/token-revocation.service';
import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { StatusService } from '../status/status.service';
import { resetDatabase } from '../testing/reset';
import { TradeQueueService } from '../trade/trade-queue.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { AbuseService } from './abuse.service';
import { LedgerAuditService } from './ledger-audit.service';

/**
 * Step 14's hardening against real Postgres and real Redis.
 *
 * The rules are tested next door. What needs infrastructure is everything the
 * rules cannot see: that a staff account is actually refused at the trade path,
 * that a frozen account keeps its money and loses the ability to add to a
 * position, that the queue executes trades in order and survives Redis being
 * away, that the sweep files evidence a reviewer can read, and that the audit
 * passes on a database every prior test has churned through — which is the
 * strongest clean-bill the platform can give itself.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('hardening (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let wallet: WalletService;
  let trades: TradeService;
  let queue: TradeQueueService;
  let abuse: AbuseService;
  let audit: LedgerAuditService;

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
    );
    queue = new TradeQueueService(
      trades,
      prisma,
      new ThreadService(prisma, config),
      new NotificationsService(prisma, new PushSender(prisma), new EmailSender(), new SmsSender()),
    );
    await queue.onModuleInit();
    abuse = new AbuseService(
      prisma,
      config,
      new AdminAuditService(prisma),
      new TokenRevocationService(),
    );
    audit = new LedgerAuditService(prisma, new StatusService(prisma));
  });

  afterAll(async () => {
    await queue.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await config.refresh();
  });

  async function person(email: string, topUp = '500000') {
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

  async function market(question = 'Will this harden?') {
    return prisma.market.create({
      data: {
        shelf: 'official',
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

  // ------------------------------------------------------------ §2.7's blocks

  it('refuses a staff account at the trade path', async () => {
    const staffId = await person('resolver@example.com');
    await prisma.user.update({ where: { id: staffId }, data: { role: 'resolver' } });
    const m = await market();

    await expect(
      trades.buy({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: staffId,
        amount: '10000',
        requestId: `staff-${staffId}`,
      }),
    ).rejects.toThrow(/staff accounts cannot trade/);
  });

  it('freezes an account out of new positions but not out of its money', async () => {
    const userId = await person('frozen@example.com');
    const m = await market();

    // What they held going in: top-up plus starter balance plus signup bonus.
    const before = await wallet.balanceOf(userId);
    await prisma.user.update({ where: { id: userId }, data: { status: 'frozen' } });

    await expect(
      trades.buy({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId,
        amount: '10000',
        requestId: `frozen-${userId}`,
      }),
    ).rejects.toThrow(/frozen/);

    // The balance is untouched: a freeze is a stop, not a seizure. Money only
    // ever moves through §2.10's approvals workflow.
    const balance = await wallet.balanceOf(userId);
    expect(balance.available.toString()).toBe(before.available.toString());
  });

  // --------------------------------------------------------------- the queue

  it('fills a queued trade and returns it to the caller', async () => {
    const userId = await person('queued@example.com');
    const m = await market();

    const outcome = await queue.submit({
      kind: 'buy',
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId: `q-${userId}`,
    });

    expect(outcome.status).toBe('filled');
    expect(outcome.trade?.cost.toString()).toBe('10000');
  });

  it('executes one market’s trades strictly in submission order', async () => {
    const m = await market();
    const people = await Promise.all(
      Array.from({ length: 6 }, (_, index) => person(`order${index}@example.com`)),
    );

    // Submitted concurrently; §11 says they must execute in stream order, which
    // means each later trade prices off the pot state the earlier ones left.
    const outcomes = await Promise.all(
      people.map((userId, index) =>
        queue.submit({
          kind: 'buy',
          marketId: m.id,
          outcomeId: m.outcomes[0]!.id,
          userId,
          amount: String(5_000 + index * 1_000),
          requestId: `race-${userId}`,
        }),
      ),
    );

    expect(outcomes.every((entry) => entry.status === 'filled')).toBe(true);

    // The proof of ordering is conservation: six trades priced off consistent
    // states leave Σstaked === pot to the digit. Two trades that priced off the
    // same state would break it.
    const after = await prisma.market.findUniqueOrThrow({
      where: { id: m.id },
      include: { outcomes: true },
    });
    const staked = after.outcomes.reduce(
      (total, row) => total.plus(new Decimal(row.stakedTotal.toString())),
      new Decimal(0),
    );
    expect(staked.toString()).toBe(new Decimal(after.potTotal.toString()).toString());
  });

  it('returns a refusal to the caller instead of retrying it for ever', async () => {
    // The starter balance and signup bonus arrive regardless, so the ask has to
    // clear what the account holds — but stay under the RG platform cap, which
    // fires first and is its own (correct) refusal.
    const userId = await person('poor@example.com', '100');
    const m = await market();

    const outcome = await queue.submit({
      kind: 'buy',
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '900000',
      requestId: `broke-${userId}`,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toMatch(/insufficient/i);
  });

  it('is idempotent through the queue: one request id, one trade', async () => {
    const userId = await person('retry@example.com');
    const m = await market();
    const requestId = `retry-${userId}`;

    const first = await queue.submit({
      kind: 'buy',
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId,
    });
    const second = await queue.submit({
      kind: 'buy',
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId,
    });

    expect(first.status).toBe('filled');
    expect(second.status).toBe('filled');
    expect(second.trade?.id).toBe(first.trade?.id);
    expect(await prisma.trade.count({ where: { requestId } })).toBe(1);
  });

  it('posts the trade’s reason even when the caller stops waiting', async () => {
    // §2.15a's take used to be written by the HTTP handler *after* the queue
    // returned a filled trade — so a trade the queue deferred (which is what a
    // busy market does, which is when the argument matters most) answered
    // "accepted" and dropped the reason on the floor for ever. The take belongs
    // to whoever executes the trade.
    const userId = await person('reasoned@example.com');
    await prisma.user.update({ where: { id: userId }, data: { tier: 1 } });
    const m = await market('Will the take survive the queue?');
    const requestId = `reason-${userId}`;

    // waitMs 0: submitted, then abandoned before the worker has run — exactly
    // the caller that gets a 202.
    const outcome = await queue.submit(
      {
        kind: 'buy',
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId,
        amount: '10000',
        requestId,
        reason: 'Osimhen is back, that changes everything',
      },
      0,
    );
    expect(outcome.status).toBe('queued');

    await expect
      .poll(async () => prisma.comment.count({ where: { marketId: m.id } }), { timeout: 15_000 })
      .toBe(1);

    const take = await prisma.comment.findFirstOrThrow({ where: { marketId: m.id } });
    expect(take.text).toBe('Osimhen is back, that changes everything');
    expect(take.fromTrade).toBe(true);
    // And it carries the position the trade just created, which is the whole
    // reason the take is written at execution time rather than at submission.
    expect(take.positionSnapshot).toMatch(/YES@/i);
  });

  it('answers a late caller through the status lookup', async () => {
    const userId = await person('late@example.com');
    const m = await market();
    const requestId = `late-${userId}`;

    await queue.submit({
      kind: 'buy',
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId,
    });

    const status = await queue.outcomeOf(requestId);
    expect(status.status).toBe('filled');
    expect(status.trade?.requestId).toBe(requestId);
  });

  // --------------------------------------------------------------- the sweep

  it('files a wash-trading flag with the evidence a reviewer needs', async () => {
    const washer = await person('washer@example.com');
    const m = await market();

    // Five fast round trips: buy, sell everything, repeat.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const bought = await trades.buy({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: washer,
        amount: '5000',
        requestId: `wash-buy-${cycle}-${washer}`,
      });
      await trades.sell({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: washer,
        shares: bought.shares.toString(),
        requestId: `wash-sell-${cycle}-${washer}`,
      });
    }

    const result = await abuse.sweep();
    expect(result.filed).toBeGreaterThan(0);

    const rows = await abuse.queue();
    const flag = rows.find((row) => row.account.id === washer);
    expect(flag?.kind).toBe('wash_trading');
    expect(Number(flag?.evidence['roundTrips'])).toBeGreaterThanOrEqual(4);
  });

  it('updates an open flag on re-sweep rather than filing a duplicate', async () => {
    const washer = await person('rewasher@example.com');
    const m = await market();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const bought = await trades.buy({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: washer,
        amount: '5000',
        requestId: `rewash-buy-${cycle}-${washer}`,
      });
      await trades.sell({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: washer,
        shares: bought.shares.toString(),
        requestId: `rewash-sell-${cycle}-${washer}`,
      });
    }

    const first = await abuse.sweep();
    const second = await abuse.sweep();

    expect(first.filed).toBe(1);
    expect(second.filed).toBe(0);
    expect(second.updated).toBe(1);
    expect(await prisma.abuseFlag.count({ where: { userId: washer } })).toBe(1);
  });

  it('does not re-raise evidence a person has cleared', async () => {
    const washer = await person('cleared@example.com');
    const reviewer = await person('reviewer@example.com', '0');
    await prisma.user.update({ where: { id: reviewer }, data: { role: 'trust_safety' } });

    const m = await market();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const bought = await trades.buy({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: washer,
        amount: '5000',
        requestId: `clr-buy-${cycle}-${washer}`,
      });
      await trades.sell({
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        userId: washer,
        shares: bought.shares.toString(),
        requestId: `clr-sell-${cycle}-${washer}`,
      });
    }

    await abuse.sweep();
    const [flag] = await abuse.queue();
    await abuse.decide({
      flagId: flag!.id,
      staffId: reviewer,
      decision: 'clear',
      note: 'Looked at it — closing a losing position in stages, not washing.',
      ip: '127.0.0.1',
    });

    // The same evidence must not come back: overruling a person's decision
    // automatically is how a queue loses their trust.
    const again = await abuse.sweep();
    expect(again.filed).toBe(0);
    expect(await abuse.queue()).toHaveLength(0);
  });

  it('freeze and unfreeze are audited and reversible', async () => {
    const suspect = await person('suspect@example.com');
    const reviewer = await person('tsafety@example.com', '0');
    await prisma.user.update({ where: { id: reviewer }, data: { role: 'trust_safety' } });

    await prisma.abuseFlag.create({
      data: {
        userId: suspect,
        kind: 'stake_flood',
        severity: '0.8',
        summary: 'test flag',
        evidenceJson: { peakTradesPerHour: 200 },
        dedupeKey: `stake_flood:${suspect}:`,
      },
    });
    const [flag] = await abuse.queue();

    const frozen = await abuse.decide({
      flagId: flag!.id,
      staffId: reviewer,
      decision: 'freeze',
      ip: '127.0.0.1',
    });
    expect(frozen.accountStatus).toBe('frozen');

    const back = await abuse.decide({
      flagId: flag!.id,
      staffId: reviewer,
      decision: 'unfreeze',
      ip: '127.0.0.1',
    });
    expect(back.accountStatus).toBe('active');

    // Both decisions are on the audit trail with the reviewer's name.
    const trail = await prisma.adminAudit.findMany({
      where: { staffId: reviewer },
      orderBy: { ts: 'asc' },
    });
    expect(trail.map((row) => row.action)).toEqual(['abuse.freeze', 'abuse.unfreeze']);
  });

  it('clusters unverified accounts sharing a device', async () => {
    for (let index = 0; index < 5; index += 1) {
      const { userId } = await auth.signup({
        email: `farm${index}@example.com`,
        password: 'correct-horse-battery',
        ageAttested: true,
      });
      await abuse.recordDevice({ userId, fingerprint: 'same-device-hash-0001' });
    }

    const result = await abuse.sweep();
    expect(result.filed).toBe(5);

    const rows = await abuse.queue();
    expect(rows.every((row) => row.kind === 'multi_account')).toBe(true);
    expect(Number(rows[0]?.evidence['unverified'])).toBe(5);
  });

  // --------------------------------------------------------------- the audit

  it('passes on a database real trading has churned through', async () => {
    const alice = await person('audit-a@example.com');
    const bob = await person('audit-b@example.com');
    const m = await market();

    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId: alice,
      amount: '20000',
      requestId: `aud-a-${alice}`,
    });
    const bought = await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[1]!.id,
      userId: bob,
      amount: '15000',
      requestId: `aud-b-${bob}`,
    });
    await trades.sell({
      marketId: m.id,
      outcomeId: m.outcomes[1]!.id,
      userId: bob,
      shares: new Decimal(bought.shares.toString()).div(2).toString(),
      requestId: `aud-c-${bob}`,
    });

    const result = await audit.run();
    expect(result.findings).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it('catches money invented by a write that bypassed the ledger service', async () => {
    const userId = await person('phantom@example.com');

    // A one-legged insert — exactly the write assertBalanced exists to stop,
    // done here at the SQL layer the way a bug or a compromise would.
    await prisma.$executeRawUnsafe(
      `INSERT INTO ledger (id, "userId", type, "fundClass", amount, currency, ref, "createdAt")
       VALUES ('phantom-entry', '${userId}', 'adjustment', 'user_available', 1000000, 'SPC', 'phantom', NOW())`,
    );

    const result = await audit.run();
    expect(result.clean).toBe(false);
    expect(result.findings.some((finding) => finding.check === 'double_entry')).toBe(true);

    // And it opened an incident: §6.10's red is a page, not a log line.
    expect(await prisma.statusIncident.count()).toBeGreaterThan(0);
  });

  it('catches an escrow mismatch on an open market', async () => {
    const userId = await person('escrow@example.com');
    const m = await market();
    await trades.buy({
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      userId,
      amount: '10000',
      requestId: `esc-${userId}`,
    });

    // Corrupt the cached pot, as a bug would.
    await prisma.market.update({ where: { id: m.id }, data: { potTotal: '999999' } });

    const result = await audit.run();
    expect(result.clean).toBe(false);
    expect(result.findings.some((finding) => finding.check === 'escrow_matches_pot')).toBe(true);
  });
});

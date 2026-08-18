import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import type { UserRole } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthService } from '../auth/auth.service';
import { TotpService } from '../auth/totp.service';
import { QuestionEngineService } from '../community/question-engine.service';
import { generateSync } from 'otplib';
import { CommunityService } from '../community/community.service';
import { SeedService } from '../community/seed.service';
import { MarketVoidService } from '../community/void.service';
import { LedgerService } from '../ledger/ledger.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { resetDatabase } from '../testing/reset';
import { ResolutionService } from '../trade/resolution.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { ResolutionFlowService } from './resolution-flow.service';
import type { MarketTemplate } from '../community/market-template';
import { CreatorAnalyticsService } from '../creator/analytics.service';
import { AutopsyService } from '../creator/autopsy.service';
import { CreatorService } from '../creator/creator.service';
import { ThreadService } from '../community-layer/thread.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrizeService } from '../leaderboard/prize.service';

/**
 * The resolution flow and the four-eyes workflow, against a real database
 * (§2.6, §2.10, Rulebook Part 1 §5).
 *
 * These are the paths where the platform's own staff are the risk: the person
 * who says who won, and the person who moves money by hand. Both are split in
 * two on purpose, and both splits are tested here by trying to do it alone.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('resolution, disputes and approvals (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let wallet: WalletService;
  let auth: AuthService;
  let community: CommunityService;
  let seeds: SeedService;
  let trades: TradeService;
  let flow: ResolutionFlowService;
  let approvals: ApprovalsService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();

    const ledger = new LedgerService(prisma);
    const voids = new MarketVoidService(ledger);
    // Notifications are best-effort by design; in tests they run against the
    // same database with every channel unconfigured, so they record and move on.
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    const audit = new AdminAuditService(prisma);
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );
    const analytics = new AnalyticsService(prisma);
    // §2.14's creator platform: the ladder, the analytics it reads, and
    // the autopsy that moves a creator's record when a market closes.
    const creators = new CreatorService(prisma, config, notifications);
    const creatorAnalytics = new CreatorAnalyticsService(prisma);
    const autopsies = new AutopsyService(prisma, creatorAnalytics, creators, notifications);
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
    seeds = new SeedService(prisma, config, wallet, voids, creators);
    trades = new TradeService(
      prisma,
      ledger,
      wallet,
      config,
      { publish: async () => undefined } as unknown as PriceCacheService,
      new RgService(prisma, config),
    );
    flow = new ResolutionFlowService(
      prisma,
      config,
      new ResolutionService(prisma, ledger, config),
      audit,
      notifications,
      // No API key in tests: the engine's model seam is null, and the parts that
      // matter here — §2.9's outcome log — do not need one.
      new QuestionEngineService(prisma, config, null),
      autopsies,
      new ThreadService(prisma, config),
      analytics,
    );
    // §2.8's prize tool: drawn up here, and paid only when the approvals
    // workflow signs it — which is the path under test.
    const prizes = new PrizeService(prisma, config, wallet, notifications, audit, analytics);
    approvals = new ApprovalsService(
      prisma,
      ledger,
      voids,
      config,
      audit,
      new TotpService(prisma),
      prizes,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    for (const [key, value] of Object.entries({
      symmetric_seed_per_outcome_spc: 2_000,
      participation_floor_users: 1,
      dispute_window_hours: 48,
      config_change_delay_hours: 24,
    })) {
      await prisma.platformConfig.updateMany({ where: { key }, data: { valueJson: value } });
    }
    await config.refresh();
  });

  const template: MarketTemplate = {
    question: 'Will the CBN hold the benchmark rate at its next meeting?',
    outcomes: [
      { label: 'HOLD', criteria: 'The MPC communique states the rate is unchanged.' },
      { label: 'CHANGE', criteria: 'The MPC communique states a new rate.' },
    ],
    sourceName: 'CBN MPC communique',
    sourceUrl: 'https://www.cbn.gov.ng/',
    eventDate: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    voidDate: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    edgeCases: { postponed: 'Voids if the meeting does not sit before the void date.' },
  };

  async function person(email: string, role: UserRole = 'user') {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
    if (role !== 'user') {
      await prisma.user.update({ where: { id: userId }, data: { role } });
    }
    return { userId, role, ip: '10.0.0.9' };
  }

  /**
   * A staff member with 2FA live, since §6.4b's approve button demands a fresh
   * code. `code()` returns one for the moment it is called.
   */
  async function staffWith2fa(email: string, role: UserRole) {
    const actor = await person(email, role);
    const enrolment = await new TotpService(prisma).beginEnrolment(actor.userId);
    await new TotpService(prisma).confirmEnrolment(
      actor.userId,
      generateSync({ secret: enrolment.secret }),
    );
    return { ...actor, code: () => generateSync({ secret: enrolment.secret }) };
  }

  /** A live seeded market with two ordinary stakers on it. */
  async function liveMarket(creatorId: string) {
    const { marketId } = await community.create({
      creatorId,
      template,
      liquidityParam: '50000',
      activationPath: 'seeded',
    });
    await seeds.seedSolo({ marketId, userId: creatorId });

    const outcomes = await prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
    });
    return { marketId, outcomes };
  }

  it('runs the whole flow: propose, wait, confirm, pay out', async () => {
    const creator = await person('flow-creator@example.ng');
    const staff = await person('flow-resolver@example.ng', 'resolver');
    const punter = await person('flow-punter@example.ng');

    const { marketId, outcomes } = await liveMarket(creator.userId);
    const hold = outcomes[0];
    const change = outcomes[1];
    if (hold === undefined || change === undefined) throw new Error('binary market expected');

    await trades.buy({
      marketId,
      outcomeId: hold.id,
      userId: punter.userId,
      amount: '3000',
      requestId: 'flow-stake',
    });

    // 1. The creator proposes. Nothing is paid, and the market stops trading.
    const { disputeClosesAt } = await flow.propose({
      marketId,
      outcomeId: hold.id,
      evidenceUrl: 'https://www.cbn.gov.ng/mpc/communique-301',
      actor: creator,
    });
    expect(disputeClosesAt.getTime()).toBeGreaterThan(Date.now());

    const proposed = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(proposed.state).toBe('dispute_window');
    await expect(
      trades.buy({
        marketId,
        outcomeId: hold.id,
        userId: punter.userId,
        amount: '100',
        requestId: 'after-proposal',
      }),
    ).rejects.toThrow(/trading is closed/);

    // 2. The window is real: nobody can finalise inside it.
    await expect(
      flow.finalize({
        marketId,
        outcomeId: hold.id,
        reasoning: 'The communique says the rate is unchanged.',
        actor: staff,
      }),
    ).rejects.toThrow(/window is open/);

    // 3. Wind the clock past the window, the way the job would find it.
    await prisma.market.update({
      where: { id: marketId },
      data: { disputeClosesAt: new Date(Date.now() - 1_000) },
    });
    expect((await flow.closeDisputeWindow(marketId)).outcome).toBe('due');

    const balanceBefore = await wallet.balanceOf(punter.userId);
    const result = await flow.finalize({
      marketId,
      outcomeId: hold.id,
      reasoning: 'The communique says the rate is unchanged.',
      actor: staff,
    });

    expect(result.payouts.length).toBeGreaterThan(0);
    const settled = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(settled.state).toBe('resolved');
    expect(settled.disputeClosesAt).toBeNull();

    const balanceAfter = await wallet.balanceOf(punter.userId);
    expect(balanceAfter.available.gt(balanceBefore.available)).toBe(true);
    expect(balanceAfter.escrowed.isZero()).toBe(true);

    // The bond came back on a clean resolution (Part 3 §5).
    const bond = await prisma.bond.findUniqueOrThrow({ where: { marketId } });
    expect(bond.state).toBe('refunded');

    // One market, one resolution record: the proposal that was disputed is the
    // row that gets finalised, rather than a second row appearing at payout
    // claiming the resolver proposed it too.
    const resolutions = await prisma.resolution.findMany({ where: { marketId } });
    expect(resolutions).toHaveLength(1);
    const resolution = resolutions[0];
    expect(resolution?.proposedBy).toBe(creator.userId);
    expect(resolution?.finalizedBy).toBe(staff.userId);
    expect(resolution?.finalOutcomeId).toBe(hold.id);
  });

  it('will not let the proposer confirm their own result', async () => {
    const creator = await person('self-creator@example.ng', 'admin');
    const punter = await person('self-punter@example.ng');
    const { marketId, outcomes } = await liveMarket(creator.userId);
    const hold = outcomes[0];
    if (hold === undefined) throw new Error('binary market expected');

    await trades.buy({
      marketId,
      outcomeId: hold.id,
      userId: punter.userId,
      amount: '1000',
      requestId: 'self-stake',
    });

    await flow.propose({
      marketId,
      outcomeId: hold.id,
      evidenceUrl: 'https://www.cbn.gov.ng/mpc/communique-301',
      actor: creator,
    });
    await prisma.market.update({
      where: { id: marketId },
      data: { disputeClosesAt: new Date(Date.now() - 1_000) },
    });

    // Even as an admin — especially as an admin.
    await expect(
      flow.finalize({
        marketId,
        outcomeId: hold.id,
        reasoning: 'I proposed it and I am confirming it.',
        actor: creator,
      }),
    ).rejects.toThrow(/someone else confirms it/);

    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('dispute_window');
  });

  it('takes disputes from participants only, and blocks the payout until they are decided', async () => {
    const creator = await person('d-creator@example.ng');
    const staff = await person('d-resolver@example.ng', 'resolver');
    const punter = await person('d-punter@example.ng');
    const stranger = await person('d-stranger@example.ng');

    const { marketId, outcomes } = await liveMarket(creator.userId);
    const hold = outcomes[0];
    const change = outcomes[1];
    if (hold === undefined || change === undefined) throw new Error('binary market expected');

    await trades.buy({
      marketId,
      outcomeId: change.id,
      userId: punter.userId,
      amount: '2500',
      requestId: 'd-stake',
    });
    await flow.propose({
      marketId,
      outcomeId: hold.id,
      evidenceUrl: 'https://www.cbn.gov.ng/mpc/communique-301',
      actor: creator,
    });

    await expect(
      flow.fileDispute({
        marketId,
        userId: stranger.userId,
        evidenceUrl: 'https://www.cbn.gov.ng/mpc/communique-301',
        text: 'I read the communique and it says something else entirely.',
      }),
    ).rejects.toThrow(/only participants/);

    const dispute = await flow.fileDispute({
      marketId,
      userId: punter.userId,
      evidenceUrl: 'https://www.cbn.gov.ng/mpc/communique-301',
      text: 'The communique announces a new rate, so CHANGE is the result.',
    });
    expect(dispute.state).toBe('open');

    await expect(
      flow.fileDispute({
        marketId,
        userId: punter.userId,
        evidenceUrl: 'https://www.cbn.gov.ng/mpc/communique-301',
        text: 'Filing the same complaint a second time to be sure.',
      }),
    ).rejects.toThrow(/already have an open dispute/);

    await prisma.market.update({
      where: { id: marketId },
      data: { disputeClosesAt: new Date(Date.now() - 1_000) },
    });
    expect((await flow.closeDisputeWindow(marketId)).outcome).toBe('disputed');

    await expect(
      flow.finalize({
        marketId,
        outcomeId: hold.id,
        reasoning: 'Ignoring the dispute and paying the proposal.',
        actor: staff,
      }),
    ).rejects.toThrow(/decide the open disputes/i);

    // Upholding it changes the result — which is the point of the window.
    await flow.decideDispute({
      disputeId: dispute.id,
      upheld: true,
      decision: 'The named source announces a new rate; the proposal misread it.',
      actor: staff,
    });

    const result = await flow.finalize({
      marketId,
      outcomeId: change.id,
      reasoning: 'Upheld dispute: the communique announces a new rate.',
      actor: staff,
    });
    expect(result.payouts.some((p) => p.userId === punter.userId)).toBe(true);

    const settled = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(settled.resolvedOutcomeId).toBe(change.id);
  });

  it('refuses a trade once the event has started, whatever the state column says', async () => {
    const creator = await person('freeze-creator@example.ng');
    const punter = await person('freeze-punter@example.ng');
    const { marketId, outcomes } = await liveMarket(creator.userId);
    const hold = outcomes[0];
    if (hold === undefined) throw new Error('binary market expected');

    // The sweep has not run yet; the market still reads `active`.
    await prisma.market.update({
      where: { id: marketId },
      data: { eventDate: new Date(Date.now() - 60_000) },
    });

    await expect(
      trades.buy({
        marketId,
        outcomeId: hold.id,
        userId: punter.userId,
        amount: '500',
        requestId: 'late-trade',
      }),
    ).rejects.toThrow(/froze when the event started/);

    expect(await flow.freezeDueMarkets()).toBe(1);
    const frozen = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(frozen.state).toBe('pending_resolution');
  });

  describe('four-eyes approvals', () => {
    it('refuses the proposer’s own approval, and a non-money role', async () => {
      const finance = await person('a-finance@example.ng', 'finance');
      const support = await person('a-support@example.ng', 'support');
      const creator = await person('a-creator@example.ng');
      const { marketId } = await liveMarket(creator.userId);

      const approval = await approvals.propose({
        actionType: 'bond.forfeit',
        payload: { marketId },
        reason: 'Creator proposed a result the named source contradicts.',
        actor: finance,
      });

      await expect(approvals.approve({ approvalId: approval.id, actor: finance })).rejects.toThrow(
        /four eyes means a second person/,
      );

      await expect(approvals.approve({ approvalId: approval.id, actor: support })).rejects.toThrow(
        /needs a finance or admin approver/,
      );

      // Nothing moved on either refusal.
      const bond = await prisma.bond.findUniqueOrThrow({ where: { marketId } });
      expect(bond.state).toBe('held');
      const still = await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } });
      expect(still.state).toBe('pending');
    });

    it('forfeits a bond on the second eye, and never twice', async () => {
      const finance = await person('f-finance@example.ng', 'finance');
      const boss = await staffWith2fa('f-admin@example.ng', 'admin');
      const creator = await person('f-creator@example.ng');
      const { marketId } = await liveMarket(creator.userId);

      const bondAmount = new Decimal(await config.get('conduct_bond_spc'));
      const platformBefore = await wallet.balanceOf('sys_platform');

      const approval = await approvals.propose({
        actionType: 'bond.forfeit',
        payload: { marketId },
        reason: 'Creator abandoned resolution after the void date.',
        actor: finance,
      });
      const done = await approvals.approve({
        approvalId: approval.id,
        actor: boss,
        totpCode: boss.code(),
      });
      expect(done.state).toBe('approved');
      expect(done.executedAt).not.toBeNull();

      const bond = await prisma.bond.findUniqueOrThrow({ where: { marketId } });
      expect(bond.state).toBe('forfeited');
      expect(bond.reason).toMatch(/abandoned resolution/);

      const platformAfter = await wallet.balanceOf('sys_platform');
      expect(platformAfter.available.minus(platformBefore.available).eq(bondAmount)).toBe(true);
      // The bond left escrow and nothing else did — the creator's symmetric seed
      // is still staked in the market they seeded.
      const creatorEscrow = (await wallet.balanceOf(creator.userId)).escrowed;
      expect(creatorEscrow.eq(new Decimal(4_000))).toBe(true);

      // A second proposal for the same bond fails on approval, and the failure
      // leaves the approval pending rather than approved-but-unexecuted.
      const again = await approvals.propose({
        actionType: 'bond.forfeit',
        payload: { marketId },
        reason: 'Duplicate proposal filed by mistake.',
        actor: finance,
      });
      await expect(
        approvals.approve({ approvalId: again.id, actor: boss, totpCode: boss.code() }),
      ).rejects.toThrow(/already forfeited/);
      const stuck = await prisma.approval.findUniqueOrThrow({ where: { id: again.id } });
      expect(stuck.state).toBe('pending');
      expect(stuck.executedAt).toBeNull();
    });

    it('voids a live market through the workflow and refunds everyone', async () => {
      const finance = await person('v-finance@example.ng', 'finance');
      const boss = await staffWith2fa('v-admin@example.ng', 'admin');
      const creator = await person('v-creator@example.ng');
      const punter = await person('v-punter@example.ng');

      const creatorBefore = await wallet.balanceOf(creator.userId);
      const punterBefore = await wallet.balanceOf(punter.userId);

      const { marketId, outcomes } = await liveMarket(creator.userId);
      const hold = outcomes[0];
      if (hold === undefined) throw new Error('binary market expected');
      await trades.buy({
        marketId,
        outcomeId: hold.id,
        userId: punter.userId,
        amount: '1800',
        requestId: 'v-stake',
      });

      const approval = await approvals.propose({
        actionType: 'market.void_after_activation',
        payload: { marketId },
        reason: 'The MPC meeting was cancelled; the source will never publish.',
        actor: finance,
      });
      await approvals.approve({ approvalId: approval.id, actor: boss, totpCode: boss.code() });

      const voided = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
      expect(voided.state).toBe('voided');

      // Rulebook Part 1 §6: refunded at exactly the amount staked, no fees.
      expect((await wallet.balanceOf(punter.userId)).available.eq(punterBefore.available)).toBe(
        true,
      );
      expect((await wallet.balanceOf(creator.userId)).available.eq(creatorBefore.available)).toBe(
        true,
      );
    });

    it('corrects a balance with a reversing entry, never an edit', async () => {
      const finance = await person('adj-finance@example.ng', 'finance');
      const boss = await staffWith2fa('adj-admin@example.ng', 'admin');
      const punter = await person('adj-punter@example.ng');

      const before = await wallet.balanceOf(punter.userId);
      const approval = await approvals.propose({
        actionType: 'ledger.adjust',
        payload: { userId: punter.userId, amount: '250.5' },
        reason: 'Goodwill credit for the outage on the 12th, ticket #441.',
        actor: finance,
      });
      await approvals.approve({ approvalId: approval.id, actor: boss, totpCode: boss.code() });

      const after = await wallet.balanceOf(punter.userId);
      expect(after.available.minus(before.available).eq(new Decimal('250.5'))).toBe(true);

      const entries = await prisma.ledgerEntry.findMany({
        where: { type: 'adjustment' },
      });
      // Two rows, summing to zero: the correction came from the platform's own
      // fees, not from thin air.
      expect(entries).toHaveLength(2);
      const total = entries.reduce(
        (acc, row) => acc.plus(new Decimal(row.amount.toString())),
        new Decimal(0),
      );
      expect(total.isZero()).toBe(true);
    });

    it('lands a config change as a pending version that activates on its delay', async () => {
      const finance = await person('c-finance@example.ng', 'finance');
      const boss = await staffWith2fa('c-admin@example.ng', 'admin');

      const before = await config.get('exit_fee_rate');
      const approval = await approvals.propose({
        actionType: 'config.change',
        payload: { key: 'exit_fee_rate', value: 0.015 },
        reason: 'Board approved the exit fee moving to 1.5% from the 1st.',
        actor: finance,
      });
      await approvals.approve({ approvalId: approval.id, actor: boss, totpCode: boss.code() });

      // §6.4b: never retroactively — the live value is unchanged until the delay
      // has run, so markets already open keep the terms they opened under.
      await config.refresh();
      expect(await config.get('exit_fee_rate')).toBe(before);

      const pending = await prisma.platformConfig.findFirstOrThrow({
        where: { key: 'exit_fee_rate', state: 'pending' },
      });
      expect(Number(pending.valueJson)).toBe(0.015);

      const version = await prisma.configVersion.findFirstOrThrow({
        where: { key: 'exit_fee_rate' },
      });
      expect(version.proposedBy).toBe(finance.userId);
      expect(version.approvedBy).toBe(boss.userId);
      expect(version.reason).toMatch(/Board approved/);

      // Wind the effective date back and the change lands by itself.
      await prisma.platformConfig.update({
        where: { key_version: { key: 'exit_fee_rate', version: pending.version } },
        data: { effectiveAt: new Date(Date.now() - 1_000) },
      });
      await config.refresh();
      expect(await config.get('exit_fee_rate')).toBe(0.015);

      const superseded = await prisma.platformConfig.findMany({
        where: { key: 'exit_fee_rate', state: 'active' },
      });
      expect(superseded).toHaveLength(1);
    });

    it('refuses a config value its own key would reject', async () => {
      const finance = await person('bad-finance@example.ng', 'finance');
      await expect(
        approvals.propose({
          actionType: 'config.change',
          // §2.3 caps the exit fee at 2%.
          payload: { key: 'exit_fee_rate', value: 0.5 },
          reason: 'Trying to set an exit fee well past the documented ceiling.',
          actor: finance,
        }),
      ).rejects.toThrow(/not valid/);

      await expect(
        approvals.propose({
          actionType: 'config.change',
          payload: { key: 'exit_fee_rat', value: 0.01 },
          reason: 'A typo that must not quietly become a new setting.',
          actor: finance,
        }),
      ).rejects.toThrow(/not a known config key/);
    });
  });
});

import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import type { UserRole } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthService } from '../auth/auth.service';
import { TotpService } from '../auth/totp.service';
import { CommunityService } from '../community/community.service';
import { SeedService } from '../community/seed.service';
import { MarketVoidService } from '../community/void.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketHealthService } from '../market/health.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PriceCacheService } from '../realtime/price-cache.service';
import { StatusService } from '../status/status.service';
import { SupportService } from '../support/support.service';
import { testOrderBook } from '../testing/order-book';
import { resetDatabase } from '../testing/reset';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';
import { RgBlockedError, RgService } from './rg.service';
import type { MarketTemplate } from '../community/market-template';
import { approvalAnswers, compliantTemplate } from '../testing/templates';
import { CreatorAnalyticsService } from '../creator/analytics.service';
import { AutopsyService } from '../creator/autopsy.service';
import { CreatorService } from '../creator/creator.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrizeService } from '../leaderboard/prize.service';

/**
 * The company layer against a real database (§2.11, §2.12).
 *
 * The tests that matter here are the ones where the platform has to act against
 * its own commercial interest: a self-exclusion that stops someone staking, an
 * SLA that says the desk is late, and a 2FA gate that stops an approver who is
 * in a hurry.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('company layer (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let wallet: WalletService;
  let auth: AuthService;
  let rg: RgService;
  let support: SupportService;
  let notifications: NotificationsService;
  let status: StatusService;
  let totp: TotpService;
  let approvals: ApprovalsService;
  let community: CommunityService;
  let seeds: SeedService;
  let trades: TradeService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();

    const ledger = new LedgerService(prisma);
    const voids = new MarketVoidService(ledger);
    const audit = new AdminAuditService(prisma);
    notifications = new NotificationsService(
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
    rg = new RgService(prisma, config);
    support = new SupportService(prisma, config, notifications);
    status = new StatusService(prisma);
    totp = new TotpService(prisma);
    // §2.8's prize tool: drawn up in the leaderboard module and paid only
    // when the approvals workflow signs it.
    const prizes = new PrizeService(
      prisma,
      config,
      wallet,
      notifications,
      audit,
      new AnalyticsService(prisma),
    );
    // §2.14's creator platform: the ladder, the analytics it reads, and
    // the autopsy that moves a creator's record when a market closes.
    const creators = new CreatorService(prisma, config, notifications);
    seeds = new SeedService(prisma, config, wallet, voids, creators);
    approvals = new ApprovalsService(prisma, ledger, voids, config, audit, totp, prizes, seeds);
    const creatorAnalytics = new CreatorAnalyticsService(prisma);
    const autopsies = new AutopsyService(
      prisma,
      creatorAnalytics,
      creators,
      notifications,
      new MarketHealthService(prisma),
    );
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
      rg,
      testOrderBook(prisma, ledger, wallet),
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
      reality_check_minutes: 60,
      rg_platform_stake_limit_spc: 1_000_000,
      rg_platform_loss_limit_spc: 1_000_000,
    })) {
      await prisma.platformConfig.updateMany({ where: { key }, data: { valueJson: value } });
    }
    await config.refresh();
  });

  const template: MarketTemplate = compliantTemplate({
    question: 'Will the Eagles name a new captain before 23:59 WAT on the window deadline?',
    outcomes: [
      {
        label: 'YES',
        criteria: 'The NFF announces a new substantive captain before 23:59 WAT on that date.',
      },
      {
        label: 'NO',
        criteria: 'No new substantive captain has been announced by 23:59 WAT on that date.',
      },
    ],
    sourceName: 'NFF official site',
    sourceUrl: 'https://www.thenff.com/news/super-eagles/',
    eventDate: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    voidDate: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    edgeCases: {
      interim: 'An interim captain does not count.',
      'no publication': 'If the NFF announces nothing by the void date, the market voids.',
    },
  });

  async function person(email: string, role: UserRole = 'user') {
    const { userId } = await auth.signup({
      email,
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await auth.markContactVerified(userId);
    if (role !== 'user') await prisma.user.update({ where: { id: userId }, data: { role } });
    return { userId, role, ip: '10.0.0.4' };
  }

  async function liveMarket(creatorId: string) {
    const { marketId } = await community.create({
      creatorId,
      template,
      ...approvalAnswers(),
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

  describe('responsible gambling (§2.12)', () => {
    it('self-exclusion blocks staking and leaves the balance withdrawable', async () => {
      const creator = await person('rg-creator@example.ng');
      const punter = await person('rg-punter@example.ng');
      const { marketId, outcomes } = await liveMarket(creator.userId);
      const yes = outcomes[0];
      if (yes === undefined) throw new Error('binary market expected');

      await trades.buy({
        marketId,
        outcomeId: yes.id,
        userId: punter.userId,
        amount: '500',
        requestId: 'rg-before',
      });

      await rg.selfExclude({ userId: punter.userId });

      await expect(
        trades.buy({
          marketId,
          outcomeId: yes.id,
          userId: punter.userId,
          amount: '500',
          requestId: 'rg-after',
        }),
      ).rejects.toThrow(/self-excluded/);

      // The whole point: the money is still theirs. Nothing about the exclusion
      // touches the balance, and the ledger can still pay it out.
      const balance = await wallet.balanceOf(punter.userId);
      expect(balance.available.gt(0)).toBe(true);
      await wallet.issue({
        userId: punter.userId,
        amount: new Decimal(1),
        type: 'prize',
        ref: 'withdrawable-check',
      });
      expect((await wallet.balanceOf(punter.userId)).available.gt(balance.available)).toBe(true);

      // And it cannot be quietly undone by the settings endpoint.
      await expect(
        rg.setLimits({ userId: punter.userId, stakeLimit: '100000' }),
      ).rejects.toBeInstanceOf(RgBlockedError);
    });

    it('holds a cool-off, and refuses to loosen a limit during one', async () => {
      const punter = await person('rg-cool@example.ng');
      const creator = await person('rg-cool-creator@example.ng');
      const { marketId, outcomes } = await liveMarket(creator.userId);
      const yes = outcomes[0];
      if (yes === undefined) throw new Error('binary market expected');

      await rg.setLimits({ userId: punter.userId, stakeLimit: '1000' });
      await rg.coolOff({ userId: punter.userId, days: 2 });

      await expect(
        trades.buy({
          marketId,
          outcomeId: yes.id,
          userId: punter.userId,
          amount: '100',
          requestId: 'cool-off-trade',
        }),
      ).rejects.toThrow(/cool-off/);

      await expect(rg.setLimits({ userId: punter.userId, stakeLimit: '50000' })).rejects.toThrow(
        /only be tightened/,
      );
      // Tightening is always allowed — that is the asymmetry that makes a limit
      // worth having.
      await rg.setLimits({ userId: punter.userId, stakeLimit: '250' });
      const view = await rg.view(punter.userId);
      expect(view.stakeLimit).toBe('250');
    });

    it('enforces the daily stake limit against the trade record', async () => {
      const creator = await person('rg-limit-creator@example.ng');
      const punter = await person('rg-limit@example.ng');
      const { marketId, outcomes } = await liveMarket(creator.userId);
      const yes = outcomes[0];
      if (yes === undefined) throw new Error('binary market expected');

      await rg.setLimits({ userId: punter.userId, stakeLimit: '1000' });
      await trades.buy({
        marketId,
        outcomeId: yes.id,
        userId: punter.userId,
        amount: '800',
        requestId: 'limit-1',
      });

      await expect(
        trades.buy({
          marketId,
          outcomeId: yes.id,
          userId: punter.userId,
          amount: '300',
          requestId: 'limit-2',
        }),
      ).rejects.toThrow(/past your limit/);

      // Right up to the line is fine.
      await trades.buy({
        marketId,
        outcomeId: yes.id,
        userId: punter.userId,
        amount: '200',
        requestId: 'limit-3',
      });
      const view = await rg.view(punter.userId);
      expect(new Decimal(view.stakedToday).eq(1_000)).toBe(true);
    });

    it('prompts a reality check after the configured session length', async () => {
      const punter = await person('rg-reality@example.ng');
      const start = new Date('2026-03-01T10:00:00Z');

      expect((await rg.realityCheck(punter.userId, start)).due).toBe(false);
      expect(
        (await rg.realityCheck(punter.userId, new Date(start.getTime() + 30 * 60_000))).due,
      ).toBe(false);

      const later = new Date(start.getTime() + 61 * 60_000);
      const prompt = await rg.realityCheck(punter.userId, later);
      expect(prompt.due).toBe(true);
      expect(prompt.helpline.length).toBeGreaterThan(20);

      // The clock restarts, so it prompts once an hour rather than every poll.
      expect((await rg.realityCheck(punter.userId, later)).due).toBe(false);
    });
  });

  describe('support desk (§2.12, §6.7)', () => {
    it('sets the SLA from the category, pauses it on a staff reply, and escalates a breach', async () => {
      const punter = await person('sup-user@example.ng');
      const agent = await person('sup-agent@example.ng', 'support');
      const opened = new Date('2026-03-01T09:00:00Z');

      const ticket = await support.open({
        userId: punter.userId,
        category: 'payout_query',
        subject: 'My payout has not arrived',
        body: 'The market settled yesterday and I have not been paid yet.',
        now: opened,
      });
      // payout_query is 4 hours in the seeded table.
      expect(ticket.slaDue.getTime() - opened.getTime()).toBe(4 * 3_600_000);

      const breachTime = new Date(opened.getTime() + 5 * 3_600_000);
      expect(await support.escalateOverdue(breachTime)).toBe(1);
      expect(
        (await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).state,
      ).toBe('escalated');

      // A staff reply stops the clock and notifies the user.
      await support.reply({
        ticketId: ticket.id,
        authorId: agent.userId,
        authorRole: 'support',
        body: 'Looking into this now — the market settled at 14:02 and the payout batch ran after.',
      });
      const replied = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(replied.state).toBe('waiting_on_user');
      expect(await support.escalateOverdue(breachTime)).toBe(0);

      const inbox = await notifications.inbox(punter.userId);
      expect(inbox.some((row) => row.type === 'support_reply')).toBe(true);

      // An internal note stays internal.
      await support.reply({
        ticketId: ticket.id,
        authorId: agent.userId,
        authorRole: 'support',
        body: 'Checked the ledger: payout ref resolve:xyz landed. Chasing the SMS gateway.',
        staffOnly: true,
      });
      const asUserSees = await support.forUser(punter.userId);
      expect(asUserSees[0]?.messages.every((message) => !message.staffOnly)).toBe(true);
      expect(asUserSees[0]?.messages).toHaveLength(2);
    });

    it('will not let one user reply on another user’s ticket', async () => {
      const mine = await person('sup-mine@example.ng');
      const theirs = await person('sup-theirs@example.ng');
      const ticket = await support.open({
        userId: mine.userId,
        category: 'account',
        subject: 'Cannot change my phone number',
        body: 'The app says the number is already in use, but it is my own number.',
      });

      await expect(
        support.reply({
          ticketId: ticket.id,
          authorId: theirs.userId,
          authorRole: 'user',
          body: 'Adding myself to this conversation.',
        }),
      ).rejects.toThrow(/not your ticket/);
    });
  });

  describe('notifications (§2.12)', () => {
    it('records every attempt, including the channels that could not send', async () => {
      const punter = await person('note-user@example.ng');

      await notifications.notify({
        userId: punter.userId,
        type: 'rg_confirmation',
        body: 'Your limits changed.',
      });

      const rows = await prisma.notification.findMany({ where: { userId: punter.userId } });
      const channels = rows.map((row) => row.channel).sort();
      expect(channels).toEqual(['email', 'in_app', 'push', 'sms']);

      const inApp = rows.find((row) => row.channel === 'in_app');
      expect(inApp?.sentAt).not.toBeNull();

      // Nothing is configured in tests, so the other three record why they did
      // not go rather than looking like they did.
      for (const channel of ['push', 'email', 'sms'] as const) {
        const row = rows.find((entry) => entry.channel === channel);
        expect(row?.sentAt).toBeNull();
        expect(row?.failure).toBeTruthy();
      }
    });

    it('respects a per-channel opt-out', async () => {
      const punter = await person('note-optout@example.ng');
      await notifications.setPreference({
        userId: punter.userId,
        channel: 'email',
        enabled: false,
      });

      await notifications.notify({ userId: punter.userId, type: 'payout', body: 'You were paid.' });
      const rows = await prisma.notification.findMany({ where: { userId: punter.userId } });
      expect(rows.some((row) => row.channel === 'email')).toBe(false);
      expect(rows.some((row) => row.channel === 'in_app')).toBe(true);
    });
  });

  describe('staff 2FA (§2.11, §6.4b)', () => {
    it('gates the approve button, and only a real code opens it', async () => {
      const finance = await person('2fa-finance@example.ng', 'finance');
      const boss = await person('2fa-admin@example.ng', 'admin');
      const creator = await person('2fa-creator@example.ng');
      const { marketId } = await liveMarket(creator.userId);

      const approval = await approvals.propose({
        actionType: 'bond.forfeit',
        payload: { marketId },
        reason: 'Creator abandoned resolution after the void date.',
        actor: finance,
      });

      // Not enrolled: §2.11 makes 2FA mandatory for staff, so this fails closed.
      await expect(approvals.approve({ approvalId: approval.id, actor: boss })).rejects.toThrow(
        /set up 2FA/,
      );

      const enrolment = await totp.beginEnrolment(boss.userId);
      await totp.confirmEnrolment(boss.userId, generateSync({ secret: enrolment.secret }));

      await expect(
        approvals.approve({ approvalId: approval.id, actor: boss, totpCode: '000000' }),
      ).rejects.toThrow(/did not match/);
      await expect(approvals.approve({ approvalId: approval.id, actor: boss })).rejects.toThrow(
        /code from your authenticator/,
      );

      // Nothing moved on any of those refusals.
      expect((await prisma.bond.findUniqueOrThrow({ where: { marketId } })).state).toBe('held');

      const approved = await approvals.approve({
        approvalId: approval.id,
        actor: boss,
        totpCode: generateSync({ secret: enrolment.secret }),
      });
      expect(approved.state).toBe('approved');
      expect((await prisma.bond.findUniqueOrThrow({ where: { marketId } })).state).toBe(
        'forfeited',
      );
    });

    it('refuses enrolment for a non-staff account', async () => {
      const punter = await person('2fa-punter@example.ng');
      await expect(totp.beginEnrolment(punter.userId)).rejects.toThrow(/staff accounts/);
    });
  });

  describe('status page (§2.12)', () => {
    it('publishes an incident and its timeline, and clears when resolved', async () => {
      const boss = await person('status-admin@example.ng', 'admin');

      expect((await status.page()).status).toBe('operational');

      const incident = await status.open({
        title: 'Trades are slow to confirm',
        severity: 'degraded',
        body: 'Queue lag is above our alert threshold. Trades are landing but confirmations are late.',
        postedBy: boss.userId,
      });

      const during = await status.page();
      expect(during.status).toBe('degraded');
      expect(during.incidents[0]?.updates).toHaveLength(1);

      await status.update({
        incidentId: incident.id,
        state: 'monitoring',
        body: 'Cause found and fixed; watching the queue for another 30 minutes.',
        postedBy: boss.userId,
      });
      await status.update({
        incidentId: incident.id,
        state: 'resolved',
        body: 'Queue lag back to normal for 30 minutes. Nothing was lost — no trade was dropped.',
        postedBy: boss.userId,
      });

      const after = await status.page();
      expect(after.status).toBe('operational');
      // The history stays, in order, and nothing was rewritten.
      expect(after.incidents[0]?.state).toBe('resolved');
      expect(after.incidents[0]?.updates).toHaveLength(3);
      expect(after.incidents[0]?.resolvedAt).not.toBeNull();
    });
  });
});

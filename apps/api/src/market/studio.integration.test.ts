import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import { CreatorService } from '../creator/creator.service';
import { MarketVoidService } from '../community/void.service';
import { SeedService } from '../community/seed.service';
import { LedgerService } from '../ledger/ledger.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { compliantTemplate } from '../testing/templates';
import { WalletService } from '../wallet/wallet.service';
import { StudioError, StudioService } from './studio.service';

/**
 * The Market Studio's review and publish paths.
 *
 * The publish assertions are the ones that matter: the review screen is a
 * claim, and a service that publishes a market the screen showed as failing
 * makes the screen decoration. So the tests go at the endpoint directly, the
 * way a client that skipped the screen would.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('market studio (integration)', () => {
  let prisma: PrismaService;
  let studio: StudioService;
  let staffId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();

    const config = new PlatformConfigService(prisma);
    await config.refresh();
    const ledger = new LedgerService(prisma);
    const wallet = new WalletService(prisma, ledger);
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    studio = new StudioService(
      prisma,
      config,
      new SeedService(
        prisma,
        config,
        wallet,
        new MarketVoidService(ledger),
        new CreatorService(prisma, config, notifications),
      ),
      new AdminAuditService(prisma),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const staff = await prisma.user.create({
      data: { email: 'studio-staff@example.ng', pwHash: 'x', role: 'admin', tier: 1 },
    });
    staffId = staff.id;
  });

  const answers = {
    attestedNoInfluence: true,
    confirmations: { '18': true, '25': true, R3: false },
  };

  it('reviews a half-written draft without falling over', async () => {
    // The wizard reviews on every keystroke, so it spends most of a session
    // asking about a market with no dates and no outcomes. An earlier version
    // threw `RangeError: Invalid time value` out of the endpoint here, and the
    // wizard rendered "Internal server error" where the checklist should have
    // been — on every session, from the first character typed.
    const report = await studio.reviewDraft({
      question: 'Will something happen?',
      outcomes: [],
      sourceName: '',
      sourceUrl: '',
      eventDate: '',
      voidDate: '',
      edgeCases: {},
    });

    expect(report.blocked).toBe(true);
    expect(report.findings.length).toBeGreaterThan(20);
    // Not "no collisions" — nobody could check a calendar against a date that
    // does not exist yet, and a pass there would be a claim about nothing.
    expect(report.findings.find((finding) => finding.rule === '33')?.status).toBe('note');
  });

  it('publishes a market that satisfies the checklist, and seeds it', async () => {
    const result = await studio.publish({
      draft: compliantTemplate(),
      staffId,
      ip: '10.0.0.1',
      ...answers,
      warningReason: 'the shelf is short an economy market this cycle',
    });

    const market = await prisma.market.findUniqueOrThrow({
      where: { id: result.marketId },
      include: { outcomes: true },
    });
    expect(market.shelf).toBe('official');
    expect(market.state).toBe('active');
    expect(market.outcomes).toHaveLength(2);
    expect(Number(result.seeded)).toBeGreaterThan(0);
  });

  it('refuses a market the checklist fails, called directly', async () => {
    await expect(
      studio.publish({
        draft: compliantTemplate({ sourceName: 'widely reported' }),
        staffId,
        ip: '10.0.0.1',
        ...answers,
      }),
    ).rejects.toBeInstanceOf(StudioError);

    expect(await prisma.market.count()).toBe(0);
  });

  it('refuses a market whose judgement questions were never answered', async () => {
    // The whole point of the review screen. A client that posts straight to
    // publish has skipped the three questions the checklist says software
    // cannot decide, and skipping them is not the same as passing them.
    await expect(
      studio.publish({ draft: compliantTemplate(), staffId, ip: '10.0.0.1' }),
    ).rejects.toThrow(/Rule 25|Rule 18|attest/);

    expect(await prisma.market.count()).toBe(0);
  });

  it('will not publish over a warning without a reason', async () => {
    await expect(
      studio.publish({
        draft: compliantTemplate({ balanceEstimates: [0.9, 0.1] }),
        staffId,
        ip: '10.0.0.1',
        ...answers,
      }),
    ).rejects.toThrow(/say why you are publishing anyway/i);
  });

  it('writes the whole report to the audit log, not a verdict', async () => {
    // An audit row saying "published, clean" cannot be checked against
    // anything later. One carrying the lines the reviewer saw can.
    const result = await studio.publish({
      draft: compliantTemplate(),
      staffId,
      ip: '10.0.0.1',
      ...answers,
      warningReason: 'the shelf is short an economy market this cycle',
    });

    const entry = await prisma.adminAudit.findFirstOrThrow({
      where: { targetRef: `market:${result.marketId}` },
    });
    const after = entry.afterJson as { report?: { findings?: unknown[] } };
    expect(after.report?.findings?.length).toBeGreaterThan(20);
  });
});

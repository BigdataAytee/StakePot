import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { EmailSender } from './email.sender';
import { NotificationsService } from './notifications.service';
import { PushSender } from './push.sender';
import { SmsSender } from './sms.sender';

/**
 * Where a verification code is allowed to go, and what happens when it cannot
 * go anywhere.
 *
 * Both of these came out of a real deployment: an environment with no mail
 * transport told its first user "we sent a code" and then never sent one — and
 * the reason the account could still have been verified is that the code was
 * also being served back through the signed-in session, which is the one place
 * it must never appear.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('verification delivery (integration)', () => {
  let prisma: PrismaService;
  let notifications: NotificationsService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function account(email: string): Promise<string> {
    const user = await prisma.user.create({
      data: { email, pwHash: 'x', tier: 0, contactVerified: false, role: 'user', status: 'active' },
    });
    return user.id;
  }

  it('never puts the code in the in-app inbox', async () => {
    const userId = await account('inbox@example.com');

    await notifications.notify({
      userId,
      type: 'contact_verification',
      body: 'Your StakeAm code is 123456. It expires shortly.',
    });

    // The inbox is authenticated by the very session the code exists to verify.
    // A code readable there is not a second factor: somebody who signed up with
    // an address they do not own could read their own code out of the app and
    // take Tier 1 — the bonus, market creation, leaderboards, prizes.
    const inbox = await notifications.inbox(userId);
    expect(inbox).toHaveLength(0);
    expect(JSON.stringify(inbox)).not.toContain('123456');

    // It is still on the record for the channels that were tried, because
    // "we told them" has to be checkable.
    const rows = await prisma.notification.findMany({ where: { userId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.channel !== 'in_app')).toBe(true);
  });

  // Skipped where a transport is configured — the e2e stack runs an SMTP sink,
  // and this case is specifically about the environment that has none.
  it.skipIf(process.env['SMTP_URL'] !== undefined && process.env['SMTP_URL'] !== '')(
    'reports that a code went nowhere rather than claiming it was sent',
    async () => {
      // The state a fresh deployment is in: no SMTP_URL, no TERMII_KEY.
      const userId = await account('nowhere@example.com');

      const outcome = await notifications.notify({
        userId,
        type: 'contact_verification',
        body: 'Your StakeAm code is 654321. It expires shortly.',
      });

      expect(outcome.delivered).toHaveLength(0);
      expect(outcome.failed.map((row) => row.failure)).toContain('SMTP_URL is not configured');
    },
  );

  it('still reports delivery for the channels that worked', async () => {
    // An in-app-only notification has a channel that cannot fail: it is a row.
    const userId = await account('inapp@example.com');

    const outcome = await notifications.notify({
      userId,
      type: 'trade_confirmed',
      body: 'Stake placed.',
    });

    expect(outcome.delivered).toEqual(['in_app']);
    expect(outcome.failed).toEqual([]);
  });
});

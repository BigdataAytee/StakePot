import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerService } from '../ledger/ledger.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { WalletService } from '../wallet/wallet.service';
import { AuthError, AuthService } from './auth.service';

/**
 * What signup says when it says no.
 *
 * §2.7's one account per contact is a unique index, so a second signup on the
 * same address is refused by the database. What the database says is
 * `P2002 · Unique constraint failed on the fields: (email)`, and that was going
 * straight to the person's screen — unreadable to them, and a free description
 * of the schema to everyone else.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('signup refusals (integration)', () => {
  let prisma: PrismaService;
  let auth: AuthService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();

    const config = new PlatformConfigService(prisma);
    await config.refresh();
    const ledger = new LedgerService(prisma);
    auth = new AuthService(
      prisma,
      new WalletService(prisma, ledger),
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
      new AnalyticsService(prisma),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const password = 'correct-horse-battery';

  it('refuses a second account on the same email in words a person can act on', async () => {
    await auth.signup({ email: 'taken@example.com', password, ageAttested: true });

    const second = auth.signup({ email: 'taken@example.com', password, ageAttested: true });

    await expect(second).rejects.toBeInstanceOf(AuthError);
    await expect(second).rejects.toThrow(/already uses that email/i);
    await expect(second).rejects.toThrow(/log in instead/i);
  });

  it('leaks no database internals in the refusal', async () => {
    await auth.signup({ email: 'leak@example.com', password, ageAttested: true });

    const message = await auth
      .signup({ email: 'leak@example.com', password, ageAttested: true })
      .then(
        () => '',
        (error: Error) => error.message,
      );

    // The words that were on the screen, and the shape of anything like them.
    expect(message).not.toMatch(/prisma/i);
    expect(message).not.toMatch(/unique constraint/i);
    expect(message).not.toMatch(/invocation/i);
    expect(message).not.toMatch(/P2002/);
    expect(message).not.toMatch(/\buser\.create\b/);
  });

  it('names the phone when the phone is what clashed', async () => {
    await auth.signup({ phone: '+2348000000001', password, ageAttested: true });

    await expect(
      auth.signup({ phone: '+2348000000001', password, ageAttested: true }),
    ).rejects.toThrow(/already uses that phone number/i);
  });

  it('is case-insensitive about it, because an email address is', async () => {
    await auth.signup({ email: 'Mixed.Case@Example.com', password, ageAttested: true });

    // Stored lowercased, so the second attempt collides rather than quietly
    // creating a second account for the same inbox.
    await expect(
      auth.signup({ email: 'mixed.case@example.com', password, ageAttested: true }),
    ).rejects.toThrow(/already uses that email/i);
  });

  it('does not pay a starter balance to an account it refused to create', async () => {
    await auth.signup({ email: 'once@example.com', password, ageAttested: true });
    await auth
      .signup({ email: 'once@example.com', password, ageAttested: true })
      .catch(() => undefined);

    expect(await prisma.user.count({ where: { email: 'once@example.com' } })).toBe(1);

    // One account, one starter balance. The refused attempt must not have paid
    // anything on its way to failing — the create and the credit are in one
    // transaction precisely so a half-made account cannot hold money. Counted
    // as money rather than as rows, because an issue is two legs.
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'once@example.com' } });
    const credited = await prisma.ledgerEntry.aggregate({
      where: { userId: user.id, type: 'signup_bonus' },
      _sum: { amount: true },
    });
    const starter = await new PlatformConfigService(prisma).get('starter_balance_spc');
    expect(new Decimal(credited._sum.amount?.toString() ?? '0').eq(starter)).toBe(true);
  });
});

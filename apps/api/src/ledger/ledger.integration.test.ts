import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { WalletService } from '../wallet/wallet.service';
import { resetDatabase } from '../testing/reset';
import { LedgerService } from './ledger.service';
import { UnbalancedTransactionError, escrow } from './posting';

/**
 * The money path against a real Postgres.
 *
 * Set TEST_DATABASE_URL to a database the migrations have been applied to. The
 * ledger's guarantees are database guarantees — append-only grants, triggers,
 * transactional atomicity — and none of them can be checked against a mock.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/**
 * A minimal market to hang escrow rows off. The ledger's marketId is a real
 * foreign key, so the money path cannot reference a market that never existed —
 * which is the point, and which is why this fixture exists rather than a
 * made-up id.
 */
async function createTestMarket(prisma: PrismaService): Promise<string> {
  const market = await prisma.market.create({
    data: {
      shelf: 'official',
      question: 'Test market for ledger integration',
      sourceName: 'Test source',
      sourceUrl: 'https://example.ng/source',
      criteriaJson: {},
      edgeCasesJson: {},
      eventDate: new Date(Date.now() + 86_400_000),
      voidDate: new Date(Date.now() + 172_800_000),
      liquidityParam: '50000',
      feeBps: 300,
      state: 'active',
    },
  });
  return market.id;
}

describe.skipIf(!TEST_DATABASE_URL)('ledger (integration)', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let wallet: WalletService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let marketId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();

    config = new PlatformConfigService(prisma);
    await config.refresh();

    ledger = new LedgerService(prisma);
    wallet = new WalletService(prisma, ledger);
    auth = new AuthService(
      prisma,
      wallet,
      new JwtService({ secret: 'test-secret-at-least-32-characters-long' }),
      config,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Wipe everything except the seeded house accounts and config. */
  beforeEach(async () => {
    await resetDatabase(prisma);
    marketId = await createTestMarket(prisma);
  });

  it('signup issues the starter balance, and the wallet matches the ledger', async () => {
    const starter = await config.get('starter_balance_spc');
    const { userId, tier } = await auth.signup({
      email: 'ada@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });

    expect(tier).toBe(0);

    const cached = await wallet.balanceOf(userId);
    const derived = await ledger.deriveBalance(userId, 'SPC');
    expect(cached.available.eq(starter)).toBe(true);
    expect(derived.available.eq(cached.available)).toBe(true);

    // Issuance shows up as a negative prize-pool balance: total in circulation.
    expect((await ledger.totalIssued('SPC')).eq(starter)).toBe(true);
  });

  it('refuses signup without an age attestation or a contact', async () => {
    await expect(
      auth.signup({ email: 'x@example.ng', password: 'correct-horse-battery', ageAttested: false }),
    ).rejects.toThrow(/18 or older/);
    await expect(
      auth.signup({ password: 'correct-horse-battery', ageAttested: true }),
    ).rejects.toThrow(/email or a phone/);
  });

  it('verifying a contact promotes to Tier 1 and pays the bonus exactly once', async () => {
    const starter = await config.get('starter_balance_spc');
    const bonus = await config.get('signup_bonus_spc');
    const { userId } = await auth.signup({
      phone: '+2348030000001',
      password: 'correct-horse-battery',
      ageAttested: true,
    });

    await auth.markContactVerified(userId);
    await auth.markContactVerified(userId); // idempotent — must not pay twice

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.tier).toBe(1);
    expect(user.contactVerified).toBe(true);

    const balance = await wallet.balanceOf(userId);
    expect(balance.available.eq(new Decimal(starter).plus(bonus))).toBe(true);
  });

  it('login rejects a wrong password and a system account', async () => {
    await auth.signup({
      email: 'bola@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    await expect(
      auth.login({ contact: 'bola@example.ng', password: 'wrong-password-here' }),
    ).rejects.toThrow(/invalid credentials/);

    const ok = await auth.login({ contact: 'bola@example.ng', password: 'correct-horse-battery' });
    expect(ok.accessToken.length).toBeGreaterThan(20);
  });

  it('escrow moves available → escrow and refuses to overdraw', async () => {
    const { userId } = await auth.signup({
      email: 'chidi@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    const starter = new Decimal(await config.get('starter_balance_spc'));

    await wallet.escrow({
      userId,
      marketId,
      amount: starter.div(2),
      type: 'stake',
      ref: 'test:stake:1',
    });

    const after = await wallet.balanceOf(userId);
    expect(after.available.eq(starter.div(2))).toBe(true);
    expect(after.escrowed.eq(starter.div(2))).toBe(true);

    await expect(
      wallet.escrow({
        userId,
        marketId,
        amount: starter,
        type: 'stake',
        ref: 'test:stake:2',
      }),
    ).rejects.toThrow(/insufficient funds/);

    // The rejected stake left nothing behind.
    const unchanged = await wallet.balanceOf(userId);
    expect(unchanged.available.eq(starter.div(2))).toBe(true);
  });

  it('an unbalanced transaction is refused before it reaches the database', async () => {
    const { userId } = await auth.signup({
      email: 'dami@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    const before = await prisma.ledgerEntry.count();

    await expect(
      prisma.$transaction((tx) =>
        ledger.post(
          tx,
          [
            {
              userId,
              type: 'payout',
              fundClass: 'user_escrow',
              amount: new Decimal(-100),
              currency: 'SPC',
            },
            {
              userId,
              type: 'payout',
              fundClass: 'user_available',
              amount: new Decimal(150),
              currency: 'SPC',
            },
          ],
          'test:unbalanced',
        ),
      ),
    ).rejects.toThrow(UnbalancedTransactionError);

    expect(await prisma.ledgerEntry.count()).toBe(before);
  });

  it('the database rejects an UPDATE or DELETE on a ledger row', async () => {
    const { userId } = await auth.signup({
      email: 'emeka@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    const row = await prisma.ledgerEntry.findFirstOrThrow({ where: { userId } });

    await expect(
      prisma.$executeRaw`UPDATE ledger SET amount = 1 WHERE id = ${row.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM ledger WHERE id = ${row.id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('a rolled-back transaction leaves neither ledger rows nor wallet drift', async () => {
    const { userId } = await auth.signup({
      email: 'funke@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });
    const before = await wallet.balanceOf(userId);
    const rows = await prisma.ledgerEntry.count();

    await expect(
      prisma.$transaction(async (tx) => {
        await ledger.post(
          tx,
          escrow({
            userId,
            marketId,
            amount: new Decimal(100),
            type: 'stake',
            currency: 'SPC',
          }),
          'test:rollback',
        );
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await prisma.ledgerEntry.count()).toBe(rows);
    const after = await wallet.balanceOf(userId);
    expect(after.available.eq(before.available)).toBe(true);
    expect(after.escrowed.isZero()).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('reconciliation (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let auth: AuthService;
  let reconciliation: ReconciliationService;

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
    );
    reconciliation = new ReconciliationService(prisma, config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.platformConfig.updateMany({
      where: { key: 'withdrawals_frozen' },
      data: { valueJson: false },
    });
    await config.refresh();
  });

  it('passes clean when the wallets agree with the ledger', async () => {
    await auth.signup({
      email: 'clean@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });

    const outcome = await reconciliation.run('SPC', new Date());
    expect(outcome.status).toBe('clean');
    expect(outcome.mismatches).toHaveLength(0);
    expect(outcome.diff.isZero()).toBe(true);
    expect(await config.get('withdrawals_frozen')).toBe(false);
  });

  it('catches a wallet that drifted from the ledger, and freezes withdrawals', async () => {
    const { userId } = await auth.signup({
      email: 'drift@example.ng',
      password: 'correct-horse-battery',
      ageAttested: true,
    });

    // Exactly the condition §2.10 exists for: a balance that moved without a
    // ledger row behind it. Nothing in the application can do this — hence the
    // raw write.
    await prisma.wallet.update({
      where: { userId_currency: { userId, currency: 'SPC' } },
      data: { available: { increment: new Prisma.Decimal('1') } },
    });

    const outcome = await reconciliation.run('SPC', new Date());
    expect(outcome.status).toBe('exception');
    expect(outcome.mismatches).toHaveLength(1);
    expect(outcome.mismatches[0]?.userId).toBe(userId);
    expect(outcome.diff.eq(new Decimal(-1))).toBe(true);

    // "...freezes withdrawals until a human clears it."
    await config.refresh();
    expect(await config.get('withdrawals_frozen')).toBe(true);

    // The freeze is recorded in the immutable config history with a reason.
    const history = await prisma.configVersion.findFirst({
      where: { key: 'withdrawals_frozen' },
      orderBy: { proposedAt: 'desc' },
    });
    expect(history?.reason).toMatch(/reconciliation exception/);

    const run = await prisma.reconciliationRun.findUniqueOrThrow({ where: { id: outcome.runId } });
    expect(run.status).toBe('exception');
  });
});

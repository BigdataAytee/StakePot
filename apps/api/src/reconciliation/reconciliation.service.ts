import { Decimal } from '@stakeam/engine';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Currency } from '@prisma/client';

import { logger } from '../logger';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

export interface Mismatch {
  readonly userId: string;
  readonly field: 'available' | 'escrowed';
  readonly ledger: Decimal;
  readonly wallet: Decimal;
}

export interface ReconciliationOutcome {
  readonly runId: string;
  readonly ledgerTotal: Decimal;
  readonly walletTotal: Decimal;
  readonly diff: Decimal;
  readonly status: 'clean' | 'exception';
  readonly mismatches: readonly Mismatch[];
}

/**
 * The daily reconciliation job (§2.10).
 *
 * "Every day, recompute all balances from the append-only ledger and compare to
 * stored wallet totals... Any mismatch — even ₦1 — pages on-call and freezes
 * withdrawals until a human clears it."
 *
 * The tolerance is a config key and is seeded at zero deliberately. It exists
 * so an operator can widen it under a four-eyes proposal with a written reason,
 * not so the code can quietly forgive a discrepancy.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
  ) {}

  async run(currency: Currency = 'SPC', runDate: Date): Promise<ReconciliationOutcome> {
    const tolerance = new Decimal(await this.config.get('reconciliation_tolerance_spc'));

    // Truth: the append-only ledger, grouped per account and fund class.
    const ledgerRows = await this.prisma.ledgerEntry.groupBy({
      by: ['userId', 'fundClass'],
      where: { currency },
      _sum: { amount: true },
    });

    const derived = new Map<string, { available: Decimal; escrowed: Decimal }>();
    for (const row of ledgerRows) {
      const entry = derived.get(row.userId) ?? {
        available: new Decimal(0),
        escrowed: new Decimal(0),
      };
      const amount = new Decimal(row._sum.amount?.toString() ?? '0');
      if (row.fundClass === 'user_escrow') {
        entry.escrowed = entry.escrowed.plus(amount);
      } else {
        // user_available, platform_fees and prize_pool all settle into the
        // account's spendable balance; the fund class keeps them distinguishable.
        entry.available = entry.available.plus(amount);
      }
      derived.set(row.userId, entry);
    }

    // The cache being checked.
    const wallets = await this.prisma.wallet.findMany({ where: { currency } });

    const mismatches: Mismatch[] = [];
    let ledgerTotal = new Decimal(0);
    let walletTotal = new Decimal(0);

    const accounts = new Set<string>([...derived.keys(), ...wallets.map((w) => w.userId)]);
    for (const userId of accounts) {
      const fromLedger = derived.get(userId) ?? {
        available: new Decimal(0),
        escrowed: new Decimal(0),
      };
      const row = wallets.find((w) => w.userId === userId);
      const fromWallet = {
        available: new Decimal(row?.available.toString() ?? '0'),
        escrowed: new Decimal(row?.escrowed.toString() ?? '0'),
      };

      ledgerTotal = ledgerTotal.plus(fromLedger.available).plus(fromLedger.escrowed);
      walletTotal = walletTotal.plus(fromWallet.available).plus(fromWallet.escrowed);

      for (const field of ['available', 'escrowed'] as const) {
        const gap = fromLedger[field].minus(fromWallet[field]).abs();
        if (gap.gt(tolerance)) {
          mismatches.push({
            userId,
            field,
            ledger: fromLedger[field],
            wallet: fromWallet[field],
          });
        }
      }
    }

    const diff = ledgerTotal.minus(walletTotal);
    const status = mismatches.length === 0 && diff.abs().lte(tolerance) ? 'clean' : 'exception';

    const run = await this.prisma.reconciliationRun.create({
      data: {
        runDate,
        ledgerTotal: new Prisma.Decimal(ledgerTotal.toString()),
        walletTotal: new Prisma.Decimal(walletTotal.toString()),
        status,
        diff: new Prisma.Decimal(diff.toString()),
      },
    });

    if (status === 'exception') {
      await this.freezeWithdrawals();
      logger.error(
        { runId: run.id, diff: diff.toString(), mismatches: mismatches.length },
        'reconciliation exception — withdrawals frozen, page on-call',
      );
    } else {
      logger.info({ runId: run.id, ledgerTotal: ledgerTotal.toString() }, 'reconciliation clean');
    }

    return { runId: run.id, ledgerTotal, walletTotal, diff, status, mismatches };
  }

  /**
   * Freeze withdrawals immediately, bypassing the four-eyes delay.
   *
   * §6.4b's approval flow governs *deliberate* economics changes. A freeze is
   * the safety interlock firing, and it must not wait 24 hours for a second
   * approver — unfreezing is what needs a human, and that goes through the
   * normal proposal path.
   */
  private async freezeWithdrawals(): Promise<void> {
    const current = await this.prisma.platformConfig.findFirst({
      where: { key: 'withdrawals_frozen', state: 'active' },
      orderBy: { version: 'desc' },
    });

    if (current?.valueJson === true) return;

    await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.platformConfig.update({
          where: { key_version: { key: current.key, version: current.version } },
          data: { state: 'superseded' },
        });
      }
      await tx.platformConfig.create({
        data: {
          key: 'withdrawals_frozen',
          valueJson: true,
          effectiveAt: new Date(),
          version: (current?.version ?? 0) + 1,
          state: 'active',
        },
      });
      await tx.configVersion.create({
        data: {
          key: 'withdrawals_frozen',
          oldValue: current?.valueJson ?? Prisma.JsonNull,
          newValue: true,
          reason: 'automatic: reconciliation exception — withdrawals frozen pending human review',
          proposedBy: 'system:reconciliation',
          approvedBy: 'system:reconciliation',
          activatedAt: new Date(),
        },
      });
    });
  }
}

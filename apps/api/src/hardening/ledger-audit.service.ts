import { Injectable } from '@nestjs/common';
import { Decimal } from '@stakeam/engine';

import { SYSTEM_PLATFORM_ACCOUNT } from '../ledger/posting';
import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { StatusService } from '../status/status.service';

/**
 * §2.7's "nightly ledger audit job (invariant checks); alert on any escrow
 * mismatch."
 *
 * The reconciliation job (§2.10) answers "does what we hold match what we owe".
 * This answers a different and narrower question: **is the ledger internally
 * consistent** — does it sum to zero, does every open market hold exactly the
 * escrow its pot claims, does any account hold a negative balance it should not.
 *
 * The distinction matters because these fail differently. Reconciliation drifts
 * when the outside world disagrees with us. These invariants cannot drift at
 * all: they are arithmetic on rows we wrote ourselves, so any violation is a
 * bug in the platform and is red by definition (§6.10's alarm discipline).
 */

export interface AuditFinding {
  readonly check: string;
  readonly detail: string;
  readonly severity: 'red' | 'amber';
}

export interface AuditResult {
  readonly ranAt: Date;
  readonly checks: number;
  readonly findings: readonly AuditFinding[];
  readonly clean: boolean;
}

@Injectable()
export class LedgerAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
  ) {}

  /**
   * Every invariant, run in one pass.
   *
   * Deliberately continues after a finding rather than stopping at the first:
   * an operator woken at 4am needs the whole picture, and a second violation
   * often explains the first.
   */
  async run(now = new Date()): Promise<AuditResult> {
    const findings: AuditFinding[] = [];
    const checks = [
      () => this.everyPostingSumsToZero(),
      () => this.escrowMatchesOpenMarkets(),
      () => this.noNegativeUserBalances(),
      () => this.stakedMatchesPot(),
    ];

    for (const check of checks) {
      try {
        findings.push(...(await check()));
      } catch (error) {
        findings.push({
          check: 'audit',
          severity: 'red',
          detail: `a check could not complete: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    const result: AuditResult = {
      ranAt: now,
      checks: checks.length,
      findings,
      clean: findings.length === 0,
    };

    if (!result.clean) {
      // §6.10: red means an on-call page and a banner across every admin screen.
      // An invariant violation is money that does not add up, so it is never
      // logged quietly and left for somebody to notice.
      logger.error({ findings }, 'LEDGER AUDIT FAILED — money invariants do not hold');
      await this.status
        .open({
          title: 'Ledger audit found an inconsistency',
          // `outage` rather than `degraded`: nothing is slow, but the money
          // does not add up, and §6.10 has exactly one severity that pages.
          severity: 'outage',
          body: findings.map((finding) => `${finding.check}: ${finding.detail}`).join('\n'),
          postedBy: SYSTEM_PLATFORM_ACCOUNT,
        })
        .catch(() => undefined);
    } else {
      logger.info({ checks: checks.length }, 'ledger audit clean');
    }

    return result;
  }

  /**
   * The double-entry rule, over the whole table.
   *
   * Every transaction is asserted balanced before it is written, so this is
   * belt and braces — but it is the check that catches a write that bypassed
   * `LedgerService.post`, which is exactly the bug nothing else would find.
   */
  private async everyPostingSumsToZero(): Promise<AuditFinding[]> {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['currency'],
      _sum: { amount: true },
    });

    return rows.flatMap((row) => {
      const total = new Decimal((row._sum.amount ?? 0).toString());
      if (total.isZero()) return [];
      return [
        {
          check: 'double_entry',
          severity: 'red' as const,
          detail: `${row.currency} ledger sums to ${total.toString()} instead of zero — money was created by a write`,
        },
      ];
    });
  }

  /**
   * Escrow held per market matches what its pot says (§2.7's escrow mismatch).
   *
   * Bonds live in escrow without being part of the pot, so they are added to
   * the expectation before the comparison — the same asymmetry that once broke
   * resolution for every community market with a bond. The order book is the
   * third such tenant: money locked behind a resting order, and the collateral
   * behind a matched position, are both in `user_escrow` and neither is in any
   * pot. Left out, this check would go red on every market the book is on —
   * which is the worst possible failure for an alarm, because the fix would be
   * to stop believing it.
   */
  private async escrowMatchesOpenMarkets(): Promise<AuditFinding[]> {
    const markets = await this.prisma.market.findMany({
      where: { state: { in: ['seeding', 'funding', 'active', 'frozen', 'dispute_window'] } },
      select: { id: true, potTotal: true },
      take: 5_000,
    });
    if (markets.length === 0) return [];

    const ids = markets.map((market) => market.id);
    const [escrow, bonds, book] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({
        by: ['marketId'],
        where: { marketId: { in: ids }, fundClass: 'user_escrow' },
        _sum: { amount: true },
      }),
      this.prisma.bond.findMany({
        where: { marketId: { in: ids }, state: 'held' },
        select: { marketId: true, amount: true },
      }),
      // The order book's escrow: locked behind open orders, plus the collateral
      // behind matched positions. Held in the same fund class as pot stake and
      // no part of any pot, so it is the third asymmetry this check has to know
      // about — the same shape as the bond, for the same reason.
      this.prisma.ledgerEntry.groupBy({
        by: ['marketId'],
        where: {
          marketId: { in: ids },
          fundClass: 'user_escrow',
          type: { in: ['order_lock', 'order_release'] },
        },
        _sum: { amount: true },
      }),
    ]);

    const escrowed = new Map(
      escrow.map((row) => [row.marketId ?? '', new Decimal((row._sum.amount ?? 0).toString())]),
    );
    const bondFor = new Map(
      bonds.map((bond) => [bond.marketId, new Decimal(bond.amount.toString())]),
    );
    const bookFor = new Map(
      book.map((row) => [row.marketId ?? '', new Decimal((row._sum.amount ?? 0).toString())]),
    );

    const findings: AuditFinding[] = [];
    for (const market of markets) {
      const held = escrowed.get(market.id) ?? new Decimal(0);
      const bond = bondFor.get(market.id) ?? new Decimal(0);
      const onTheBook = bookFor.get(market.id) ?? new Decimal(0);
      const pot = new Decimal(market.potTotal.toString());

      const expected = pot.plus(bond).plus(onTheBook);
      if (!held.equals(expected)) {
        findings.push({
          check: 'escrow_matches_pot',
          severity: 'red',
          detail:
            `market ${market.id} holds ${held.toString()} in escrow but its pot ` +
            `(${pot.toString()}) plus bond (${bond.toString()}) plus order book ` +
            `(${onTheBook.toString()}) is ${expected.toString()}`,
        });
      }
    }
    return findings;
  }

  /**
   * No user's available or escrowed balance is negative.
   *
   * The wallet refuses to spend what is not there, so a negative balance means
   * something wrote around it. Platform accounts are excluded: `prize_pool`
   * runs negative by design — its balance is the SPC in circulation.
   */
  private async noNegativeUserBalances(): Promise<AuditFinding[]> {
    const balances = await this.prisma.ledgerEntry.groupBy({
      by: ['userId', 'fundClass'],
      where: { fundClass: { in: ['user_available', 'user_escrow'] } },
      _sum: { amount: true },
    });

    return balances.flatMap((row) => {
      if (row.userId.startsWith('sys_')) return [];
      const total = new Decimal((row._sum.amount ?? 0).toString());
      if (!total.isNegative()) return [];
      return [
        {
          check: 'no_negative_balances',
          severity: 'red' as const,
          detail: `${row.userId} holds ${total.toString()} in ${row.fundClass}`,
        },
      ];
    });
  }

  /**
   * §2.3's `Σ staked === pot`, on the cached columns.
   *
   * These are a cache of the trades table, which is what makes them worth
   * checking: the engine asserts the identity on every operation, so a
   * divergence here is the cache having drifted from the arithmetic rather than
   * the arithmetic being wrong. Amber, not red — no money is missing, but the
   * fee basis at resolution is computed from these columns.
   */
  private async stakedMatchesPot(): Promise<AuditFinding[]> {
    const markets = await this.prisma.market.findMany({
      where: { state: { in: ['seeding', 'funding', 'active', 'frozen', 'dispute_window'] } },
      select: { id: true, potTotal: true, outcomes: { select: { stakedTotal: true } } },
      take: 5_000,
    });

    return markets.flatMap((market) => {
      const staked = market.outcomes.reduce(
        (total, outcome) => total.plus(new Decimal(outcome.stakedTotal.toString())),
        new Decimal(0),
      );
      const pot = new Decimal(market.potTotal.toString());
      if (staked.equals(pot)) return [];
      return [
        {
          check: 'staked_matches_pot',
          severity: 'amber' as const,
          detail: `market ${market.id} has Σstaked ${staked.toString()} against a pot of ${pot.toString()}`,
        },
      ];
    });
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AbuseFlagKind } from '@prisma/client';

import { AdminAuditService } from '../audit/admin-audit.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { detect, type AbuseFlag, type AbuseRules } from './abuse';

export class AbuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbuseError';
  }
}

/**
 * §6.5's abuse queue.
 *
 * The sweep detects and files; a person in Trust & Safety decides. Freezing an
 * account is the heaviest thing the platform does to somebody short of a ban —
 * it stops them opening or adding to a position while their money stays exactly
 * where it is — so it is a human action with a name attached and an audit row
 * behind it, never something a threshold does on its own at 3am.
 */
@Injectable()
export class AbuseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async rules(): Promise<AbuseRules> {
    const [washWindowMinutes, washCycles, floodTradesPerHour, clusterAccounts] = await Promise.all([
      this.config.get('abuse_wash_window_minutes'),
      this.config.get('abuse_wash_cycles'),
      this.config.get('abuse_flood_trades_per_hour'),
      this.config.get('abuse_cluster_accounts'),
    ]);
    return { washWindowMinutes, washCycles, floodTradesPerHour, clusterAccounts };
  }

  /**
   * Run the rules over a recent window and file what they find.
   *
   * Keyed by `dedupeKey`, so an hourly sweep updates the flag it already raised
   * rather than filing a new one every hour — a queue that grows by twenty-four
   * rows a day per offender is a queue nobody reads.
   *
   * A flag a reviewer has already **cleared** is not raised again from the same
   * evidence: overruling somebody's decision automatically is how a queue loses
   * the trust of the people who work it.
   */
  async sweep(params: { since?: Date; now?: Date } = {}): Promise<{
    detected: number;
    filed: number;
    updated: number;
  }> {
    const now = params.now ?? new Date();
    const since = params.since ?? new Date(now.getTime() - 7 * 86_400_000);
    const rules = await this.rules();

    const [trades, devices] = await Promise.all([
      this.prisma.trade.findMany({
        where: { createdAt: { gte: since } },
        select: { userId: true, marketId: true, side: true, cost: true, createdAt: true },
        take: 100_000,
      }),
      this.prisma.deviceFingerprint.findMany({
        where: { lastSeenAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } },
        select: {
          userId: true,
          fingerprint: true,
          user: { select: { tier: true, createdAt: true } },
        },
        take: 50_000,
      }),
    ]);

    const found = detect(
      {
        trades: trades.map((row) => ({
          userId: row.userId,
          marketId: row.marketId,
          side: row.side === 'seed' ? 'seed' : row.side === 'sell' ? 'sell' : 'buy',
          cost: Number(row.cost),
          at: row.createdAt,
        })),
        accounts: devices.map((row) => ({
          userId: row.userId,
          fingerprint: row.fingerprint,
          tier: row.user.tier,
          createdAt: row.user.createdAt,
        })),
      },
      rules,
    );

    let filed = 0;
    let updated = 0;
    for (const flag of found) {
      const key = dedupeKeyFor(flag);
      const existing = await this.prisma.abuseFlag.findUnique({ where: { dedupeKey: key } });

      if (existing !== null && existing.state === 'cleared') continue;

      if (existing !== null) {
        await this.prisma.abuseFlag.update({
          where: { dedupeKey: key },
          data: {
            severity: new Prisma.Decimal(flag.severity),
            summary: flag.summary,
            evidenceJson: flag.evidence as Prisma.InputJsonValue,
          },
        });
        updated += 1;
        continue;
      }

      await this.prisma.abuseFlag.create({
        data: {
          userId: flag.userId,
          kind: flag.kind as AbuseFlagKind,
          severity: new Prisma.Decimal(flag.severity),
          summary: flag.summary,
          evidenceJson: flag.evidence as Prisma.InputJsonValue,
          dedupeKey: key,
        },
      });
      filed += 1;
    }

    return { detected: found.length, filed, updated };
  }

  /** The queue §6.5 reads: open flags, most severe first. */
  async queue(params: { state?: 'open' | 'actioned' | 'cleared'; take?: number } = {}) {
    const rows = await this.prisma.abuseFlag.findMany({
      where: { state: params.state ?? 'open' },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      take: params.take ?? 50,
      include: {
        user: {
          select: { id: true, handle: true, displayName: true, tier: true, status: true },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      severity: Number(row.severity),
      summary: row.summary,
      evidence: row.evidenceJson as Record<string, string | number>,
      note: row.note,
      createdAt: row.createdAt,
      account: {
        id: row.user.id,
        handle: row.user.handle,
        displayName: row.user.displayName,
        tier: row.user.tier,
        status: row.user.status,
      },
    }));
  }

  /**
   * A reviewer's decision.
   *
   * `freeze` stops the account opening or adding to positions and leaves every
   * naira exactly where it is — balance changes go through §2.10's approvals
   * workflow and nowhere else, so there is deliberately no path here that
   * touches money. `clear` records that a person looked and disagreed with the
   * rule, which is why the sweep will not raise that evidence again.
   */
  async decide(params: {
    flagId: string;
    staffId: string;
    decision: 'freeze' | 'clear' | 'unfreeze';
    note?: string;
    ip: string;
  }): Promise<{ state: string; accountStatus: string }> {
    const flag = await this.prisma.abuseFlag.findUnique({ where: { id: params.flagId } });
    if (flag === null) throw new AbuseError('no such flag');

    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id: flag.userId },
      select: { status: true },
    });

    const status =
      params.decision === 'freeze'
        ? 'frozen'
        : params.decision === 'unfreeze'
          ? 'active'
          : before.status;

    await this.prisma.$transaction(async (tx) => {
      if (status !== before.status) {
        await tx.user.update({ where: { id: flag.userId }, data: { status } });
      }
      await tx.abuseFlag.update({
        where: { id: params.flagId },
        data: {
          state: params.decision === 'clear' ? 'cleared' : 'actioned',
          reviewedBy: params.staffId,
          reviewedAt: new Date(),
          ...(params.note === undefined ? {} : { note: params.note }),
        },
      });
    });

    await this.audit.record({
      staffId: params.staffId,
      action: `abuse.${params.decision}`,
      targetRef: `user:${flag.userId}`,
      before: { status: before.status, flagState: flag.state },
      after: { status, flagState: params.decision === 'clear' ? 'cleared' : 'actioned' },
      ip: params.ip,
    });

    return { state: params.decision === 'clear' ? 'cleared' : 'actioned', accountStatus: status };
  }

  /**
   * Record the device an account is using (§2.1, §2.7).
   *
   * Upserted rather than appended: what matters is which accounts share a
   * device, not how many times each one has opened the app.
   */
  async recordDevice(params: { userId: string; fingerprint: string }): Promise<void> {
    const fingerprint = params.fingerprint.trim().slice(0, 128);
    if (fingerprint.length < 8) return;

    await this.prisma.deviceFingerprint.upsert({
      where: { userId_fingerprint: { userId: params.userId, fingerprint } },
      update: { lastSeenAt: new Date() },
      create: { userId: params.userId, fingerprint },
    });
  }
}

/**
 * What counts as "the same finding".
 *
 * Includes the market for a wash flag — the same account washing a different
 * market is a different finding — and the fingerprint for a cluster, so a farm
 * that grows by one account updates its flag rather than filing a fresh one.
 */
function dedupeKeyFor(flag: AbuseFlag): string {
  const scope =
    flag.kind === 'wash_trading'
      ? String(flag.evidence['marketId'] ?? '')
      : flag.kind === 'multi_account'
        ? String(flag.evidence['fingerprint'] ?? '')
        : '';
  return `${flag.kind}:${flag.userId}:${scope}`;
}

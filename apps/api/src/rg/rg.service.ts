import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RgSettings } from '@prisma/client';
import { Decimal } from '@stakeam/engine';
import { subDays } from 'date-fns';

import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

export class RgBlockedError extends Error {
  constructor(
    message: string,
    readonly reason: 'self_excluded' | 'cool_off' | 'stake_limit' | 'loss_limit',
  ) {
    super(message);
    this.name = 'RgBlockedError';
  }
}

export interface RgView {
  readonly depositLimit: string | null;
  readonly stakeLimit: string | null;
  readonly lossLimit: string | null;
  readonly cooloffUntil: string | null;
  readonly selfExcluded: boolean;
  readonly selfExcludedAt: string | null;
  /** Staked today, against whichever limit binds. */
  readonly stakedToday: string;
  readonly lostToday: string;
  readonly effectiveStakeLimit: string;
  readonly effectiveLossLimit: string;
  readonly helpline: string;
  readonly realityCheckMinutes: number;
}

/**
 * Responsible gambling (§2.12).
 *
 * "Per-user deposit/stake/loss limits (user-set and platform caps), cool-off
 * periods, permanent self-exclusion (blocks login to trading, allows
 * withdrawal), session reality-check prompts after [60] min continuous use,
 * visible helpline info. In points mode the limits exist but sit dormant/high —
 * the flows are tested long before the licence requires them, and
 * self-exclusion works even for points."
 *
 * Two rules shape everything here. A limit can always be made **stricter**
 * immediately and **looser** only after the cool-off has run — otherwise a
 * limit is a speed bump you remove in the moment you most need it. And
 * self-exclusion blocks staking but never withdrawal: money already someone's
 * stays theirs to take out, which is the difference between protecting a person
 * and holding their balance hostage.
 */
@Injectable()
export class RgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
  ) {}

  /**
   * The gate every stake passes through.
   *
   * Called inside the trade transaction, before any money moves. It reads the
   * day's activity from the ledger rather than a counter, so a limit cannot be
   * defeated by anything that forgot to increment.
   */
  async assertMayStake(userId: string, amount: Decimal, now = new Date()): Promise<void> {
    const settings = await this.prisma.rgSettings.findUnique({ where: { userId } });

    if (settings?.selfExcluded === true) {
      throw new RgBlockedError(
        'you self-excluded from staking. Your balance is still yours to withdraw.',
        'self_excluded',
      );
    }
    if (settings?.cooloffUntil != null && settings.cooloffUntil.getTime() > now.getTime()) {
      throw new RgBlockedError(
        `you are on a cool-off until ${settings.cooloffUntil.toISOString()}`,
        'cool_off',
      );
    }

    const stakeLimit = await this.effectiveStakeLimit(settings);
    const stakedToday = await this.stakedToday(userId, now);
    if (stakedToday.plus(amount).gt(stakeLimit)) {
      throw new RgBlockedError(
        `this would take today's stakes to ${stakedToday.plus(amount).toString()}, ` +
          `past your limit of ${stakeLimit.toString()}`,
        'stake_limit',
      );
    }

    const lossLimit = await this.effectiveLossLimit(settings);
    const lostToday = await this.lostToday(userId, now);
    if (lostToday.gte(lossLimit)) {
      throw new RgBlockedError(
        `you have reached today's loss limit of ${lossLimit.toString()}`,
        'loss_limit',
      );
    }
  }

  /**
   * Set the user's own limits.
   *
   * A tighter limit lands now. A looser one is refused while a cool-off is
   * running, and otherwise takes effect immediately — the licensed phase adds a
   * waiting period here, which is a config change rather than a rewrite.
   */
  async setLimits(params: {
    userId: string;
    depositLimit?: string | null;
    stakeLimit?: string | null;
    lossLimit?: string | null;
    now?: Date;
  }): Promise<RgSettings> {
    const now = params.now ?? new Date();
    const existing = await this.prisma.rgSettings.findUnique({ where: { userId: params.userId } });

    if (existing?.selfExcluded === true) {
      throw new RgBlockedError('a self-exclusion cannot be edited', 'self_excluded');
    }
    if (existing?.cooloffUntil != null && existing.cooloffUntil.getTime() > now.getTime()) {
      for (const field of ['depositLimit', 'stakeLimit', 'lossLimit'] as const) {
        const next = params[field];
        if (next === undefined) continue;
        const before = existing[field];
        const loosening =
          next === null || before === null || new Decimal(next).gt(new Decimal(before.toString()));
        if (loosening) {
          throw new RgBlockedError(
            'limits can only be tightened during a cool-off — that is what a cool-off is',
            'cool_off',
          );
        }
      }
    }

    const data = {
      ...(params.depositLimit === undefined
        ? {}
        : { depositLimit: this.toDecimal(params.depositLimit) }),
      ...(params.stakeLimit === undefined ? {} : { stakeLimit: this.toDecimal(params.stakeLimit) }),
      ...(params.lossLimit === undefined ? {} : { lossLimit: this.toDecimal(params.lossLimit) }),
    };

    return this.prisma.rgSettings.upsert({
      where: { userId: params.userId },
      create: { userId: params.userId, ...data },
      update: data,
    });
  }

  /** Take a break. Blocks staking until it runs out; nothing else changes. */
  async coolOff(params: { userId: string; days: number; now?: Date }): Promise<RgSettings> {
    const now = params.now ?? new Date();
    const maxDays = await this.config.get('rg_cooloff_max_days');
    if (!Number.isInteger(params.days) || params.days < 1 || params.days > maxDays) {
      throw new RgBlockedError(`a cool-off runs from 1 to ${maxDays} days`, 'cool_off');
    }

    const until = new Date(now.getTime() + params.days * 86_400_000);
    const existing = await this.prisma.rgSettings.findUnique({ where: { userId: params.userId } });
    // A cool-off can be extended but never shortened. Someone reaching for this
    // control a second time is not asking for less of it.
    const cooloffUntil =
      existing?.cooloffUntil != null && existing.cooloffUntil.getTime() > until.getTime()
        ? existing.cooloffUntil
        : until;

    return this.prisma.rgSettings.upsert({
      where: { userId: params.userId },
      create: { userId: params.userId, cooloffUntil },
      update: { cooloffUntil },
    });
  }

  /**
   * Permanent self-exclusion (§2.12).
   *
   * There is deliberately no method to undo this. Reinstatement is a support
   * request that a human handles, because an undo button on this control is the
   * one thing that would make it worthless.
   */
  async selfExclude(params: { userId: string; now?: Date }): Promise<RgSettings> {
    const now = params.now ?? new Date();
    return this.prisma.rgSettings.upsert({
      where: { userId: params.userId },
      create: { userId: params.userId, selfExcluded: true, selfExcludedAt: now },
      update: { selfExcluded: true, selfExcludedAt: now },
    });
  }

  /**
   * The session reality check (§2.12): "prompts after [60] min continuous use".
   *
   * Returns whether the prompt is due, and stamps it when it is — the client
   * shows it and the clock restarts. Session start is stamped on the first call
   * after a gap, so "continuous use" means what it says.
   */
  async realityCheck(
    userId: string,
    now = new Date(),
  ): Promise<{ due: boolean; minutes: number; helpline: string }> {
    const minutes = await this.config.get('reality_check_minutes');
    const helpline = await this.config.get('rg_helpline');
    const window = minutes * 60_000;

    const settings = await this.prisma.rgSettings.findUnique({ where: { userId } });
    const since = settings?.lastRealityCheckAt ?? settings?.sessionStartedAt ?? null;

    if (since === null) {
      await this.prisma.rgSettings.upsert({
        where: { userId },
        create: { userId, sessionStartedAt: now },
        update: { sessionStartedAt: now },
      });
      return { due: false, minutes, helpline };
    }

    if (now.getTime() - since.getTime() < window) {
      return { due: false, minutes, helpline };
    }

    await this.prisma.rgSettings.update({
      where: { userId },
      data: { lastRealityCheckAt: now, sessionStartedAt: now },
    });
    return { due: true, minutes, helpline };
  }

  /** Everything the account's limits screen shows, in one read. */
  async view(userId: string, now = new Date()): Promise<RgView> {
    const settings = await this.prisma.rgSettings.findUnique({ where: { userId } });

    return {
      depositLimit: settings?.depositLimit?.toString() ?? null,
      stakeLimit: settings?.stakeLimit?.toString() ?? null,
      lossLimit: settings?.lossLimit?.toString() ?? null,
      cooloffUntil: settings?.cooloffUntil?.toISOString() ?? null,
      selfExcluded: settings?.selfExcluded ?? false,
      selfExcludedAt: settings?.selfExcludedAt?.toISOString() ?? null,
      stakedToday: (await this.stakedToday(userId, now)).toString(),
      lostToday: (await this.lostToday(userId, now)).toString(),
      effectiveStakeLimit: (await this.effectiveStakeLimit(settings)).toString(),
      effectiveLossLimit: (await this.effectiveLossLimit(settings)).toString(),
      helpline: await this.config.get('rg_helpline'),
      realityCheckMinutes: await this.config.get('reality_check_minutes'),
    };
  }

  /** Money staked in the last 24 hours, read from the trade record. */
  private async stakedToday(userId: string, now: Date): Promise<Decimal> {
    const result = await this.prisma.trade.aggregate({
      where: { userId, side: 'buy', createdAt: { gte: subDays(now, 1) } },
      _sum: { cost: true },
    });
    return new Decimal(result._sum.cost?.toString() ?? '0');
  }

  /**
   * Net loss in the last 24 hours: staked, less what came back.
   *
   * Read from the ledger rather than from positions, because what matters to a
   * loss limit is money that left the account and did not return — payouts,
   * refunds and early exits all count against it.
   */
  private async lostToday(userId: string, now: Date): Promise<Decimal> {
    const since = subDays(now, 1);
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['type'],
      where: {
        userId,
        fundClass: 'user_available',
        createdAt: { gte: since },
        type: { in: ['trade_buy', 'stake', 'seed', 'payout', 'refund', 'trade_sell'] },
      },
      _sum: { amount: true },
    });

    // These postings are signed: money leaving `user_available` is negative, so
    // the net of the day's play is exactly their sum, and a loss is its negation.
    const net = rows.reduce(
      (acc, row) => acc.plus(new Decimal(row._sum.amount?.toString() ?? '0')),
      new Decimal(0),
    );
    return Decimal.max(net.negated(), new Decimal(0));
  }

  private async effectiveStakeLimit(settings: RgSettings | null): Promise<Decimal> {
    const platform = new Decimal(await this.config.get('rg_platform_stake_limit_spc'));
    const own = settings?.stakeLimit == null ? null : new Decimal(settings.stakeLimit.toString());
    // The stricter of the two always wins. A platform cap is a ceiling, not a
    // permission slip.
    return own === null ? platform : Decimal.min(own, platform);
  }

  private async effectiveLossLimit(settings: RgSettings | null): Promise<Decimal> {
    const platform = new Decimal(await this.config.get('rg_platform_loss_limit_spc'));
    const own = settings?.lossLimit == null ? null : new Decimal(settings.lossLimit.toString());
    return own === null ? platform : Decimal.min(own, platform);
  }

  private toDecimal(value: string | null): Prisma.Decimal | null {
    return value === null ? null : new Prisma.Decimal(value);
  }
}

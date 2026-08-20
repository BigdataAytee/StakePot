import { Injectable } from '@nestjs/common';
import { DEFAULT_FREEZE_BUFFER_SECONDS, freezeAtFor, isTradingFrozen } from '@stakeam/rules';

import { AdminAuditService } from '../audit/admin-audit.service';
import { logger } from '../logger';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderBookService } from '../orderbook/orderbook.service';

export class FreezeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreezeError';
  }
}

/** States a market can be frozen *out of*. Everything else is already closed. */
const TRADABLE = ['seeding', 'funding', 'active'] as const;

/**
 * Trading stops when the event starts (§2.3, checklist rule 22).
 *
 * The rule is one sentence and the reason it needs a service is that a rule
 * enforced only by a job is a rule that holds until the job is late. So the
 * freeze exists in three places that cannot disagree, because all three read
 * `@stakeam/rules`:
 *
 * 1. **The money path** checks the clock inside the trade transaction. This is
 *    the one that actually protects anybody — a trade that queued at 14:59 and
 *    executes at 15:01 is refused at execution, not at submission.
 * 2. **This service** flips the state, so every screen, query and report agrees
 *    without each of them doing date arithmetic.
 * 3. **The screens** read the same functions to render a countdown and a badge.
 *
 * Idempotence is the property to protect here. The sweep runs on a schedule, a
 * schedule can fire twice, and a second freeze that re-annotated the chart and
 * re-notified every holder would turn a late job into a wave of duplicate
 * alarms at the worst possible moment. `frozenAt` is the guard: set once, and
 * everything downstream of the flip happens only on the transition.
 */
@Injectable()
export class MarketFreezeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly notifications: NotificationsService,
    private readonly config: PlatformConfigService,
    private readonly book: OrderBookService,
  ) {}

  /** The freeze time a market opening now should carry. */
  async freezeTimeFor(eventDate: Date): Promise<Date> {
    return freezeAtFor(eventDate, await this.bufferSeconds());
  }

  private async bufferSeconds(): Promise<number> {
    try {
      return await this.config.get('freeze_buffer_seconds');
    } catch (error) {
      // A config read that fails must not mean "no buffer". Falling back to the
      // rules module's default keeps the guarantee; falling back to zero would
      // quietly remove the protection at exactly the moment something is wrong.
      logger.warn({ error }, 'freeze buffer unreadable — using the default');
      return DEFAULT_FREEZE_BUFFER_SECONDS;
    }
  }

  /**
   * Freeze every market whose time has come.
   *
   * Returns how many it froze rather than nothing, so a sweep that has quietly
   * stopped freezing anything is visible in the job log rather than reported as
   * a success with no content.
   */
  async sweep(now = new Date()): Promise<{ frozen: number; checked: number }> {
    const due = await this.prisma.market.findMany({
      where: {
        state: { in: [...TRADABLE] },
        OR: [{ freezeAt: { lte: now } }, { freezeAt: null, eventDate: { lte: now } }],
      },
      select: { id: true },
      // A bound rather than none: an outage that leaves a thousand markets due
      // should freeze them in batches the sweep can finish, not in one
      // transaction that times out and freezes none.
      take: 500,
    });

    let frozen = 0;
    for (const market of due) {
      const result = await this.freeze({ marketId: market.id, reason: 'the event started', now });
      if (result.froze) frozen += 1;
    }
    return { frozen, checked: due.length };
  }

  /**
   * Freeze one market, once.
   *
   * `froze: false` is the ordinary answer for a market that is already frozen —
   * a late job, a second sweep, an admin pressing the button on a market the
   * clock already closed. Not an error, and deliberately not a no-op that
   * pretends to have acted.
   */
  async freeze(params: {
    marketId: string;
    reason: string;
    actor?: { userId: string; ip: string };
    now?: Date;
  }): Promise<{ froze: boolean; state: string; cancelledOrders?: number }> {
    const now = params.now ?? new Date();
    const reason = params.reason.trim();
    if (reason.length < 3) throw new FreezeError('a freeze needs a reason');

    const outcome = await this.prisma.$transaction(async (tx) => {
      // The same row lock the trade path takes. Without it, a freeze and a trade
      // can interleave: the trade reads `active`, the freeze commits, and the
      // trade commits after it — a stake accepted on a market the database says
      // is closed.
      await tx.$queryRaw`SELECT id FROM markets WHERE id = ${params.marketId} FOR UPDATE`;
      const market = await tx.market.findUnique({ where: { id: params.marketId } });
      if (market === null) throw new FreezeError('no such market');

      if (market.frozenAt !== null || !TRADABLE.includes(market.state as never)) {
        return { froze: false, state: market.state, cancelledOrders: 0 };
      }

      await tx.market.update({
        where: { id: market.id },
        data: { state: 'frozen', frozenAt: now, freezeReason: reason },
      });
      await tx.marketAnnotation.create({
        data: {
          marketId: market.id,
          type: 'freeze',
          label: `Trading closed — ${reason}`,
          // Null: the schedule did this, not a person. Attributing an automatic
          // freeze to a staff member would be a lie on a money screen.
          pinnedBy: params.actor?.userId ?? null,
          ts: now,
        },
      });

      /*
        Every resting order, cancelled and refunded, in the same transaction as
        the freeze.

        An order resting into a frozen market is money locked against a trade
        that can never happen. Leaving it there until settlement would be the
        platform holding somebody's balance for no reason at all, which is
        precisely the behaviour §2.7 says this product does not have. Doing it
        here rather than in a follow-up job is what makes it true at the instant
        the market closes rather than whenever a sweep next runs.
      */
      const cancelled = await this.book.cancelAllFor(tx, market.id, `freeze:${market.id}`);
      return { froze: true, state: 'frozen', cancelledOrders: cancelled };
    });

    if (!outcome.froze) return outcome;

    await this.audit.record({
      staffId: params.actor?.userId ?? 'system',
      action: params.actor === undefined ? 'market.freeze:scheduled' : 'market.freeze:manual',
      targetRef: params.marketId,
      after: { reason, at: now.toISOString() },
      ip: params.actor?.ip ?? 'scheduler',
    });

    await this.tellHolders(params.marketId, reason);
    return outcome;
  }

  /**
   * Move a market's freeze time, before it freezes.
   *
   * The case this exists for is a fixture rescheduled: the event moved, so the
   * time on the ticket is wrong, and leaving it wrong means freezing a market
   * hours before anything happens. Refused once the market is frozen — that is
   * `unfreeze`, which is the dangerous direction and needs two people.
   */
  async amend(params: {
    marketId: string;
    freezeAt: Date;
    eventDate?: Date;
    reason: string;
    actor: { userId: string; ip: string };
    now?: Date;
  }): Promise<{ freezeAt: string; eventDate: string }> {
    const now = params.now ?? new Date();
    const reason = params.reason.trim();
    if (reason.length < 8) throw new FreezeError('say why the time is moving');
    if (params.freezeAt.getTime() <= now.getTime()) {
      throw new FreezeError('a new freeze time has to be in the future');
    }

    const market = await this.prisma.market.findUnique({ where: { id: params.marketId } });
    if (market === null) throw new FreezeError('no such market');
    if (market.frozenAt !== null || !TRADABLE.includes(market.state as never)) {
      throw new FreezeError(
        `this market is ${market.state} — reopening it is an unfreeze, which needs two approvals`,
      );
    }

    const eventDate = params.eventDate ?? market.eventDate;
    if (params.freezeAt.getTime() > eventDate.getTime()) {
      // The whole point of the freeze time is that it is not after the event.
      throw new FreezeError('trading cannot still be open once the event has started');
    }
    if (eventDate.getTime() >= market.voidDate.getTime()) {
      throw new FreezeError('the event has to happen before the market voids');
    }

    const updated = await this.prisma.market.update({
      where: { id: market.id },
      data: { freezeAt: params.freezeAt, eventDate },
    });

    await this.audit.record({
      staffId: params.actor.userId,
      action: 'market.freeze:amend',
      targetRef: market.id,
      before: {
        freezeAt: market.freezeAt?.toISOString() ?? null,
        eventDate: market.eventDate.toISOString(),
      },
      after: {
        freezeAt: params.freezeAt.toISOString(),
        eventDate: eventDate.toISOString(),
        reason,
      },
      ip: params.actor.ip,
    });

    // Announced, not just recorded. A trader planning around a countdown is
    // owed the news that it moved, and an audit row is not something they read.
    await this.tellHolders(
      market.id,
      `the time changed — trading now closes ${params.freezeAt.toISOString()}`,
      'market_activated',
    );

    return {
      freezeAt: updated.freezeAt?.toISOString() ?? params.freezeAt.toISOString(),
      eventDate: updated.eventDate.toISOString(),
    };
  }

  /**
   * Whether this market is closed to trading right now.
   *
   * Reads the same rules function the money path does. Exposed so a screen or
   * a controller can ask without re-deriving it, and so there is exactly one
   * answer to the question in the codebase.
   */
  async isFrozen(marketId: string, now = new Date()): Promise<boolean> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: { freezeAt: true, eventDate: true, state: true },
    });
    if (market === null) return true;
    return isTradingFrozen({ ...market, now });
  }

  /**
   * Tell everyone holding a position that it is locked.
   *
   * Best effort and never thrown out of: a market must freeze whether or not a
   * push gateway is up. The state change is the protection; the message is the
   * courtesy, and letting the courtesy fail the protection would be backwards.
   */
  private async tellHolders(
    marketId: string,
    reason: string,
    type: 'market_frozen' | 'market_activated' = 'market_frozen',
  ): Promise<void> {
    try {
      const [market, holders] = await Promise.all([
        this.prisma.market.findUnique({ where: { id: marketId }, select: { question: true } }),
        this.prisma.position.findMany({
          where: { marketId, shares: { gt: 0 } },
          select: { userId: true },
          distinct: ['userId'],
          take: 5_000,
        }),
      ]);
      if (market === null) return;

      for (const holder of holders) {
        await this.notifications.notify({
          userId: holder.userId,
          type,
          body:
            type === 'market_frozen'
              ? `Your position is locked — ${market.question} (${reason}). It stays visible, and settles when the result is in.`
              : `${market.question}: ${reason}.`,
          data: { marketId },
        });
      }
    } catch (error) {
      logger.warn({ marketId, error }, 'could not tell holders about the freeze');
    }
  }
}

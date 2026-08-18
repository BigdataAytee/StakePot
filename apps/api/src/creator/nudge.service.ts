import { Injectable } from '@nestjs/common';

import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatorAnalyticsService } from './analytics.service';
import {
  DEFAULT_NUDGE_RULES,
  nudgesFor,
  type MarketSnapshot,
  type Nudge,
  type NudgeRules,
} from './nudges';

/** Market states a creator can still do something about. */
const ACTIONABLE = ['funding', 'active', 'frozen'] as const;

/**
 * §2.14d's nudge engine, wired to real markets.
 *
 * The rules are pure and live next door; this is only delivery — which is the
 * part that can do harm. A nudge is the platform spending the one channel it
 * has to reach a creator who can still fix something, so the throttle here
 * matters more than the copy: at most one nudge per market per
 * `nudge_min_hours_between`, and never the same kind twice in a row.
 */
@Injectable()
export class NudgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly notifications: NotificationsService,
    private readonly analytics: CreatorAnalyticsService,
  ) {}

  async rules(): Promise<NudgeRules> {
    const [participationFloor, proposalHours] = await Promise.all([
      this.config.get('participation_floor_users'),
      this.config.get('resolution_proposal_hours'),
    ]);
    return {
      ...DEFAULT_NUDGE_RULES,
      participationFloor,
      // Urgent means "inside the window you still have", which is exactly the
      // creator's proposal window — not a number picked separately from it.
      urgentHours: proposalHours,
    };
  }

  /**
   * Everything a market currently warrants, without sending anything.
   *
   * The creator studio reads this directly: a prompt on the screen is not a
   * message, so it is not throttled and does not consume the notification
   * channel.
   */
  async forMarket(marketId: string, now = new Date()): Promise<readonly Nudge[]> {
    const snapshot = await this.snapshot(marketId, now);
    if (snapshot === null) return [];
    return nudgesFor(snapshot, await this.rules());
  }

  async snapshot(marketId: string, now = new Date()): Promise<MarketSnapshot | null> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) return null;

    const [stakers, views, proposal, proposalHours] = await Promise.all([
      this.prisma.trade.findMany({
        where: {
          marketId,
          side: 'buy',
          ...(market.creatorId === null ? {} : { userId: { not: market.creatorId } }),
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.analytics.viewCount(marketId),
      this.prisma.resolution.findFirst({ where: { marketId } }),
      this.config.get('resolution_proposal_hours'),
    ]);

    const hoursFrom = (date: Date | null): number | null =>
      date === null ? null : (date.getTime() - now.getTime()) / 3_600_000;

    const proposalDeadline = new Date(market.eventDate.getTime() + proposalHours * 3_600_000);

    return {
      marketId,
      state: market.state,
      activationPath: market.activationPath === 'seeded' ? 'seeded' : 'organic',
      stakedByOutcome: market.outcomes.map((outcome) => Number(outcome.stakedTotal)),
      prices: market.outcomes.map((outcome) => Number(outcome.priceCurrent)),
      outcomeLabels: market.outcomes.map((outcome) => outcome.label),
      distinctStakers: stakers.length,
      views,
      hoursToWindowClose: hoursFrom(market.fundingClosesAt),
      hoursToEventDate: hoursFrom(market.eventDate),
      hoursToProposalDeadline: hoursFrom(proposalDeadline),
      resolutionProposed: proposal !== null,
    };
  }

  /**
   * Send at most one nudge for a market, if it is due one.
   *
   * The throttle reads the notification history rather than a column on the
   * market: the send log is what actually happened, and a "last nudged at"
   * field would be one more thing that can disagree with it.
   */
  async nudge(marketId: string, now = new Date()): Promise<Nudge | null> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: { creatorId: true },
    });
    if (market === null || market.creatorId === null) return null;

    const due = await this.forMarket(marketId, now);
    const top = due[0];
    if (top === undefined) return null;

    const minHours = await this.config.get('nudge_min_hours_between');
    const since = new Date(now.getTime() - minHours * 3_600_000);

    const recent = await this.prisma.notification.findFirst({
      where: {
        userId: market.creatorId,
        type: 'creator_nudge',
        createdAt: { gte: since },
        // The payload is flat — `notify` spreads `data` alongside title and
        // body — so the market id sits at the top level, not under `data`.
        payloadJson: { path: ['marketId'], equals: marketId },
      },
    });
    if (recent !== null) return null;

    await this.notifications.notify({
      userId: market.creatorId,
      type: 'creator_nudge',
      body: top.body,
      data: { marketId, kind: top.kind, action: top.action },
    });
    return top;
  }

  /**
   * The sweep. Every market a creator could still act on gets considered; the
   * throttle decides which ones actually reach anybody.
   */
  async sweep(now = new Date()): Promise<{ considered: number; sent: number }> {
    const markets = await this.prisma.market.findMany({
      where: {
        shelf: 'community',
        creatorId: { not: null },
        state: { in: [...ACTIONABLE] },
      },
      select: { id: true },
      take: 500,
    });

    let sent = 0;
    for (const market of markets) {
      const nudge = await this.nudge(market.id, now);
      if (nudge !== null) sent += 1;
    }
    return { considered: markets.length, sent };
  }
}

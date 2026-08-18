import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { EventName } from '../analytics/events';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §2.14d's creator analytics.
 *
 * "Views→stakes conversion, pool balance over time, traffic sources, activation
 * progress bar per side."
 *
 * Every number here is counted from rows the platform already keeps — trades,
 * outcomes, price history, and the `events` table §3 puts analytics in. Nothing
 * is sampled and nothing is estimated: a creator deciding whether to spend
 * their own money seeding a market is entitled to a real number.
 */

// The names come from §3's taxonomy rather than being spelled here: two
// spellings of one event is how an analytics table stops being usable.
export const VIEW_EVENT: EventName = 'market_view';
export const SEARCH_EVENT: EventName = 'market_search';

export interface CreatorAnalytics {
  readonly marketId: string;
  readonly question: string;
  readonly state: string;
  readonly views: number;
  readonly distinctViewers: number;
  readonly stakers: number;
  /** Views→stakes, 0–1. Null when nobody has looked yet — not zero. */
  readonly conversion: number | null;
  readonly volume: string;
  readonly creatorFeeAccrued: string;
  readonly sources: readonly { source: string; views: number }[];
  readonly pools: readonly {
    outcomeId: string;
    label: string;
    staked: string;
    price: string;
    /** Progress toward the per-outcome activation floor, 0–1. Null if no floor. */
    activationProgress: number | null;
  }[];
  readonly balanceOverTime: readonly { at: Date; prices: readonly string[] }[];
}

@Injectable()
export class CreatorAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record that somebody looked at a market.
   *
   * Called explicitly by the client rather than inferred from a page render:
   * a server-side fetch is not a person, and a conversion rate whose
   * denominator counts crawlers tells a creator to fix a problem they do not
   * have.
   */
  async recordView(params: { marketId: string; userId?: string; source?: string }): Promise<void> {
    await this.prisma.event.create({
      data: {
        ...(params.userId === undefined ? {} : { userId: params.userId }),
        name: VIEW_EVENT,
        propertiesJson: {
          marketId: params.marketId,
          source: normaliseSource(params.source),
        },
      },
    });
  }

  /** Record a search, and whether the platform had anything to show for it. */
  async recordSearch(params: {
    query: string;
    userId?: string;
    resultCount: number;
  }): Promise<void> {
    const query = params.query.trim();
    if (query.length === 0) return;

    await this.prisma.event.create({
      data: {
        ...(params.userId === undefined ? {} : { userId: params.userId }),
        name: SEARCH_EVENT,
        propertiesJson: { query, resultCount: params.resultCount },
      },
    });
  }

  async forMarket(marketId: string): Promise<CreatorAnalytics | null> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) return null;

    const views = await this.prisma.event.findMany({
      where: {
        name: VIEW_EVENT,
        propertiesJson: { path: ['marketId'], equals: marketId },
      },
      select: { userId: true, propertiesJson: true },
    });

    const stakerRows = await this.prisma.trade.findMany({
      where: { marketId, side: 'buy' },
      select: { userId: true },
      distinct: ['userId'],
    });

    const bySource = new Map<string, number>();
    const viewers = new Set<string>();
    for (const view of views) {
      const properties = view.propertiesJson as { source?: unknown } | null;
      const source = typeof properties?.source === 'string' ? properties.source : 'direct';
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
      if (view.userId !== null) viewers.add(view.userId);
    }

    // The creator's accrued share, read from the ledger rather than recomputed:
    // what they have actually been credited is the only honest answer.
    const fees = await this.prisma.ledgerEntry.aggregate({
      where: { marketId, type: 'fee_creator' },
      _sum: { amount: true },
    });

    const history = await this.prisma.priceHistory.findMany({
      where: { marketId },
      orderBy: { ts: 'asc' },
      take: 500,
    });

    const byTime = new Map<number, Map<string, string>>();
    for (const point of history) {
      const bucket = byTime.get(point.ts.getTime()) ?? new Map<string, string>();
      bucket.set(point.outcomeId, point.price.toString());
      byTime.set(point.ts.getTime(), bucket);
    }

    return {
      marketId,
      question: market.question,
      state: market.state,
      views: views.length,
      distinctViewers: viewers.size,
      stakers: stakerRows.length,
      conversion: views.length === 0 ? null : stakerRows.length / views.length,
      volume: market.potTotal.toString(),
      creatorFeeAccrued: (fees._sum.amount ?? new Prisma.Decimal(0)).abs().toString(),
      sources: [...bySource.entries()]
        .map(([source, count]) => ({ source, views: count }))
        .sort((left, right) => right.views - left.views),
      pools: market.outcomes.map((outcome) => ({
        outcomeId: outcome.id,
        label: outcome.label,
        staked: outcome.stakedTotal.toString(),
        price: outcome.priceCurrent.toString(),
        activationProgress: null,
      })),
      balanceOverTime: [...byTime.entries()]
        .sort(([left], [right]) => left - right)
        .map(([at, prices]) => ({
          at: new Date(at),
          prices: market.outcomes.map((outcome) => prices.get(outcome.id) ?? '0'),
        })),
    };
  }

  /**
   * §2.14d's "activation progress bar per side", filled in against the floor
   * the market is actually measured by.
   *
   * Passed the floor rather than reading config itself, so the bar a creator
   * watches and the check that decides activation cannot disagree.
   */
  withActivationProgress(
    analytics: CreatorAnalytics,
    perOutcomeFloor: number | null,
  ): CreatorAnalytics {
    if (perOutcomeFloor === null || perOutcomeFloor <= 0) return analytics;
    return {
      ...analytics,
      pools: analytics.pools.map((pool) => ({
        ...pool,
        activationProgress: Math.min(1, Number(pool.staked) / perOutcomeFloor),
      })),
    };
  }

  /**
   * Searches that found nothing, grouped by what was asked (§2.14b).
   *
   * The raw material for the unmet-demand signal. Grouping and the decision
   * about whether a live market already serves it happen in the opportunity
   * service — this only reads the log.
   */
  async emptySearches(since: Date): Promise<readonly { query: string; userId: string | null }[]> {
    const rows = await this.prisma.event.findMany({
      where: {
        name: SEARCH_EVENT,
        ts: { gte: since },
        propertiesJson: { path: ['resultCount'], equals: 0 },
      },
      select: { userId: true, propertiesJson: true },
      take: 5_000,
    });

    return rows.flatMap((row) => {
      const properties = row.propertiesJson as { query?: unknown } | null;
      return typeof properties?.query === 'string'
        ? [{ query: properties.query, userId: row.userId }]
        : [];
    });
  }

  /** Views for one market, used by the autopsy. */
  async viewCount(marketId: string): Promise<number> {
    return this.prisma.event.count({
      where: {
        name: VIEW_EVENT,
        propertiesJson: { path: ['marketId'], equals: marketId },
      },
    });
  }
}

/** Traffic sources are a small, closed set; anything else is "direct". */
const KNOWN_SOURCES = new Set(['direct', 'share', 'whatsapp', 'x', 'feed', 'profile', 'search']);

function normaliseSource(source: string | undefined): string {
  if (source === undefined) return 'direct';
  const cleaned = source.trim().toLowerCase().slice(0, 20);
  return KNOWN_SOURCES.has(cleaned) ? cleaned : 'direct';
}

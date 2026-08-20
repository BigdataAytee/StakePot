import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ITEMS_PER_MARKET, SOURCES_PER_PASS } from './research.service';

const DAY = 86_400_000;

/**
 * How a source is doing, in one word.
 *
 * `off` is a decision somebody made and is not a fault. `failing` is a source
 * that has missed enough fetches in a row to have stopped being a source.
 * `stale` is the quiet one and the reason this screen exists: it is still
 * enabled, still not erroring, and has not produced anything in a day — a feed
 * that moved, or a section that was retired, looks exactly like a quiet news
 * week until somebody compares it to the others.
 */
export type SourceStatus = 'ok' | 'stale' | 'failing' | 'off';

/** Consecutive failures after which a source has stopped being a source. */
const FAILING_AT = 3;

export interface SourceHealth {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly status: SourceStatus;
  readonly trust: number;
  readonly failureCount: number;
  readonly conflicts: number;
  readonly lastFetchAt: string | null;
  readonly lastOkAt: string | null;
  readonly itemsLast24h: number;
  readonly disabledReason: string | null;
}

export interface MarketCoverage {
  readonly marketId: string;
  readonly question: string;
  readonly sourceName: string;
  readonly items: number;
  readonly lastItemAt: string | null;
  readonly hoursToEvent: number;
}

export interface CrawlHealth {
  readonly sources: readonly SourceHealth[];
  readonly totals: {
    readonly sources: number;
    readonly enabled: number;
    readonly failing: number;
    readonly stale: number;
    readonly itemsLast24h: number;
    readonly itemsPerHour: number;
    readonly openConflicts: number;
    /** Live markets with nothing linked to them at all. */
    readonly uncoveredMarkets: number;
  };
  /** The per-pass ceilings, printed rather than assumed. */
  readonly budgets: { readonly sourcesPerPass: number; readonly itemsPerMarket: number };
  readonly coverage: readonly MarketCoverage[];
  readonly conflicts: readonly {
    readonly id: string;
    readonly marketId: string | null;
    readonly factKey: string;
    readonly claims: readonly { sourceName: string; tier: string; value: unknown }[];
    readonly detectedAt: string;
  }[];
  readonly builtAt: string;
}

/**
 * The crawl health screen (intelligence brief §6: guardrails and observability).
 *
 * A research pipeline fails silently by construction. Nothing errors when a
 * feed quietly stops carrying a section, or when a source's markup changes and
 * every fetch returns zero items, or when the one market settling tomorrow has
 * nothing linked to it — the job still runs, still reports success, and the
 * screens downstream still render. The failure only shows up as an absence,
 * and absences are invisible unless something counts them.
 *
 * So this counts them, and the two numbers that matter most are the ones a
 * "pipeline healthy" light would never show: sources that are up and producing
 * nothing, and live markets with no coverage at all.
 *
 * Read-only. Every control on the screen it feeds goes through the registry's
 * own kill switches, which record who turned a source off and why.
 */
@Injectable()
export class CrawlHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async report(now = new Date()): Promise<CrawlHealth> {
    const since = new Date(now.getTime() - DAY);

    const [sources, recentBySource, openConflicts, markets] = await Promise.all([
      this.prisma.source.findMany({ orderBy: [{ tier: 'asc' }, { name: 'asc' }] }),
      this.prisma.sourceItem.groupBy({
        by: ['sourceId'],
        where: { fetchedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.sourceConflict.findMany({
        where: { resolvedAt: null },
        orderBy: { detectedAt: 'desc' },
        take: 50,
      }),
      this.prisma.market.findMany({
        where: {
          state: { in: ['seeding', 'funding', 'active', 'frozen', 'pending_resolution'] },
        },
        select: { id: true, question: true, sourceName: true, eventDate: true },
        orderBy: { eventDate: 'asc' },
        take: 200,
      }),
    ]);

    const itemsBy = new Map(recentBySource.map((row) => [row.sourceId, row._count._all]));

    const health: SourceHealth[] = sources.map((source) => {
      const itemsLast24h = itemsBy.get(source.id) ?? 0;
      const status: SourceStatus = !source.enabled
        ? 'off'
        : source.failureCount >= FAILING_AT
          ? 'failing'
          : // Never fetched at all counts as stale rather than ok: a source
            // imported and never read is the commonest way a bulk import goes
            // wrong, and "ok" would hide it behind a green row.
            itemsLast24h === 0
            ? 'stale'
            : 'ok';

      return {
        id: source.id,
        name: source.name,
        tier: source.tier,
        status,
        trust: Number(source.trust.toString()),
        failureCount: source.failureCount,
        conflicts: source.conflicts,
        lastFetchAt: source.lastFetchAt?.toISOString() ?? null,
        lastOkAt: source.lastOkAt?.toISOString() ?? null,
        itemsLast24h,
        disabledReason: source.disabledReason,
      };
    });

    const coverage = await this.coverageFor(markets, now);

    const itemsLast24h = [...itemsBy.values()].reduce((a, b) => a + b, 0);

    return {
      sources: health,
      totals: {
        sources: sources.length,
        enabled: sources.filter((source) => source.enabled).length,
        failing: health.filter((source) => source.status === 'failing').length,
        stale: health.filter((source) => source.status === 'stale').length,
        itemsLast24h,
        itemsPerHour: Math.round((itemsLast24h / 24) * 10) / 10,
        openConflicts: openConflicts.length,
        uncoveredMarkets: coverage.filter((market) => market.items === 0).length,
      },
      budgets: { sourcesPerPass: SOURCES_PER_PASS, itemsPerMarket: ITEMS_PER_MARKET },
      coverage,
      conflicts: openConflicts.map((conflict) => ({
        id: conflict.id,
        marketId: conflict.marketId,
        factKey: conflict.factKey,
        claims:
          (conflict.claimsJson as { sourceName: string; tier: string; value: unknown }[]) ?? [],
        detectedAt: conflict.detectedAt.toISOString(),
      })),
      builtAt: now.toISOString(),
    };
  }

  /**
   * How much the pipeline has found about each live market.
   *
   * Sorted by how soon it settles, not by how thin it is. A market with no
   * coverage and three weeks to run is a gap; the same market settling
   * tomorrow is the thing to fix this morning, and a list ordered by badness
   * would bury it under older, emptier ones.
   */
  private async coverageFor(
    markets: readonly { id: string; question: string; sourceName: string; eventDate: Date }[],
    now: Date,
  ): Promise<MarketCoverage[]> {
    if (markets.length === 0) return [];
    const ids = markets.map((market) => market.id);

    const [counts, latest] = await Promise.all([
      this.prisma.marketSourceItem.groupBy({
        by: ['marketId'],
        where: { marketId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.marketSourceItem.findMany({
        where: { marketId: { in: ids } },
        select: { marketId: true, item: { select: { publishedAt: true } } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);

    const countBy = new Map(counts.map((row) => [row.marketId, row._count._all]));
    const lastBy = new Map<string, Date>();
    for (const row of latest) {
      const seen = lastBy.get(row.marketId);
      if (seen === undefined || row.item.publishedAt > seen) {
        lastBy.set(row.marketId, row.item.publishedAt);
      }
    }

    return markets.map((market) => ({
      marketId: market.id,
      question: market.question,
      sourceName: market.sourceName,
      items: countBy.get(market.id) ?? 0,
      lastItemAt: lastBy.get(market.id)?.toISOString() ?? null,
      hoursToEvent: Math.round((market.eventDate.getTime() - now.getTime()) / 3_600_000),
    }));
  }
}

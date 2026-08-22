import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ITEMS_PER_MARKET, ResearchService, SOURCES_PER_PASS } from './research.service';

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
  readonly kind: string;
  readonly feedUrl: string | null;
  readonly status: SourceStatus;
  readonly trust: number;
  readonly failureCount: number;
  readonly conflicts: number;
  readonly lastFetchAt: string | null;
  readonly lastOkAt: string | null;
  /**
   * When this source last published something we kept.
   *
   * Separate from `lastOkAt` because they answer different questions, and the
   * one everybody checks is the wrong one: a feed that answers 200 every
   * minute and has published nothing in a fortnight is green by `lastOkAt` and
   * dead by this.
   */
  readonly lastItemAt: string | null;
  readonly lastError: string | null;
  readonly itemsLast24h: number;
  /** Which polling tier it is on right now, and how often that means. */
  readonly cadence: string;
  readonly intervalMs: number;
  readonly nextCheckAt: string | null;
  /** Hours until the soonest live market that depends on it settles. */
  readonly attachedHours: number | null;
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
  /**
   * Whether anything is actually reading, and when it last did.
   *
   * Three states look identical from the source rows alone — no fetcher is
   * configured, the sweep has never run, or the sources genuinely had nothing
   * new — and only the first is a deployment that will never read anything.
   * Distinguishing them is the whole reason this field exists: the pipeline
   * once had no scheduled caller at all, and every screen downstream rendered
   * an empty list that looked exactly like a quiet news week.
   */
  readonly pipeline: {
    readonly fetcher: string;
    readonly fetching: boolean;
    readonly lastFetchAt: string | null;
  };
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly research: ResearchService,
  ) {}

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

    const cadences = await this.research.cadencePlan(now);

    const health: SourceHealth[] = sources.map((source) => {
      const cadence = cadences.get(source.id) ?? {
        label: 'normal',
        intervalMs: 5 * 60_000,
        attachedHours: null,
      };
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
        kind: source.kind,
        feedUrl: source.feedUrl,
        status,
        trust: Number(source.trust.toString()),
        failureCount: source.failureCount,
        conflicts: source.conflicts,
        lastFetchAt: source.lastFetchAt?.toISOString() ?? null,
        lastOkAt: source.lastOkAt?.toISOString() ?? null,
        lastItemAt: source.lastItemAt?.toISOString() ?? null,
        lastError: source.lastError,
        itemsLast24h,
        cadence: cadence.label,
        intervalMs: cadence.intervalMs,
        nextCheckAt:
          !source.enabled || source.lastFetchAt === null
            ? null
            : new Date(source.lastFetchAt.getTime() + cadence.intervalMs).toISOString(),
        attachedHours:
          cadence.attachedHours === null ? null : Math.round(cadence.attachedHours * 10) / 10,
        disabledReason: source.disabledReason,
      };
    });

    const coverage = await this.coverageFor(markets, now);
    const fetcher = this.research.describeFetcher();
    const lastFetch = sources.reduce<Date | null>(
      (latest, source) =>
        source.lastFetchAt !== null && (latest === null || source.lastFetchAt > latest)
          ? source.lastFetchAt
          : latest,
      null,
    );

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
      pipeline: {
        fetcher: fetcher.name,
        fetching: fetcher.enabled,
        lastFetchAt: lastFetch === null ? null : lastFetch.toISOString(),
      },
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

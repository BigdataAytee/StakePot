import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { crawlIntervalMs, isPublicTier } from '@stakeam/rules';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { DisabledFetcher, SOURCE_FETCHER, type SourceFetcher } from './fetcher';
import {
  ANNOTATION_FLOOR,
  cluster,
  detectConflicts,
  relevanceOf,
  RELEVANCE_FLOOR,
  type FactClaim,
} from './relevance';

/**
 * How many items one pass may store per market, and how many sources one pass
 * may read.
 *
 * Budgets rather than "read everything": a pipeline with no ceiling is one
 * that costs whatever the internet decides to publish today. Both are per-pass
 * and deliberately small — the pass runs often, so an interesting hour catches
 * up over three passes rather than in one enormous one.
 *
 * Exported so the crawl-health screen can print them. A cap nobody can see is
 * indistinguishable from having found everything there was.
 */
export const ITEMS_PER_MARKET = 60;
export const SOURCES_PER_PASS = 40;

@Injectable()
export class ResearchService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SOURCE_FETCHER)
    private readonly fetcher: SourceFetcher = new DisabledFetcher(),
  ) {}

  /**
   * One pass: read the sources that are due, store what is new, and link it to
   * the markets it is about.
   *
   * Returns what it did rather than nothing, because the crawl-health screen is
   * built from these numbers and a job that reports only "ok" is a job nobody
   * can tell has quietly stopped finding anything.
   */
  async pass(params: { now?: Date } = {}): Promise<{
    sourcesRead: number;
    itemsStored: number;
    linksMade: number;
    conflictsFound: number;
    skipped: { disabled: number; tooSoon: number; notAllowed: number };
  }> {
    const now = params.now ?? new Date();
    const summary = {
      sourcesRead: 0,
      itemsStored: 0,
      linksMade: 0,
      conflictsFound: 0,
      skipped: { disabled: 0, tooSoon: 0, notAllowed: 0 },
    };

    const markets = await this.liveMarkets();
    // Nothing live means nothing to research. The cadence is a function of the
    // markets, so with no markets there is no reason to read anything at all.
    if (markets.length === 0) return summary;

    const soonest = markets
      .map((market) => (market.eventDate.getTime() - now.getTime()) / 3_600_000)
      .filter((hours) => hours > 0)
      .sort((a, b) => a - b)[0];
    const interval = crawlIntervalMs(soonest ?? null);

    const sources = await this.prisma.source.findMany({
      where: { enabled: true },
      orderBy: [{ tier: 'asc' }, { lastFetchAt: 'asc' }],
      take: SOURCES_PER_PASS,
    });

    for (const source of sources) {
      const due =
        source.lastFetchAt === null || now.getTime() - source.lastFetchAt.getTime() >= interval;
      if (!due) {
        summary.skipped.tooSoon += 1;
        continue;
      }

      const since = source.lastOkAt ?? new Date(now.getTime() - 24 * 3_600_000);
      let result;
      try {
        result = await this.fetcher.fetch(
          {
            id: source.id,
            name: source.name,
            kind: source.kind,
            homeUrl: source.homeUrl,
            feedUrl: source.feedUrl,
            politenessMs: source.politenessMs,
          },
          since,
        );
      } catch (error) {
        // A source that keeps failing backs itself off through `failureCount`
        // rather than being retried at full rate forever. A newsroom whose feed
        // is down does not need this platform hammering it.
        logger.warn({ sourceId: source.id, error }, 'source fetch failed');
        await this.prisma.source.update({
          where: { id: source.id },
          data: { lastFetchAt: now, failureCount: { increment: 1 } },
        });
        continue;
      }

      if (!result.allowed) {
        summary.skipped.notAllowed += 1;
        await this.prisma.source.update({
          where: { id: source.id },
          data: { lastFetchAt: now, robotsAllows: false, robotsCheckedAt: now },
        });
        continue;
      }

      summary.sourcesRead += 1;
      const stored = await this.store(source.id, result.items);
      summary.itemsStored += stored.length;

      await this.prisma.source.update({
        where: { id: source.id },
        data: { lastFetchAt: now, lastOkAt: now, failureCount: 0, robotsAllows: true },
      });
    }

    // Linking is a separate pass over what is stored rather than part of the
    // fetch, so an item that arrives before a market is created still finds it.
    summary.linksMade = await this.link(markets);
    summary.conflictsFound = await this.findConflicts(markets);
    await this.recluster(markets);

    return summary;
  }

  private async liveMarkets() {
    return this.prisma.market.findMany({
      where: { state: { in: ['seeding', 'funding', 'active', 'frozen', 'pending_resolution'] } },
      select: {
        id: true,
        question: true,
        criteriaJson: true,
        sourceName: true,
        eventDate: true,
      },
    });
  }

  /** New items only. The URL is unique, so a re-read of a feed is cheap. */
  private async store(
    sourceId: string,
    items: readonly { headline: string; url: string; publishedAt: Date; facts: object }[],
  ): Promise<string[]> {
    const stored: string[] = [];
    for (const item of items) {
      const existing = await this.prisma.sourceItem.findUnique({ where: { url: item.url } });
      if (existing !== null) continue;

      const row = await this.prisma.sourceItem.create({
        data: {
          sourceId,
          headline: item.headline.trim(),
          url: item.url,
          publishedAt: item.publishedAt,
          factsJson: JSON.parse(JSON.stringify(item.facts)) as Prisma.InputJsonValue,
        },
      });
      stored.push(row.id);
    }
    return stored;
  }

  /** Score everything recent against every live market, and keep what lands. */
  private async link(
    markets: readonly {
      id: string;
      question: string;
      criteriaJson: unknown;
      sourceName: string;
    }[],
  ): Promise<number> {
    const recent = await this.prisma.sourceItem.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 500,
      include: { source: { select: { name: true, tier: true } } },
    });

    let made = 0;
    for (const market of markets) {
      const subject = {
        question: market.question,
        criteria: Object.values(asRecord(market.criteriaJson)),
        sourceName: market.sourceName,
      };

      const scored = recent
        // Tier 3 is staff-side by policy, and the link table is what the
        // public context panel reads. Filtered here rather than at render
        // time, so a signal cannot reach a screen through a route nobody
        // remembered to guard.
        .filter((item) => isPublicTier(item.source.tier))
        .map((item) => ({
          item,
          relevance: relevanceOf(
            { headline: item.headline, sourceName: item.source.name },
            subject,
          ),
        }))
        .filter((entry) => entry.relevance >= RELEVANCE_FLOOR)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, ITEMS_PER_MARKET);

      for (const entry of scored) {
        await this.prisma.marketSourceItem.upsert({
          where: { marketId_itemId: { marketId: market.id, itemId: entry.item.id } },
          create: {
            marketId: market.id,
            itemId: entry.item.id,
            relevance: new Prisma.Decimal(entry.relevance),
          },
          // Relevance can move when a market's criteria are corrected, and a
          // stale score would keep an item ranked where it no longer belongs.
          update: { relevance: new Prisma.Decimal(entry.relevance) },
        });
        made += 1;

        if (entry.relevance >= ANNOTATION_FLOOR) {
          await this.markChart(market.id, entry.item);
        }
      }
    }
    return made;
  }

  /**
   * Mark a significant item on the chart, at the moment it was published.
   *
   * An annotation is an assertion that this is why the line moved, which is a
   * strong claim to make automatically — so the bar is the annotation floor
   * rather than the storage floor, and the item keeps its link so a reader can
   * check the claim in one tap.
   *
   * Guarded on the URL rather than on an id: the same story arriving through a
   * feed and a sitemap is two `source_items` rows with one URL, and two marks
   * on the chart at the same minute reads as two events.
   */
  private async markChart(
    marketId: string,
    item: { headline: string; url: string; publishedAt: Date },
  ): Promise<void> {
    const existing = await this.prisma.marketAnnotation.findFirst({
      where: { marketId, url: item.url },
    });
    if (existing !== null) return;

    await this.prisma.marketAnnotation.create({
      data: {
        marketId,
        type: 'news',
        label: item.headline.slice(0, 140),
        url: item.url,
        // Null: nobody pinned this, the pipeline found it. The ticket shows
        // "pinned by" only when a person put their name to it, and attributing
        // an automatic mark to a staff member would be a lie on a money screen.
        pinnedBy: null,
        ts: item.publishedAt,
      },
    });
  }

  /**
   * Where the sources linked to a market disagree.
   *
   * Recorded rather than resolved. A conflict is a fact about the world that a
   * person has to look at, and the pipeline's only job is to make sure they
   * see it before they settle anything.
   */
  private async findConflicts(markets: readonly { id: string }[]): Promise<number> {
    let found = 0;

    for (const market of markets) {
      const links = await this.prisma.marketSourceItem.findMany({
        where: { marketId: market.id },
        include: { item: { include: { source: { select: { name: true, tier: true } } } } },
      });

      const claims: (FactClaim & { factKey: string })[] = [];
      for (const link of links) {
        for (const [factKey, value] of Object.entries(asRecord(link.item.factsJson))) {
          claims.push({
            factKey,
            sourceName: link.item.source.name,
            tier: link.item.source.tier,
            value: value as string | number,
          });
        }
      }

      for (const conflict of detectConflicts(claims)) {
        const open = await this.prisma.sourceConflict.findFirst({
          where: { marketId: market.id, factKey: conflict.factKey, resolvedAt: null },
        });
        if (open !== null) continue;

        await this.prisma.sourceConflict.create({
          data: {
            marketId: market.id,
            factKey: conflict.factKey,
            claimsJson: JSON.parse(JSON.stringify(conflict.claims)) as Prisma.InputJsonValue,
          },
        });
        found += 1;
      }
    }
    return found;
  }

  /** Group the same story across outlets, so a panel shows it once. */
  private async recluster(markets: readonly { id: string }[]): Promise<void> {
    for (const market of markets) {
      const links = await this.prisma.marketSourceItem.findMany({
        where: { marketId: market.id },
        include: { item: true },
        take: 200,
      });

      for (const group of cluster(
        links.map((link) => ({
          id: link.item.id,
          headline: link.item.headline,
          publishedAt: link.item.publishedAt,
        })),
      )) {
        await this.prisma.sourceItem.updateMany({
          where: { id: { in: [...group.members] } },
          data: { clusterId: group.id },
        });
      }
    }
  }
}

function asRecord(value: unknown): Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

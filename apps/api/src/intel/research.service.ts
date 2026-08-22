import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { cadenceLabel, crawlIntervalMs, inPublishWindow, isPublicTier } from '@stakeam/rules';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { DisabledFetcher, SOURCE_FETCHER, type FetchedItem, type SourceFetcher } from './fetcher';
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
   * Which fetcher is bound, by name.
   *
   * The crawl-health screen needs it to tell three states apart that otherwise
   * look identical — nothing has been read because no fetcher is configured,
   * because the sweep has never run, or because the sources genuinely had
   * nothing new. Only the first is a deployment that will never read anything,
   * and it is the easiest of the three to mistake for the third.
   */
  describeFetcher(): { name: string; enabled: boolean } {
    const described = this.fetcher.describe?.();
    if (described !== undefined) return { name: described.name, enabled: described.reads };
    // A fixture fetcher in a test, which need not implement `describe`.
    return {
      name: this.fetcher.constructor.name,
      enabled: !(this.fetcher instanceof DisabledFetcher),
    };
  }

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
    /** Sources that answered 304: read successfully, nothing new to download. */
    unchanged: number;
    skipped: { disabled: number; tooSoon: number; notAllowed: number };
  }> {
    const now = params.now ?? new Date();
    const summary = {
      sourcesRead: 0,
      itemsStored: 0,
      linksMade: 0,
      conflictsFound: 0,
      unchanged: 0,
      skipped: { disabled: 0, tooSoon: 0, notAllowed: 0 },
    };

    const markets = await this.liveMarkets();
    // Nothing live means nothing to research. The cadence is a function of the
    // markets, so with no markets there is no reason to read anything at all.
    if (markets.length === 0) return summary;

    const attached = await this.attachmentHours(markets, now);

    const sources = await this.prisma.source.findMany({
      where: { enabled: true },
      orderBy: [{ tier: 'asc' }, { lastFetchAt: 'asc' }],
      take: SOURCES_PER_PASS,
    });

    for (const source of sources) {
      // Cadence is per source, not per sweep. The sweep runs every five
      // minutes and asks each source whether it is due — which is what lets a
      // feed attached to a market settling tonight poll every minute while a
      // background source on the same sweep polls once an hour.
      const interval = crawlIntervalMs({
        cadence: source.cadence,
        hoursToNearestSettlement: attached.get(source.id) ?? null,
        failureCount: source.failureCount,
        inPublishWindow: inPublishWindow(source.publishWindow, now),
      });
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
          { etag: source.etag, lastModified: source.lastModified },
        );
      } catch (error) {
        // A source that keeps failing backs itself off through `failureCount`
        // rather than being retried at full rate forever. A newsroom whose feed
        // is down does not need this platform hammering it.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ sourceId: source.id, error }, 'source fetch failed');
        await this.prisma.source.update({
          where: { id: source.id },
          data: { lastFetchAt: now, failureCount: { increment: 1 }, lastError: message },
        });
        continue;
      }

      if (!result.allowed) {
        summary.skipped.notAllowed += 1;
        await this.prisma.source.update({
          where: { id: source.id },
          data: {
            lastFetchAt: now,
            lastError: result.note ?? 'not allowed',
            // Only a robots verdict writes the robots columns. "No fetcher is
            // configured" and "this kind needs HTML extraction" are facts about
            // us, and recording them as a disallow would put a red robots flag
            // on every source in a deployment that was simply never switched on.
            ...(result.blockedBy === 'robots' ? { robotsAllows: false, robotsCheckedAt: now } : {}),
          },
        });
        continue;
      }

      summary.sourcesRead += 1;

      // A 304 is a success. It must not be stored as a failure, and it must not
      // clear the validators — dropping them makes the next read unconditional
      // and downloads the whole feed again to learn the same thing.
      if (result.notModified === true) {
        summary.unchanged += 1;
        await this.prisma.source.update({
          where: { id: source.id },
          data: { lastFetchAt: now, lastOkAt: now, failureCount: 0, lastError: null },
        });
        continue;
      }

      const stored = await this.store(source.id, result.items);
      summary.itemsStored += stored.length;

      const newest = result.items.reduce<Date | null>(
        (latest, item) =>
          latest === null || item.publishedAt > latest ? item.publishedAt : latest,
        null,
      );

      await this.prisma.source.update({
        where: { id: source.id },
        data: {
          lastFetchAt: now,
          lastOkAt: now,
          failureCount: 0,
          robotsAllows: true,
          // A 200 that parsed to nothing is still worth saying out loud: it is
          // how a feed that moved looks, and it is indistinguishable from a
          // quiet news week unless the row says which it was.
          lastError: result.note ?? null,
          ...(stored.length > 0 && newest !== null ? { lastItemAt: newest } : {}),
          // `undefined` where the fetcher does not speak HTTP at all, which
          // must leave the stored validators alone rather than wipe them.
          ...(result.etag !== undefined ? { etag: result.etag } : {}),
          ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
        },
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

  /**
   * New items only, deduped on the guid *and* the URL.
   *
   * Two different mistakes, which is why both are checked. The URL catches the
   * same story reaching us down two routes — a feed and a sitemap, or two
   * sections of one site. The guid catches the same story arriving twice from
   * one publisher under two URLs, which is what happens when a headline is
   * re-slugged, a tracking parameter is appended, or a site moves to https:
   * the bytes differ, the guid does not, and without it the news panel shows
   * one story three times.
   *
   * Within a batch as well as against the table. A feed that repeats an entry
   * inside one document is not rare, and the unique index would turn that into
   * an exception in the middle of a pass.
   */
  private async store(sourceId: string, items: readonly FetchedItem[]): Promise<string[]> {
    const stored: string[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      const guid = item.guid ?? null;
      const key = guid ?? item.url;
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = await this.prisma.sourceItem.findFirst({
        where: {
          OR: [{ url: item.url }, ...(guid === null ? [] : [{ sourceId, guid }])],
        },
        select: { id: true },
      });
      if (existing !== null) continue;

      try {
        const row = await this.prisma.sourceItem.create({
          data: {
            sourceId,
            headline: item.headline.trim(),
            url: item.url,
            guid,
            publishedAt: item.publishedAt,
            factsJson: JSON.parse(JSON.stringify(item.facts)) as Prisma.InputJsonValue,
          },
        });
        stored.push(row.id);
      } catch (error) {
        // Two passes overlapping on the same feed. The unique index is the
        // real guarantee; this read-then-write is only the cheap path, and
        // losing that race means the item is already stored.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }
    return stored;
  }

  /**
   * For each source, how many hours until the soonest market that depends on
   * it settles — or absent from the map when nothing live does.
   *
   * This is what makes the cadence tiers mean anything. "Attached" is read two
   * ways, because a source earns its place either by authority or by having
   * actually produced something relevant:
   *
   * 1. the market names it as its resolution source, which is the strongest
   *    possible attachment — that source's publication *is* the settlement; and
   * 2. it has already had an item linked to the market by relevance scoring.
   *
   * A source attached to nothing falls to the idle interval rather than
   * polling all day for markets that do not exist.
   */
  private async attachmentHours(
    markets: readonly { id: string; sourceName: string; eventDate: Date }[],
    now: Date,
  ): Promise<Map<string, number>> {
    const hours = new Map<string, number>();
    const live = new Map<string, number>();
    for (const market of markets) {
      const toSettlement = (market.eventDate.getTime() - now.getTime()) / 3_600_000;
      // A market past its event date is waiting on a person, not on the news.
      if (toSettlement > 0) live.set(market.id, toSettlement);
    }
    if (live.size === 0) return hours;

    const soonest = (sourceId: string, value: number): void => {
      const held = hours.get(sourceId);
      if (held === undefined || value < held) hours.set(sourceId, value);
    };

    const named = await this.prisma.source.findMany({
      where: { name: { in: [...new Set(markets.map((market) => market.sourceName))] } },
      select: { id: true, name: true },
    });
    for (const market of markets) {
      const toSettlement = live.get(market.id);
      if (toSettlement === undefined) continue;
      for (const source of named) {
        if (source.name === market.sourceName) soonest(source.id, toSettlement);
      }
    }

    const links = await this.prisma.marketSourceItem.findMany({
      where: { marketId: { in: [...live.keys()] } },
      select: { marketId: true, item: { select: { sourceId: true } } },
      take: 5_000,
    });
    for (const link of links) {
      const toSettlement = live.get(link.marketId);
      if (toSettlement !== undefined) soonest(link.item.sourceId, toSettlement);
    }

    return hours;
  }

  /**
   * What each source's polling interval currently is, and why.
   *
   * Exported to the crawl-health screen rather than kept inside the pass: a
   * cadence nobody can see is one nobody can tell has gone wrong, and "this
   * source polls hourly because no live market depends on it" is exactly the
   * sentence an operator needs when a market is settling and its feed looks
   * quiet.
   */
  async cadencePlan(
    now = new Date(),
  ): Promise<Map<string, { label: string; intervalMs: number; attachedHours: number | null }>> {
    const markets = await this.liveMarkets();
    const attached = await this.attachmentHours(markets, now);
    const sources = await this.prisma.source.findMany({
      select: { id: true, cadence: true, failureCount: true, publishWindow: true },
    });

    const plan = new Map<
      string,
      { label: string; intervalMs: number; attachedHours: number | null }
    >();
    for (const source of sources) {
      const input = {
        cadence: source.cadence,
        hoursToNearestSettlement: attached.get(source.id) ?? null,
        failureCount: source.failureCount,
        inPublishWindow: inPublishWindow(source.publishWindow, now),
      };
      plan.set(source.id, {
        label: cadenceLabel(input),
        intervalMs: crawlIntervalMs(input),
        attachedHours: attached.get(source.id) ?? null,
      });
    }
    return plan;
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

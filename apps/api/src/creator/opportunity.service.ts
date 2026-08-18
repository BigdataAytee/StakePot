import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OpportunitySource as DbOpportunitySource } from '@prisma/client';

import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatorAnalyticsService } from './analytics.service';
import {
  alreadyServed,
  DEFAULT_DEMAND_RULES,
  demandScore,
  normaliseQuery,
  type DemandRules,
} from './opportunity-ranking';

export class OpportunityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpportunityError';
  }
}

export interface FeedEntry {
  readonly id: string;
  readonly source: DbOpportunitySource;
  readonly title: string;
  readonly score: number;
  readonly expiresAt: Date;
  readonly claimed: boolean;
  readonly evidence: Record<string, unknown> | null;
  readonly template: {
    id: string;
    category: string;
    templateJson: unknown;
    localisableFields: unknown;
  } | null;
}

/**
 * §2.14b's opportunity feed.
 *
 * "Trending now… unmet-demand signals… seasonal push." Three sources, one
 * ranked list, each with a pre-filled template one tap away.
 *
 * The unmet-demand half is the part that earns its keep: it is the only signal
 * on the platform that measures a question people came looking for and did not
 * find. It is also the one that must never point a creator at a market that
 * already exists, so the gap test reuses §2.9's similarity — one opinion about
 * what counts as the same market, not two.
 */
@Injectable()
export class OpportunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly analytics: CreatorAnalyticsService,
  ) {}

  async rules(): Promise<DemandRules> {
    const [minSearchers, horizonDays] = await Promise.all([
      this.config.get('opportunity_min_searchers'),
      this.config.get('opportunity_horizon_days'),
    ]);
    return {
      ...DEFAULT_DEMAND_RULES,
      minSearchers,
      horizonDays,
      saturationSearchers: Math.max(minSearchers * 10, DEFAULT_DEMAND_RULES.saturationSearchers),
    };
  }

  /** The feed, best first. Claimed entries drop out — the volume is gone. */
  async feed(params: { includeClaimed?: boolean; now?: Date } = {}): Promise<FeedEntry[]> {
    const now = params.now ?? new Date();

    const rows = await this.prisma.opportunity.findMany({
      where: {
        expiresAt: { gt: now },
        ...(params.includeClaimed === true ? {} : { claimedBy: null }),
      },
      include: { template: true },
      orderBy: { demandScore: 'desc' },
      take: 50,
    });

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      title: row.title,
      score: Number(row.demandScore),
      expiresAt: row.expiresAt,
      claimed: row.claimedBy !== null,
      evidence: (row.evidenceJson as Record<string, unknown> | null) ?? null,
      template:
        row.template === null
          ? null
          : {
              id: row.template.id,
              category: row.template.category,
              templateJson: row.template.templateJson,
              localisableFields: row.template.localisableFields,
            },
    }));
  }

  /**
   * Put an opportunity on the feed, or refresh the one that is already there.
   *
   * Keyed by `dedupeKey` so the hourly sweep updates a score rather than
   * posting the same fixture again every hour — a feed that repeats itself is a
   * feed creators stop reading.
   */
  async upsert(params: {
    dedupeKey: string;
    source: DbOpportunitySource;
    title: string;
    daysToEvent: number | null;
    searchers?: number;
    templateId?: string;
    evidence?: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<{ id: string; score: number }> {
    const rules = await this.rules();
    const score = demandScore(
      {
        source: params.source,
        title: params.title,
        daysToEvent: params.daysToEvent,
        ...(params.searchers === undefined ? {} : { searchers: params.searchers }),
      },
      rules,
    );

    const data = {
      source: params.source,
      title: params.title,
      demandScore: new Prisma.Decimal(score),
      expiresAt: params.expiresAt,
      ...(params.templateId === undefined ? {} : { templateId: params.templateId }),
      ...(params.evidence === undefined
        ? {}
        : { evidenceJson: params.evidence as Prisma.InputJsonValue }),
    };

    const row = await this.prisma.opportunity.upsert({
      where: { dedupeKey: params.dedupeKey },
      // A claimed opportunity is history: refreshing its score would put it
      // back in front of creators as though it were still available.
      update: data,
      create: { ...data, dedupeKey: params.dedupeKey },
    });

    return { id: row.id, score: Number(row.demandScore) };
  }

  /**
   * Turn the search log into unmet demand (§2.14b).
   *
   * "47 users searched 'BBNaija eviction' this week — no market exists. Create
   * it?" Distinct people, not distinct searches: one person refreshing is not
   * demand, and counting it as such is how a feed fills with noise.
   */
  async detectSearchGaps(params: { since: Date; now?: Date } = { since: weekAgo() }): Promise<{
    surfaced: number;
    suppressed: number;
  }> {
    const now = params.now ?? new Date();
    const rules = await this.rules();
    const ttlDays = await this.config.get('opportunity_ttl_days');

    const searches = await this.analytics.emptySearches(params.since);

    const buckets = new Map<string, { display: string; users: Set<string> }>();
    for (const search of searches) {
      const key = normaliseQuery(search.query);
      if (key.length === 0) continue;
      const bucket = buckets.get(key) ?? { display: search.query.trim(), users: new Set<string>() };
      // An anonymous search still counts as one person, distinguished by the
      // query text alone — an over-count of one is better than dropping every
      // logged-out searcher, who are exactly the people not yet converted.
      bucket.users.add(search.userId ?? `anon:${search.query.trim().toLowerCase()}`);
      buckets.set(key, bucket);
    }

    const live = await this.prisma.market.findMany({
      where: { state: { in: ['seeding', 'funding', 'active', 'frozen'] } },
      select: { question: true },
      take: 500,
    });

    let surfaced = 0;
    let suppressed = 0;

    for (const [key, bucket] of buckets) {
      if (bucket.users.size < rules.minSearchers) continue;

      // §2.14e: pointing a creator at a market that already exists splits its
      // liquidity, which is worse than saying nothing at all.
      if (alreadyServed(bucket.display, live, rules)) {
        suppressed += 1;
        continue;
      }

      await this.upsert({
        dedupeKey: `search:${key}`,
        source: 'search_gap',
        title: bucket.display,
        daysToEvent: null,
        searchers: bucket.users.size,
        evidence: { searchers: bucket.users.size, query: bucket.display },
        expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
      });
      surfaced += 1;
    }

    return { surfaced, suppressed };
  }

  /**
   * Claim an opportunity for a market (§2.14b: "first creator to claim an
   * opportunity captures its volume").
   *
   * Conditional on it still being unclaimed, in one statement, so two creators
   * pressing at the same moment cannot both win it.
   */
  async claim(params: {
    opportunityId: string;
    userId: string;
    marketId: string;
    now?: Date;
  }): Promise<void> {
    const now = params.now ?? new Date();
    const claimed = await this.prisma.opportunity.updateMany({
      where: { id: params.opportunityId, claimedBy: null },
      data: { claimedBy: params.userId, claimedAt: now, marketId: params.marketId },
    });

    if (claimed.count === 0) {
      const existing = await this.prisma.opportunity.findUnique({
        where: { id: params.opportunityId },
      });
      throw new OpportunityError(
        existing === null
          ? 'no such opportunity'
          : 'somebody has already claimed this one — the volume goes to their market',
      );
    }
  }

  /** The template library the wizard offers (§2.14a). */
  async templates(category?: string) {
    return this.prisma.ticketTemplate.findMany({
      where: {
        active: true,
        ...(category === undefined ? {} : { category: category as never }),
      },
      orderBy: { category: 'asc' },
    });
  }

  /** Drop what has expired unclaimed, so the feed reads as live. */
  async expire(now = new Date()): Promise<number> {
    const removed = await this.prisma.opportunity.deleteMany({
      where: { expiresAt: { lte: now }, claimedBy: null },
    });
    return removed.count;
  }
}

function weekAgo(): Date {
  return new Date(Date.now() - 7 * 86_400_000);
}

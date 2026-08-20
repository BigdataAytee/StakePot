import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { CrawlHealthService } from './crawl-health.service';

/**
 * The crawl health report.
 *
 * Every test here is about an absence, because that is the only way this
 * pipeline fails. A source whose feed moved throws nothing; a market nobody
 * has linked anything to renders a context panel that is merely empty. The
 * tests assert the report notices what a "pipeline healthy" light would not.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const HOUR = 3_600_000;
const NOW = new Date('2026-03-10T12:00:00Z');

describe.skipIf(!TEST_DATABASE_URL)('crawl health (integration)', () => {
  let prisma: PrismaService;
  let crawl: CrawlHealthService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    crawl = new CrawlHealthService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function source(params: {
    name: string;
    tier?: 'resolution' | 'news' | 'signal';
    enabled?: boolean;
    failureCount?: number;
    disabledReason?: string;
  }) {
    return prisma.source.create({
      data: {
        tier: params.tier ?? 'news',
        kind: 'rss',
        name: params.name,
        homeUrl: `https://${params.name.toLowerCase().replace(/\s+/g, '-')}.example`,
        trust: '0.6',
        enabled: params.enabled ?? true,
        failureCount: params.failureCount ?? 0,
        ...(params.disabledReason === undefined ? {} : { disabledReason: params.disabledReason }),
      },
    });
  }

  async function item(sourceId: string, hoursAgo: number, slug: string) {
    return prisma.sourceItem.create({
      data: {
        sourceId,
        headline: `Something happened (${slug})`,
        url: `https://example.ng/${sourceId}/${slug}`,
        publishedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
        fetchedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
      },
    });
  }

  it('separates a source that is failing from one that is merely quiet', async () => {
    const busy = await source({ name: 'Busy paper' });
    const quiet = await source({ name: 'Quiet paper' });
    await source({ name: 'Broken paper', failureCount: 4 });
    await source({
      name: 'Stopped paper',
      enabled: false,
      disabledReason: 'paywalled',
    });

    await item(busy.id, 2, 'a');
    await item(busy.id, 5, 'b');
    // The quiet one published two days ago and nothing since. Nothing errored.
    await item(quiet.id, 50, 'c');

    const report = await crawl.report(NOW);
    const byName = new Map(report.sources.map((row) => [row.name, row]));

    expect(byName.get('Busy paper')?.status).toBe('ok');
    // The whole reason this screen exists: enabled, not erroring, silent. This
    // is what a feed that moved looks like, and what a slow news week looks
    // like, and only the comparison to the others tells them apart.
    expect(byName.get('Quiet paper')?.status).toBe('stale');
    expect(byName.get('Broken paper')?.status).toBe('failing');
    expect(byName.get('Stopped paper')?.status).toBe('off');
    expect(byName.get('Stopped paper')?.disabledReason).toBe('paywalled');

    expect(report.totals.itemsLast24h).toBe(2);
    expect(report.totals.stale).toBe(1);
    expect(report.totals.failing).toBe(1);
    expect(report.totals.enabled).toBe(3);
  });

  it('counts a never-fetched source as stale rather than healthy', async () => {
    // The commonest way a bulk import goes wrong: hundreds of rows added, none
    // of them ever read. "ok" would hide every one of them behind a green row.
    await source({ name: 'Imported and forgotten' });

    const report = await crawl.report(NOW);
    expect(report.sources[0]?.status).toBe('stale');
    expect(report.sources[0]?.lastOkAt).toBeNull();
  });

  it('names the live markets nothing has been linked to, soonest first', async () => {
    const paper = await source({ name: 'Paper' });
    const linked = await item(paper.id, 3, 'linked');

    const covered = await liveMarket('Will the covered thing happen?', 200);
    const bare = await liveMarket('Will the bare thing happen?', 20);
    await prisma.marketSourceItem.create({
      data: { marketId: covered, itemId: linked.id, relevance: '0.8' },
    });

    const report = await crawl.report(NOW);

    expect(report.totals.uncoveredMarkets).toBe(1);
    // Soonest first, not thinnest first. A bare market three weeks out is a
    // gap; the same market settling tomorrow is this morning's job, and an
    // order by badness would bury it under older, emptier ones.
    expect(report.coverage.map((row) => row.marketId)).toEqual([bare, covered]);
    expect(report.coverage[0]?.items).toBe(0);
    expect(report.coverage[1]?.items).toBe(1);
  });

  it('carries unresolved disagreements and leaves both numbers standing', async () => {
    const marketId = await liveMarket('Will the naira close below ₦1,500?', 48);
    await prisma.sourceConflict.create({
      data: {
        marketId,
        factKey: 'naira_rate',
        claimsJson: [
          { sourceName: 'CBN', tier: 'resolution', value: 1532.41 },
          { sourceName: 'BusinessDay', tier: 'news', value: 1498 },
        ],
      },
    });
    await prisma.sourceConflict.create({
      data: { factKey: 'settled_already', claimsJson: [], resolvedAt: new Date() },
    });

    const report = await crawl.report(NOW);

    expect(report.totals.openConflicts).toBe(1);
    const values = report.conflicts[0]?.claims.map((claim) => claim.value) ?? [];
    expect(values).toContain(1532.41);
    expect(values).toContain(1498);
  });

  it('prints the per-pass budgets rather than letting them be assumed', async () => {
    // A cap nobody can see is indistinguishable from having found everything
    // there was, which is the more comfortable and more wrong reading.
    const report = await crawl.report(NOW);
    expect(report.budgets.sourcesPerPass).toBeGreaterThan(0);
    expect(report.budgets.itemsPerMarket).toBeGreaterThan(0);
  });

  async function liveMarket(question: string, hoursToEvent: number): Promise<string> {
    const market = await prisma.market.create({
      data: {
        shelf: 'official',
        question,
        sourceName: 'CBN',
        sourceUrl: 'https://www.cbn.gov.ng/',
        criteriaJson: {},
        edgeCasesJson: {},
        eventDate: new Date(NOW.getTime() + hoursToEvent * HOUR),
        voidDate: new Date(NOW.getTime() + (hoursToEvent + 200) * HOUR),
        state: 'active',
        liquidityParam: '50000',
        feeBps: 200,
      },
    });
    return market.id;
  }
});

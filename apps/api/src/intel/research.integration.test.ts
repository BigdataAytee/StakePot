import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { DisabledFetcher, type FetchResult, type SourceFetcher } from './fetcher';
import { ResearchService } from './research.service';

/**
 * The pipeline, against a fetcher that reads fixtures.
 *
 * Nothing here touches a real newsroom, and that is the design rather than a
 * testing convenience — the default binding in the application is a fetcher
 * that reads nothing, so a pipeline that starts crawling on boot would be
 * crawling from CI and from every preview environment before anybody decided
 * it should.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

class FixtureFetcher implements SourceFetcher {
  public calls = 0;
  constructor(private readonly byName: Record<string, FetchResult>) {}
  async fetch(target: { name: string }): Promise<FetchResult> {
    this.calls += 1;
    return this.byName[target.name] ?? { items: [], allowed: true };
  }
}

describe.skipIf(!TEST_DATABASE_URL)('research pipeline (integration)', () => {
  let prisma: PrismaService;
  let marketId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const market = await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will the naira close below ₦1,500/$ on the official window this month?',
        sourceName: 'CBN',
        sourceUrl: 'https://www.cbn.gov.ng/rates/',
        criteriaJson: {
          Yes: 'The CBN official window closing rate on the last business day is below ₦1,500/$.',
          No: 'That rate is ₦1,500/$ or above.',
        },
        edgeCasesJson: {},
        eventDate: new Date(Date.now() + 5 * 86_400_000),
        voidDate: new Date(Date.now() + 12 * 86_400_000),
        liquidityParam: '50000',
        feeBps: 700,
        state: 'active',
        outcomes: {
          create: [
            { label: 'Yes', ordinal: 0, priceCurrent: '0.5' },
            { label: 'No', ordinal: 1, priceCurrent: '0.5' },
          ],
        },
      },
    });
    marketId = market.id;
  });

  async function source(name: string, tier: 'resolution' | 'news' | 'signal') {
    return prisma.source.create({
      data: {
        tier,
        kind: 'rss',
        name,
        homeUrl: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example`,
        trust: tier === 'resolution' ? '1' : '0.6',
      },
    });
  }

  it('stores what a source published and links it to the market it is about', async () => {
    await source('CBN', 'resolution');
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        CBN: {
          allowed: true,
          items: [
            {
              headline: 'CBN official window closing rate ₦1,532/$ for the last business day',
              url: 'https://www.cbn.gov.ng/rates/2026-08-20',
              publishedAt: new Date(),
              facts: { 'naira.official.close': 1532 },
            },
          ],
        },
      }),
    );

    const summary = await research.pass();

    expect(summary.itemsStored).toBe(1);
    expect(summary.linksMade).toBe(1);
    const link = await prisma.marketSourceItem.findFirstOrThrow({ where: { marketId } });
    expect(Number(link.relevance)).toBeGreaterThan(0.3);
  });

  it('keeps an unrelated story out of the market', async () => {
    await source('A paper', 'news');
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        'A paper': {
          allowed: true,
          items: [
            {
              headline: 'Super Eagles name squad for the next qualifier',
              url: 'https://paper.example/eagles',
              publishedAt: new Date(),
              facts: {},
            },
          ],
        },
      }),
    );

    const summary = await research.pass();
    expect(summary.itemsStored).toBe(1);
    expect(summary.linksMade).toBe(0);
  });

  it('never links a tier-3 signal to a market', async () => {
    // The link table is what the public context panel reads, so a signal is
    // kept out here rather than at render time — a filter at the screen is one
    // route somebody can forget to guard.
    await source('A forecast market', 'signal');
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        'A forecast market': {
          allowed: true,
          items: [
            {
              headline: 'Naira official window closing rate implied at ₦1,532/$',
              url: 'https://forecast.example/naira',
              publishedAt: new Date(),
              facts: { 'naira.official.close': 1532 },
            },
          ],
        },
      }),
    );

    const summary = await research.pass();
    expect(summary.itemsStored).toBe(1);
    expect(summary.linksMade).toBe(0);
  });

  it('flags two sources disagreeing rather than averaging them', async () => {
    await source('CBN', 'resolution');
    await source('A paper', 'news');
    const item = {
      publishedAt: new Date(),
    };
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        CBN: {
          allowed: true,
          items: [
            {
              ...item,
              headline: 'CBN official window closing rate ₦1,532/$',
              url: 'https://cbn.example/rate',
              facts: { 'naira.official.close': 1532 },
            },
          ],
        },
        'A paper': {
          allowed: true,
          items: [
            {
              ...item,
              headline: 'Naira closes at ₦1,498/$ on the CBN official window',
              url: 'https://paper.example/naira',
              facts: { 'naira.official.close': 1498 },
            },
          ],
        },
      }),
    );

    const summary = await research.pass();
    expect(summary.conflictsFound).toBe(1);

    const conflict = await prisma.sourceConflict.findFirstOrThrow({ where: { marketId } });
    expect(conflict.factKey).toBe('naira.official.close');
    const claims = conflict.claimsJson as { value: number }[];
    // Both figures, unreconciled. Their average is a number nobody published.
    expect(claims.map((claim) => claim.value).sort()).toEqual([1498, 1532]);
  });

  it('does not raise the same conflict twice', async () => {
    await source('CBN', 'resolution');
    await source('A paper', 'news');
    const fetcher = new FixtureFetcher({
      CBN: {
        allowed: true,
        items: [
          {
            headline: 'CBN official window closing rate ₦1,532/$',
            url: 'https://cbn.example/rate',
            publishedAt: new Date(),
            facts: { 'naira.official.close': 1532 },
          },
        ],
      },
      'A paper': {
        allowed: true,
        items: [
          {
            headline: 'Naira closes at ₦1,498/$ on the CBN official window',
            url: 'https://paper.example/naira',
            publishedAt: new Date(),
            facts: { 'naira.official.close': 1498 },
          },
        ],
      },
    });

    const research = new ResearchService(prisma, fetcher);
    await research.pass();
    const second = await research.pass({ now: new Date(Date.now() + 7 * 86_400_000) });

    expect(second.conflictsFound).toBe(0);
    expect(await prisma.sourceConflict.count()).toBe(1);
  });

  it('folds one wire story carried by many outlets into one cluster', async () => {
    const outlets = ['Paper A', 'Paper B', 'Paper C'];
    for (const name of outlets) await source(name, 'news');

    const research = new ResearchService(
      prisma,
      new FixtureFetcher(
        Object.fromEntries(
          outlets.map((name, index) => [
            name,
            {
              allowed: true,
              items: [
                {
                  headline: 'CBN resumes dollar sales on the official window to BDC operators',
                  url: `https://${name.replace(/\s+/g, '')}.example/story`,
                  publishedAt: new Date(Date.now() - index * 60_000),
                  facts: {},
                },
              ],
            } satisfies FetchResult,
          ]),
        ),
      ),
    );

    await research.pass();

    const items = await prisma.sourceItem.findMany();
    const clusters = new Set(items.map((item) => item.clusterId));
    expect(items).toHaveLength(3);
    expect(clusters.size).toBe(1);
  });

  it('respects the crawl interval instead of reading on every pass', async () => {
    await source('CBN', 'resolution');
    const fetcher = new FixtureFetcher({ CBN: { allowed: true, items: [] } });
    const research = new ResearchService(prisma, fetcher);

    await research.pass();
    expect(fetcher.calls).toBe(1);

    // Immediately again: the market settles in five days, so the cadence is
    // hourly and this source is not due.
    const second = await research.pass();
    expect(fetcher.calls).toBe(1);
    expect(second.skipped.tooSoon).toBe(1);
  });

  it('reads nothing at all when no market is live', async () => {
    await prisma.market.update({ where: { id: marketId }, data: { state: 'resolved' } });
    await source('CBN', 'resolution');
    const fetcher = new FixtureFetcher({ CBN: { allowed: true, items: [] } });

    const summary = await new ResearchService(prisma, fetcher).pass();

    expect(fetcher.calls).toBe(0);
    expect(summary.sourcesRead).toBe(0);
  });

  it('records that a source said no, without treating it as a failure', async () => {
    const row = await source('A paper', 'news');
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        'A paper': { allowed: false, items: [], note: 'robots.txt disallows this path' },
      }),
    );

    const summary = await research.pass();
    expect(summary.skipped.notAllowed).toBe(1);

    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.robotsAllows).toBe(false);
    // Not a failure: a source that declines is behaving correctly, and
    // counting it as one would back off a feed that is working as intended.
    expect(after.failureCount).toBe(0);
  });

  it('reads nothing with the default fetcher', async () => {
    // The application's default binding. Crawling is something an operator
    // turns on, not something that starts because the service booted.
    await source('CBN', 'resolution');
    const summary = await new ResearchService(prisma, new DisabledFetcher()).pass();

    expect(summary.itemsStored).toBe(0);
    expect(summary.skipped.notAllowed).toBe(1);
  });
});

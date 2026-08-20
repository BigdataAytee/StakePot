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
        'A paper': {
          allowed: false,
          blockedBy: 'robots',
          items: [],
          note: 'robots.txt disallows this path',
        },
      }),
    );

    const summary = await research.pass();
    expect(summary.skipped.notAllowed).toBe(1);

    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.robotsAllows).toBe(false);
    expect(after.lastError).toContain('robots');
    // Not a failure: a source that declines is behaving correctly, and
    // counting it as one would back off a feed that is working as intended.
    expect(after.failureCount).toBe(0);
  });

  it('does not blame robots.txt when the reason we read nothing is us', async () => {
    const row = await source('A paper', 'news');
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        'A paper': {
          allowed: false,
          blockedBy: 'disabled',
          items: [],
          note: 'no fetcher is configured — nothing is being read',
        },
      }),
    );

    await research.pass();

    // The bug this stops: a deployment that was never switched on used to end
    // up with a red robots flag on every source it owns, which reads as forty
    // newsrooms refusing us rather than one environment variable being unset.
    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.robotsAllows).toBe(true);
    expect(after.robotsCheckedAt).toBeNull();
    expect(after.lastError).toContain('no fetcher');
  });

  it('reads nothing with the default fetcher', async () => {
    // The application's default binding. Crawling is something an operator
    // turns on, not something that starts because the service booted.
    await source('CBN', 'resolution');
    const summary = await new ResearchService(prisma, new DisabledFetcher()).pass();

    expect(summary.itemsStored).toBe(0);
    expect(summary.skipped.notAllowed).toBe(1);
  });

  it('sends the stored validators back, and treats a 304 as a healthy read', async () => {
    const row = await source('CBN', 'resolution');
    await prisma.source.update({
      where: { id: row.id },
      data: { etag: '"seen-this"', lastModified: 'Mon, 09 Mar 2026 09:05:00 GMT' },
    });

    const seen: unknown[] = [];
    const research = new ResearchService(prisma, {
      async fetch(_target, _since, validators) {
        seen.push(validators);
        return { items: [], allowed: true, notModified: true, etag: '"seen-this"' };
      },
    });

    const summary = await research.pass();

    expect(seen).toEqual([{ etag: '"seen-this"', lastModified: 'Mon, 09 Mar 2026 09:05:00 GMT' }]);
    expect(summary.unchanged).toBe(1);
    expect(summary.sourcesRead).toBe(1);

    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    // A 304 is a success: it clears the error, keeps the validators, and does
    // not count against the source. Recording it as "no items" would make a
    // working feed look like a dead one on the Research tab.
    expect(after.lastOkAt).not.toBeNull();
    expect(after.failureCount).toBe(0);
    expect(after.lastError).toBeNull();
    expect(after.etag).toBe('"seen-this"');
  });

  it('remembers the last item time, which is not the same as the last fetch time', async () => {
    const row = await source('CBN', 'resolution');
    const published = new Date(Date.now() - 3 * 3_600_000);
    const research = new ResearchService(
      prisma,
      new FixtureFetcher({
        CBN: {
          allowed: true,
          items: [
            {
              headline: 'CBN official window closing rate ₦1,532/$',
              url: 'https://cbn.example/rate-1',
              publishedAt: published,
              facts: {},
            },
          ],
        },
      }),
    );

    await research.pass();

    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    // The distinction the crawl-health screen turns on: a feed that answers 200
    // every minute and has published nothing for a fortnight is healthy by
    // `lastOkAt` and dead by the measure that matters.
    expect(after.lastItemAt?.toISOString()).toBe(published.toISOString());
    expect(after.lastOkAt?.getTime()).toBeGreaterThan(published.getTime());
  });

  it('does not store the same story twice when the publisher changes its URL', async () => {
    await source('CBN', 'resolution');
    const item = {
      headline: 'CBN official window closing rate ₦1,532/$',
      publishedAt: new Date(),
      guid: 'cbn-rate-2026-08-20',
      facts: {},
    };

    const first = new ResearchService(
      prisma,
      new FixtureFetcher({
        CBN: { allowed: true, items: [{ ...item, url: 'http://cbn.example/rates/2026-08-20' }] },
      }),
    );
    expect((await first.pass()).itemsStored).toBe(1);

    // Same story, same guid, new URL — https, and a tracking parameter. Without
    // guid dedupe this is a second row and the news panel shows it twice.
    const second = new ResearchService(
      prisma,
      new FixtureFetcher({
        CBN: {
          allowed: true,
          items: [{ ...item, url: 'https://cbn.example/rates/2026-08-20?utm_source=rss' }],
        },
      }),
    );
    await prisma.source.updateMany({ data: { lastFetchAt: null, lastOkAt: null } });
    expect((await second.pass()).itemsStored).toBe(0);
    expect(await prisma.sourceItem.count()).toBe(1);
  });

  it('escalates a source to the one-minute tier when its market is settling', async () => {
    // The market created in `beforeEach` settles in five days and names CBN.
    const cbn = await source('CBN', 'resolution');
    const unattached = await source('A paper', 'news');

    const plan = await new ResearchService(prisma).cadencePlan();
    expect(plan.get(cbn.id)?.label).toBe('normal');
    // Nothing live depends on it, so it idles rather than polling all day for
    // markets that do not exist.
    expect(plan.get(unattached.id)?.label).toBe('background');

    await prisma.market.update({
      where: { id: marketId },
      data: { eventDate: new Date(Date.now() + 6 * 3_600_000) },
    });

    const escalated = await new ResearchService(prisma).cadencePlan();
    expect(escalated.get(cbn.id)?.label).toBe('urgent');
    expect(escalated.get(cbn.id)?.intervalMs).toBe(60_000);
    // Automatic, and it falls back on its own: nobody has to remember to
    // de-escalate a source after a market settles.
    expect(escalated.get(unattached.id)?.label).toBe('background');
  });

  it('lets an operator pin a cadence, overriding what the markets say', async () => {
    const row = await source('A paper', 'news');
    await prisma.source.update({ where: { id: row.id }, data: { cadence: 'urgent' } });

    const plan = await new ResearchService(prisma).cadencePlan();
    expect(plan.get(row.id)?.label).toBe('urgent');
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { PoliteFetcher } from './fetcher';
import { HttpFetcher } from './http-fetcher';
import { ResearchService } from './research.service';

/**
 * The whole pipeline, over a real socket.
 *
 * Every other test in this directory reads fixtures, which is right — the
 * rules of relevance, clustering and budgets should not need a network. But
 * "reads fixtures" is also how a pipeline can be entirely green and never have
 * moved a byte: the fetcher was a stub for weeks, the tests passed, and no
 * screen downstream would ever have shown anything.
 *
 * So this one starts an HTTP server, registers it as a source, and runs a pass
 * against it. Real request, real headers, real conditional 304, real feed
 * parsing, real rows. The publisher is local because a test must not depend on
 * a newsroom being up — everything between the socket and the source row is
 * the production path.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const ETAG = '"rev-1"';

function feed(items: { id: string; title: string; url: string; at: Date }[]): string {
  return `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Fixture wire</title>
${items
  .map(
    (item) => `  <item>
    <title>${item.title}</title>
    <link>${item.url}</link>
    <guid isPermaLink="false">${item.id}</guid>
    <pubDate>${item.at.toUTCString()}</pubDate>
  </item>`,
  )
  .join('\n')}
</channel></rss>`;
}

describe.skipIf(!TEST_DATABASE_URL)('fetching a feed end to end (integration)', () => {
  let prisma: PrismaService;
  let server: Server;
  let origin: string;
  let requests: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  let body = '';
  let robots = 'User-agent: *\nAllow: /\n';

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();

    server = createServer((request, response) => {
      requests.push({ path: request.url ?? '', headers: request.headers });

      if (request.url === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(robots);
        return;
      }
      if (request.url === '/feed.xml') {
        if (request.headers['if-none-match'] === ETAG) {
          response.writeHead(304, { etag: ETAG });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/rss+xml', etag: ETAG });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    requests = [];
    robots = 'User-agent: *\nAllow: /\n';
    await resetDatabase(prisma);
    await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will the naira close below ₦1,500/$ on the official window this month?',
        sourceName: 'Fixture wire',
        sourceUrl: `${origin}/`,
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
  });

  /** The source row a phone import would produce, pointed at the fixture. */
  async function register() {
    return prisma.source.create({
      data: {
        tier: 'resolution',
        kind: 'rss',
        name: 'Fixture wire',
        homeUrl: `${origin}/`,
        feedUrl: `${origin}/feed.xml`,
        trust: '1',
        politenessMs: 0,
      },
    });
  }

  const research = () => new ResearchService(prisma, new PoliteFetcher(new HttpFetcher()));

  it('reads a live feed, stores the items, and turns the source green', async () => {
    const row = await register();
    body = feed([
      {
        id: 'naira-1',
        title: 'CBN official window closing rate ₦1,532/$ on the last business day',
        url: `${origin}/rates/2026-08-20`,
        at: new Date(Date.now() - 3_600_000),
      },
    ]);

    const summary = await research().pass();

    expect(summary.sourcesRead).toBe(1);
    expect(summary.itemsStored).toBe(1);
    expect(summary.linksMade).toBe(1);

    // robots.txt before the feed, in that order.
    expect(requests.map((request) => request.path)).toEqual(['/robots.txt', '/feed.xml']);
    expect(String(requests[1]?.headers['user-agent'])).toContain('StakeAmResearchBot');

    const item = await prisma.sourceItem.findFirstOrThrow();
    expect(item.headline).toContain('₦1,532/$');
    expect(item.guid).toBe('naira-1');

    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastOkAt).not.toBeNull();
    expect(after.lastItemAt).not.toBeNull();
    expect(after.failureCount).toBe(0);
    expect(after.lastError).toBeNull();
    expect(after.etag).toBe(ETAG);
  });

  it('sends the etag back on the next pass and takes the 304', async () => {
    const row = await register();
    body = feed([
      {
        id: 'naira-1',
        title: 'CBN official window closing rate ₦1,532/$',
        url: `${origin}/rates/2026-08-20`,
        at: new Date(Date.now() - 3_600_000),
      },
    ]);

    await research().pass();
    // Due again. The cadence is the subject of its own tests; here the point is
    // what goes over the wire on the second read.
    await prisma.source.update({ where: { id: row.id }, data: { lastFetchAt: null } });
    requests = [];

    const second = await research().pass();

    expect(requests.at(-1)?.headers['if-none-match']).toBe(ETAG);
    expect(second.unchanged).toBe(1);
    expect(second.itemsStored).toBe(0);
    // A 304 is a healthy read, not a silent source.
    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastOkAt).not.toBeNull();
    expect(after.lastError).toBeNull();
    expect(await prisma.sourceItem.count()).toBe(1);
  });

  it('does not read a path robots.txt disallows', async () => {
    const row = await register();
    robots = 'User-agent: *\nDisallow: /feed.xml\n';
    body = feed([{ id: 'x', title: 'Anything', url: `${origin}/x`, at: new Date() }]);

    const summary = await research().pass();

    expect(summary.skipped.notAllowed).toBe(1);
    expect(requests.map((request) => request.path)).toEqual(['/robots.txt']);
    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.robotsAllows).toBe(false);
    // Being told not to read something is not a failure, and backing the source
    // off as if it were would punish a publisher for answering correctly.
    expect(after.failureCount).toBe(0);
  });

  it('survives a feed that is not a feed', async () => {
    const row = await register();
    body = '<html><body><h1>Service unavailable</h1></body></html>';

    const summary = await research().pass();

    expect(summary.itemsStored).toBe(0);
    const after = await prisma.source.findUniqueOrThrow({ where: { id: row.id } });
    // Reached, answered, and what came back was not a feed. That is a
    // configuration problem and must not read the same as a quiet news week.
    expect(after.lastError).toContain('nothing in it parsed as a feed');
  });
});

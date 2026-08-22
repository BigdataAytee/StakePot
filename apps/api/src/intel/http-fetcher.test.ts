import { describe, expect, it } from 'vitest';

import type { FetchTarget } from './fetcher';
import { HttpFetcher, pathAllowed } from './http-fetcher';

const NOW = new Date('2026-03-10T12:00:00Z');
const SINCE = new Date('2026-03-01T00:00:00Z');

const CAF: FetchTarget = {
  id: 'caf',
  name: 'CAF',
  kind: 'rss',
  homeUrl: 'https://caf.example',
  feedUrl: 'https://caf.example/news/rss',
  politenessMs: 2_000,
};

const FEED = `<rss><channel>
  <item>
    <title>AFCON qualifier moved to Uyo</title>
    <link>https://caf.example/news/uyo</link>
    <pubDate>Mon, 09 Mar 2026 09:00:00 GMT</pubDate>
    <guid>uyo-1</guid>
  </item>
</channel></rss>`;

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * A stand-in for the network that records what was asked for.
 *
 * `routes` is keyed by URL; anything not listed 404s, which is how a site with
 * no `robots.txt` behaves and is the case we most need to get right.
 */
function stubHttp(
  routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url] ?? { status: 404 };
    // 304 and 204 are null-body statuses; the Response constructor rejects a
    // body for them, empty string included.
    const body = route.status === 304 || route.status === 204 ? null : (route.body ?? '');
    return new Response(body, {
      status: route.status,
      headers: route.headers ?? {},
    });
  }) as typeof fetch;
  return { http, calls };
}

const at = (calls: readonly Call[], url: string): Call | undefined =>
  calls.find((c) => c.url === url);

describe('reading a source over HTTP', () => {
  it('fetches a feed and returns its items with the validators to send next time', async () => {
    const { http, calls } = stubHttp({
      'https://caf.example/news/rss': {
        status: 200,
        body: FEED,
        headers: { etag: '"abc123"', 'last-modified': 'Mon, 09 Mar 2026 09:05:00 GMT' },
      },
    });

    const result = await new HttpFetcher(http, () => NOW.getTime()).fetch(CAF, SINCE);

    expect(result.allowed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.headline).toBe('AFCON qualifier moved to Uyo');
    expect(result.etag).toBe('"abc123"');
    expect(result.lastModified).toBe('Mon, 09 Mar 2026 09:05:00 GMT');
    // robots first, then the feed. In that order, so we never read a byte of a
    // site before it has told us we may.
    expect(calls.map((c) => c.url)).toEqual([
      'https://caf.example/robots.txt',
      'https://caf.example/news/rss',
    ]);
  });

  it('sends the previous validators and treats a 304 as a success, not a silent source', async () => {
    const { http, calls } = stubHttp({ 'https://caf.example/news/rss': { status: 304 } });

    const result = await new HttpFetcher(http, () => NOW.getTime()).fetch(CAF, SINCE, {
      etag: '"abc123"',
      lastModified: 'Mon, 09 Mar 2026 09:05:00 GMT',
    });

    const sent = at(calls, 'https://caf.example/news/rss')?.headers ?? {};
    expect(sent['if-none-match']).toBe('"abc123"');
    expect(sent['if-modified-since']).toBe('Mon, 09 Mar 2026 09:05:00 GMT');

    expect(result.allowed).toBe(true);
    expect(result.notModified).toBe(true);
    expect(result.items).toHaveLength(0);
    // The validators survive a 304 — dropping them would mean the next read is
    // unconditional and we download the whole feed again for nothing.
    expect(result.etag).toBe('"abc123"');
  });

  it('sends no conditional headers on the first ever read of a source', async () => {
    const { http, calls } = stubHttp({
      'https://caf.example/news/rss': { status: 200, body: FEED },
    });

    await new HttpFetcher(http, () => NOW.getTime()).fetch(CAF, SINCE);

    const sent = at(calls, 'https://caf.example/news/rss')?.headers ?? {};
    expect(sent['if-none-match']).toBeUndefined();
    expect(sent['if-modified-since']).toBeUndefined();
    expect(sent['user-agent']).toContain('StakeAmResearchBot');
  });

  it('honours a robots.txt disallow, and calls it a skip rather than a failure', async () => {
    const { http, calls } = stubHttp({
      'https://caf.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /news' },
      'https://caf.example/news/rss': { status: 200, body: FEED },
    });

    const result = await new HttpFetcher(http, () => NOW.getTime()).fetch(CAF, SINCE);

    expect(result.allowed).toBe(false);
    expect(result.note).toContain('robots');
    expect(at(calls, 'https://caf.example/news/rss')).toBeUndefined();
  });

  it('asks robots.txt once a day, not once a minute', async () => {
    const { http, calls } = stubHttp({
      'https://caf.example/news/rss': { status: 200, body: FEED },
    });
    let clock = NOW.getTime();
    const fetcher = new HttpFetcher(http, () => clock);

    await fetcher.fetch(CAF, SINCE);
    clock += 60_000;
    await fetcher.fetch(CAF, SINCE);

    expect(calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);

    clock += 25 * 3_600_000;
    await fetcher.fetch(CAF, SINCE);
    expect(calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('reads a site with no robots.txt at all', async () => {
    const { http } = stubHttp({
      'https://caf.example/news/rss': { status: 200, body: FEED },
    });

    const result = await new HttpFetcher(http, () => NOW.getTime()).fetch(CAF, SINCE);

    expect(result.allowed).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('never throws — an error, a 500 and rubbish in the body each cost one pass', async () => {
    const clock = () => NOW.getTime();

    const exploding = (async () => {
      throw new Error('getaddrinfo ENOTFOUND caf.example');
    }) as typeof fetch;
    const crashed = await new HttpFetcher(exploding, clock).fetch(CAF, SINCE);
    expect(crashed.items).toHaveLength(0);
    expect(crashed.note).toContain('ENOTFOUND');

    const { http: server500 } = stubHttp({ 'https://caf.example/news/rss': { status: 503 } });
    const down = await new HttpFetcher(server500, clock).fetch(CAF, SINCE);
    expect(down.items).toHaveLength(0);
    expect(down.note).toBe('HTTP 503');

    const { http: notAFeed } = stubHttp({
      'https://caf.example/news/rss': {
        status: 200,
        body: '<html><body>Page not found</body></html>',
      },
    });
    const rubbish = await new HttpFetcher(notAFeed, clock).fetch(CAF, SINCE);
    expect(rubbish.items).toHaveLength(0);
    // The distinction matters on the Research tab: we reached it, it answered,
    // and what came back was not a feed. That is a configuration problem, and
    // it should not read the same as "the site is down".
    expect(rubbish.note).toContain('nothing in it parsed as a feed');
  });

  it('refuses a kind it cannot actually read rather than pretending to try', async () => {
    const { http, calls } = stubHttp({});

    const result = await new HttpFetcher(http, () => NOW.getTime()).fetch(
      { ...CAF, kind: 'crawl', feedUrl: null },
      SINCE,
    );

    expect(result.allowed).toBe(false);
    expect(result.note).toContain('HTML extraction');
    expect(calls).toHaveLength(0);
  });

  it('drops items older than the last read', async () => {
    const { http } = stubHttp({
      'https://caf.example/news/rss': {
        status: 200,
        body: `<rss><channel>
          <item><title>Old</title><link>https://caf.example/old</link>
            <pubDate>Fri, 09 Jan 2026 09:00:00 GMT</pubDate></item>
          <item><title>New</title><link>https://caf.example/new</link>
            <pubDate>Mon, 09 Mar 2026 09:00:00 GMT</pubDate></item>
        </channel></rss>`,
      },
    });

    const result = await new HttpFetcher(http, () => NOW.getTime()).fetch(CAF, SINCE);

    expect(result.items.map((i) => i.headline)).toEqual(['New']);
  });
});

describe('robots.txt rules', () => {
  it('allows everything when there are no rules for us', () => {
    expect(pathAllowed('', '/news/rss')).toBe(true);
    expect(pathAllowed('User-agent: Googlebot\nDisallow: /', '/news/rss')).toBe(true);
  });

  it('lets the longest matching rule win, so Disallow: / plus Allow: /feed means the feed', () => {
    const robots = 'User-agent: *\nDisallow: /\nAllow: /feed';
    expect(pathAllowed(robots, '/feed/news.xml')).toBe(true);
    expect(pathAllowed(robots, '/members')).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const robots = '# our rules\n\nUser-agent: *\nDisallow: /private # staff only\n';
    expect(pathAllowed(robots, '/private/list')).toBe(false);
    expect(pathAllowed(robots, '/news')).toBe(true);
  });

  it('reads the group for * and not the group before it', () => {
    const robots = 'User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';
    expect(pathAllowed(robots, '/news/rss')).toBe(true);
  });
});

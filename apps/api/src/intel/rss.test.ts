import { describe, expect, it } from 'vitest';

import { parseFeed } from './rss';

const NOW = new Date('2026-03-10T12:00:00Z');

/**
 * Feed parsing, exercised on the shapes real feeds actually arrive in.
 *
 * Every malformed case here is one a live feed has produced. The property that
 * matters across all of them: **the parser never throws**, because a source
 * having a bad day must cost one pass rather than the whole sweep.
 */
describe('feed parsing', () => {
  it('reads a plain RSS feed', () => {
    const items = parseFeed(
      `<rss><channel>
        <item>
          <title>CAF confirms AFCON qualifier dates</title>
          <link>https://cafonline.example/afcon-dates</link>
          <pubDate>Mon, 09 Mar 2026 14:00:00 GMT</pubDate>
          <guid>afcon-dates-1</guid>
        </item>
      </channel></rss>`,
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.headline).toBe('CAF confirms AFCON qualifier dates');
    expect(items[0]?.url).toBe('https://cafonline.example/afcon-dates');
    expect(items[0]?.guid).toBe('afcon-dates-1');
    expect(items[0]?.publishedAt.toISOString()).toBe('2026-03-09T14:00:00.000Z');
  });

  it('reads Atom, and picks the readable link out of several', () => {
    const items = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Super Eagles squad named</title>
          <link rel="self" href="https://example.ng/feed"/>
          <link rel="alternate" href="https://example.ng/squad"/>
          <id>tag:example.ng,2026:squad</id>
          <published>2026-03-08T09:30:00Z</published>
        </entry>
      </feed>`,
      NOW,
    );

    // `rel="self"` is the feed itself. Taking the first link would have every
    // entry in the feed pointing at the feed.
    expect(items[0]?.url).toBe('https://example.ng/squad');
    expect(items[0]?.guid).toBe('tag:example.ng,2026:squad');
  });

  it('unwraps CDATA and decodes entities in the right order', () => {
    const items = parseFeed(
      `<rss><channel><item>
        <title><![CDATA[Fuel &amp; power: NNPC&#39;s statement]]></title>
        <link>https://example.ng/a?x=1&amp;y=2</link>
      </item></channel></rss>`,
      NOW,
    );

    expect(items[0]?.headline).toBe("Fuel & power: NNPC's statement");
    // Ampersand decoded last, or `&amp;lt;` would become `<`.
    expect(items[0]?.url).toBe('https://example.ng/a?x=1&y=2');
  });

  it('skips the broken entry and keeps the rest', () => {
    const items = parseFeed(
      `<rss><channel>
        <item><title>No link at all</title></item>
        <item><link>https://example.ng/no-title</link></item>
        <item><title>Fine</title><link>https://example.ng/fine</link></item>
      </channel></rss>`,
      NOW,
    );

    // One entry with no link is one entry lost. Refusing the feed over it
    // loses the other forty.
    expect(items.map((item) => item.headline)).toEqual(['Fine']);
  });

  it('dates an undated item now rather than at the epoch', () => {
    const items = parseFeed(
      `<rss><channel><item><title>Undated</title><link>https://example.ng/u</link></item></channel></rss>`,
      NOW,
    );
    // 1970 would sort it below everything for ever and it would never surface.
    expect(items[0]?.publishedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('returns nothing rather than throwing on rubbish', () => {
    for (const rubbish of [
      '',
      '<html><body>404</body></html>',
      '<rss><channel>',
      '{"json":true}',
    ]) {
      expect(() => parseFeed(rubbish, NOW)).not.toThrow();
      expect(parseFeed(rubbish, NOW)).toEqual([]);
    }
  });

  it('survives an unclosed tag mid-feed', () => {
    const items = parseFeed(
      `<rss><channel>
        <item><title>First</title><link>https://example.ng/1</link></item>
        <item><title>Truncated`,
      NOW,
    );
    expect(items.map((item) => item.headline)).toEqual(['First']);
  });
});

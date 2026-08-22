import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { BriefingService } from './briefing.service';

/**
 * What the engine reads before it drafts.
 *
 * The panel this feeds is a citation, so the tests are about what must never
 * appear in it: a staff-only signal, a story from outside the window, or an
 * empty list standing in for "we read nothing".
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const DAY = 86_400_000;
const NOW = new Date('2026-03-10T12:00:00Z');

describe.skipIf(!TEST_DATABASE_URL)('slot briefing (integration)', () => {
  let prisma: PrismaService;
  let briefings: BriefingService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    briefings = new BriefingService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
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

  async function item(params: {
    sourceId: string;
    headline: string;
    daysAgo: number;
    facts?: Record<string, string | number>;
  }) {
    return prisma.sourceItem.create({
      data: {
        sourceId: params.sourceId,
        headline: params.headline,
        url: `https://example.ng/${params.sourceId}/${encodeURIComponent(params.headline).slice(0, 60)}`,
        publishedAt: new Date(NOW.getTime() - params.daysAgo * DAY),
        factsJson: params.facts ?? {},
      },
    });
  }

  const BRIEF = 'Naira, inflation or interest rates, pitched at the analyst consensus.';

  it('reads the recent, relevant, publishable items and nothing else', async () => {
    const cbn = await source('CBN', 'resolution');
    const paper = await source('BusinessDay', 'news');
    const desk = await source('Internal desk', 'signal');

    await item({
      sourceId: cbn.id,
      headline: 'CBN holds interest rates as inflation eases to 23.4%',
      daysAgo: 2,
      facts: { inflation_rate: '23.4%' },
    });
    await item({
      sourceId: paper.id,
      headline: 'Analysts split on whether the CBN will hold interest rates again',
      daysAgo: 1,
    });
    // Outside the fortnight.
    await item({ sourceId: paper.id, headline: 'CBN inflation rates naira outlook', daysAgo: 40 });
    // Tier 3. Never appears on any surface, and this one is staff-only anyway
    // — which is exactly the reasoning that leaks a source list two refactors
    // later, so the gate is in the service rather than in the screen.
    await item({
      sourceId: desk.id,
      headline: 'CBN interest rates decision leaked to our desk',
      daysAgo: 1,
    });

    const briefing = await briefings.forSlot({ brief: BRIEF, now: NOW });

    // Two: the item from outside the fortnight is never read at all, and the
    // Tier 3 one is dropped before scoring. `itemsRead` is what was scored,
    // which is the number the prompt and the panel both quote.
    expect(briefing.itemsRead).toBe(2);
    const headlines = briefing.stories.map((story) => story.headline);
    expect(headlines).toHaveLength(2);
    expect(headlines.join(' ')).not.toContain('leaked to our desk');
    expect(headlines.join(' ')).not.toContain('outlook');
    expect(briefing.figures.map((figure) => figure.key)).toEqual(['inflation_rate']);
    expect(briefing.figures[0]?.sourceName).toBe('CBN');
  });

  it('says nothing was published rather than returning an empty panel', async () => {
    const paper = await source('BusinessDay', 'news');
    await item({
      sourceId: paper.id,
      headline: 'Super Eagles name squad for the AFCON qualifier',
      daysAgo: 1,
    });

    const briefing = await briefings.forSlot({ brief: BRIEF, now: NOW });

    // One item was read and scored; none of it was about this slot. The
    // distinction matters to the prompt, which is told not to invent recent
    // developments, and to the panel, which says so out loud.
    expect(briefing.itemsRead).toBe(1);
    expect(briefing.stories).toHaveLength(0);
  });

  it('counts one wire story once and says how many outlets carried it', async () => {
    const a = await source('Reuters', 'news');
    const b = await source('BusinessDay', 'news');
    const c = await source('Punch', 'news');
    for (const outlet of [a, b, c]) {
      await item({
        sourceId: outlet.id,
        headline: 'CBN holds interest rates as inflation eases',
        daysAgo: 1,
      });
    }

    const briefing = await briefings.forSlot({ brief: BRIEF, now: NOW });

    expect(briefing.stories).toHaveLength(1);
    // The number a reviewer actually wants: one outlet is a report, three is a
    // story, and the panel would be a lie if it printed the same line thrice.
    expect(briefing.stories[0]?.sourceCount).toBe(3);
  });

  it('flags two sources publishing different numbers rather than averaging them', async () => {
    const cbn = await source('CBN', 'resolution');
    const paper = await source('BusinessDay', 'news');
    await item({
      sourceId: cbn.id,
      headline: 'CBN publishes official naira rate for the interest rates window',
      daysAgo: 1,
      facts: { naira_rate: 1532.41 },
    });
    await item({
      sourceId: paper.id,
      headline: 'Naira closes at a different interest rates window level, traders say',
      daysAgo: 1,
      facts: { naira_rate: 1498.0 },
    });

    const briefing = await briefings.forSlot({ brief: BRIEF, now: NOW });

    expect(briefing.conflicts.map((conflict) => conflict.factKey)).toEqual(['naira_rate']);
    // Both numbers survive. The average of a published 1,532 and a published
    // 1,498 is a number nobody published and no market could settle on.
    const claimed = briefing.conflicts[0]?.claims.map((claim) => claim.value) ?? [];
    expect(claimed).toContain(1532.41);
    expect(claimed).toContain(1498);
  });
});

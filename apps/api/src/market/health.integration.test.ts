import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { MarketHealthService } from './health.service';

/**
 * Part 5 of docs/ticket-creation-checklist.md, as the sweep runs it.
 *
 * The thresholds themselves are `packages/rules`' problem and are tested there
 * against the document. What is tested here is the half a pure function cannot
 * do: that a flag raised at 10am and gone by noon is still there at settlement,
 * that a sweep running every fifteen minutes for a fortnight leaves one row and
 * not four hundred, and that the post-mortem rule 43 asks for actually carries
 * what fired.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const HOUR = 3_600_000;
const NOW = new Date('2026-03-10T12:00:00Z');

describe.skipIf(!TEST_DATABASE_URL)('part 5 monitoring sweep (integration)', () => {
  let prisma: PrismaService;
  let health: MarketHealthService;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    health = new MarketHealthService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await prisma.user.create({
      data: { email: 'watcher@example.ng', pwHash: 'x', role: 'user', tier: 1 },
    });
    userId = user.id;
  });

  /** A live market, open for `openHours`, split `[yes, no]` naira on the pot. */
  async function liveMarket(params: {
    openHours: number;
    split: [number, number];
    eventInHours?: number;
  }): Promise<string> {
    const [yes, no] = params.split;
    const market = await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will the CBN hold the MPR at its March meeting?',
        sourceName: 'CBN',
        sourceUrl: 'https://www.cbn.gov.ng/',
        criteriaJson: {},
        edgeCasesJson: {},
        eventDate: new Date(NOW.getTime() + (params.eventInHours ?? 24 * 30) * HOUR),
        voidDate: new Date(NOW.getTime() + 60 * 24 * HOUR),
        state: 'active',
        liquidityParam: '1000',
        potTotal: String(yes + no),
        feeBps: 200,
        createdAt: new Date(NOW.getTime() - params.openHours * HOUR),
      },
    });
    await prisma.outcome.createMany({
      data: [
        { marketId: market.id, label: 'Hold', ordinal: 0, stakedTotal: String(yes) },
        { marketId: market.id, label: 'Cut', ordinal: 1, stakedTotal: String(no) },
      ],
    });
    return market.id;
  }

  it('records a lopsided market once, however many times it is swept', async () => {
    const marketId = await liveMarket({ openHours: 72, split: [8200, 1800] });

    const first = await health.sweep(NOW);
    expect(first.raised).toBe(1);

    // Fifteen minutes later, and fifteen after that. Same condition, same row.
    const second = await health.sweep(new Date(NOW.getTime() + 0.25 * HOUR));
    const third = await health.sweep(new Date(NOW.getTime() + 0.5 * HOUR));
    expect(second.raised).toBe(0);
    expect(second.standing).toBe(1);
    expect(third.standing).toBe(1);

    const rows = await prisma.marketHealthFlag.findMany({ where: { marketId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rule).toBe('35');
    expect(rows[0]?.firings).toBe(3);
    // The clock on the flag is when it *started*, which is the number an
    // operator acts on — "82/18 since Tuesday" is a decision, "82/18" is not.
    expect(rows[0]?.firstFiredAt.toISOString()).toBe(NOW.toISOString());
    expect(rows[0]?.lastFiredAt.getTime()).toBe(NOW.getTime() + 0.5 * HOUR);
    expect(rows[0]?.clearedAt).toBeNull();
  });

  it('clears a flag when the condition passes, and keeps the row', async () => {
    const marketId = await liveMarket({ openHours: 72, split: [8200, 1800] });
    await health.sweep(NOW);

    // The other side arrives and the market converges.
    await prisma.outcome.updateMany({
      where: { marketId, label: 'Cut' },
      data: { stakedTotal: '7800' },
    });
    const later = new Date(NOW.getTime() + 6 * HOUR);
    const swept = await health.sweep(later);

    expect(swept.cleared).toBe(1);
    const rows = await prisma.marketHealthFlag.findMany({ where: { marketId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clearedAt?.toISOString()).toBe(later.toISOString());

    // And the history still remembers it. This is the whole reason the table
    // exists: computed on read, this market now looks like it never wobbled.
    const history = await health.historyFor(marketId);
    expect(history.map((flag) => flag.rule)).toEqual(['35']);
  });

  it('re-opens the same row when a cleared condition comes back', async () => {
    const marketId = await liveMarket({ openHours: 72, split: [8200, 1800] });
    await health.sweep(NOW);
    await prisma.outcome.updateMany({
      where: { marketId, label: 'Cut' },
      data: { stakedTotal: '7800' },
    });
    await health.sweep(new Date(NOW.getTime() + 6 * HOUR));
    await prisma.outcome.updateMany({
      where: { marketId, label: 'Cut' },
      data: { stakedTotal: '900' },
    });
    await health.sweep(new Date(NOW.getTime() + 12 * HOUR));

    const rows = await prisma.marketHealthFlag.findMany({ where: { marketId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clearedAt).toBeNull();
    // "Flagged, recovered, flagged again" is one flag with a history, not two.
    expect(rows[0]?.firstFiredAt.toISOString()).toBe(NOW.toISOString());
  });

  it('does not flag a market that is lopsided in its first hour', async () => {
    // The 48-hour wait is the rule, not an implementation detail: every market
    // is 100/0 after its first trade, and a flag that fires on all of them
    // teaches everybody to ignore it before a real one ever arrives.
    await liveMarket({ openHours: 1, split: [9000, 0] });
    const swept = await health.sweep(NOW);
    expect(swept.raised).toBe(0);
  });

  it('flags an early whale by concentration, not by size', async () => {
    const marketId = await liveMarket({ openHours: 6, split: [5000, 5000] });
    const outcome = await prisma.outcome.findFirstOrThrow({ where: { marketId, ordinal: 0 } });
    const other = await prisma.user.create({
      data: { email: 'small@example.ng', pwHash: 'x', role: 'user', tier: 1 },
    });
    await prisma.position.createMany({
      data: [
        { userId, marketId, outcomeId: outcome.id, shares: '9000' },
        { userId: other.id, marketId, outcomeId: outcome.id, shares: '1000' },
      ],
    });

    await health.sweep(NOW);
    const rows = await prisma.marketHealthFlag.findMany({ where: { marketId } });
    expect(rows.map((row) => row.rule)).toEqual(['36']);
    expect(rows[0]?.severity).toBe('act');
  });

  it('closes out flags on a market that has settled', async () => {
    const marketId = await liveMarket({ openHours: 72, split: [8200, 1800] });
    await health.sweep(NOW);
    await prisma.market.update({ where: { id: marketId }, data: { state: 'resolved' } });

    const later = new Date(NOW.getTime() + HOUR);
    await health.sweep(later);

    // A settled market is not swept, so without this its flag would sit open
    // for ever and "no clearedAt" would stop meaning "a problem right now".
    const rows = await prisma.marketHealthFlag.findMany({ where: { marketId } });
    expect(rows[0]?.clearedAt?.toISOString()).toBe(later.toISOString());
    expect(await health.historyFor(marketId)).toHaveLength(1);
  });

  it('tells the Studio how long each live flag has been standing', async () => {
    const marketId = await liveMarket({ openHours: 72, split: [8200, 1800] });
    await health.sweep(NOW);

    const markets = await prisma.market.findMany({
      select: {
        id: true,
        state: true,
        createdAt: true,
        eventDate: true,
        outcomes: { select: { stakedTotal: true } },
      },
    });
    const flags = await health.standingFlagsFor(markets, new Date(NOW.getTime() + 3 * HOUR));

    const flag = flags.get(marketId)?.[0];
    expect(flag?.rule).toBe('35');
    // The wording is live — 75 hours open, not the 72 the row was written at —
    // while `since` comes from the record. Both, or the screen is either stale
    // or amnesiac.
    expect(flag?.message).toContain('75h');
    expect(flag?.since).toBe(NOW.toISOString());
  });
});

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * What a price did recently, for every screen that has to say so.
 *
 * Three surfaces need the same two facts and were each about to grow their own
 * query for them: the market card's "+3.2%" badge, the portfolio's per-holding
 * sparkline and today's P&L, and the ticket's chart. A price series is the most
 * expensive thing this database is asked for on a read path — one row per
 * outcome per tick — so three implementations of it is three chances to fetch
 * every row since the market opened to draw a 40px line.
 *
 * The window is anchored on a caller-supplied `now` rather than read from the
 * clock inside. A "24h change" computed against three slightly different
 * instants, in three components rendering the same card, is the kind of
 * discrepancy nobody can reproduce and everybody notices.
 */
export interface PricePoint {
  /** Milliseconds since the epoch — smaller on the wire than an ISO string. */
  t: number;
  /** 0–1. */
  p: number;
}

export interface OutcomeWindow {
  outcomeId: string;
  /** The price at the start of the window, or null when the market is younger. */
  opened: number | null;
  /** Latest price in the window; falls back to the outcome's stored price. */
  latest: number;
  /** Change over the window as a fraction of the opening price, or null. */
  change: number | null;
  high: number;
  low: number;
  /** Downsampled for drawing — see `downsample`. */
  series: PricePoint[];
}

/** How many points a line needs to read correctly at ticket width. */
const MAX_POINTS = 120;

@Injectable()
export class PriceWindowService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The window for every outcome of one market.
   *
   * One query for the market rather than one per outcome: a five-candidate
   * market drawing five lines would otherwise be five round trips that the
   * database could have answered as one ordered scan of a single index.
   */
  async forMarket(marketId: string, sinceMs: number, now = Date.now()): Promise<OutcomeWindow[]> {
    const rows = await this.prisma.priceHistory.findMany({
      where: { marketId, ts: { gte: new Date(now - sinceMs) } },
      orderBy: { ts: 'asc' },
      select: { outcomeId: true, price: true, ts: true },
    });

    const outcomes = await this.prisma.outcome.findMany({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, priceCurrent: true },
    });

    const byOutcome = new Map<string, PricePoint[]>();
    for (const outcome of outcomes) byOutcome.set(outcome.id, []);
    for (const row of rows) {
      byOutcome.get(row.outcomeId)?.push({ t: row.ts.getTime(), p: Number(row.price.toString()) });
    }

    return outcomes.map((outcome) => {
      const points = byOutcome.get(outcome.id) ?? [];
      const stored = Number(outcome.priceCurrent.toString());
      return summarise(outcome.id, points, stored);
    });
  }

  /**
   * The window for a scattered set of outcomes across many markets — the
   * portfolio's case, where every row is a different market.
   *
   * Still one query. The alternative is a request per holding, which is fine
   * for the three positions a new account has and quadratic misery for the
   * account this feature exists to serve.
   */
  async forOutcomes(
    outcomeIds: readonly string[],
    sinceMs: number,
    now = Date.now(),
  ): Promise<Map<string, OutcomeWindow>> {
    const ids = [...new Set(outcomeIds)];
    const result = new Map<string, OutcomeWindow>();
    if (ids.length === 0) return result;

    const [rows, outcomes] = await Promise.all([
      this.prisma.priceHistory.findMany({
        where: { outcomeId: { in: ids }, ts: { gte: new Date(now - sinceMs) } },
        orderBy: { ts: 'asc' },
        select: { outcomeId: true, price: true, ts: true },
      }),
      this.prisma.outcome.findMany({
        where: { id: { in: ids } },
        select: { id: true, priceCurrent: true },
      }),
    ]);

    const byOutcome = new Map<string, PricePoint[]>();
    for (const id of ids) byOutcome.set(id, []);
    for (const row of rows) {
      byOutcome.get(row.outcomeId)?.push({ t: row.ts.getTime(), p: Number(row.price.toString()) });
    }

    for (const outcome of outcomes) {
      const points = byOutcome.get(outcome.id) ?? [];
      result.set(
        outcome.id,
        summarise(outcome.id, points, Number(outcome.priceCurrent.toString())),
      );
    }
    return result;
  }
}

function summarise(outcomeId: string, points: PricePoint[], stored: number): OutcomeWindow {
  const prices = points.map((point) => point.p);
  const opened = points[0]?.p ?? null;
  const latest = points.at(-1)?.p ?? stored;

  return {
    outcomeId,
    opened,
    latest,
    /*
     * Change as a fraction of where it started, not in percentage points.
     *
     * 50% → 52% is "+4.0%", which is what a quote page means by a change and
     * what a trader's return on the position actually was. Reporting it as
     * "+2%" — the difference in probability points — reads as a change a
     * twentieth the size it was.
     *
     * Null in three cases, all of which are "we do not know" rather than
     * "flat", and the difference matters because the badge is read as a claim:
     *
     *   * Nothing recorded in the window at all.
     *   * Exactly one point. History is written *after* each trade, so a market
     *     whose first trade of the day was its only trade has one row — the
     *     price it moved *to* — and no record of where it moved *from*. The
     *     first version of this divided that single point by itself and
     *     rendered a confident "0.0%" on a market that had just moved two
     *     points, which is the badge lying in the one situation it exists for.
     *   * An opening price of zero, which a settled market legitimately has and
     *     which would otherwise make the badge Infinity.
     */
    change:
      opened === null || opened === 0 || points.length < 2 ? null : (latest - opened) / opened,
    high: prices.length === 0 ? stored : Math.max(...prices),
    low: prices.length === 0 ? stored : Math.min(...prices),
    series: downsample(points, MAX_POINTS),
  };
}

/**
 * Thin a series to at most `limit` points, keeping the first and the last.
 *
 * Evenly spaced by index rather than by time: the ticks are already irregular
 * (a busy market writes more of them), and that irregularity is information —
 * a flat stretch during which nothing traded should look flat, not be
 * interpolated into a slope.
 *
 * The last point is preserved explicitly because it is the one the end dot
 * sits on and the one every figure beside the chart is derived from; dropping
 * it to satisfy the stride would make the chart disagree with the header.
 */
export function downsample(points: readonly PricePoint[], limit: number): PricePoint[] {
  if (points.length <= limit) return [...points];
  const stride = (points.length - 1) / (limit - 1);
  const out: PricePoint[] = [];
  for (let i = 0; i < limit - 1; i += 1) {
    const point = points[Math.floor(i * stride)];
    if (point !== undefined) out.push(point);
  }
  const last = points.at(-1);
  if (last !== undefined) out.push(last);
  return out;
}

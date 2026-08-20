import { Injectable } from '@nestjs/common';
import { Prisma, type MarketState } from '@prisma/client';
import { healthFlags, type HealthFlag, type MarketHealthFacts } from '@stakeam/rules';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';

/** The states a market can be in and still trip a Part 5 flag. */
const WATCHED: MarketState[] = [
  'seeding',
  'funding',
  'active',
  'frozen',
  'pending_resolution',
  'dispute_window',
];

/** What `healthFlags` needs from a market row, and nothing more. */
export interface WatchedMarket {
  readonly id: string;
  readonly state: string;
  readonly createdAt: Date;
  readonly eventDate: Date;
  readonly outcomes: readonly { readonly stakedTotal: Prisma.Decimal }[];
}

/** A flag as the Studio shows it: the live wording, plus how long it has held. */
export interface StandingFlag extends HealthFlag {
  /** When a sweep first recorded this rule on this market. Null if never. */
  readonly since: string | null;
}

/** A flag as the post-mortem reads it, live or long since cleared. */
export interface RecordedFlag {
  readonly rule: string;
  readonly severity: string;
  readonly message: string;
  readonly firstFiredAt: Date;
  readonly lastFiredAt: Date;
  readonly firings: number;
  readonly clearedAt: Date | null;
}

/**
 * Part 5 of docs/ticket-creation-checklist.md — "post-publish monitoring".
 *
 * The checklist writes Part 5 as instructions to a person: watch the split for
 * 48 hours, watch for whale entry, prepare the resolution before the event,
 * resolve promptly. A person watching forty markets watches none of them, so
 * `packages/rules`' `healthFlags()` turns them into a pure function and this
 * service runs it on a timer.
 *
 * The rules themselves live in `packages/rules` and nothing here re-states a
 * threshold. That is the checklist brief's "no duplicated rule logic anywhere",
 * and it is load-bearing rather than tidy: staff told at publish that 35–65% is
 * the band, then flagged at 70/30 by a job with its own idea of lopsided, would
 * rightly stop believing either number.
 *
 * Two callers, one computation. The Studio's Manage tab wants the flags as they
 * are *now* and computes them on read, because a dashboard showing a
 * fifteen-minute-old whale is a dashboard nobody trusts. The sweep wants them
 * *recorded*, because rule 43's post-mortem asks what fired during the market's
 * life and a condition that has since passed leaves no trace in a live read.
 */
@Injectable()
export class MarketHealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Flags for markets already loaded by the caller, keyed by market id.
   *
   * Takes the rows rather than the ids because both callers have already
   * selected them for their own reasons — the Manage tab by its state filter,
   * the sweep by what is live — and re-reading them here would be a second
   * pass over the same table to learn the same thing.
   */
  async flagsFor(markets: readonly WatchedMarket[], now: Date): Promise<Map<string, HealthFlag[]>> {
    const flags = new Map<string, HealthFlag[]>();
    if (markets.length === 0) return flags;

    const ids = markets.map((market) => market.id);
    // Two grouped passes rather than a query per market: the Manage tab is the
    // screen an operator leaves open, and two hundred round trips per refresh
    // is how a dashboard becomes the heaviest thing on the database.
    const [holdersBy, proposals] = await Promise.all([
      this.holderCountsFor(ids),
      this.prisma.resolution.findMany({
        where: { marketId: { in: ids } },
        select: { marketId: true },
        distinct: ['marketId'],
      }),
    ]);

    const proposed = new Set(proposals.map((row) => row.marketId));

    for (const market of markets) {
      const staked = market.outcomes.map((outcome) => Number(outcome.stakedTotal.toString()));
      const pot = staked.reduce((a, b) => a + b, 0);
      const holders = holdersBy.get(market.id);

      const facts: MarketHealthFacts = {
        marketId: market.id,
        state: market.state,
        openedAt: market.createdAt,
        eventDate: market.eventDate,
        leadingShare: pot > 0 ? Math.max(...staked) / pot : null,
        largestHolderShare:
          holders !== undefined && holders.total > 0 ? holders.largest / holders.total : null,
        holders: holders?.count ?? 0,
        resolutionProposed: proposed.has(market.id),
      };

      flags.set(market.id, healthFlags(facts, now));
    }

    return flags;
  }

  /**
   * Holder counts and concentration for a set of markets.
   *
   * Public because the Manage tab prints the holder count beside the flags and
   * would otherwise run the same grouped query a second time on the same
   * request.
   */
  async holderCountsFor(
    ids: readonly string[],
  ): Promise<Map<string, { count: number; largest: number; total: number }>> {
    const holdersBy = new Map<string, { count: number; largest: number; total: number }>();
    if (ids.length === 0) return holdersBy;

    const positions = await this.prisma.position.groupBy({
      by: ['marketId', 'userId'],
      where: { marketId: { in: [...ids] }, shares: { gt: 0 } },
      _sum: { shares: true },
    });

    for (const row of positions) {
      const shares = Number((row._sum.shares ?? new Prisma.Decimal(0)).toString());
      const seen = holdersBy.get(row.marketId) ?? { count: 0, largest: 0, total: 0 };
      seen.count += 1;
      seen.largest = Math.max(seen.largest, shares);
      seen.total += shares;
      holdersBy.set(row.marketId, seen);
    }
    return holdersBy;
  }

  /**
   * Live flags for the Studio, each carrying how long it has been standing.
   *
   * The wording and the severity come from the live computation, so nothing on
   * the screen is stale. `since` comes from the recorded row, because "running
   * 82/18" reads very differently from "running 82/18, and has been since
   * Tuesday" — the second is the one an operator acts on.
   */
  async standingFlagsFor(
    markets: readonly WatchedMarket[],
    now: Date,
  ): Promise<Map<string, StandingFlag[]>> {
    const live = await this.flagsFor(markets, now);
    const ids = [...live.keys()].filter((id) => (live.get(id) ?? []).length > 0);

    const recorded =
      ids.length === 0
        ? []
        : await this.prisma.marketHealthFlag.findMany({
            where: { marketId: { in: ids }, clearedAt: null },
            select: { marketId: true, rule: true, firstFiredAt: true },
          });

    const sinceBy = new Map<string, Date>();
    for (const row of recorded) sinceBy.set(`${row.marketId}:${row.rule}`, row.firstFiredAt);

    const out = new Map<string, StandingFlag[]>();
    for (const [marketId, flags] of live) {
      out.set(
        marketId,
        flags.map((flag) => ({
          ...flag,
          since: sinceBy.get(`${marketId}:${flag.rule}`)?.toISOString() ?? null,
        })),
      );
    }
    return out;
  }

  /**
   * One monitoring pass over every market that could still trip a flag.
   *
   * Idempotent by construction: a rule still firing bumps `lastFiredAt` and the
   * count on the existing row rather than writing a new one, so a sweep that
   * runs twice — or runs every fifteen minutes for a fortnight — leaves one row
   * per market per rule, not four hundred.
   */
  async sweep(now = new Date()): Promise<{
    scanned: number;
    raised: number;
    standing: number;
    cleared: number;
  }> {
    const markets = await this.prisma.market.findMany({
      where: { state: { in: WATCHED } },
      select: {
        id: true,
        state: true,
        createdAt: true,
        eventDate: true,
        outcomes: { select: { stakedTotal: true } },
      },
    });

    const flags = await this.flagsFor(markets, now);
    const open = await this.prisma.marketHealthFlag.findMany({
      where: { marketId: { in: markets.map((market) => market.id) }, clearedAt: null },
      select: { id: true, marketId: true, rule: true },
    });

    const openBy = new Map(open.map((row) => [`${row.marketId}:${row.rule}`, row.id]));
    let raised = 0;
    let standing = 0;

    for (const [marketId, firing] of flags) {
      for (const flag of firing) {
        const key = `${marketId}:${flag.rule}`;
        const already = openBy.get(key);
        openBy.delete(key);

        if (already === undefined) {
          // A rule that fired, cleared, and has come back gets its old row
          // re-opened rather than a second one: the unique key is (market,
          // rule), and "flagged, recovered, flagged again" is a fact about one
          // flag rather than two.
          await this.prisma.marketHealthFlag.upsert({
            where: { marketId_rule: { marketId, rule: flag.rule } },
            create: {
              marketId,
              rule: flag.rule,
              severity: flag.severity,
              message: flag.message,
              firstFiredAt: now,
              lastFiredAt: now,
            },
            update: {
              severity: flag.severity,
              message: flag.message,
              lastFiredAt: now,
              clearedAt: null,
              firings: { increment: 1 },
            },
          });
          raised += 1;
        } else {
          await this.prisma.marketHealthFlag.update({
            where: { id: already },
            data: {
              severity: flag.severity,
              // The wording carries live numbers, so the latest is the useful
              // one. `firstFiredAt` is untouched — it is what says how long.
              message: flag.message,
              lastFiredAt: now,
              firings: { increment: 1 },
            },
          });
          standing += 1;
        }
      }
    }

    // Whatever is left in `openBy` was flagged before and is not firing now.
    const stale = [...openBy.values()];
    if (stale.length > 0) {
      await this.prisma.marketHealthFlag.updateMany({
        where: { id: { in: stale } },
        data: { clearedAt: now },
      });
    }

    // A market that has settled or voided is no longer live, so it is not in
    // `markets` and its open flags would otherwise sit open forever. Closing
    // them here keeps "no `clearedAt`" meaning "a problem right now" — the
    // post-mortem reads the history, cleared rows included, so nothing is lost.
    const settled = await this.prisma.marketHealthFlag.updateMany({
      where: { clearedAt: null, market: { state: { in: ['resolved', 'voided'] } } },
      data: { clearedAt: now },
    });

    const result = {
      scanned: markets.length,
      raised,
      standing,
      cleared: stale.length + settled.count,
    };
    if (result.raised > 0 || result.cleared > 0) logger.info(result, 'market health sweep');
    return result;
  }

  /**
   * Every flag ever raised on one market, cleared ones included.
   *
   * Rule 43's post-mortem is the caller. A flag that cleared is the interesting
   * one: a market that ran 80/20 for three days and then found its other side
   * is a different training example from one that never wobbled, and only the
   * cleared row can tell them apart.
   */
  async historyFor(marketId: string): Promise<RecordedFlag[]> {
    const rows = await this.prisma.marketHealthFlag.findMany({
      where: { marketId },
      orderBy: { firstFiredAt: 'asc' },
    });
    return rows.map((row) => ({
      rule: row.rule,
      severity: row.severity,
      message: row.message,
      firstFiredAt: row.firstFiredAt,
      lastFiredAt: row.lastFiredAt,
      firings: row.firings,
      clearedAt: row.clearedAt,
    }));
  }
}

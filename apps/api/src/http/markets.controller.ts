import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Decimal } from '@stakeam/engine';

import { OptionalJwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { subHours } from 'date-fns';

import { sourceWatchOf } from '../intel/source-watch';
import { PriceCacheService } from '../realtime/price-cache.service';
import { PriceWindowService } from '../market/price-window.service';
import { PrismaService } from '../prisma/prisma.service';
import { PULSE_WINDOW_MINUTES, pulseOf } from './pulse';

/** Timeframes the §7.2 chart offers: 1H · 6H · 1D · 1W · ALL. */
const TIMEFRAME_HOURS: Record<string, number | null> = {
  '1H': 1,
  '6H': 6,
  '1D': 24,
  '1W': 168,
  ALL: null,
};

/**
 * The read path (§11): served from Redis and replicas, never the primary's
 * write path. Nothing here takes a lock or opens a transaction.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('markets')
export class MarketsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prices: PriceCacheService,
    private readonly window: PriceWindowService,
  ) {}

  /** The two shelves on the markets home (§7.1). */
  @Get()
  async list(@Query('shelf') shelf?: string) {
    const markets = await this.prisma.market.findMany({
      where: {
        ...(shelf === 'official' || shelf === 'community' ? { shelf } : {}),
        state: {
          // `seeding` and `funding` are on the shelf as well: a market taking
          // sponsors or stakes is exactly the one that needs to be found.
          in: [
            'seeding',
            'funding',
            'active',
            'frozen',
            'pending_resolution',
            'dispute_window',
            'resolved',
          ],
        },
      },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
      orderBy: [{ state: 'asc' }, { eventDate: 'asc' }],
      take: 50,
    });

    // How busy each market has been today, in one grouped pass rather than a
    // query per card. The shelf sorts by this, so it has to be the real
    // figure — a "trending" order computed from the total pot would just be
    // the volume order wearing a different name, and would rank a market that
    // filled up last month above one that is filling up now.
    const traded = await this.prisma.trade.groupBy({
      by: ['marketId'],
      where: {
        marketId: { in: markets.map((market) => market.id) },
        // A seed takes no side and moves no price (§2.4), so it is liquidity
        // rather than activity and must not read as a busy market.
        side: { not: 'seed' },
        createdAt: { gte: subHours(new Date(), 24) },
      },
      _sum: { cost: true },
    });
    const volume24h = new Map(traded.map((row) => [row.marketId, (row._sum.cost ?? 0).toString()]));

    /*
     * A day of price for every card's headline outcome, in one query.
     *
     * This used to be `await this.sparklineFor(...)` inside a `Promise.all` over
     * the markets — fifty cards, fifty round trips, each scanning the same
     * index. One batched read replaces them, and it carries the 24h change the
     * card now shows beside the dial as well, so the badge and the line are
     * computed from the same points and cannot contradict each other.
     */
    const windows = await this.window.forOutcomes(
      markets
        .map((market) => market.outcomes[0]?.id)
        .filter((id): id is string => id !== undefined),
      DAY_MS,
    );

    return markets.map((market) => {
      const headline = market.outcomes[0]?.id;
      const window = headline === undefined ? undefined : windows.get(headline);
      return {
        ...this.serialiseMarket(market),
        volume24h: volume24h.get(market.id) ?? '0',
        // The card's mini sparkline: last 24h of the headline outcome (§7.1).
        sparkline: (window?.series ?? []).map((point) => String(point.p)),
        /** The move over the same 24h, as a fraction. Null on a young market. */
        change24h: window?.change ?? null,
      };
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const market = await this.prisma.market.findUnique({
      where: { id },
      include: {
        outcomes: { orderBy: { ordinal: 'asc' } },
        creator: {
          select: { id: true, email: true, handle: true, displayName: true },
        },
      },
    });
    if (market === null) throw new NotFoundException('market not found');

    const [annotations, traders, volume, cached, proposal, windows] = await Promise.all([
      this.prisma.marketAnnotation.findMany({
        where: { marketId: id },
        orderBy: { ts: 'asc' },
      }),
      // Seeders are not traders and a seed is not volume: it takes no side and
      // moves no price (§2.4). Counting it would tell a reader the market has an
      // argument going when all it has is liquidity.
      this.prisma.trade.findMany({
        where: { marketId: id, side: { not: 'seed' } },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.trade.aggregate({
        where: {
          marketId: id,
          side: { not: 'seed' },
          createdAt: { gte: subHours(new Date(), 24) },
        },
        _sum: { cost: true },
      }),
      this.prices.read(id),
      // §7.2f: the ticket has to show what has been proposed and how long is
      // left to argue with it. The newest row wins — a re-proposal after a
      // successful dispute supersedes the one it replaced.
      this.prisma.resolution.findFirst({
        where: { marketId: id },
        orderBy: { proposedAt: 'desc' },
      }),
      // The same day of price the card badge uses, so the ticket's header and
      // the card a reader arrived from cannot disagree about which way it went.
      this.window.forMarket(id, DAY_MS),
    ]);

    const creatorProfile =
      market.creatorId === null
        ? null
        : await this.prisma.creatorProfile.findUnique({ where: { userId: market.creatorId } });

    // What the winners actually split. `potTotal` is drained to zero when a
    // market settles — correct, since the pot no longer exists — so a recap
    // card reading it would report nothing was at stake. Summed from the payout
    // legs, which is the money that really landed in people's balances.
    const distributed =
      market.state !== 'resolved'
        ? null
        : await this.prisma.ledgerEntry.aggregate({
            where: { marketId: id, type: 'payout', fundClass: 'user_available' },
            _sum: { amount: true },
          });

    return {
      ...this.serialiseMarket(market),
      // Live prices come from Redis when they are there; the row is the fallback.
      livePrices: cached?.prices ?? null,
      annotations: annotations.map((a) => ({
        id: a.id,
        type: a.type,
        label: a.label,
        // Only `news` carries these: the rest are events this platform
        // generated itself and has no outside source to cite for.
        url: a.url,
        pinnedBy: a.pinnedBy,
        ts: a.ts.toISOString(),
      })),
      traderCount: traders.length,
      /**
       * The headline outcome's 24h move, for the ticket's quote row. Same
       * window and same maths as the card, from the same service.
       */
      change24h: windows.find((w) => w.outcomeId === market.outcomes[0]?.id)?.change ?? null,
      /** §2.6's proposed resolution, and §7.2f's dispute-window countdown. */
      resolution:
        proposal === null
          ? null
          : {
              proposedOutcomeId: proposal.proposedOutcomeId,
              evidenceUrl: proposal.evidenceUrl,
              proposedAt: proposal.proposedAt.toISOString(),
              finalOutcomeId: proposal.finalOutcomeId,
              finalizedAt: proposal.finalizedAt?.toISOString() ?? null,
            },
      disputeClosesAt: market.disputeClosesAt?.toISOString() ?? null,
      volume24h: (volume._sum.cost ?? 0).toString(),
      /** Null while a market is open; what the winners split once it settled. */
      distributed:
        distributed === null ? null : (distributed._sum.amount ?? new Prisma.Decimal(0)).toString(),
      // §2.14c's byline: whose market this is, and what they have earned the
      // right to be called. Read here rather than fetched separately because
      // the share card (§2.14d) renders from this one response.
      creator:
        market.creator === null
          ? null
          : {
              id: market.creator.id,
              handle: market.creator.handle,
              displayName: market.creator.displayName,
              badge: badgeFor(creatorProfile?.level ?? 1),
              followerCount: creatorProfile?.followerCount ?? 0,
              cleanResolutions: creatorProfile?.cleanResolutions ?? 0,
            },
    };
  }

  /**
   * §7.2g's receipt: what the pot became, and what it became for you.
   *
   * Built from the ledger rather than recomputed, which is the whole point.
   * The receipt is the artifact a winner screenshots, so the number on it has
   * to be the number that actually landed in their balance — a second
   * calculation of the payout is a second chance to disagree with the books.
   *
   * The market half is public: anyone reading a resolved market should see the
   * pot, the fee and the per-share value. Only `you` needs a session, and it
   * is null without one.
   */
  @Get(':id/receipt')
  @UseGuards(OptionalJwtGuard)
  async receipt(@Param('id') id: string, @Req() request: RequestWithUser) {
    const market = await this.prisma.market.findUnique({
      where: { id },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new NotFoundException('market not found');
    if (market.state !== 'resolved') return null;

    const [paid, fees] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { marketId: id, type: 'payout', fundClass: 'user_available' },
        _sum: { amount: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { marketId: id, type: { in: ['fee_platform', 'fee_creator'] } },
        _sum: { amount: true },
      }),
    ]);

    const distributed = new Decimal((paid._sum.amount ?? 0).toString());
    const fee = new Decimal((fees._sum.amount ?? 0).toString()).abs();
    const won = market.outcomes.find((row) => row.id === market.resolvedOutcomeId);
    const winningShares = new Decimal((won?.sharesOutstanding ?? 0).toString());

    const userId = request.user?.userId;
    let you = null;
    if (userId !== undefined) {
      const [position, received] = await Promise.all([
        // A resolved market always names a winning outcome; the guard is for
        // the type, not for a case that happens.
        market.resolvedOutcomeId === null
          ? null
          : this.prisma.position.findFirst({
              where: { userId, marketId: id, outcomeId: market.resolvedOutcomeId },
            }),
        this.prisma.ledgerEntry.aggregate({
          where: { userId, marketId: id, type: 'payout', fundClass: 'user_available' },
          _sum: { amount: true },
        }),
      ]);
      const payout = new Decimal((received._sum.amount ?? 0).toString());
      // Someone who held nothing on the winning side still gets a line — "you
      // were on the other side of this" is information, and a blank space is
      // not.
      you = {
        shares: (position?.shares ?? 0).toString(),
        payout: payout.toString(),
        won: payout.gt(0),
      };
    }

    return {
      outcomeLabel: won?.label ?? null,
      distributed: distributed.toString(),
      fee: fee.toString(),
      // What one winning share turned out to be worth — §2.3's pot/q_win.
      perShare: winningShares.gt(0) ? distributed.div(winningShares).toString() : '0',
      winningShares: winningShares.toString(),
      you,
    };
  }

  /** The §7.2a area chart's series. */
  @Get(':id/history')
  async history(
    @Param('id') id: string,
    @Query('outcomeId') outcomeId?: string,
    @Query('tf') timeframe = '1D',
  ) {
    const hours = TIMEFRAME_HOURS[timeframe] ?? null;
    const points = await this.prisma.priceHistory.findMany({
      where: {
        marketId: id,
        ...(outcomeId === undefined ? {} : { outcomeId }),
        ...(hours === null ? {} : { ts: { gte: subHours(new Date(), hours) } }),
      },
      orderBy: { ts: 'asc' },
      take: 2000,
    });

    return points.map((p) => ({
      outcomeId: p.outcomeId,
      price: p.price.toString(),
      pot: p.pot.toString(),
      ts: p.ts.toISOString(),
    }));
  }

  /**
   * A market's pulse — how busy it is, right now.
   *
   * Separate from `context` because it answers a different question on a
   * different clock. Context is what this market is about and changes when the
   * world does; the pulse is what the room is doing and changes every time
   * somebody trades. Folding it into the context response would mean either
   * refetching sixty news items to learn that one trade landed, or letting the
   * activity feed go stale to avoid it.
   *
   * Everything below is counted from executed trades. Nothing here is a price,
   * nothing here is derived from a price, and nothing here can move one — see
   * the note at the top of `pulse.ts`. Seeds are excluded throughout: a seed
   * takes no side and moves no price (§2.4), so counting it as activity would
   * report a busy market to somebody looking at one where nobody has traded.
   */
  @Get(':id/pulse')
  async pulse(@Param('id') id: string) {
    const now = new Date();

    const [outcomes, recent, ticker] = await Promise.all([
      this.prisma.outcome.findMany({
        where: { marketId: id },
        select: { id: true, label: true },
      }),
      // The window plus one row for the last trade however old it is, in one
      // query: the ticker's own rows are the tail, and `pulseOf` takes the
      // latest `createdAt` it can see. An hour of trades on a busy market is a
      // few hundred rows on an index this query is already covered by.
      this.prisma.trade.findMany({
        where: {
          marketId: id,
          side: { not: 'seed' },
          createdAt: { gte: new Date(now.getTime() - PULSE_WINDOW_MINUTES * 60_000) },
        },
        select: { userId: true, side: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      this.prisma.trade.findMany({
        where: { marketId: id, side: { not: 'seed' } },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true,
          userId: true,
          outcomeId: true,
          side: true,
          shares: true,
          cost: true,
          priceAfter: true,
          createdAt: true,
        },
      }),
    ]);

    const labels = new Map(outcomes.map((outcome) => [outcome.id, outcome.label]));

    // A market whose last trade was yesterday has an empty window, and "when
    // did anything last happen" is the one figure a quiet market most needs to
    // be able to answer. The ticker rows carry it — but only the ones the
    // window did not already return: a trade counted twice is a market
    // reporting twice the activity it has, which on the pressure bar is a
    // crowd that does not exist.
    const cutoff = now.getTime() - PULSE_WINDOW_MINUTES * 60_000;
    const seen = [
      ...recent,
      ...ticker
        .filter((trade) => trade.createdAt.getTime() < cutoff)
        .map((trade) => ({
          userId: trade.userId,
          side: trade.side,
          createdAt: trade.createdAt,
        })),
    ];

    return {
      ...pulseOf(seen, now),
      ticker: ticker.map((trade) => ({
        id: trade.id,
        // The same per-market alias the activity feed uses, for the same
        // reason: a trade is not a post, and nobody signed up to have their
        // positions read off a public stream under a name.
        actor: pseudonym(id, trade.userId),
        side: trade.side,
        outcomeId: trade.outcomeId,
        label: labels.get(trade.outcomeId) ?? '',
        shares: trade.shares.toString(),
        cost: trade.cost.toString(),
        price: trade.priceAfter.toString(),
        ts: trade.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The ticket's context panel (§7.2f, extended): what the price has done since
   * it opened, how the room is positioned, and what has just happened.
   *
   * Separate from `detail` on purpose. The detail response is server-rendered
   * into the page and has to be fast; this is everything below the fold, it
   * refreshes after a fill, and none of it is needed to decide whether to
   * trade — only to understand what you are trading into.
   */
  @Get(':id/context')
  async context(@Param('id') id: string) {
    const market = await this.prisma.market.findUnique({
      where: { id },
      select: {
        id: true,
        createdAt: true,
        // The source watch needs both: the body that settles it, and the
        // wording the threshold has to be recovered from.
        question: true,
        sourceName: true,
        outcomes: {
          orderBy: { ordinal: 'asc' },
          select: { id: true, label: true },
        },
      },
    });
    if (market === null) throw new NotFoundException('market not found');

    const labels = new Map(market.outcomes.map((o) => [o.id, o.label]));

    const [windows, biggest, holders, activity, coverage] = await Promise.all([
      // Since it opened, not since yesterday: "high" on a quote page means the
      // highest it has ever been, and a 24h high labelled "High" would be a
      // different number every morning for a price that had not moved.
      //
      // Windowed from the epoch rather than from `createdAt`. They are the same
      // window for any real market, and the epoch is the one that cannot be
      // wrong: a row whose `createdAt` was written after its first price — a
      // restored backup, a fixture — would otherwise report "no opening price"
      // beneath a chart visibly drawing one.
      this.window.forMarket(id, Date.now()),
      this.biggestMove(id),
      // Only live holders. A position closed back to zero is a row that stays
      // behind, and counting it would report a crowd that has already left.
      this.prisma.position.groupBy({
        by: ['outcomeId'],
        where: { marketId: id, shares: { gt: 0 } },
        _count: { userId: true },
      }),
      this.prisma.trade.findMany({
        where: { marketId: id, side: { not: 'seed' } },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          userId: true,
          outcomeId: true,
          side: true,
          shares: true,
          cost: true,
          priceAfter: true,
          createdAt: true,
        },
      }),
      // Everything the research pipeline has linked to this market. Pinned
      // first, then relevance — a staff member who put their name to an item
      // has said it matters more than a score can.
      this.prisma.marketSourceItem.findMany({
        where: { marketId: id },
        orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { relevance: 'desc' }],
        take: 60,
        include: { item: { include: { source: { select: { name: true, tier: true } } } } },
      }),
    ]);

    const holdersBy = new Map(holders.map((row) => [row.outcomeId, row._count.userId]));

    return {
      openedAt: market.createdAt.toISOString(),
      stats: market.outcomes.map((outcome) => {
        const window = windows.find((w) => w.outcomeId === outcome.id);
        return {
          outcomeId: outcome.id,
          label: outcome.label,
          opened: window?.opened ?? null,
          latest: window?.latest ?? null,
          high: window?.high ?? null,
          low: window?.low ?? null,
          change: window?.change ?? null,
          holders: holdersBy.get(outcome.id) ?? 0,
        };
      }),
      /** The single tick that moved the price most, and which side it moved. */
      biggestMove:
        biggest === null
          ? null
          : {
              outcomeId: biggest.outcomeId,
              label: labels.get(biggest.outcomeId) ?? '',
              from: biggest.prev,
              to: biggest.price,
              ts: biggest.ts.toISOString(),
            },
      /**
       * The clustered news stream.
       *
       * One line per story rather than one per outlet: forty papers running
       * the same wire copy is one thing that happened, and listing it forty
       * times buries everything else under the loudest story of the day. The
       * source count is what a reader actually wants from the other
       * thirty-nine.
       */
      news: clusterView(coverage),
      /**
       * The named source's latest figure against the market's own threshold.
       *
       * Absent — not zeroed — when either half is missing. The threshold is
       * recovered from the question's wording, and a parse that failed should
       * produce no strip rather than a wrong line on a price chart.
       */
      sourceWatch: sourceWatchOf({
        sourceName: market.sourceName,
        question: market.question,
        latest: latestOfficialFigure(coverage),
        readings: officialSeries(coverage),
      }),
      activity: activity.map((trade) => ({
        id: trade.id,
        // Pseudonymous, and per-market. A trade is not a post: somebody who
        // has said nothing in the thread has not agreed to have their
        // positions read off a public feed. Salting with the market id stops
        // the same handle being followed from one market to the next.
        actor: pseudonym(id, trade.userId),
        side: trade.side,
        outcomeId: trade.outcomeId,
        label: labels.get(trade.outcomeId) ?? '',
        shares: trade.shares.toString(),
        cost: trade.cost.toString(),
        price: trade.priceAfter.toString(),
        ts: trade.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The largest single move in this market's price, across every outcome.
   *
   * A window function rather than a scan in Node: price history is one row per
   * outcome per trade, so a busy market has tens of thousands of them and the
   * answer is one row. Reading them all back to subtract pairs would make the
   * cheapest fact on the panel the most expensive query on the page.
   */
  private async biggestMove(marketId: string) {
    const rows = await this.prisma.$queryRaw<
      { outcomeId: string; ts: Date; price: Prisma.Decimal; prev: Prisma.Decimal }[]
    >`
      SELECT "outcomeId", ts, price, prev
      FROM (
        SELECT "outcomeId", ts, price,
               lag(price) OVER (PARTITION BY "outcomeId" ORDER BY ts) AS prev
        FROM price_history
        WHERE "marketId" = ${marketId}
      ) moves
      WHERE prev IS NOT NULL
      ORDER BY abs(price - prev) DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      outcomeId: row.outcomeId,
      ts: row.ts,
      price: Number(row.price.toString()),
      prev: Number(row.prev.toString()),
    };
  }

  private serialiseMarket(market: {
    id: string;
    shelf: string;
    question: string;
    sourceName: string;
    sourceUrl: string;
    state: string;
    activationPath: string;
    fundingClosesAt: Date | null;
    eventDate: Date;
    freezeAt: Date | null;
    frozenAt: Date | null;
    freezeReason: string | null;
    voidDate: Date;
    potTotal: { toString(): string };
    liquidityParam: { toString(): string };
    feeBps: number;
    criteriaJson: unknown;
    resolvedOutcomeId: string | null;
    createdAt: Date;
    outcomes: {
      id: string;
      label: string;
      ordinal: number;
      priceCurrent: { toString(): string };
      stakedTotal: { toString(): string };
      sharesOutstanding: { toString(): string };
      isOther: boolean;
    }[];
  }) {
    return {
      id: market.id,
      shelf: market.shelf,
      createdAt: market.createdAt.toISOString(),
      question: market.question,
      sourceName: market.sourceName,
      sourceUrl: market.sourceUrl,
      state: market.state,
      // Path B markets carry a live seed and a floor still to meet, and the
      // ticket has to say so (§2.14a: the funding-state view).
      activationPath: market.activationPath,
      fundingClosesAt: market.fundingClosesAt?.toISOString() ?? null,
      eventDate: market.eventDate.toISOString(),
      // §2.3, checklist rule 22. Sent as data rather than as a rendered
      // sentence so the countdown ticks client-side and the badge, the
      // disabled button and the sheet's refusal all derive from one fact.
      freezeAt: market.freezeAt?.toISOString() ?? null,
      frozenAt: market.frozenAt?.toISOString() ?? null,
      freezeReason: market.freezeReason,
      voidDate: market.voidDate.toISOString(),
      pot: market.potTotal.toString(),
      // The Trade Ticket needs L and shares outstanding to quote the §2.3
      // estimate honestly; without them it can only guess, and a wrong
      // "Est. to win" is worse than none.
      liquidity: market.liquidityParam.toString(),
      feeBps: market.feeBps,
      criteria: market.criteriaJson,
      resolvedOutcomeId: market.resolvedOutcomeId,
      outcomes: market.outcomes.map((o) => ({
        id: o.id,
        label: o.label,
        ordinal: o.ordinal,
        price: o.priceCurrent.toString(),
        staked: o.stakedTotal.toString(),
        shares: o.sharesOutstanding.toString(),
        isOther: o.isOther,
      })),
    };
  }
}

/** §2.14c's ladder names, for the byline. Level 1 wears no badge. */
function badgeFor(level: number): string | null {
  if (level >= 3) return 'Pro';
  if (level === 2) return 'Verified';
  return null;
}

/**
 * A stable, market-local alias for a trader.
 *
 * Six hex characters rather than four: at four, a market with a few hundred
 * traders is likelier than not to show two different people under one name,
 * and a feed that silently merges two traders into one is worse than no feed.
 */
function pseudonym(marketId: string, userId: string): string {
  return createHash('sha256').update(`${marketId}:${userId}`).digest('hex').slice(0, 6);
}

/** One row per cluster, carrying how many outlets ran it. */
function clusterView(
  coverage: readonly {
    relevance: { toString(): string };
    pinnedAt: Date | null;
    pinnedBy: string | null;
    item: {
      id: string;
      headline: string;
      url: string;
      publishedAt: Date;
      clusterId: string | null;
      source: { name: string; tier: string };
    };
  }[],
) {
  const seen = new Map<string, { row: (typeof coverage)[number]; outlets: Set<string> }>();

  for (const row of coverage) {
    // An item the pipeline has not clustered yet stands alone under its own id
    // rather than being dropped — a reader should see a story the minute it
    // lands, not once a later pass has grouped it.
    const key = row.item.clusterId ?? row.item.id;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, { row, outlets: new Set([row.item.source.name]) });
      continue;
    }

    existing.outlets.add(row.item.source.name);

    // Whose byline the line carries.
    //
    // The clusterer seeds each group with its earliest member, on the
    // principle that the outlet which broke a story is the one worth citing —
    // and the first version of this kept whichever row the *query* returned
    // first instead, which for three papers of equal relevance is arbitrary.
    // Three outlets running one wire story were credited to whichever one the
    // database happened to hand back, and it was not the one that broke it.
    const seedIsHere = row.item.id === row.item.clusterId;
    const earlier = row.item.publishedAt < existing.row.item.publishedAt;
    if (seedIsHere || (existing.row.item.id !== existing.row.item.clusterId && earlier)) {
      existing.row = row;
    }
  }

  return [...seen.values()].map(({ row, outlets }) => ({
    id: row.item.id,
    headline: row.item.headline,
    url: row.item.url,
    outlet: row.item.source.name,
    tier: row.item.source.tier,
    sourceCount: outlets.size,
    publishedAt: row.item.publishedAt.toISOString(),
    relevance: Number(row.relevance.toString()),
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    pinnedBy: row.pinnedBy,
  }));
}

/**
 * The most recent figure published by a source that could settle this market.
 *
 * Tier 1 only. A newspaper reporting what the CBN published is not the CBN
 * publishing it, and a source-watch strip that quoted the newspaper would be
 * putting a second-hand number where a reader expects the official one.
 */
function latestOfficialFigure(
  coverage: readonly {
    item: {
      publishedAt: Date;
      factsJson: unknown;
      source: { tier: string };
    };
  }[],
): { value: string | number; publishedAt: Date } | null {
  const official = coverage
    .filter((row) => row.item.source.tier === 'resolution')
    .sort((a, b) => b.item.publishedAt.getTime() - a.item.publishedAt.getTime());

  for (const row of official) {
    const facts = row.item.factsJson;
    if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) continue;
    const [value] = Object.values(facts as Record<string, string | number>);
    if (value !== undefined) return { value, publishedAt: row.item.publishedAt };
  }
  return null;
}

/**
 * Every figure the resolving body has published for this market, for plotting
 * against the threshold.
 *
 * Tier 1 only, for the same reason as the latest figure: a newspaper reporting
 * a CBN print is not the CBN, and a line built from second-hand numbers would
 * be a chart of what the press said rather than of what happened.
 *
 * The first value of `factsJson` is the reading, which is the convention the
 * extraction rules write to. An item with no facts extracted is skipped rather
 * than guessed at — an absent point leaves a gap, and a guessed one puts a
 * wrong number on a money screen.
 */
function officialSeries(
  coverage: readonly {
    item: {
      publishedAt: Date;
      factsJson: unknown;
      source: { name: string; tier: string };
    };
  }[],
): { value: string | number; publishedAt: Date; outlet: string }[] {
  const points: { value: string | number; publishedAt: Date; outlet: string }[] = [];

  for (const row of coverage) {
    if (row.item.source.tier !== 'resolution') continue;
    const facts = row.item.factsJson;
    if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) continue;
    const [value] = Object.values(facts as Record<string, string | number>);
    if (value === undefined) continue;
    points.push({ value, publishedAt: row.item.publishedAt, outlet: row.item.source.name });
  }

  return points;
}

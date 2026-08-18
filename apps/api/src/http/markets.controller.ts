import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { subHours } from 'date-fns';

import { PriceCacheService } from '../realtime/price-cache.service';
import { PrismaService } from '../prisma/prisma.service';

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
@Controller('markets')
export class MarketsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prices: PriceCacheService,
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

    return Promise.all(
      markets.map(async (market) => ({
        ...this.serialiseMarket(market),
        // The card's mini sparkline: last 24h of the headline outcome (§7.1).
        sparkline: await this.sparklineFor(market.id, market.outcomes[0]?.id),
      })),
    );
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

    const [annotations, traders, volume, cached] = await Promise.all([
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
        ts: a.ts.toISOString(),
      })),
      traderCount: traders.length,
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

  private async sparklineFor(marketId: string, outcomeId?: string): Promise<string[]> {
    if (outcomeId === undefined) return [];
    const points = await this.prisma.priceHistory.findMany({
      where: { marketId, outcomeId, ts: { gte: subHours(new Date(), 24) } },
      orderBy: { ts: 'asc' },
      select: { price: true },
      take: 60,
    });
    return points.map((p) => p.price.toString());
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
    voidDate: Date;
    potTotal: { toString(): string };
    liquidityParam: { toString(): string };
    feeBps: number;
    criteriaJson: unknown;
    resolvedOutcomeId: string | null;
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
      question: market.question,
      sourceName: market.sourceName,
      sourceUrl: market.sourceUrl,
      state: market.state,
      // Path B markets carry a live seed and a floor still to meet, and the
      // ticket has to say so (§2.14a: the funding-state view).
      activationPath: market.activationPath,
      fundingClosesAt: market.fundingClosesAt?.toISOString() ?? null,
      eventDate: market.eventDate.toISOString(),
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

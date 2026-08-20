import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Decimal, buy as potBuy, priceOf } from '@stakeam/engine';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { toEngineState, indexOf } from '../market/market-state';
import {
  KOBO_PER_SHARE,
  isValidPrice,
  planMatch,
  remainingOf,
  sharesFor,
  stakeFor,
} from '../orderbook/matching';
import { OrderBookService } from '../orderbook/orderbook.service';
import { averageKobo, routeFor, tightenToPot, withinLimit } from '../orderbook/routing';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How thin a pot has to be before the quote says so.
 *
 * §5's guard: "if a large order would fill mostly from a thin pot, warn and
 * offer to rest the remainder on the book instead of executing." Two thirds is
 * the line — below it the trade is mostly the pot absorbing size, which is
 * exactly when the average price is worst and when resting is worth offering.
 */
const THIN_POT_SHARE = 0.66;

/** How far the pot's average may drift from its quoted price before it is worth saying. */
const IMPACT_WARN_KOBO = 3;

class QuoteDto {
  @IsString() @IsNotEmpty() outcomeId!: string;
  @Matches(/^\d+(\.\d+)?$/) amount!: string;
  @IsOptional() @IsInt() @Min(1) @Max(99) limitKobo?: number;
}

@Controller('markets')
export class OrderBookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly book: OrderBookService,
    private readonly config: PlatformConfigService,
  ) {}

  /**
   * The depth panel: top levels each side, and whether this market has a book
   * at all.
   *
   * Public and unauthenticated, like every other market read. Who is resting an
   * order is not in the response — depth is a quantity at a price, and naming
   * the people behind it would let anybody watch a trader's hand.
   */
  @Get(':id/book')
  async depth(@Param('id') id: string, @Query('levels') levels = '6') {
    const market = await this.prisma.market.findUnique({
      where: { id },
      select: {
        id: true,
        outcomes: { orderBy: { ordinal: 'asc' }, select: { id: true, label: true } },
      },
    });
    if (market === null) throw new BadRequestException('market not found');

    const enabled = await this.book.enabledFor(id);
    const route = routeFor({
      outcomes: market.outcomes.map((outcome, ordinal) => ({ id: outcome.id, ordinal })),
      outcomeId: market.outcomes[0]?.id ?? '',
      limitKobo: null,
    });

    if (!enabled || route === null) {
      // Said explicitly rather than returning empty levels: "no depth" and "no
      // book on this market" look identical on a screen and mean different
      // things to somebody deciding whether to wait.
      return { enabled: false, bookOutcomeId: null, bids: [], asks: [] };
    }

    const depth = await this.book.depth(
      id,
      route.bookOutcomeId,
      Math.min(20, Math.max(1, Number.parseInt(levels, 10) || 6)),
    );

    const view = (rows: typeof depth.asks) =>
      rows.map((row) => ({
        priceKobo: row.priceKobo,
        shares: row.shares.toString(),
        naira: row.naira.toString(),
      }));

    return {
      enabled: true,
      bookOutcomeId: route.bookOutcomeId,
      /** What a buyer of the first outcome can lift. */
      asks: view(depth.asks),
      /** What a seller of it can hit — equivalently, what a buyer of the second can lift. */
      bids: view(depth.bids),
    };
  }

  /**
   * What a trade would do, before anybody commits to it.
   *
   * The one screen where the matched/pot distinction has to be unmistakable, so
   * the response keeps them apart rather than handing the client a total to
   * split. A matched share pays ₦1 exactly; a pot share pays a share of a pot
   * that is still filling. Those are different promises and the numbers are
   * labelled as such.
   */
  @Post(':id/quote')
  async quote(@Param('id') id: string, @Body() body: QuoteDto) {
    const amount = new Decimal(body.amount);
    if (amount.lte(0)) throw new BadRequestException('amount must be greater than zero');
    const limit = body.limitKobo ?? null;
    if (limit !== null && !isValidPrice(limit)) {
      throw new BadRequestException('a limit price is a whole number of kobo between 1 and 99');
    }

    const market = await this.prisma.market.findUnique({
      where: { id },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new BadRequestException('market not found');

    const loaded = toEngineState(market, market.outcomes, await this.config.get('exit_fee_rate'));
    const index = indexOf(loaded, body.outcomeId);

    const enabled = await this.book.enabledFor(id);
    const route = enabled
      ? routeFor({ outcomes: loaded.outcomes, outcomeId: body.outcomeId, limitKobo: limit })
      : null;

    let budget = amount;
    let matchedShares = new Decimal(0);
    let matchedCost = new Decimal(0);
    let bestKobo: number | null = null;

    if (route !== null) {
      // The engine's price, matching what `TradeService` will use when this
      // quote is actually executed. A preview priced off a different number
      // from the fill is worse than no preview.
      const potKobo = priceOf(
        loaded.state.q,
        loaded.state.liquidity,
        indexOf(loaded, route.bookOutcomeId),
      )
        .times(KOBO_PER_SHARE)
        .toNumber();

      const book = await this.book.bookFor(
        this.prisma,
        id,
        route.bookOutcomeId,
        route.side === 'buy' ? 'sell' : 'buy',
      );
      const plan = planMatch({
        takerSide: route.side,
        limitKobo: tightenToPot(route.side, route.limitKobo, potKobo),
        budget,
        book,
        // A quote is for whoever is reading it, and the reader is not
        // necessarily signed in. An empty id matches nobody's resting orders,
        // which slightly overstates depth for somebody who has orders of their
        // own — the fill they get is the honest one, and it is smaller.
        takerUserId: '',
      });
      matchedShares = plan.shares;
      matchedCost = plan.spent;
      budget = plan.remainingBudget;
      bestKobo = plan.fills[0]?.priceKobo ?? null;

      // Depth on the side this trade would take, for the "₦40,000 available at
      // 62k" line beside the price.
      void book.reduce((total, order) => total.plus(remainingOf(order)), new Decimal(0));
    }

    let potShares = new Decimal(0);
    let potCost = new Decimal(0);
    let potAverageKobo: Decimal | null = null;
    let restShares = new Decimal(0);

    if (budget.gt(0)) {
      const trial = potBuy(loaded.state, index, budget.toString());
      const shares = new Decimal(trial.shares.toString());
      const average = averageKobo(budget, shares);
      if (withinLimit(average, limit)) {
        potShares = shares;
        potCost = budget;
        potAverageKobo = average;
        budget = new Decimal(0);
      } else if (route !== null && route.limitKobo !== null) {
        restShares = sharesFor(budget, route.side, route.limitKobo);
      }
    }

    const quotedKobo = priceOf(loaded.state.q, loaded.state.liquidity, index).times(KOBO_PER_SHARE);
    const totalShares = matchedShares.plus(potShares);
    const potShareOfTrade = totalShares.gt(0) ? potShares.div(totalShares).toNumber() : 0;

    const warnings: string[] = [];
    if (
      potShares.gt(0) &&
      potShareOfTrade > THIN_POT_SHARE &&
      potAverageKobo !== null &&
      potAverageKobo.minus(quotedKobo).gt(IMPACT_WARN_KOBO)
    ) {
      warnings.push(
        `Most of this would come from the pot, at an average of ` +
          `${potAverageKobo.toDecimalPlaces(1).toString()}k against a quoted ` +
          `${quotedKobo.toDecimalPlaces(1).toString()}k. Setting a limit would rest the ` +
          `rest on the book instead of paying that.`,
      );
    }

    return {
      /** Filled against other traders. Payout is exact and known now. */
      matched: matchedShares.lte(0)
        ? null
        : {
            shares: matchedShares.toString(),
            cost: matchedCost.toString(),
            exactPayout: matchedShares.toString(),
            priceKobo: bestKobo,
          },
      /** Filled from the pot at the formula price. Payout is an estimate. */
      pot: potShares.lte(0)
        ? null
        : {
            shares: potShares.toString(),
            cost: potCost.toString(),
            averageKobo: potAverageKobo?.toDecimalPlaces(2).toString() ?? null,
            quotedKobo: quotedKobo.toDecimalPlaces(2).toString(),
          },
      /** Would rest on the book at the trader's limit. Has not happened yet. */
      resting:
        restShares.lte(0) || route?.limitKobo == null
          ? null
          : {
              shares: restShares.toString(),
              priceKobo: limit,
              locked: stakeFor(route.side, restShares, route.limitKobo).toString(),
            },
      warnings,
    };
  }

  /** A trader's own open orders, with what each one is holding. */
  @Get('orders/mine')
  @UseGuards(JwtGuard)
  async mine(@Req() request: RequestWithUser, @Query('marketId') marketId?: string) {
    const userId = request.user?.userId;
    if (userId === undefined) throw new BadRequestException('no authenticated user');

    const orders = await this.book.openOrdersFor(userId, marketId);
    return orders.map((order) => {
      /*
        Read back as the trade that was made, not as the row that stores it.

        A binary market keeps one book, on its first outcome, with the second
        expressed as the short side (see `routeFor`). So a person who pressed
        "Buy NO at 15k" has a row saying `sell YES at 85`. Showing them that row
        would be the book's bookkeeping surfacing on a screen where somebody is
        deciding whether to cancel — and 85k is not a number they recognise.
      */
      const complement = order.market.outcomes.find((row) => row.id !== order.outcomeId);
      const asBought =
        order.side === 'sell' && complement !== undefined
          ? { label: complement.label, priceKobo: KOBO_PER_SHARE - order.priceKobo }
          : { label: order.outcome.label, priceKobo: order.priceKobo };

      return {
        id: order.id,
        marketId: order.marketId,
        question: order.market.question,
        outcomeId: order.outcomeId,
        label: asBought.label,
        side: order.side,
        priceKobo: asBought.priceKobo,
        shares: order.shares.toString(),
        filled: order.filled.toString(),
        locked: order.locked.toString(),
        createdAt: order.createdAt.toISOString(),
      };
    });
  }

  /**
   * Matched holdings, which pay a known ₦1 a share rather than a pot share.
   *
   * Kept apart from `/me/positions` rather than merged into it, and the
   * separation is the feature: those two lists are claims on different money
   * with different certainties, and a portfolio that stacked them into one
   * table would be inviting somebody to add an exact figure to an estimate and
   * believe the total.
   */
  @Get('orders/matched')
  @UseGuards(JwtGuard)
  async matched(@Req() request: RequestWithUser, @Query('marketId') marketId?: string) {
    const userId = request.user?.userId;
    if (userId === undefined) throw new BadRequestException('no authenticated user');

    const rows = await this.book.matchedFor(userId, marketId);
    return rows.map((row) => ({
      id: row.id,
      marketId: row.marketId,
      question: row.market.question,
      marketState: row.market.state,
      outcomeId: row.outcomeId,
      /**
       * What the holder actually backed.
       *
       * A short of the first outcome is a long of the second — that is how a
       * binary book carries both buttons on one book — so the label is flipped
       * back before it reaches a screen. Nobody pressed "short YES"; they
       * pressed "Buy NO".
       */
      label: row.side === 'long' ? row.outcome.label : `not ${row.outcome.label}`,
      side: row.side,
      shares: row.shares.toString(),
      staked: row.escrowed.toString(),
      /** ₦1 a share if this holding is right. Exact, and known already. */
      exactPayout: row.shares.toString(),
      settled: row.market.state === 'resolved' || row.market.state === 'voided',
      won:
        row.market.resolvedOutcomeId === null
          ? null
          : (row.market.resolvedOutcomeId === row.outcomeId) === (row.side === 'long'),
    }));
  }

  /**
   * Cancel one, and get the money back in the same transaction.
   *
   * Idempotent: a second tap returns the same cancelled order rather than an
   * error. Telling somebody their cancellation failed when it had already
   * succeeded is how a person cancels twice and then panics.
   */
  @Delete('orders/:orderId')
  @UseGuards(JwtGuard)
  async cancel(@Req() request: RequestWithUser, @Param('orderId') orderId: string) {
    const userId = request.user?.userId;
    if (userId === undefined) throw new BadRequestException('no authenticated user');

    const order = await this.book.cancel(userId, orderId);
    return { id: order.id, state: order.state, released: order.locked.toString() };
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Decimal } from '@stakeam/engine';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { PriceWindowService } from '../market/price-window.service';
import { TradeQueueService } from '../trade/trade-queue.service';
import { WalletService } from '../wallet/wallet.service';
import { RateLimit, RateLimitGuard } from '../hardening/rate-limit.guard';

/** The portfolio's "today", and every card's 24h change. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A positive decimal amount as a string — money never crosses the wire as a float. */
const DECIMAL = /^\d+(\.\d{1,18})?$/;

export class PlaceTradeDto {
  @IsString() @IsNotEmpty() marketId!: string;
  @IsString() @IsNotEmpty() outcomeId!: string;
  @IsIn(['buy', 'sell']) side!: 'buy' | 'sell';
  /** Money to spend on a buy, or shares to return on a sell. */
  @Matches(DECIMAL, { message: 'amount must be a positive decimal string' }) amount!: string;
  /** Client-generated idempotency key (§11). */
  @IsString() @IsNotEmpty() requestId!: string;
  /**
   * §2.15a's reason prompt: the optional one-line "why?" at trade time, which
   * feeds the thread. "The best forecasting education new users can get."
   */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

@Controller()
export class TradesController {
  constructor(
    private readonly queue: TradeQueueService,
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly prices: PriceWindowService,
  ) {}

  @Post('trades')
  @UseGuards(JwtGuard, RateLimitGuard)
  @RateLimit('trade')
  async place(@Req() request: RequestWithUser, @Body() body: PlaceTradeDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    // §11's per-market queue. Ordered within a market, parallel across markets,
    // and a burst is absorbed as stream entries rather than as held database
    // connections. Falls back to inline execution — same service, same row
    // lock, same guarantees — when Redis is away.
    const outcome = await this.queue.submit(
      body.side === 'buy'
        ? {
            kind: 'buy',
            marketId: body.marketId,
            outcomeId: body.outcomeId,
            userId: user.userId,
            amount: body.amount,
            requestId: body.requestId,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          }
        : {
            kind: 'sell',
            marketId: body.marketId,
            outcomeId: body.outcomeId,
            userId: user.userId,
            shares: body.amount,
            requestId: body.requestId,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          },
    );

    if (outcome.status === 'rejected') {
      throw new BadRequestException(outcome.reason ?? 'trade refused');
    }
    if (outcome.status === 'queued' || outcome.trade === undefined) {
      // §11: "users see 'order placed' instantly (accepted into queue) and
      // confirmation when executed." The id is what the client polls with, and
      // `status` is what tells it this is not a fill — a client that reads only
      // the HTTP code sees 2xx and believes it is done.
      return { status: 'queued' as const, accepted: true, requestId: body.requestId };
    }
    const trade = outcome.trade;

    // §3's analytics table. Best-effort by construction — `record` swallows its
    // own failures — because a dashboard is never a reason a trade fails.
    await this.analytics.record(
      'trade_placed',
      { marketId: body.marketId, side: body.side, amount: body.amount },
      user.userId,
    );
    if (body.side === 'buy') {
      const priorTrades = await this.prisma.trade.count({
        where: { userId: user.userId, side: 'buy' },
      });
      if (priorTrades === 1) {
        // The trade just written is the only one: this was their first stake,
        // which is the funnel step that actually matters.
        await this.analytics.record(
          'first_stake',
          { marketId: body.marketId, amount: body.amount },
          user.userId,
        );
      }
    }

    // §2.15a's reason is posted by whoever executes the trade — see
    // TradeQueueService.postReason. It used to be posted here, which was right
    // only for trades that filled while the caller waited: a trade the queue
    // deferred returned 202 from the branch above and its take was dropped on
    // the floor, silently, and precisely under the load that makes the queue
    // defer in the first place.
    return {
      status: 'filled' as const,
      id: trade.id,
      side: trade.side,
      shares: trade.shares.toString(),
      cost: trade.cost.toString(),
      fee: trade.fee.toString(),
      priceAfter: trade.priceAfter.toString(),
    };
  }

  /** What happened to a queued trade, for a client whose submit timed out. */
  @Get('trades/:requestId/status')
  @UseGuards(JwtGuard)
  async tradeStatus(@Req() request: RequestWithUser, @Param('requestId') requestId: string) {
    const outcome = await this.queue.outcomeOf(requestId);
    // Only the requester's own trades: a request id is client-generated, and
    // another account's ids are none of this one's business.
    if (outcome.trade !== undefined && outcome.trade.userId !== request.user!.userId) {
      throw new BadRequestException('not your trade');
    }
    return {
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.trade === undefined
        ? {}
        : {
            trade: {
              id: outcome.trade.id,
              side: outcome.trade.side,
              shares: outcome.trade.shares.toString(),
              cost: outcome.trade.cost.toString(),
              fee: outcome.trade.fee.toString(),
              priceAfter: outcome.trade.priceAfter.toString(),
            },
          }),
    };
  }

  /** The §7.5 wallet header: available and in-open-markets, shown separately. */
  @Get('me/wallet')
  @UseGuards(JwtGuard)
  async wallet_(@Req() request: RequestWithUser) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    const balance = await this.wallet.balanceOf(user.userId);
    return {
      available: balance.available.toString(),
      escrowed: balance.escrowed.toString(),
      tier: user.tier,
    };
  }

  /**
   * The Wallet screen's history (§2.16d).
   *
   * Read straight from the ledger, which is why it is complete by construction:
   * there is no second place a money event could have been recorded, so a line
   * missing here would mean the money never moved. Only the user's own
   * `user_available` legs — the escrow legs are the same events seen from the
   * pot's side, and showing both would double every row on screen.
   */
  @Get('me/wallet/history')
  @UseGuards(JwtGuard)
  async walletHistory(@Req() request: RequestWithUser) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { userId: user.userId, fundClass: 'user_available' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { market: { select: { id: true, question: true } } },
    });

    return entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amount: entry.amount.toString(),
      createdAt: entry.createdAt.toISOString(),
      marketId: entry.marketId,
      marketQuestion: entry.market?.question ?? null,
      ref: entry.ref,
    }));
  }

  /**
   * §7.5's downloadable monthly statement.
   *
   * CSV rather than PDF: a statement's job is to be checkable, and a
   * spreadsheet is what somebody actually reconciles against. Generated from
   * the ledger for the requested month, so it is complete by construction —
   * there is no second place a money event could have been recorded.
   *
   * Escrow legs are excluded for the same reason the on-screen history
   * excludes them: they are the same events seen from the pot's side, and
   * showing both would double every row on a document people balance against.
   */
  @Get('me/wallet/statement')
  @UseGuards(JwtGuard)
  async statement(@Req() request: RequestWithUser, @Query('month') month?: string) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    // `YYYY-MM`, defaulting to the current month.
    const now = new Date();
    const asked = /^\d{4}-\d{2}$/.test(month ?? '')
      ? (month as string)
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const [year, monthIndex] = asked.split('-').map((part) => Number.parseInt(part, 10));
    if (year === undefined || monthIndex === undefined) {
      throw new BadRequestException('month must look like 2026-08');
    }
    const from = new Date(Date.UTC(year, monthIndex - 1, 1));
    const to = new Date(Date.UTC(year, monthIndex, 1));

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        userId: user.userId,
        fundClass: 'user_available',
        createdAt: { gte: from, lt: to },
      },
      orderBy: { createdAt: 'asc' },
      include: { market: { select: { question: true } } },
    });

    const escape = (value: string): string =>
      /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

    const rows = entries.map((entry) =>
      [
        entry.createdAt.toISOString(),
        entry.type,
        entry.amount.toString(),
        entry.currency,
        entry.market?.question ?? '',
        entry.ref ?? '',
      ]
        .map((cell) => escape(String(cell)))
        .join(','),
    );

    const total = entries.reduce((sum, entry) => sum.plus(entry.amount.toString()), new Decimal(0));

    return {
      month: asked,
      rows: entries.length,
      net: total.toString(),
      csv: ['date,type,amount,currency,market,reference', ...rows].join('\n'),
    };
  }

  /**
   * Positions — the ticket's panel (§7.2d) and the portfolio screen (§7.1).
   *
   * Open only by default, which is what the ticket panel has always asked
   * for. `?all=1` adds settled and closed rows, because §7.1's "my positions"
   * wants "open positions with live P&L, closed history, pending payouts" and
   * a screen that only ever shows what is still running cannot show somebody
   * what they won.
   */
  @Get('me/positions')
  @UseGuards(JwtGuard)
  async positions(@Req() request: RequestWithUser, @Query('all') all?: string) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    const everything = all === '1' || all === 'true';

    const positions = await this.prisma.position.findMany({
      where: {
        userId: user.userId,
        ...(everything ? {} : { shares: { gt: 0 } }),
      },
      include: {
        market: {
          select: {
            id: true,
            question: true,
            state: true,
            resolvedOutcomeId: true,
            shelf: true,
            eventDate: true,
            resolutions: { select: { finalizedAt: true }, take: 1 },
          },
        },
        outcome: { select: { id: true, label: true, priceCurrent: true } },
      },
    });

    /*
     * A day of price for every open holding, in one query.
     *
     * The portfolio header claims a figure for today — "up ₦412" — and a row
     * cannot substantiate that from its current price alone; it needs where the
     * price stood when the day began. The same fetch supplies each row's
     * sparkline, so the line and the number can never disagree with each other.
     *
     * Open positions only: a settled one's price is pinned at 0 or 1 and its
     * result already lives in `realizedPnl`, so a day of history for it would
     * be work done to draw a line that says nothing.
     */
    const windows = await this.prices.forOutcomes(
      positions.filter((p) => p.market.resolvedOutcomeId === null).map((p) => p.outcomeId),
      DAY_MS,
    );

    return positions.map((p) => {
      const resolved = p.market.resolvedOutcomeId;
      const window = windows.get(p.outcomeId);
      return {
        /** Where the price stood 24h ago, and the move since. Null if younger. */
        price24hAgo: window?.opened?.toString() ?? null,
        change24h: window?.change ?? null,
        /** Points for the row's sparkline, already thinned for drawing. */
        series: window?.series ?? [],
        settlesAt: p.market.eventDate.toISOString(),
        marketId: p.marketId,
        marketQuestion: p.market.question,
        marketState: p.market.state,
        shelf: p.market.shelf,
        outcomeId: p.outcomeId,
        outcomeLabel: p.outcome.label,
        shares: p.shares.toString(),
        avgPrice: p.avgPrice.toString(),
        price: p.outcome.priceCurrent.toString(),
        realizedPnl: p.realizedPnl.toString(),
        // Null while the market is still running. `true`/`false` only once
        // there is a result — "not won yet" and "lost" must not look the same.
        won: resolved === null ? null : resolved === p.outcomeId,
        settledAt: p.market.resolutions[0]?.finalizedAt?.toISOString() ?? null,
      };
    });
  }
}

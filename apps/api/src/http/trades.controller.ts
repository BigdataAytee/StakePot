import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { AnalyticsService } from '../analytics/analytics.service';
import { ThreadService } from '../community-layer/thread.service';
import { PrismaService } from '../prisma/prisma.service';
import { TradeQueueService } from '../trade/trade-queue.service';
import { WalletService } from '../wallet/wallet.service';
import { RateLimit, RateLimitGuard } from '../hardening/rate-limit.guard';

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
    private readonly threads: ThreadService,
    private readonly analytics: AnalyticsService,
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
          }
        : {
            kind: 'sell',
            marketId: body.marketId,
            outcomeId: body.outcomeId,
            userId: user.userId,
            shares: body.amount,
            requestId: body.requestId,
          },
    );

    if (outcome.status === 'rejected') {
      throw new BadRequestException(outcome.reason ?? 'trade refused');
    }
    if (outcome.status === 'queued' || outcome.trade === undefined) {
      // §11: "users see 'order placed' instantly (accepted into queue) and
      // confirmation when executed." 202, with the id to poll.
      return { accepted: true, requestId: body.requestId };
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

    // The reason posts *after* the trade, so the badge it carries is the
    // position the trade just created — which is the point of asking at trade
    // time rather than in the thread. Best-effort: a rejected comment (rate
    // limit, a tripped rule) must never unwind a settled trade.
    if (body.reason !== undefined && body.reason.trim().length > 0) {
      await this.threads
        .post({
          marketId: body.marketId,
          userId: user.userId,
          text: body.reason,
          fromTrade: true,
        })
        .catch(() => undefined);
    }

    return {
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

  /** Open positions, for the ticket's position panel (§7.2d). */
  @Get('me/positions')
  @UseGuards(JwtGuard)
  async positions(@Req() request: RequestWithUser) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const positions = await this.prisma.position.findMany({
      where: { userId: user.userId, shares: { gt: 0 } },
      include: {
        market: { select: { id: true, question: true, state: true } },
        outcome: { select: { id: true, label: true, priceCurrent: true } },
      },
    });

    return positions.map((p) => ({
      marketId: p.marketId,
      marketQuestion: p.market.question,
      marketState: p.market.state,
      outcomeId: p.outcomeId,
      outcomeLabel: p.outcome.label,
      shares: p.shares.toString(),
      avgPrice: p.avgPrice.toString(),
      price: p.outcome.priceCurrent.toString(),
      realizedPnl: p.realizedPnl.toString(),
    }));
  }
}

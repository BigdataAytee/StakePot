import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString, Matches } from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TradeService } from '../trade/trade.service';
import { WalletService } from '../wallet/wallet.service';

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
}

@Controller()
export class TradesController {
  constructor(
    private readonly trades: TradeService,
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('trades')
  @UseGuards(JwtGuard)
  async place(@Req() request: RequestWithUser, @Body() body: PlaceTradeDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const trade =
      body.side === 'buy'
        ? await this.trades.buy({
            marketId: body.marketId,
            outcomeId: body.outcomeId,
            userId: user.userId,
            amount: body.amount,
            requestId: body.requestId,
          })
        : await this.trades.sell({
            marketId: body.marketId,
            outcomeId: body.outcomeId,
            userId: user.userId,
            shares: body.amount,
            requestId: body.requestId,
          });

    return {
      id: trade.id,
      side: trade.side,
      shares: trade.shares.toString(),
      cost: trade.cost.toString(),
      fee: trade.fee.toString(),
      priceAfter: trade.priceAfter.toString(),
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

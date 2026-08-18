import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Trade } from '@prisma/client';
import { Decimal, buy, sell, type TradeResult } from '@stakeam/engine';

import { LedgerService, type Tx } from '../ledger/ledger.service';
import { release } from '../ledger/posting';
import { indexOf, outcomeAt, toEngineState } from '../market/market-state';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { WalletService } from '../wallet/wallet.service';

export class TradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeError';
  }
}

export interface BuyInput {
  readonly marketId: string;
  readonly outcomeId: string;
  readonly userId: string;
  /** Money to spend. */
  readonly amount: string;
  /** Client-generated idempotency key (§11). A retry must never double-fill. */
  readonly requestId: string;
}

export interface SellInput {
  readonly marketId: string;
  readonly outcomeId: string;
  readonly userId: string;
  /** Shares to return. */
  readonly shares: string;
  readonly requestId: string;
}

const dec = (v: Decimal | Decimal): Prisma.Decimal => new Prisma.Decimal(v.toString());

/**
 * The trade path (§2.3, §11).
 *
 * "Every trade executes atomically in one DB transaction: read pot state →
 * price via formula → fee → ledger entries → new pot state → price snapshot →
 * price_changed event."
 *
 * Two trades on one market must never price off the same pot state. §11's
 * answer at scale is a per-market queue; until that lands in step 14, the same
 * guarantee comes from taking a row lock on the market inside the transaction,
 * which serialises writers per market while leaving different markets fully
 * parallel — the same property, enforced one layer down.
 */
@Injectable()
export class TradeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly prices: PriceCacheService,
    private readonly rg: RgService,
  ) {}

  /**
   * Push the new prices onto the live feed.
   *
   * Deliberately after the transaction commits, not inside it: a tick for a
   * trade that then rolled back would show every watcher a price that never
   * existed. A tick that fails to publish is a missed frame — the next trade
   * corrects it, and the chart's history comes from `price_history` regardless.
   */
  private async broadcast(
    marketId: string,
    loaded: ReturnType<typeof toEngineState>,
    result: TradeResult,
  ): Promise<void> {
    const prices: Record<string, string> = {};
    for (const [i, outcome] of loaded.outcomes.entries()) {
      const price = result.pricesAfter[i];
      if (price !== undefined) prices[outcome.id] = price.toString();
    }
    await this.prices
      .publish({ marketId, prices, pot: result.state.pot.toString(), at: Date.now() })
      .catch(() => undefined);
  }

  async buy(input: BuyInput): Promise<Trade> {
    const amount = new Decimal(input.amount);
    if (amount.lte(0)) throw new TradeError('amount must be greater than zero');

    const committed = await this.prisma.$transaction(async (tx) => {
      const existing = await this.replay(tx, input.requestId);
      if (existing) return existing;

      const loaded = await this.lockAndLoad(tx, input.marketId, input.userId);
      const index = indexOf(loaded, input.outcomeId);

      // §2.12's limits are checked here rather than at the edge: this is the one
      // path money can leave a user's balance through, so a self-exclusion that
      // holds here holds everywhere, including on any endpoint added later.
      await this.rg.assertMayStake(input.userId, amount);

      // Escrow first: a trade the user cannot fund must not move the market.
      await this.wallet.escrow({
        userId: input.userId,
        marketId: input.marketId,
        amount,
        type: 'trade_buy',
        ref: input.requestId,
        tx,
      });

      const result = buy(loaded.state, index, amount.toString());
      await this.persist(tx, input, loaded, index, result, 'buy', amount, new Decimal(0));
      const trade = await this.recordTrade(tx, input, index, result, 'buy', amount, new Decimal(0));

      return { trade, loaded, result };
    });

    if ('loaded' in committed) {
      await this.broadcast(input.marketId, committed.loaded, committed.result);
      return committed.trade;
    }
    return committed;
  }

  /**
   * Early exit (§2.3).
   *
   * The pot gives up the full refund; the exit fee is withheld from the seller
   * and credited to `platform_fees`. Taking it out of the pot instead would
   * break `pot === C(q) − C(q0)`.
   */
  async sell(input: SellInput): Promise<Trade> {
    const shares = new Decimal(input.shares);
    if (shares.lte(0)) throw new TradeError('shares must be greater than zero');

    const committed = await this.prisma.$transaction(async (tx) => {
      const existing = await this.replay(tx, input.requestId);
      if (existing) return existing;

      const loaded = await this.lockAndLoad(tx, input.marketId);
      const index = indexOf(loaded, input.outcomeId);

      const position = await tx.position.findUnique({
        where: {
          userId_marketId_outcomeId: {
            userId: input.userId,
            marketId: input.marketId,
            outcomeId: input.outcomeId,
          },
        },
      });
      const held = new Decimal(position?.shares.toString() ?? '0');
      if (held.lt(shares)) {
        throw new TradeError(
          `cannot sell ${shares.toString()} shares — the position holds ${held.toString()}`,
        );
      }

      const result = sell(loaded.state, index, shares.toString());
      const gross = new Decimal(result.gross.toString());
      const fee = new Decimal(result.exitFee.toString());
      const net = new Decimal(result.net.toString());

      // The full refund leaves escrow; the fee is then taken off the seller's
      // side and booked to platform fees, so the pot identity is untouched.
      await this.ledger.post(
        tx,
        release({
          userId: input.userId,
          marketId: input.marketId,
          amount: new Decimal(gross),
          type: 'trade_sell',
          currency: 'SPC',
        }),
        input.requestId,
      );

      if (fee.gt(0)) {
        await this.ledger.post(
          tx,
          [
            {
              userId: input.userId,
              marketId: input.marketId,
              type: 'fee_platform',
              fundClass: 'user_available',
              amount: fee.negated(),
              currency: 'SPC',
            },
            {
              userId: 'sys_platform',
              marketId: input.marketId,
              type: 'fee_platform',
              fundClass: 'platform_fees',
              amount: fee,
              currency: 'SPC',
            },
          ],
          input.requestId,
        );
      }

      await this.persist(tx, input, loaded, index, result, 'sell', gross.negated(), fee);
      const trade = await this.recordTrade(tx, input, index, result, 'sell', net, fee);

      return { trade, loaded, result };
    });

    if ('loaded' in committed) {
      await this.broadcast(input.marketId, committed.loaded, committed.result);
      return committed.trade;
    }
    return committed;
  }

  /** A repeated request_id returns the original fill rather than trading again. */
  private async replay(tx: Tx, requestId: string): Promise<Trade | null> {
    return tx.trade.findUnique({ where: { requestId } });
  }

  /**
   * Take the market's row lock, then read its state.
   *
   * `FOR UPDATE` is what makes "read pot state → price → write" atomic against a
   * concurrent trade on the same market. Postgres queues the second writer here
   * rather than letting it price off state that is about to change.
   */
  private async lockAndLoad(tx: Tx, marketId: string, userId?: string) {
    await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;

    const market = await tx.market.findUniqueOrThrow({
      where: { id: marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market.state !== 'active') {
      throw new TradeError(`market is ${market.state} — trading is closed`);
    }

    // §7.2's countdown is a promise: trading freezes when the event starts. The
    // job that flips the market's state runs on a sweep and can be late, so the
    // money path checks the clock itself rather than trusting the flag — a trade
    // placed after kick-off by someone watching the match is the exact abuse
    // this closes.
    if (market.eventDate.getTime() <= Date.now()) {
      throw new TradeError('this market froze when the event started');
    }

    // §2.5: "Creator cannot place directional stakes in own market (enforced at
    // trade endpoint), except symmetric seed." A creator who can take a side in
    // the market they also settle has both the motive and the means, and the
    // conduct bond is not a substitute for removing the conflict.
    if (userId !== undefined && market.creatorId !== null && market.creatorId === userId) {
      throw new TradeError(
        'you created this market, so you cannot take a side in it — only a symmetric seed',
      );
    }

    // §2.7: "staff blocked from trading entirely."
    //
    // Not a conflict on one market but on all of them: staff see the resolution
    // queue, the drafts queue and the abuse flags before anybody else, and a
    // resolver who holds a position anywhere is a resolver whose decisions can
    // be questioned. Enforced here rather than at the endpoint because this is
    // the one path a position can be opened through, so it holds for any
    // endpoint added later.
    if (userId !== undefined) {
      const trader = await tx.user.findUnique({
        where: { id: userId },
        select: { role: true, status: true },
      });
      if (trader !== null && trader.role !== 'user') {
        throw new TradeError(
          'staff accounts cannot trade — the people who settle markets do not hold positions in them',
        );
      }
      // A frozen account (§6.5's abuse queue) keeps its balance and loses the
      // ability to add to a position.
      if (trader !== null && trader.status !== 'active') {
        throw new TradeError('this account is frozen — contact support');
      }
    }

    const exitFeeRate = await this.config.get('exit_fee_rate');
    return toEngineState(market, market.outcomes, exitFeeRate);
  }

  /** New pot state, share counts, prices, and the §7.2 chart snapshot. */
  private async persist(
    tx: Tx,
    input: { marketId: string },
    loaded: ReturnType<typeof toEngineState>,
    index: number,
    result: TradeResult,
    side: 'buy' | 'sell',
    stakedDelta: Decimal,
    _fee: Decimal,
  ): Promise<void> {
    const traded = outcomeAt(loaded, index);
    const sharesDelta = side === 'buy' ? result.shares : result.shares.negated();

    await tx.outcome.update({
      where: { id: traded.id },
      data: {
        sharesOutstanding: { increment: dec(sharesDelta) },
        stakedTotal: { increment: dec(stakedDelta) },
      },
    });

    // The pot moves by exactly the money that moved, database-side, for the same
    // reason position shares do: Σ stakedTotal === potTotal has to hold exactly,
    // and two exact Postgres additions of the same value always agree.
    await tx.market.update({
      where: { id: input.marketId },
      data: { potTotal: { increment: dec(stakedDelta) } },
    });

    // Every outcome's price moved, not just the one traded.
    for (const [i, outcome] of loaded.outcomes.entries()) {
      const price = result.pricesAfter[i];
      if (price === undefined) continue;
      await tx.outcome.update({
        where: { id: outcome.id },
        data: { priceCurrent: dec(price) },
      });
      await tx.priceHistory.create({
        data: {
          marketId: input.marketId,
          outcomeId: outcome.id,
          price: dec(price),
          pot: dec(result.state.pot),
        },
      });
    }
  }

  private async recordTrade(
    tx: Tx,
    input: BuyInput | SellInput,
    index: number,
    result: TradeResult,
    side: 'buy' | 'sell',
    cost: Decimal,
    fee: Decimal,
  ): Promise<Trade> {
    const priceAfter = result.pricesAfter[index];
    const sharesDelta = side === 'buy' ? result.shares : result.shares.negated();

    const trade = await tx.trade.create({
      data: {
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        userId: input.userId,
        side,
        shares: dec(result.shares),
        cost: dec(cost),
        fee: dec(fee),
        priceAfter: dec(priceAfter ?? new Decimal(0)),
        requestId: input.requestId,
      },
    });

    await this.updatePosition(tx, input, sharesDelta, cost, side);
    return trade;
  }

  /**
   * Keep the position in step.
   *
   * `shares` moves by a database-side increment, exactly as
   * `outcomes.sharesOutstanding` does. Computing it in JS and writing the result
   * would let the two drift apart by a rounding unit, and Σpositions ===
   * sharesOutstanding is what resolution depends on to conserve. Postgres
   * numeric addition is exact; two exact additions of the same value agree.
   *
   * `avgPrice` is the average cost per share paid on the way in, and realised
   * P&L accrues on the way out. Neither feeds conservation, so both are computed
   * here rather than in SQL.
   */
  private async updatePosition(
    tx: Tx,
    input: BuyInput | SellInput,
    sharesDelta: Decimal,
    cost: Decimal,
    side: 'buy' | 'sell',
  ): Promise<void> {
    const key = {
      userId: input.userId,
      marketId: input.marketId,
      outcomeId: input.outcomeId,
    };
    const existing = await tx.position.findUnique({
      where: { userId_marketId_outcomeId: key },
    });

    const heldBefore = new Decimal(existing?.shares.toString() ?? '0');
    const avgBefore = new Decimal(existing?.avgPrice.toString() ?? '0');

    if (side === 'buy') {
      const heldAfter = heldBefore.plus(sharesDelta);
      const avgAfter = heldAfter.isZero()
        ? new Decimal(0)
        : heldBefore.times(avgBefore).plus(cost).div(heldAfter);

      if (existing === null) {
        await tx.position.create({
          data: { ...key, shares: dec(sharesDelta), avgPrice: dec(avgAfter), realizedPnl: 0 },
        });
        return;
      }
      await tx.position.update({
        where: { userId_marketId_outcomeId: key },
        data: { shares: { increment: dec(sharesDelta) }, avgPrice: dec(avgAfter) },
      });
      return;
    }

    // Selling: proceeds above what those shares cost are realised P&L.
    const soldShares = sharesDelta.negated();
    const realised = cost.minus(soldShares.times(avgBefore));
    await tx.position.update({
      where: { userId_marketId_outcomeId: key },
      data: {
        shares: { increment: dec(sharesDelta) },
        realizedPnl: { increment: dec(realised) },
      },
    });
  }
}

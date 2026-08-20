import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MatchSide, Order, OrderSide } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { FlagsService } from '../flags/flags.service';
import { LedgerService, type Tx } from '../ledger/ledger.service';
import { release } from '../ledger/posting';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import {
  MONEY_DP,
  QUANTUM,
  depthLevels,
  isValidPrice,
  opposite,
  planMatch,
  remainingOf,
  stakeFor,
  type Fill,
  type RestingOrder,
  type Side,
} from './matching';

export class OrderBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderBookError';
  }
}

/**
 * The flag that turns matching on, one market at a time.
 *
 * The existing flag table already carries an `allowList`, an `enabled` kill
 * switch and a rollout percentage — and `flagOn` takes a *subject*, which
 * nothing says has to be a user. Passing the market id makes the allow list a
 * list of markets, which is exactly the per-market switch the rollout needs,
 * with an instant global off already wired to the console. A second flag
 * mechanism for the same job would have been a second thing to check in an
 * incident.
 */
export const ORDER_BOOK_FLAG = 'order-book';

const dec = (v: Decimal): Prisma.Decimal => new Prisma.Decimal(v.toString());
const num = (v: { toString(): string }): Decimal => new Decimal(v.toString());

/** Which way a matched position pays, given the side that acquired it. */
const matchSideFor = (side: Side): MatchSide => (side === 'buy' ? 'long' : 'short');

export interface PlaceInput {
  readonly marketId: string;
  readonly outcomeId: string;
  readonly userId: string;
  readonly side: Side;
  readonly priceKobo: number;
  /** Shares to rest. Money locked is `stakeFor(side, shares, price)`. */
  readonly shares: Decimal;
  readonly requestId: string;
}

export interface MatchResult {
  readonly fills: readonly Fill[];
  readonly shares: Decimal;
  readonly spent: Decimal;
  readonly remainingBudget: Decimal;
}

/**
 * The matching layer.
 *
 * Peer-to-peer fills sit *above* the pot, never inside it. Two properties are
 * the whole design, and every method here exists to hold one of them:
 *
 * **The platform carries no capital and no risk.** A matched pair escrows
 * exactly ₦1 per share between the two of them — the buyer's price and the
 * seller's counter-stake — and exactly one side is paid that ₦1 at settlement.
 * Nobody underwrites anything. `matching.ts` proves the arithmetic; this
 * service is what makes the database agree with it.
 *
 * **The two pools never touch.** Matched shares live in `matched_positions`,
 * not in `positions`, so the pot's resolution query cannot see them even by
 * accident — and pot shares never appear here. `outcomes.sharesOutstanding`
 * and `markets.potTotal` are untouched by everything below, which is what
 * keeps §2.3's pot identity exact and `packages/engine` unmodified.
 *
 * Everything runs inside a transaction the caller opened under the market's
 * row lock. There is no second concurrency path.
 */
@Injectable()
export class OrderBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallet: WalletService,
    private readonly flags: FlagsService,
  ) {}

  /** Whether this market matches peer-to-peer, or is pot-only as before. */
  async enabledFor(marketId: string): Promise<boolean> {
    return this.flags.on(ORDER_BOOK_FLAG, marketId);
  }

  // ------------------------------------------------------------------ reads

  /** Open orders on one side of one outcome, oldest first within a price. */
  async bookFor(tx: Tx, marketId: string, outcomeId: string, side: Side): Promise<RestingOrder[]> {
    const rows = await tx.order.findMany({
      where: { marketId, outcomeId, side: side as OrderSide, state: 'open' },
      orderBy: [{ priceKobo: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        userId: true,
        priceKobo: true,
        shares: true,
        filled: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      priceKobo: row.priceKobo,
      shares: num(row.shares),
      filled: num(row.filled),
      createdAt: row.createdAt,
    }));
  }

  /**
   * Both sides of one outcome's book, aggregated to price levels.
   *
   * Read outside a transaction: depth is a display figure that is stale the
   * moment it is drawn, and taking the market's lock to render a panel would
   * put a read on the same queue as the trades.
   */
  async depth(marketId: string, outcomeId: string, levels = 6) {
    const rows = await this.prisma.order.findMany({
      where: { marketId, outcomeId, state: 'open' },
      select: {
        id: true,
        userId: true,
        side: true,
        priceKobo: true,
        shares: true,
        filled: true,
        createdAt: true,
      },
    });

    const asRestingOrders = (side: OrderSide): RestingOrder[] =>
      rows
        .filter((row) => row.side === side)
        .map((row) => ({
          id: row.id,
          userId: row.userId,
          priceKobo: row.priceKobo,
          shares: num(row.shares),
          filled: num(row.filled),
          createdAt: row.createdAt,
        }));

    // Named from the *taker's* point of view, which is how a trade sheet reads
    // it: "bids" is what a seller can hit, "asks" what a buyer can lift.
    return {
      // A buyer takes from resting sells.
      asks: depthLevels('buy', asRestingOrders('sell')).slice(0, levels),
      // A seller takes from resting buys.
      bids: depthLevels('sell', asRestingOrders('buy')).slice(0, levels),
    };
  }

  /** A trader's own open orders, newest first. */
  async openOrdersFor(userId: string, marketId?: string) {
    return this.prisma.order.findMany({
      where: { userId, state: 'open', ...(marketId === undefined ? {} : { marketId }) },
      orderBy: { createdAt: 'desc' },
      include: {
        outcome: { select: { label: true } },
        market: { select: { question: true } },
      },
      take: 100,
    });
  }

  /** Matched positions, which pay a known ₦1 a share rather than a pot share. */
  async matchedFor(userId: string, marketId?: string) {
    return this.prisma.matchedPosition.findMany({
      where: { userId, shares: { gt: 0 }, ...(marketId === undefined ? {} : { marketId }) },
      include: {
        outcome: { select: { label: true } },
        market: { select: { question: true, state: true, resolvedOutcomeId: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  // ------------------------------------------------------------- the writes

  /**
   * Match a taker's budget against the book, minting a pair per fill.
   *
   * The taker's money moves available → escrow here. The maker's does not: it
   * moved when their order rested, and a fill only reclassifies it from "held
   * against an open order" to "collateral behind a position". Posting it again
   * would double-count the maker's stake, and the ledger would refuse — which
   * is the ledger doing its job, but the point is not to ask.
   */
  async match(
    tx: Tx,
    input: {
      readonly marketId: string;
      readonly outcomeId: string;
      readonly userId: string;
      readonly side: Side;
      readonly limitKobo: number | null;
      readonly budget: Decimal;
      readonly requestId: string;
    },
  ): Promise<MatchResult> {
    const book = await this.bookFor(tx, input.marketId, input.outcomeId, opposite(input.side));
    const plan = planMatch({
      takerSide: input.side,
      limitKobo: input.limitKobo,
      budget: input.budget,
      book,
      takerUserId: input.userId,
    });

    if (plan.fills.length === 0) {
      return {
        fills: [],
        shares: new Decimal(0),
        spent: new Decimal(0),
        remainingBudget: input.budget,
      };
    }

    // The taker's whole matched stake in one posting rather than one per fill:
    // it is one movement of one person's money, and a wallet history that split
    // it across five rows because the book had five levels would be describing
    // the book rather than the trade.
    await this.wallet.escrow({
      userId: input.userId,
      marketId: input.marketId,
      amount: plan.spent,
      type: 'order_lock',
      ref: input.requestId,
      tx,
    });

    for (const fill of plan.fills) {
      await this.applyFill(tx, input, fill);
    }

    return plan;
  }

  private async applyFill(
    tx: Tx,
    input: { marketId: string; outcomeId: string; userId: string; side: Side; requestId: string },
    fill: Fill,
  ): Promise<void> {
    const makerSide = opposite(input.side);

    const maker = await tx.order.findUniqueOrThrow({ where: { id: fill.makerOrderId } });
    const filledAfter = num(maker.filled).plus(fill.shares);
    const exhausted = filledAfter.gte(num(maker.shares));

    await tx.order.update({
      where: { id: maker.id },
      data: {
        filled: dec(filledAfter),
        // Decremented by the fill's own stake, and zeroed outright when the
        // order is exhausted. The stakes are differences of a cumulative (see
        // `cumulativeStake`) so they already sum to the lock exactly; setting
        // zero on the last fill is the belt to that braces, because a lock
        // that does not reach zero is money nobody can reach.
        locked: exhausted ? dec(new Decimal(0)) : dec(num(maker.locked).minus(fill.makerStake)),
        ...(exhausted ? { state: 'filled' as const } : {}),
      },
    });

    await tx.orderFill.create({
      data: {
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        requestId: input.requestId,
        makerOrderId: maker.id,
        takerUserId: input.userId,
        makerUserId: maker.userId,
        takerSide: input.side as OrderSide,
        priceKobo: fill.priceKobo,
        shares: dec(fill.shares),
      },
    });

    await this.creditMatched(tx, {
      userId: input.userId,
      marketId: input.marketId,
      outcomeId: input.outcomeId,
      side: matchSideFor(input.side),
      shares: fill.shares,
      escrowed: fill.takerStake,
    });
    await this.creditMatched(tx, {
      userId: maker.userId,
      marketId: input.marketId,
      outcomeId: input.outcomeId,
      side: matchSideFor(makerSide),
      shares: fill.shares,
      escrowed: fill.makerStake,
    });
  }

  private async creditMatched(
    tx: Tx,
    input: {
      userId: string;
      marketId: string;
      outcomeId: string;
      side: MatchSide;
      shares: Decimal;
      escrowed: Decimal;
    },
  ): Promise<void> {
    const key = {
      userId_marketId_outcomeId_side: {
        userId: input.userId,
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        side: input.side,
      },
    };
    const existing = await tx.matchedPosition.findUnique({ where: key });
    if (existing === null) {
      await tx.matchedPosition.create({
        data: {
          userId: input.userId,
          marketId: input.marketId,
          outcomeId: input.outcomeId,
          side: input.side,
          shares: dec(input.shares),
          escrowed: dec(input.escrowed),
        },
      });
      return;
    }
    await tx.matchedPosition.update({
      where: key,
      // Database-side increments, for the same reason the pot's share counts
      // use them: Σ escrowed has to equal ₦1 × Σ shares exactly, and two exact
      // Postgres additions of the same value always agree where a read-modify-
      // write in JavaScript can lose a race.
      data: {
        shares: { increment: dec(input.shares) },
        escrowed: { increment: dec(input.escrowed) },
      },
    });
  }

  /**
   * Rest what could not be matched.
   *
   * Funds are locked here and not a moment later. "No order may rest without
   * locked funds" is not a policy the service remembers to apply — it is this
   * method, which posts the escrow in the same transaction as the row it
   * writes, so there is no interleaving in which the order exists and the money
   * does not.
   */
  async place(tx: Tx, input: PlaceInput): Promise<Order> {
    if (!isValidPrice(input.priceKobo)) {
      throw new OrderBookError(`a limit price must be a whole number of kobo between 1 and 99`);
    }
    const shares = input.shares.toDecimalPlaces(MONEY_DP, Decimal.ROUND_DOWN);
    if (shares.lt(QUANTUM)) {
      throw new OrderBookError('that leaves too little to rest on the book');
    }

    const locked = stakeFor(input.side, shares, input.priceKobo);
    if (locked.lte(0)) throw new OrderBookError('an order has to lock something');

    // No RG or tier-cap check here, and deliberately.
    //
    // `TradeService.buy` is the only door into this method, and it applies both
    // to the whole amount before any leg runs — which is the right place,
    // because the limits are on *exposure* and a request that matches half and
    // rests half has added all of it. Re-checking the resting half here would
    // count it twice against a daily stake limit and refuse a trade that is
    // inside it. If a second caller is ever added, it applies the guards
    // first; that is what `assertWithinTierCap` being a shared function rather
    // than a private method is for.

    const order = await tx.order.create({
      data: {
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        userId: input.userId,
        side: input.side as OrderSide,
        priceKobo: input.priceKobo,
        shares: dec(shares),
        locked: dec(locked),
        requestId: input.requestId,
      },
    });

    await this.wallet.escrow({
      userId: input.userId,
      marketId: input.marketId,
      amount: locked,
      type: 'order_lock',
      ref: input.requestId,
      tx,
    });

    return order;
  }

  /**
   * Cancel one order and give the money back.
   *
   * The amount released is the `locked` column, never a recomputation from the
   * price: a partially filled order has already given part of its lock to the
   * positions it minted, and re-deriving "price × remaining shares" would
   * release money that is standing behind somebody else's settled claim.
   */
  async cancel(userId: string, orderId: string): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (order === null || order.userId !== userId) {
        throw new OrderBookError('order not found');
      }
      if (order.state !== 'open') {
        // Idempotent: a double-tap on Cancel is not an error, and telling
        // somebody their cancellation failed when it had already succeeded is
        // how a person cancels twice and then panics.
        return order;
      }
      return this.releaseOrder(tx, order, `cancel:${order.id}`);
    });
  }

  /**
   * Cancel every open order on a market and refund the locks.
   *
   * Called at freeze. An order resting into a frozen market is money locked
   * against a trade that can never happen, and leaving it there until
   * settlement would be the platform holding funds for no reason — which is
   * the thing §2.7 says we do not do.
   */
  async cancelAllFor(tx: Tx, marketId: string, ref: string): Promise<number> {
    const open = await tx.order.findMany({ where: { marketId, state: 'open' } });
    for (const order of open) {
      await this.releaseOrder(tx, order, ref);
    }
    return open.length;
  }

  private async releaseOrder(tx: Tx, order: Order, ref: string): Promise<Order> {
    const locked = num(order.locked);
    if (locked.gt(0)) {
      await this.ledger.post(
        tx,
        release({
          userId: order.userId,
          marketId: order.marketId,
          amount: locked,
          type: 'order_release',
          currency: 'SPC',
        }),
        ref,
      );
    }

    return tx.order.update({
      where: { id: order.id },
      data: { state: 'cancelled', locked: dec(new Decimal(0)), cancelledAt: new Date() },
    });
  }

  /**
   * Escrow this market holds for the order book rather than for the pot.
   *
   * Read off the ledger by type, not by summing columns, because the pot's
   * settlement subtracts this from the escrow it releases — and the two
   * figures have to be the same kind of number or the subtraction is a guess.
   * `order_lock` less `order_release` is precisely "locked against orders, plus
   * collateral behind matched positions, still held".
   */
  async escrowHeldFor(tx: Tx, marketId: string): Promise<Map<string, Decimal>> {
    const rows = await tx.ledgerEntry.groupBy({
      by: ['userId'],
      where: {
        marketId,
        fundClass: 'user_escrow',
        type: { in: ['order_lock', 'order_release'] },
      },
      _sum: { amount: true },
    });
    return new Map(rows.map((row) => [row.userId, num(row._sum.amount ?? 0)]));
  }

  /** Every open order's remaining size, for the depth a quote is priced against. */
  async remainingDepth(tx: Tx, marketId: string, outcomeId: string, side: Side): Promise<Decimal> {
    const book = await this.bookFor(tx, marketId, outcomeId, side);
    return book.reduce((total, order) => total.plus(remainingOf(order)), new Decimal(0));
  }
}

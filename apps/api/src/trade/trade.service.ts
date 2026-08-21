import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Trade } from '@prisma/client';
import { Decimal, buy, priceOf, sell, type TradeResult } from '@stakeam/engine';
import { frozenMessage, isTradingFrozen } from '@stakeam/rules';

import { LedgerService, type Tx } from '../ledger/ledger.service';
import { OrderBookService } from '../orderbook/orderbook.service';
import { averageKobo, routeFor, tightenToPot, withinLimit } from '../orderbook/routing';
import { isValidPrice, sharesFor, KOBO_PER_SHARE } from '../orderbook/matching';
import { release } from '../ledger/posting';
import { indexOf, outcomeAt, toEngineState } from '../market/market-state';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { impactOf, largestWithinImpact } from './max-impact';
import { PrismaService } from '../prisma/prisma.service';
import { PriceCacheService } from '../realtime/price-cache.service';
import { RgService } from '../rg/rg.service';
import { checkTierCap } from './tier-cap';
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
  /**
   * The most this trader will pay per share, in kobo, or absent for "whatever
   * it costs".
   *
   * A limit is a promise the platform keeps in both directions: no leg fills
   * above it — not the book, and not the pot — and whatever cannot be filled
   * inside it rests on the book rather than being quietly filled outside it.
   */
  readonly limitKobo?: number | null;
}

/**
 * What one request actually did.
 *
 * A single trade can now be three things at once: part matched against people,
 * part filled from the pot, part left resting. The caller is told about all
 * three because the trader has to be — a matched share pays an exact ₦1 and a
 * pot share pays a share of a pot, and a screen that reported one number for
 * both would be describing neither.
 */
export interface FillReport {
  /** The pot leg, if any. Null when the request was fully matched or rested. */
  readonly trade: Trade | null;
  /** The matched leg, if any. */
  readonly matched: {
    readonly shares: string;
    readonly cost: string;
    readonly fills: number;
    /** ₦1 a share, known now — not an estimate. */
    readonly exactPayout: string;
  } | null;
  /** What is now resting on the book, if anything. */
  readonly resting: {
    readonly orderId: string;
    readonly shares: string;
    readonly priceKobo: number;
    readonly locked: string;
  } | null;
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
/** A probability as the percentage a trader reads on the button. */
const asPercent = (price: Decimal): string => `${price.times(100).toDecimalPlaces(1).toString()}%`;

@Injectable()
export class TradeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly prices: PriceCacheService,
    private readonly rg: RgService,
    private readonly book: OrderBookService,
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

  /**
   * How much an unverified account is allowed to have at risk.
   *
   * Measured against escrow rather than against this one trade: the cap is on
   * exposure, not on ticket size, or ten trades of a tenth the size would walk
   * straight through it. Tier 1 and above are uncapped — proving a contact is
   * exactly what lifts it, which is the incentive §2.1 is built around.
   */
  private async assertWithinTierCap(tx: Tx, userId: string, amount: Decimal): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { tier: true } });
    if (user === null) return;
    const cap = new Decimal((await this.config.get('tier0_stake_cap_spc')).toString());

    // Read through the transaction, not through the wallet service: this runs
    // inside the per-market lock, and a balance fetched outside it could be
    // stale by the time the cap is compared against it.
    const wallets = await tx.wallet.findMany({ where: { userId }, select: { escrowed: true } });
    const escrowed = wallets.reduce(
      (total, row) => total.plus(new Decimal(row.escrowed.toString())),
      new Decimal(0),
    );

    if (!checkTierCap({ tier: user.tier, escrowed, amount, cap }).allowed) {
      throw new TradeError(
        `unverified accounts can hold up to ${cap.toString()} SPC across open markets — ` +
          `you have ${escrowed.toString()} at stake. Verify your email or phone to lift this.`,
      );
    }
  }

  /**
   * A buy, routed through whatever will fill it (§2.3 plus the matching layer).
   *
   * The order is deliberate and the spec's:
   *
   *   1. **The book**, at or better than the trader's price. A peer-to-peer
   *      fill escrows ₦1 a share between two people and pays it to whichever
   *      of them is right — the platform holds neither capital nor risk, and
   *      the payout is exact and known the moment it fills.
   *   2. **The pot**, at the formula price, for whatever the book could not
   *      cover. Unchanged from before this layer existed: same engine, same
   *      identity, same estimate-not-promise payout.
   *   3. **The book again**, resting the rest — but only when the trader named
   *      a price. Without a limit there is nothing to rest *at*; with one, the
   *      remainder waits at it rather than being filled outside it.
   *
   * A limit binds both legs. A pot fill whose *average* price exceeds the limit
   * is refused and rested instead — average and not marginal, because a size
   * that walks the curve pays more than the number on the button, and a limit
   * that only checked the button would let a fill land above its own limit.
   *
   * All three legs are one transaction under one row lock. Matching did not get
   * a concurrency path of its own: it runs where trades already run, inside the
   * per-market queue, under the same idempotency key.
   */
  async buy(input: BuyInput): Promise<FillReport> {
    const amount = new Decimal(input.amount);
    if (amount.lte(0)) throw new TradeError('amount must be greater than zero');

    const limit = input.limitKobo ?? null;
    if (limit !== null && !isValidPrice(limit)) {
      throw new TradeError('a limit price is a whole number of kobo between 1 and 99');
    }

    // Read before the transaction opens: a flag is a cached read and holding
    // the market's row lock while it happens would put an operator's kill
    // switch on the critical path of every trade.
    const routed = await this.book.enabledFor(input.marketId);

    const committed = await this.prisma.$transaction(async (tx) => {
      const replayed = await this.replayReport(tx, input.requestId);
      if (replayed !== null) return { report: replayed, broadcast: null };

      const loaded = await this.lockAndLoad(tx, input.marketId, input.userId);
      const index = indexOf(loaded, input.outcomeId);

      // §2.12's limits and §2.1's Tier 0 cap, applied once to the whole amount
      // before any leg runs. Both are limits on *exposure*, and a request that
      // matches half and rests half has added all of it — checking each leg
      // separately would count the same money twice and refuse a trade that is
      // inside the limit.
      await this.rg.assertMayStake(input.userId, amount);
      await this.assertWithinTierCap(tx, input.userId, amount);

      const route = routed
        ? routeFor({ outcomes: loaded.outcomes, outcomeId: input.outcomeId, limitKobo: limit })
        : null;

      let budget = amount;
      let matched: FillReport['matched'] = null;

      if (route !== null) {
        /*
          The pot's current price is a ceiling on what the book may charge.

          Without it, "book first" fills a taker at a resting price that is
          worse than the curve sitting right beside it — the pot quotes both
          sides with no spread, so a level above its price is strictly worse
          for the taker and strictly better for whoever rested it. See
          `tightenToPot`: this one line is what stops the new venue being a
          worse deal than the old one.
        */
        // From the engine's own state, not from `outcomes.priceCurrent`.
        //
        // The column is a cache the trade path writes after every fill, so
        // normally the two agree — but this number decides what the book is
        // allowed to charge, and a cache that is stale for any reason (a
        // restored backup, a fixture, a migration that touched prices) would
        // silently move that ceiling. The share vector is the truth.
        const potKobo = priceOf(
          loaded.state.q,
          loaded.state.liquidity,
          indexOf(loaded, route.bookOutcomeId),
        )
          .times(KOBO_PER_SHARE)
          .toNumber();

        const result = await this.book.match(tx, {
          marketId: input.marketId,
          outcomeId: route.bookOutcomeId,
          userId: input.userId,
          side: route.side,
          limitKobo: tightenToPot(route.side, route.limitKobo, potKobo),
          budget,
          requestId: input.requestId,
        });
        if (result.fills.length > 0) {
          matched = {
            shares: result.shares.toString(),
            cost: result.spent.toString(),
            fills: result.fills.length,
            // ₦1 a share. Not a projection of a pot that has not finished
            // filling — the money is already escrowed, by two people.
            exactPayout: result.shares.toString(),
          };
        }
        budget = result.remainingBudget;
      }

      let trade: Trade | null = null;
      let potResult: TradeResult | null = null;

      if (budget.gt(0)) {
        const trial = buy(loaded.state, index, budget.toString());
        if (withinLimit(averageKobo(budget, new Decimal(trial.shares.toString())), limit)) {
          // Escrow first: a trade the user cannot fund must not move the market.
          //
          // And before the impact ceiling below, deliberately. Both refuse the
          // same trade, but only one of them is about the person doing it: told
          // "that would move the price too far" when the real problem is an
          // empty wallet, somebody goes looking for a smaller stake that will
          // also fail.
          await this.wallet.escrow({
            userId: input.userId,
            marketId: input.marketId,
            amount: budget,
            type: 'trade_buy',
            ref: input.requestId,
            tx,
          });

          /*
            The max-impact ceiling (§E, and the other half of checklist rule 24).

            A price is a claim about what a crowd believes, and a single stake
            large enough to reprice the market on its own is not that claim —
            it is one person's cheque wearing the crowd's clothes, and everyone
            who trades on the number afterwards is reading something that was
            bought rather than agreed.

            Only the pot leg. A matched fill moves no formula price at all, and
            a resting order moves nothing until somebody agrees with it — which
            is exactly the remedy offered below: the same money, at a price a
            counterparty has to accept.

            The throw rolls the escrow back with the rest of the transaction.
          */
          const impact = impactOf({
            state: loaded.state,
            index,
            amount: budget,
            ceilingBps: Math.round(Number(await this.config.get('max_impact_bps'))),
          });
          if (!impact.allowed) {
            const most = largestWithinImpact({
              state: loaded.state,
              index,
              ceilingBps: impact.ceilingBps,
              upperBound: budget,
            });
            throw new TradeError(
              `that would move the price from ${asPercent(impact.priceBefore)} to ` +
                `${asPercent(impact.priceAfter)} on its own. The most this market takes in ` +
                `one trade is ${most.toDecimalPlaces(0, Decimal.ROUND_DOWN).toString()} — ` +
                'stake that, or set a limit price and let somebody meet you there.',
            );
          }

          await this.persist(tx, input, loaded, index, trial, 'buy', budget, new Decimal(0));
          trade = await this.recordTrade(tx, input, index, trial, 'buy', budget, new Decimal(0));
          potResult = trial;
          budget = new Decimal(0);
        }
      }

      let resting: FillReport['resting'] = null;
      if (budget.gt(0) && route !== null && route.limitKobo !== null) {
        const shares = sharesFor(budget, route.side, route.limitKobo);
        if (shares.gt(0)) {
          const order = await this.book.place(tx, {
            marketId: input.marketId,
            outcomeId: route.bookOutcomeId,
            userId: input.userId,
            side: route.side,
            priceKobo: route.limitKobo,
            shares,
            requestId: input.requestId,
          });
          resting = {
            orderId: order.id,
            shares: order.shares.toString(),
            priceKobo: order.priceKobo,
            locked: order.locked.toString(),
          };
        }
      }

      if (matched === null && trade === null && resting === null) {
        // Every route refused. Saying nothing and returning an empty fill would
        // leave somebody staring at an unchanged balance wondering whether the
        // button worked.
        throw new TradeError(
          limit === null
            ? 'nothing could be filled right now — try again in a moment'
            : `nothing filled at ${limit}k or better, and the remainder was too small to rest`,
        );
      }

      return {
        report: { trade, matched, resting },
        // Only a pot fill moves the formula price, so only a pot fill has a
        // tick to publish. A purely matched trade changes what people hold and
        // not what the curve says — the book's own price is broadcast from the
        // depth endpoint's own refresh, not down the price feed, because a tick
        // on that channel means "the pot moved".
        broadcast: potResult === null ? null : { loaded, result: potResult },
      };
    });

    if (committed.broadcast !== null) {
      await this.broadcast(input.marketId, committed.broadcast.loaded, committed.broadcast.result);
    }
    return committed.report;
  }

  /**
   * What a repeated request already did, across all three legs.
   *
   * Idempotency used to be one unique column on one table, because a request
   * was one row. It is now up to three — a pot trade, a set of matched fills,
   * and a resting order — and a retry has to return the same answer as the
   * first attempt for all of them. Reconstructed rather than cached: a cached
   * report is a fourth thing that can be wrong.
   */
  private async replayReport(tx: Tx, requestId: string): Promise<FillReport | null> {
    const [trade, fills, order] = await Promise.all([
      tx.trade.findUnique({ where: { requestId } }),
      tx.orderFill.findMany({ where: { requestId } }),
      tx.order.findUnique({ where: { requestId } }),
    ]);

    if (trade === null && fills.length === 0 && order === null) return null;

    const shares = fills.reduce(
      (total, fill) => total.plus(new Decimal(fill.shares.toString())),
      new Decimal(0),
    );

    return {
      trade,
      matched:
        fills.length === 0
          ? null
          : {
              shares: shares.toString(),
              // Recomputed from the fills rather than stored: each fill knows
              // its own price and size, and a total column would be a second
              // place for the same fact to be wrong.
              cost: fills
                .reduce((total, fill) => {
                  const size = new Decimal(fill.shares.toString());
                  const long = size.times(fill.priceKobo).div(KOBO_PER_SHARE);
                  return total.plus(fill.takerSide === 'buy' ? long : size.minus(long));
                }, new Decimal(0))
                .toString(),
              fills: fills.length,
              exactPayout: shares.toString(),
            },
      resting:
        order === null || order.state !== 'open'
          ? null
          : {
              orderId: order.id,
              shares: order.shares.toString(),
              priceKobo: order.priceKobo,
              locked: order.locked.toString(),
            },
    };
  }

  /**
   * Early exit (§2.3).
   *
   * The pot gives up the full refund; the exit fee is withheld from the seller
   * and credited to `platform_fees`. Taking it out of the pot instead would
   * break `pot === C(q) − C(q0)`.
   */
  async sell(input: SellInput): Promise<FillReport> {
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
      return { trade: committed.trade, matched: null, resting: null };
    }
    // A replay. Reported in the same shape as a fresh fill so the caller has
    // one thing to read rather than two.
    return { trade: committed, matched: null, resting: null };
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
    // §2.3 and checklist rule 22, checked here and not only in the job that
    // flips the state.
    //
    // Two things make this the load-bearing check rather than a second opinion.
    // The sweep runs on a schedule and a schedule can be late, so a market can
    // be past its freeze time and still read `active`. And this runs *inside*
    // the transaction, after the row lock, at execution time — so a trade that
    // was submitted before the freeze and waited its turn behind other trades
    // is refused on the way out, which is the case a check at the endpoint
    // would wave through.
    //
    // It blocks sells as well as buys because `lockAndLoad` is the one path
    // into both. A half-freeze would be worse than none: it would let somebody
    // who has seen the score dump a losing position onto somebody who has not.
    if (
      isTradingFrozen({
        freezeAt: market.freezeAt,
        eventDate: market.eventDate,
        state: market.state,
      })
    ) {
      throw new TradeError(frozenMessage(market.freezeReason));
    }
    if (market.state !== 'active') {
      throw new TradeError(`market is ${market.state} — trading is closed`);
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

import { Injectable } from '@nestjs/common';
import { Prisma, type LiquidityMode, type MakerStatus, type MarketMaker } from '@prisma/client';
import { Decimal, priceOf } from '@stakeam/engine';

import { AdminAuditService } from '../audit/admin-audit.service';
import { SYSTEM_PLATFORM_ACCOUNT } from '../ledger/posting';
import type { Tx } from '../ledger/ledger.service';
import { indexOf, toEngineState } from '../market/market-state';
import { KOBO_PER_SHARE } from '../orderbook/matching';
import { OrderBookService } from '../orderbook/orderbook.service';
import { WalletService } from '../wallet/wallet.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiquidityModeService } from './mode.service';
import { quotesFor, type MakerView, type StopReason } from './quoting';

export class MarketMakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketMakerError';
  }
}

const dec = (value: Decimal): Prisma.Decimal => new Prisma.Decimal(value.toString());
const num = (value: { toString(): string }): Decimal => new Decimal(value.toString());

/** A stop reason, in the column the dashboard reads. */
const STATUS_FOR: Record<StopReason, MakerStatus> = {
  disabled: 'idle',
  killed: 'killed',
  budget_spent: 'budget_spent',
  depth_reached: 'depth_reached',
  inventory_capped: 'inventory_capped',
  market_closing: 'market_closing',
  no_room_in_bounds: 'idle',
};

export interface MakerDashboard {
  readonly marketId: string;
  readonly question: string;
  readonly enabled: boolean;
  readonly mode: LiquidityMode;
  readonly status: MakerStatus;
  readonly statusNote: string | null;
  readonly budget: string;
  readonly spent: string;
  readonly remaining: string;
  readonly inventory: { readonly long: string; readonly short: string };
  readonly openQuotes: number;
  readonly trades: number;
  readonly realisedPnl: string;
  readonly unrealisedPnl: string;
  readonly lastQuoteAt: string | null;
  readonly lastCycleAt: string | null;
  readonly killedAt: string | null;
  readonly killReason: string | null;
  readonly seededAt: string | null;
  readonly stackConfirmed: boolean;
}

/**
 * The platform's market maker.
 *
 * It posts resting limit orders on the existing book rather than inventing a
 * quoting mechanism of its own, which is the whole reason this service is
 * short: escrow, matching, settlement and the ledger already work, and a maker
 * that used a private path would be a second set of money rules to keep in
 * step with the first.
 *
 * ## What it is, honestly
 *
 * The order book's design note says the platform carries no capital and no
 * risk. That remains true of *user* trades, and the pairwise arithmetic is
 * unchanged: every matched pair still escrows exactly ₦1 a share between its
 * two sides. What this adds is a participant funded by the platform — so the
 * platform is now sometimes one of those two sides, with real inventory and
 * real directional exposure when only one of its quotes fills.
 *
 * That exposure is deliberate and it is bounded by exactly one number: the
 * per-market budget, which the maker may never exceed and which stops it dead
 * rather than shrinking it. Everything else here — the fade, the depth stop,
 * the inventory cap, standing down before the freeze — narrows that exposure
 * further. None of it makes the platform riskless, and calling it riskless
 * would be the dangerous thing to write.
 *
 * ## What it may know
 *
 * `quoting.ts` holds the rules and takes a view of the world with no field for
 * news, no field for the resolution dossier, and no field for anything an
 * administrator believes. This service's only job is to fill that view
 * honestly from the database and to do what comes back.
 */
@Injectable()
export class MarketMakerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly book: OrderBookService,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly modes: LiquidityModeService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Configure a market's maker. Creates the row on first use, off. */
  async configure(input: {
    marketId: string;
    budget: string;
    quoteSize: string;
    spreadKobo: number;
    minPriceKobo?: number;
    maxPriceKobo?: number;
    refreshMs?: number;
    depthStop?: string;
    inventoryCap?: string;
    mode?: LiquidityMode;
    staffId: string;
    ip: string;
  }): Promise<MarketMaker> {
    const mode = await this.modes.resolve(input.mode);

    const budget = new Decimal(input.budget);
    if (budget.lte(0)) throw new MarketMakerError('a maker needs a budget greater than zero');

    // The ceiling on the ceiling. A budget is a number somebody types, and a
    // typed number is a number with an extra zero in it sometimes.
    const cap = new Decimal((await this.config.get('liquidity_bot_max_budget_spc')).toString());
    if (budget.gt(cap)) {
      throw new MarketMakerError(
        `a maker is capped at ${cap.toString()} per market — raise ` +
          'liquidity_bot_max_budget_spc in the config console if that is deliberate',
      );
    }

    const quoteSize = new Decimal(input.quoteSize);
    if (quoteSize.lte(0)) throw new MarketMakerError('a quote has to be for something');
    if (!Number.isInteger(input.spreadKobo) || input.spreadKobo < 1) {
      throw new MarketMakerError('the spread is a whole number of kobo, at least 1');
    }

    const depthStop = new Decimal(
      input.depthStop ?? (await this.config.get('liquidity_bot_depth_stop_spc')).toString(),
    );
    const inventoryCap = new Decimal(input.inventoryCap ?? budget.toString());

    const before = await this.prisma.marketMaker.findUnique({
      where: { marketId: input.marketId },
    });

    const data = {
      mode,
      budget: dec(budget),
      quoteSize: dec(quoteSize),
      spreadKobo: input.spreadKobo,
      minPriceKobo: input.minPriceKobo ?? 2,
      maxPriceKobo: input.maxPriceKobo ?? 98,
      refreshMs: input.refreshMs ?? 60_000,
      depthStop: dec(depthStop),
      inventoryCap: dec(inventoryCap),
    };

    const saved = await this.prisma.marketMaker.upsert({
      where: { marketId: input.marketId },
      create: { marketId: input.marketId, ...data },
      update: data,
    });

    await this.audit.record({
      staffId: input.staffId,
      action: 'liquidity.maker:configure',
      targetRef: `market:${input.marketId}`,
      before: before === null ? { existed: false } : summarise(before),
      // The mode goes in the record, not just the config: an audit row is a
      // claim about the past, and "which money was this" has to survive
      // somebody changing the mode afterwards.
      after: { ...summarise(saved), mode },
      ip: input.ip,
    });
    return saved;
  }

  /**
   * Turn a market's maker on.
   *
   * §E: a maker on a market that was seeded in the same session is stacking
   * platform exposure on top of platform exposure, which is easy to do by
   * accident and hard to see afterwards. It needs saying out loud.
   */
  async start(input: {
    marketId: string;
    staffId: string;
    ip: string;
    confirmStacking?: boolean;
  }): Promise<MarketMaker> {
    const maker = await this.require(input.marketId);

    if (maker.seededAt !== null && !maker.stackConfirmed && input.confirmStacking !== true) {
      throw new MarketMakerError(
        'this market was seeded from the liquidity section already. Running the maker on top ' +
          'of a fresh seed stacks platform exposure — confirm that you mean to.',
      );
    }

    await this.fund(maker);

    const saved = await this.prisma.marketMaker.update({
      where: { marketId: input.marketId },
      data: {
        enabled: true,
        status: 'quoting',
        statusNote: null,
        // Starting clears a previous kill. Anything else and the switch would
        // be a switch you cannot un-flip, which people work around.
        killedAt: null,
        killedBy: null,
        killReason: null,
        ...(input.confirmStacking === true ? { stackConfirmed: true } : {}),
      },
    });

    await this.audit.record({
      staffId: input.staffId,
      action: 'liquidity.maker:start',
      targetRef: `market:${input.marketId}`,
      before: summarise(maker),
      after: { ...summarise(saved), stackedOnSeed: maker.seededAt !== null },
      ip: input.ip,
    });
    return saved;
  }

  /** Turn it off and pull the quotes. Not a kill — a kill records why. */
  async stop(input: { marketId: string; staffId: string; ip: string }): Promise<MarketMaker> {
    const maker = await this.require(input.marketId);
    await this.withdraw(input.marketId, `maker-stop:${input.marketId}:${Date.now()}`);

    const saved = await this.prisma.marketMaker.update({
      where: { marketId: input.marketId },
      data: { enabled: false, status: 'idle', statusNote: 'stopped by an operator' },
    });
    await this.audit.record({
      staffId: input.staffId,
      action: 'liquidity.maker:stop',
      targetRef: `market:${input.marketId}`,
      before: summarise(maker),
      after: summarise(saved),
      ip: input.ip,
    });
    return saved;
  }

  /**
   * The kill switch.
   *
   * Two things, in this order: the quotes come off the book, then the row is
   * marked. Marking first would leave a window in which the maker is recorded
   * as dead and its money is still standing behind orders somebody can fill.
   *
   * A killed maker will not quote again until somebody starts it deliberately.
   * A kill a scheduled cycle can undo is not a kill switch.
   */
  async kill(input: {
    marketId: string;
    staffId: string;
    ip: string;
    reason: string;
  }): Promise<{ marketId: string; cancelled: number }> {
    const reason = input.reason.trim();
    if (reason.length < 3) throw new MarketMakerError('say why — it goes in the audit log');

    const cancelled = await this.withdraw(
      input.marketId,
      `maker-kill:${input.marketId}:${Date.now()}`,
    );
    await this.prisma.marketMaker.updateMany({
      where: { marketId: input.marketId },
      data: {
        enabled: false,
        status: 'killed',
        statusNote: reason,
        killedAt: new Date(),
        killedBy: input.staffId,
        killReason: reason,
      },
    });

    await this.audit.record({
      staffId: input.staffId,
      action: 'liquidity.maker:kill',
      targetRef: `market:${input.marketId}`,
      after: { reason, quotesCancelled: cancelled },
      ip: input.ip,
    });
    return { marketId: input.marketId, cancelled };
  }

  /** Every maker at once. Same order, same guarantees. */
  async killAll(input: { staffId: string; ip: string; reason: string }): Promise<{
    markets: number;
    cancelled: number;
  }> {
    const reason = input.reason.trim();
    if (reason.length < 3) throw new MarketMakerError('say why — it goes in the audit log');

    const live = await this.prisma.marketMaker.findMany({
      where: { enabled: true },
      select: { marketId: true },
    });

    let cancelled = 0;
    for (const { marketId } of live) {
      cancelled += await this.withdraw(marketId, `maker-killall:${marketId}:${Date.now()}`);
    }
    await this.prisma.marketMaker.updateMany({
      where: { enabled: true },
      data: {
        enabled: false,
        status: 'killed',
        statusNote: reason,
        killedAt: new Date(),
        killedBy: input.staffId,
        killReason: reason,
      },
    });

    await this.audit.record({
      staffId: input.staffId,
      action: 'liquidity.maker:kill_all',
      targetRef: 'liquidity:global',
      after: { reason, markets: live.length, quotesCancelled: cancelled },
      ip: input.ip,
    });
    return { markets: live.length, cancelled };
  }

  /**
   * One cycle for one market: look, decide, quote.
   *
   * Everything happens inside a transaction under the market's row lock — the
   * same lock the trade path takes — so a cycle and a trade can never
   * interleave and the maker cannot quote against a price that is already
   * moving. There is no second concurrency path.
   */
  async cycle(marketId: string): Promise<{ status: MakerStatus; quotes: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;

      const maker = await tx.marketMaker.findUnique({ where: { marketId } });
      if (maker === null) return { status: 'idle' as MakerStatus, quotes: 0 };

      // A killed maker is left exactly as it is, including its status and the
      // reason on it. Letting a cycle rewrite the row would turn the kill
      // record into "idle" the moment anybody pressed refresh — the switch
      // would still be off, but nobody could see that it had been pulled, or
      // why, or by whom.
      if (maker.killedAt !== null) return { status: 'killed' as MakerStatus, quotes: 0 };

      // Old quotes come off before anything else, always — including when the
      // plan turns out to be to quote nothing. A maker that stopped deciding
      // to quote but left yesterday's orders resting is still quoting, at
      // yesterday's price.
      //
      // And before the view is built, not after. The budget counts money the
      // maker has committed; its own outstanding quotes are about to be
      // replaced, so counting them would make the maker read its own orders as
      // spent budget, stop, cancel, then find the budget free again next cycle
      // — flapping on and off for ever while providing nothing.
      const ref = `maker:${marketId}:${Date.now()}`;
      await this.withdraw(marketId, ref, tx);

      const view = await this.viewOf(tx, maker);
      const plan = quotesFor(view);

      if (plan.stop !== null) {
        const status = STATUS_FOR[plan.stop];
        await tx.marketMaker.update({
          where: { marketId },
          data: { status, statusNote: noteFor(plan.stop), lastCycleAt: new Date() },
        });
        return { status, quotes: 0 };
      }

      const outcomeId = await this.bookOutcome(tx, marketId);
      let placed = 0;
      for (const quote of plan.quotes) {
        await this.book.place(tx, {
          marketId,
          outcomeId,
          userId: SYSTEM_PLATFORM_ACCOUNT,
          side: quote.side,
          priceKobo: quote.priceKobo,
          shares: quote.shares,
          requestId: `${ref}:${quote.side}`,
          maker: true,
        });
        placed += 1;
      }

      const spent = await this.committed(tx, marketId);
      await tx.marketMaker.update({
        where: { marketId },
        data: {
          status: 'quoting',
          statusNote: `${plan.quotes.length} quotes at ±${plan.spreadKobo}k`,
          spent: dec(spent),
          lastQuoteAt: new Date(),
          lastCycleAt: new Date(),
        },
      });
      return { status: 'quoting' as MakerStatus, quotes: placed };
    });
  }

  /** Every enabled maker, one cycle each. The standing job's body. */
  async sweep(): Promise<{ cycled: number; quoting: number }> {
    const live = await this.prisma.marketMaker.findMany({
      where: { enabled: true, killedAt: null },
      select: { marketId: true },
    });

    let quoting = 0;
    for (const { marketId } of live) {
      // One market's failure must not stop the others: a maker stuck on a
      // market with bad data would otherwise silently freeze every other
      // market's quotes, and the symptom would be an absence.
      try {
        const result = await this.cycle(marketId);
        if (result.status === 'quoting') quoting += 1;
      } catch {
        await this.prisma.marketMaker.updateMany({
          where: { marketId },
          data: { status: 'idle', statusNote: 'last cycle failed — see the logs' },
        });
      }
    }
    return { cycled: live.length, quoting };
  }

  /** What the section shows for every market with a maker row. */
  async dashboard(): Promise<MakerDashboard[]> {
    const makers = await this.prisma.marketMaker.findMany({
      include: { market: { select: { question: true, state: true } } },
      orderBy: { updatedAt: 'desc' },
    });

    return Promise.all(
      makers.map(async (maker) => {
        const [inventory, openQuotes, trades, spent, unrealised] = await Promise.all([
          this.inventoryOf(this.prisma, maker.marketId),
          this.prisma.order.count({
            where: { marketId: maker.marketId, maker: true, state: 'open' },
          }),
          this.prisma.orderFill.count({
            where: {
              marketId: maker.marketId,
              OR: [
                { takerUserId: SYSTEM_PLATFORM_ACCOUNT },
                { makerUserId: SYSTEM_PLATFORM_ACCOUNT },
              ],
            },
          }),
          this.committed(this.prisma, maker.marketId),
          this.unrealisedOf(maker.marketId),
        ]);

        const budget = num(maker.budget);
        return {
          marketId: maker.marketId,
          question: maker.market.question,
          enabled: maker.enabled,
          mode: maker.mode,
          status: maker.status,
          statusNote: maker.statusNote,
          budget: budget.toString(),
          spent: spent.toString(),
          remaining: Decimal.max(budget.minus(spent), new Decimal(0)).toString(),
          inventory: { long: inventory.long.toString(), short: inventory.short.toString() },
          openQuotes,
          trades,
          // Nothing is realised until the market settles: a matched position
          // pays ₦1 or nothing, and until then every figure is a mark.
          realisedPnl: '0',
          unrealisedPnl: unrealised.toString(),
          lastQuoteAt: maker.lastQuoteAt?.toISOString() ?? null,
          lastCycleAt: maker.lastCycleAt?.toISOString() ?? null,
          killedAt: maker.killedAt?.toISOString() ?? null,
          killReason: maker.killReason,
          seededAt: maker.seededAt?.toISOString() ?? null,
          stackConfirmed: maker.stackConfirmed,
        };
      }),
    );
  }

  /** Remember that the liquidity section seeded this market, for §E's confirm. */
  async noteSeed(marketId: string, staffId: string): Promise<void> {
    await this.prisma.marketMaker.updateMany({
      where: { marketId },
      data: { seededBy: staffId, seededAt: new Date(), stackConfirmed: false },
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Make sure the platform account actually holds this maker's budget.
   *
   * A budget is a *ceiling*, and a ceiling is not money. The maker escrows
   * against `sys_platform` when it quotes, and that account starts at zero —
   * so without this, a perfectly configured maker fails on its first quote
   * with "insufficient funds for sys_platform", which reads like a platform
   * fault rather than the missing step it is.
   *
   * In TEST mode the float is minted as points, which is what TEST mode *is*:
   * the whole platform runs on points and they are worth nothing outside it.
   * Idempotent on the ledger ref, and topped up rather than re-issued when a
   * budget is raised, so restarting a maker does not mint its budget again.
   *
   * In LIVE mode this is where the fintech connector goes — reserve against a
   * real processor balance, capture what is spent, release the rest. It throws
   * `NotImplemented` today, which is the correct behaviour for an unbuilt
   * payment path and the reason LIVE mode is unreachable.
   */
  private async fund(maker: MarketMaker): Promise<void> {
    if (maker.mode === 'live') {
      // Unreachable while LIVE is gated, and deliberately loud if it ever is
      // not: better a refusal here than a maker quoting money nobody reserved.
      throw new MarketMakerError(
        'live-mode makers need the funding connector, which is not implemented until licensing',
      );
    }

    const ref = `maker-float:${maker.marketId}`;
    const issued = await this.prisma.ledgerEntry.aggregate({
      where: { userId: SYSTEM_PLATFORM_ACCOUNT, ref, fundClass: 'user_available' },
      _sum: { amount: true },
    });
    const already = num(issued._sum.amount ?? 0);
    const shortfall = num(maker.budget).minus(already);
    if (shortfall.lte(0)) return;

    await this.wallet.issue({
      userId: SYSTEM_PLATFORM_ACCOUNT,
      amount: shortfall,
      type: 'seed',
      ref,
    });
  }

  private async require(marketId: string): Promise<MarketMaker> {
    const maker = await this.prisma.marketMaker.findUnique({ where: { marketId } });
    if (maker === null) throw new MarketMakerError('no maker is configured on that market');
    return maker;
  }

  /** Pull every maker quote off the book and give the escrow back. */
  private async withdraw(marketId: string, ref: string, tx?: Tx): Promise<number> {
    const run = async (client: Tx): Promise<number> => {
      const open = await client.order.findMany({
        where: { marketId, maker: true, state: 'open' },
        select: { id: true },
      });
      for (const order of open) {
        await this.book.cancelAsSystem(client, order.id, ref);
      }
      return open.length;
    };
    return tx === undefined ? this.prisma.$transaction(run) : run(tx);
  }

  /** The book side the maker quotes on: outcome zero, as the router uses. */
  private async bookOutcome(tx: Tx, marketId: string): Promise<string> {
    const outcome = await tx.outcome.findFirstOrThrow({
      where: { marketId },
      orderBy: { ordinal: 'asc' },
      select: { id: true },
    });
    return outcome.id;
  }

  /**
   * What the maker currently has committed against its budget.
   *
   * Escrow standing behind open quotes, plus the collateral behind positions
   * those quotes have already turned into. Both are money the platform cannot
   * spend elsewhere, which is what a budget is about — a figure that counted
   * only open orders would free the budget up every time a quote *filled*,
   * which is precisely when the exposure became real.
   */
  private async committed(client: Tx | PrismaService, marketId: string): Promise<Decimal> {
    const [orders, positions] = await Promise.all([
      client.order.aggregate({
        where: { marketId, maker: true, state: 'open' },
        _sum: { locked: true },
      }),
      client.matchedPosition.aggregate({
        where: { marketId, userId: SYSTEM_PLATFORM_ACCOUNT },
        _sum: { escrowed: true },
      }),
    ]);
    return num(orders._sum.locked ?? 0).plus(num(positions._sum.escrowed ?? 0));
  }

  private async inventoryOf(
    client: Tx | PrismaService,
    marketId: string,
  ): Promise<{ long: Decimal; short: Decimal }> {
    const rows = await client.matchedPosition.groupBy({
      by: ['side'],
      where: { marketId, userId: SYSTEM_PLATFORM_ACCOUNT },
      _sum: { shares: true },
    });
    const of = (side: string): Decimal =>
      num(rows.find((row) => row.side === side)?._sum.shares ?? 0);
    return { long: of('long'), short: of('short') };
  }

  /**
   * The inventory marked at the pot's current price, less what it cost.
   *
   * A mark, not a result. A matched share pays ₦1 or nothing at settlement, so
   * the only honest present value is the market's own estimate of that — which
   * is the price. Labelled unrealised on every screen for the same reason.
   */
  private async unrealisedOf(marketId: string): Promise<Decimal> {
    const [market, positions] = await Promise.all([
      this.prisma.market.findUnique({
        where: { id: marketId },
        include: { outcomes: { orderBy: { ordinal: 'asc' } } },
      }),
      this.prisma.matchedPosition.findMany({
        where: { marketId, userId: SYSTEM_PLATFORM_ACCOUNT },
      }),
    ]);
    if (market === null || positions.length === 0) return new Decimal(0);

    const loaded = toEngineState(market, market.outcomes, 0);
    let value = new Decimal(0);
    for (const position of positions) {
      const price = priceOf(
        loaded.state.q,
        loaded.state.liquidity,
        indexOf(loaded, position.outcomeId),
      );
      const worth =
        position.side === 'long'
          ? num(position.shares).times(price)
          : num(position.shares).times(new Decimal(1).minus(price));
      value = value.plus(worth).minus(num(position.escrowed));
    }
    return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  }

  /** Everything the maker is allowed to see, and nothing else. */
  private async viewOf(tx: Tx, maker: MarketMaker): Promise<MakerView> {
    const market = await tx.market.findUniqueOrThrow({
      where: { id: maker.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    const outcomeId = market.outcomes[0]?.id ?? '';
    const loaded = toEngineState(market, market.outcomes, 0);
    const priceKobo = Math.round(
      priceOf(loaded.state.q, loaded.state.liquidity, 0).times(KOBO_PER_SHARE).toNumber(),
    );

    const [bid, ask, inventory, spent, recentTrades, stopMinutes] = await Promise.all([
      this.realDepth(tx, maker.marketId, outcomeId, 'buy'),
      this.realDepth(tx, maker.marketId, outcomeId, 'sell'),
      this.inventoryOf(tx, maker.marketId),
      this.committed(tx, maker.marketId),
      tx.trade.count({
        where: { marketId: maker.marketId, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      }),
      this.config.get('liquidity_bot_stop_before_freeze_minutes'),
    ]);

    return {
      enabled: maker.enabled,
      killed: maker.killedAt !== null,
      priceKobo,
      budget: num(maker.budget),
      spent,
      quoteSize: num(maker.quoteSize),
      spreadKobo: maker.spreadKobo,
      minPriceKobo: maker.minPriceKobo,
      maxPriceKobo: maker.maxPriceKobo,
      depth: { bid, ask },
      depthStop: num(maker.depthStop),
      inventory,
      inventoryCap: num(maker.inventoryCap),
      recentTrades,
      // The market's own clock, and nothing about the event behind it.
      freezeAt: market.freezeAt ?? market.eventDate,
      now: new Date(),
      stopBeforeFreezeMinutes: Math.round(Number(stopMinutes)),
    };
  }

  /**
   * Resting depth that is not the maker's own.
   *
   * Counting its own quotes would let the maker fade itself out of a market
   * nobody else is in — it would post, see "depth", withdraw, see none, post
   * again, and oscillate for ever while providing nothing.
   */
  private async realDepth(
    tx: Tx,
    marketId: string,
    outcomeId: string,
    side: 'buy' | 'sell',
  ): Promise<Decimal> {
    const orders = await tx.order.findMany({
      where: { marketId, outcomeId, side, state: 'open', maker: false },
      select: { shares: true, filled: true },
    });
    return orders.reduce(
      (total, order) => total.plus(num(order.shares).minus(num(order.filled))),
      new Decimal(0),
    );
  }
}

/** The fields worth keeping in an audit row. */
function summarise(maker: MarketMaker): Prisma.JsonObject {
  return {
    enabled: maker.enabled,
    mode: maker.mode,
    budget: maker.budget.toString(),
    quoteSize: maker.quoteSize.toString(),
    spreadKobo: maker.spreadKobo,
    depthStop: maker.depthStop.toString(),
    inventoryCap: maker.inventoryCap.toString(),
    status: maker.status,
  };
}

/** The stop reason in the words an operator reads on the dashboard. */
function noteFor(stop: StopReason): string {
  switch (stop) {
    case 'disabled':
      return 'off';
    case 'killed':
      return 'killed — start it again to clear';
    case 'budget_spent':
      return 'budget spent — it stops rather than quoting smaller';
    case 'depth_reached':
      return 'real depth arrived on both sides; the market does not need us';
    case 'inventory_capped':
      return 'inventory cap reached on a side, so both sides stopped';
    case 'market_closing':
      return 'standing down before the freeze';
    case 'no_room_in_bounds':
      return 'the price is too near the end of its bounds to quote both sides';
  }
}

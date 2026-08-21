import { Decimal } from '@stakeam/engine';

import { KOBO_PER_SHARE, isValidPrice, stakeFor, type Side } from '../orderbook/matching';

/**
 * What the market maker is allowed to do, with no database and no Nest in it.
 *
 * Every rule in the brief's §C is here rather than in the service or the
 * screen, and that placement is the point. "Symmetric quoting only" and
 * "inventory cap" and "stop before freeze" are claims about behaviour; put in
 * a controller they are claims nobody can check, and put in the UI they are
 * claims a second caller silently breaks. Here each one is a branch with a
 * name, and `quoting.test.ts` can hold the whole maker to them without a
 * database, a clock, or a market.
 *
 * ## What the maker is allowed to know
 *
 * The input type below is the entire world it sees: its own inventory, the
 * current price, the resting depth, its budget, and the clock. There is no
 * field for news, no field for the resolution source, no field for what an
 * administrator believes. That is not an omission to be filled in later — it
 * is the rule, expressed as a type. A maker that could read the dossier would
 * be trading on the platform's own knowledge of the answer, which is the one
 * thing a house must never do, and the cheapest way to guarantee it never
 * happens is to make it impossible to write.
 *
 * ## Why it never takes a view
 *
 * Quotes come out in pairs at mid ± half-spread, same size both sides. The
 * maker therefore has no opinion about the outcome: it profits from the spread
 * if both sides fill and carries inventory if only one does — which is what
 * the inventory cap and the fade are for. It never posts one side alone.
 */

/** Why a cycle produced no quotes. Each is a rule, and the dashboard names it. */
export type StopReason =
  | 'disabled'
  | 'killed'
  | 'budget_spent'
  | 'depth_reached'
  | 'inventory_capped'
  | 'market_closing'
  | 'no_room_in_bounds';

export interface MakerInventory {
  /** Shares held long, from quotes that filled on the bid. */
  readonly long: Decimal;
  /** Shares held short, from quotes that filled on the ask. */
  readonly short: Decimal;
}

/**
 * Everything the maker may see.
 *
 * Deliberately small. If a future change wants the maker to react to
 * something, it has to be added here first — which is a diff somebody reviews,
 * rather than a service quietly reaching for a table.
 */
export interface MakerView {
  readonly enabled: boolean;
  readonly killed: boolean;

  /** The pot's current price for this outcome, in kobo. The maker's anchor. */
  readonly priceKobo: number;

  /** Hard ceiling, and what has been committed against it. */
  readonly budget: Decimal;
  readonly spent: Decimal;

  /** Shares per quote before fading. */
  readonly quoteSize: Decimal;
  /** The floor half-width in kobo. Thin volume widens it; nothing narrows it. */
  readonly spreadKobo: number;
  readonly minPriceKobo: number;
  readonly maxPriceKobo: number;

  /** Real resting shares on each side, excluding the maker's own. */
  readonly depth: { readonly bid: Decimal; readonly ask: Decimal };
  /** Above this much real depth on both sides, the market does not need us. */
  readonly depthStop: Decimal;

  readonly inventory: MakerInventory;
  /** Stop adding to a side once it holds this much. */
  readonly inventoryCap: Decimal;

  /** Trades in the recent window. Thin volume widens the spread. */
  readonly recentTrades: number;

  /** When trading stops, and now. Null freeze means no scheduled stop. */
  readonly freezeAt: Date | null;
  readonly now: Date;
  /** How long before the freeze the maker stands down, in minutes. */
  readonly stopBeforeFreezeMinutes: number;
}

export interface Quote {
  readonly side: Side;
  readonly priceKobo: number;
  readonly shares: Decimal;
  /** What placing this quote locks in escrow. */
  readonly locks: Decimal;
}

export interface QuotePlan {
  readonly quotes: readonly Quote[];
  readonly stop: StopReason | null;
  /** The half-width actually used, after widening. For the dashboard. */
  readonly spreadKobo: number;
  /** What the whole plan locks. Never takes `spent` past `budget`. */
  readonly locks: Decimal;
}

/** Trades in the window below which the maker treats the market as thin. */
export const THIN_TRADES = 5;

/** The most the fade will shrink a quote: a tenth of the configured size. */
export const MIN_FADE = new Decimal('0.1');

const none = (stop: StopReason, spreadKobo: number): QuotePlan => ({
  quotes: [],
  stop,
  spreadKobo,
  locks: new Decimal(0),
});

/**
 * Widen the spread when the market is thin.
 *
 * A maker quoting tightly into a market with no other trades is not providing
 * liquidity, it is offering everybody a cheap option on whatever it does not
 * know. Fewer trades in the window means a wider quote — up to double the
 * configured half-width at zero volume, back to the configured floor once
 * ordinary volume arrives.
 *
 * It only ever widens. A maker that narrows its own spread has an opinion.
 */
export function widenedSpread(spreadKobo: number, recentTrades: number): number {
  if (recentTrades >= THIN_TRADES) return spreadKobo;
  const thinness = (THIN_TRADES - Math.max(recentTrades, 0)) / THIN_TRADES;
  return Math.ceil(spreadKobo * (1 + thinness));
}

/**
 * Shrink the quote as real depth appears.
 *
 * The maker is scaffolding. Its job is to make a new market tradeable, not to
 * stay in the middle of a busy one — real depth is other people's money and
 * better information than the maker has. So size falls linearly as depth rises
 * towards the stop, and at the stop `quotesFor` withdraws entirely.
 */
export function fadedSize(quoteSize: Decimal, realDepth: Decimal, depthStop: Decimal): Decimal {
  if (depthStop.lte(0)) return quoteSize;
  const ratio = Decimal.min(realDepth.div(depthStop), new Decimal(1));
  const scale = Decimal.max(new Decimal(1).minus(ratio), MIN_FADE);
  return quoteSize.times(scale);
}

/** Whether the freeze is close enough that the maker should stand down. */
export function closingSoon(view: MakerView): boolean {
  if (view.freezeAt === null) return false;
  const msLeft = view.freezeAt.getTime() - view.now.getTime();
  return msLeft <= view.stopBeforeFreezeMinutes * 60_000;
}

/**
 * The cycle's decision: what to quote, or why nothing.
 *
 * Order matters and is the order of the brief. The stops that mean "do not
 * trade at all" come before the ones that shape a quote, so a killed maker on
 * a frozen market reports `killed` rather than a fact about depth — the first
 * true reason is the one an operator needs.
 */
export function quotesFor(view: MakerView): QuotePlan {
  const spread = widenedSpread(view.spreadKobo, view.recentTrades);

  if (!view.enabled) return none('disabled', spread);
  if (view.killed) return none('killed', spread);

  // Before the freeze, and before anything else about the market: a maker
  // still quoting into a settling market is quoting on a result that may
  // already be known somewhere.
  if (closingSoon(view)) return none('market_closing', spread);

  const remaining = view.budget.minus(view.spent);
  if (remaining.lte(0)) return none('budget_spent', spread);

  // Real depth on both sides means the market has found its own counterparties.
  const realDepth = Decimal.min(view.depth.bid, view.depth.ask);
  if (view.depthStop.gt(0) && realDepth.gte(view.depthStop)) {
    return none('depth_reached', spread);
  }

  // Symmetric or nothing. If either side is inventory-capped the maker stops
  // quoting altogether rather than posting the other side alone — a one-sided
  // quote *is* a directional view, however it got there.
  const capped =
    view.inventory.long.gte(view.inventoryCap) || view.inventory.short.gte(view.inventoryCap);
  if (capped) return none('inventory_capped', spread);

  const bidPrice = view.priceKobo - spread;
  const askPrice = view.priceKobo + spread;
  if (
    !isValidPrice(bidPrice) ||
    !isValidPrice(askPrice) ||
    bidPrice < view.minPriceKobo ||
    askPrice > view.maxPriceKobo
  ) {
    return none('no_room_in_bounds', spread);
  }

  const faded = Decimal.min(
    fadedSize(view.quoteSize, view.depth.bid, view.depthStop),
    fadedSize(view.quoteSize, view.depth.ask, view.depthStop),
  );

  // The budget is a ceiling on the pair, not on each leg. Both quotes are
  // posted or neither is, so the money that has to be there is both.
  const perShare = unitPair(bidPrice, askPrice);
  const affordable = perShare.lte(0) ? new Decimal(0) : remaining.div(perShare);
  const shares = Decimal.min(faded, affordable).toDecimalPlaces(18, Decimal.ROUND_DOWN);

  // Below a share the pair cannot be posted symmetrically at all. Reporting
  // this as a spent budget is honest: there is not enough left to quote with.
  if (shares.lte(0)) return none('budget_spent', spread);

  const bid: Quote = {
    side: 'buy',
    priceKobo: bidPrice,
    shares,
    locks: stakeFor('buy', shares, bidPrice),
  };
  const ask: Quote = {
    side: 'sell',
    priceKobo: askPrice,
    shares,
    locks: stakeFor('sell', shares, askPrice),
  };

  // A leg that locks nothing is not a quote — it is a free option, and the
  // book rightly refuses to rest one. It happens at the very bottom of a
  // budget, where the affordable size rounds to a stake of zero on the
  // cheaper side. Reporting it as a spent budget is the truth: there is not
  // enough left to quote both sides with.
  if (bid.locks.lte(0) || ask.locks.lte(0)) return none('budget_spent', spread);

  return {
    quotes: [bid, ask],
    stop: null,
    spreadKobo: spread,
    locks: bid.locks.plus(ask.locks),
  };
}

/**
 * What one share of the symmetric pair costs to post.
 *
 * A buy at `b` locks b/100; the matching sell at `a` locks (100−a)/100. Posting
 * both is the sum, and it is what the budget is measured against — the maker
 * commits both legs or neither, so the affordable size is set by the pair.
 */
function unitPair(bidKobo: number, askKobo: number): Decimal {
  return new Decimal(bidKobo).plus(KOBO_PER_SHARE - askKobo).div(KOBO_PER_SHARE);
}

import { at, cost, prices, replaceAt } from './cost';
import { Decimal, ONE, ZERO, toDecimal, toDecimals, type Numeric } from './decimal';
import {
  EngineInvariantError,
  EngineValidationError,
  InsufficientSharesError,
  MarketFrozenError,
} from './errors';

/**
 * Relative slack allowed on the pot identity and on payout conservation.
 *
 * The identity `pot === C(q) − C(q0)` is exact in real arithmetic. At 40
 * significant digits the two sides drift by roughly 1e-34 of the pot's
 * magnitude per operation, so this bound sits orders of magnitude above the
 * drift and orders of magnitude below one kobo. Anything larger is a bug.
 */
const INVARIANT_RELATIVE_TOLERANCE = new Decimal('1e-30');

/**
 * Bounds on the early-exit fee (§2.3): configurable 0–2%, on by default at 1%.
 *
 * These are validation rails, not tunables. The live values are rows in
 * `platform_config` (§6.4b) — "every tunable value in this document lives here
 * as an editable setting, never in code" — and reach the engine as arguments.
 */
export const MAX_EXIT_FEE_RATE = new Decimal('0.02');

/** Bootstrap value for the `exit_fee_rate` config key. */
export const DEFAULT_EXIT_FEE_RATE = new Decimal('0.01');

/**
 * Immutable market state. Every engine operation returns a new state rather
 * than mutating, so a rejected trade can never leave a half-applied market
 * behind for the next caller.
 */
export interface MarketState {
  /** Liquidity constant L. Fixed at market creation and never changed. */
  readonly liquidity: Decimal;
  /** Shares outstanding per outcome at market open. The floor for sells. */
  readonly q0: readonly Decimal[];
  /** Shares outstanding per outcome, now. */
  readonly q: readonly Decimal[];
  /** Money in the pot. */
  readonly pot: Decimal;
  /**
   * Money staked per outcome, net of early exits. Sums to `pot` exactly.
   *
   * The cost curve does not segregate money by outcome — every naira lands in
   * one pot — so the "losing pool" the fee is charged on has to be tracked
   * alongside it rather than derived from `q`.
   */
  readonly staked: readonly Decimal[];
  /** Trading is closed (event started, or resolution under way). */
  readonly frozen: boolean;
  /** Early-exit fee withheld from a seller's refund. 1% by default (§2.3). */
  readonly exitFeeRate: Decimal;
  /**
   * The smallest amount the system this state came from can represent.
   *
   * Zero for a market held purely in memory, where the identities are exact.
   * A persisted market is different: share counts come out of `ln` and `exp`
   * and are irrational, so no finite column scale stores them exactly, and the
   * pot is money that has to quantise to a payable amount. Something must
   * absorb that, and stating the quantum makes it a declared property of the
   * storage rather than a fudge factor inside the assertion.
   *
   * A Decimal(38,18) column sets this to 1e-18 — sixteen orders of magnitude
   * below one kobo, so a real discrepancy still trips the invariant.
   *
   * **The quantum bounds one round trip, not a market's life.** Each write
   * truncates q and moves C(q) by up to one quantum, in a consistent
   * direction, once per trade — so the drift accumulates. Shares are
   * therefore stored far finer than money (30 dp against 18), which is what
   * keeps the accumulation negligible over any realistic number of trades.
   * Storing them at the money scale bricked markets after a few hundred
   * trades in the 10× load run: the state that fails the check is the state
   * on disk, so every subsequent trade failed too.
   */
  readonly quantum: Decimal;
}

export interface OpenMarketParams {
  /** Number of outcomes, or the initial share vector via `initialShares`. */
  readonly outcomes?: number;
  /** Liquidity constant L. See docs: ~50× the typical stake for ~1-point moves. */
  readonly liquidity: Numeric;
  /** Shares outstanding at open. Defaults to all zeros. */
  readonly initialShares?: readonly Numeric[];
  /** Early-exit fee rate in [0, 0.02]. Defaults to 1% — the fee is on by default. */
  readonly exitFeeRate?: Numeric;
  /** Storage quantum; see `MarketState.quantum`. Defaults to 0 (exact). */
  readonly quantum?: Numeric;
}

export interface TradeResult {
  /** Market state after the trade. */
  readonly state: MarketState;
  /** Shares granted (buy) or returned (sell). Always positive. */
  readonly shares: Decimal;
  /** Money into the pot (buy) or out of it (sell), before any exit fee. */
  readonly gross: Decimal;
  /** Exit fee withheld from the seller. Always 0 on a buy. */
  readonly exitFee: Decimal;
  /** What the user actually pays (buy) or receives (sell). */
  readonly net: Decimal;
  /** Display prices after the trade. */
  readonly pricesAfter: readonly Decimal[];
}

export interface Holding {
  readonly holderId: string;
  readonly shares: Numeric;
}

export interface Payout {
  readonly holderId: string;
  readonly shares: Decimal;
  readonly payout: Decimal;
}

export interface ResolutionResult {
  readonly winningOutcomeIndex: number;
  /** Money staked on every outcome that did not win. The fee's basis. */
  readonly losingPool: Decimal;
  /** losingPool × feeRate, taken off the top of the pot. */
  readonly fee: Decimal;
  /** pot − fee, split across winning shares. */
  readonly distributable: Decimal;
  readonly payouts: readonly Payout[];
  /** Σpayouts + fee − pot. Asserted to be within tolerance of zero. */
  readonly residual: Decimal;
  /** Market state after resolution: frozen, pot drained to zero. */
  readonly state: MarketState;
}

function toleranceFor(magnitude: Decimal): Decimal {
  return Decimal.max(ONE, magnitude.abs()).times(INVARIANT_RELATIVE_TOLERANCE);
}

/**
 * Slack for the pot identity, scaled to the market rather than to the pot.
 *
 * `pot === C(q) − C(q0)` subtracts two numbers the size of L and q, so that is
 * what bounds the rounding error — not the pot, which sits near zero on a fully
 * exited market even after millions have traded through it. Even on a ₦2.5m
 * book this stays around 1e-24, i.e. twenty-two orders of magnitude below one
 * kobo, so a real discrepancy still trips it.
 */
function stateTolerance(state: MarketState): Decimal {
  let scale = Decimal.max(ONE, state.pot.abs(), state.liquidity.abs());
  for (const qi of state.q) {
    const magnitude = qi.abs();
    if (magnitude.gt(scale)) scale = magnitude;
  }
  const arithmetic = scale.times(INVARIANT_RELATIVE_TOLERANCE);

  // Rounding q by one quantum moves C(q) by at most Σ p_i · quantum = quantum,
  // and the stored pot carries a quantum of its own. One per outcome plus one
  // for the pot bounds a round trip through storage.
  const storage = state.quantum.times(state.q.length + 1);

  return Decimal.max(arithmetic, storage);
}

/**
 * pot − ( C(q) − C(q0) ). Exactly zero in real arithmetic; a few ulp in practice.
 */
export function potIdentityResidual(state: MarketState): Decimal {
  const opened = cost(state.q0, state.liquidity);
  const current = cost(state.q, state.liquidity);
  return state.pot.minus(current.minus(opened));
}

/** Σ staked − pot. Exactly zero: every naira in the pot was staked on something. */
export function stakedIdentityResidual(state: MarketState): Decimal {
  const total = state.staked.reduce((acc, amount) => acc.plus(amount), ZERO);
  return total.minus(state.pot);
}

/**
 * Assert the facts that make the pot trustworthy: it equals the cost the market
 * has travelled, it is not negative, and it is fully accounted for across the
 * outcomes money was staked on.
 *
 * This is a bug detector, not a rule being enforced — nothing here clamps or
 * repairs state. Every engine operation runs it before returning.
 */
export function assertInvariants(state: MarketState): void {
  const stakedResidual = stakedIdentityResidual(state);
  if (stakedResidual.abs().gt(stateTolerance(state))) {
    throw new EngineInvariantError(
      `staked total does not reconcile to the pot: Σstaked − pot = ${stakedResidual.toString()}`,
    );
  }

  const residual = potIdentityResidual(state);
  const tolerance = stateTolerance(state);
  if (residual.abs().gt(tolerance)) {
    throw new EngineInvariantError(
      `pot identity violated: pot=${state.pot.toString()} but C(q)−C(q0)=` +
        `${state.pot.minus(residual).toString()} (residual ${residual.toString()})`,
    );
  }
  if (state.pot.lt(tolerance.negated())) {
    throw new EngineInvariantError(`pot went negative: ${state.pot.toString()}`);
  }
}

function assertTradable(state: MarketState): void {
  if (state.frozen) {
    throw new MarketFrozenError('trading is frozen for this market');
  }
}

function assertIndex(state: MarketState, outcomeIndex: number): number {
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= state.q.length) {
    throw new EngineValidationError(
      `outcome index ${outcomeIndex} is out of range (n=${state.q.length})`,
    );
  }
  return outcomeIndex;
}

/** Open a market. `q0` is the share vector the pot identity is measured from. */
export function openMarket(params: OpenMarketParams): MarketState {
  const liquidity = toDecimal(params.liquidity);
  if (liquidity.lte(0)) {
    throw new EngineValidationError(`liquidity L must be > 0, received ${liquidity.toString()}`);
  }

  const q0 = params.initialShares
    ? toDecimals(params.initialShares)
    : Array.from({ length: params.outcomes ?? 0 }, () => new Decimal(0));

  if (q0.length < 2) {
    throw new EngineValidationError(`a market needs at least 2 outcomes, received ${q0.length}`);
  }
  for (const shares of q0) {
    if (shares.isNegative()) {
      throw new EngineValidationError(`initial shares cannot be negative: ${shares.toString()}`);
    }
  }

  const exitFeeRate =
    params.exitFeeRate === undefined ? DEFAULT_EXIT_FEE_RATE : toDecimal(params.exitFeeRate);
  if (exitFeeRate.isNegative() || exitFeeRate.gt(MAX_EXIT_FEE_RATE)) {
    throw new EngineValidationError(
      `exitFeeRate must be within [0, ${MAX_EXIT_FEE_RATE.toString()}], received ${exitFeeRate.toString()}`,
    );
  }

  return {
    liquidity,
    q0: Object.freeze([...q0]),
    q: Object.freeze([...q0]),
    pot: ZERO,
    staked: Object.freeze(q0.map(() => ZERO)),
    frozen: false,
    exitFeeRate,
    quantum: params.quantum === undefined ? ZERO : toDecimal(params.quantum),
  };
}

/** Freeze trading. Called at event start, and again when resolution begins. */
export function freeze(state: MarketState): MarketState {
  return { ...state, frozen: true };
}

export function unfreeze(state: MarketState): MarketState {
  return { ...state, frozen: false };
}

/**
 * BUY — spend `spend` on outcome `outcomeIndex`.
 *
 *   Δ = L * ln( (e^(m/L) − 1 + p_i) / p_i )
 *
 * Substituting back into C shows S scales by exactly e^(m/L), so
 * C(q + Δe_i) − C(q) = m: the pot grows by precisely what was spent, which is
 * why `pot += m` below keeps the identity exact rather than approximate.
 */
export function buy(state: MarketState, outcomeIndex: number, spend: Numeric): TradeResult {
  assertTradable(state);
  const i = assertIndex(state, outcomeIndex);
  const m = toDecimal(spend);
  if (m.lte(0)) {
    throw new EngineValidationError(`spend must be > 0, received ${m.toString()}`);
  }

  const { liquidity: liq } = state;
  const priceBefore = at(prices(state.q, liq), i);
  const shares = liq.times(m.div(liq).exp().minus(ONE).plus(priceBefore).div(priceBefore).ln());

  if (shares.lte(0)) {
    throw new EngineInvariantError(
      `buy produced non-positive shares (${shares.toString()}) for spend ${m.toString()}`,
    );
  }

  const q = replaceAt(state.q, i, at(state.q, i).plus(shares));
  const next: MarketState = {
    ...state,
    q: Object.freeze(q),
    pot: state.pot.plus(m),
    staked: Object.freeze(replaceAt(state.staked, i, at(state.staked, i).plus(m))),
  };
  assertInvariants(next);

  return {
    state: next,
    shares,
    gross: m,
    exitFee: ZERO,
    net: m,
    pricesAfter: prices(next.q, liq),
  };
}

/**
 * SELL — return `shares` of outcome `outcomeIndex`.
 *
 *   r = C(q) − C(q with q_i −= Δ)
 *
 * The pot gives up the full `r`; any exit fee is withheld from the seller and
 * routed to platform fees by the caller. Taking the fee out of the pot instead
 * would break `pot === C(q) − C(q0)`.
 */
export function sell(state: MarketState, outcomeIndex: number, shares: Numeric): TradeResult {
  assertTradable(state);
  const i = assertIndex(state, outcomeIndex);
  const delta = toDecimal(shares);
  if (delta.lte(0)) {
    throw new EngineValidationError(`shares to sell must be > 0, received ${delta.toString()}`);
  }

  const { liquidity: liq } = state;
  const remaining = at(state.q, i).minus(delta);
  if (remaining.lt(at(state.q0, i))) {
    throw new InsufficientSharesError(
      `selling ${delta.toString()} of outcome ${i} would take shares outstanding to ` +
        `${remaining.toString()}, below the market's opening ${at(state.q0, i).toString()}`,
    );
  }

  const q = replaceAt(state.q, i, remaining);
  const refund = cost(state.q, liq).minus(cost(q, liq));
  if (refund.isNegative()) {
    throw new EngineInvariantError(`sell produced a negative refund: ${refund.toString()}`);
  }

  const exitFee = refund.times(state.exitFeeRate);
  const next: MarketState = {
    ...state,
    q: Object.freeze(q),
    pot: state.pot.minus(refund),
    // The gross refund leaves the pot, so it leaves this outcome's stake too.
    // The exit fee never entered the pot — it is withheld from the seller.
    staked: Object.freeze(replaceAt(state.staked, i, at(state.staked, i).minus(refund))),
  };
  assertInvariants(next);

  return {
    state: next,
    shares: delta,
    gross: refund,
    exitFee,
    net: refund.minus(exitFee),
    pricesAfter: prices(next.q, liq),
  };
}

/**
 * Pre-resolution estimate shown in the UI as `pot / q[w]`.
 *
 * Label it "estimate" wherever it is displayed — it moves with every trade
 * until the market freezes.
 */
export function estimatedPayoutPerShare(state: MarketState, outcomeIndex: number): Decimal {
  const i = assertIndex(state, outcomeIndex);
  const outstanding = at(state.q, i);
  if (outstanding.lte(0)) {
    return ZERO;
  }
  return state.pot.div(outstanding);
}

/**
 * RESOLVE — pay the winning outcome out of the pot.
 *
 *   losingPool = clamp(pot − staked[w], 0, pot)
 *   fee = losingPool × feeRate;  distributable = pot − fee
 *   holder of s winning shares receives distributable × s / q[w]
 *
 * §2.3: "Fee basis: the losing pool — official markets [3]%; community markets
 * [7]% ([4]% creator / [3]% platform)". The rulebook states it in pari-mutuel
 * terms, where each outcome has its own pool. The cost curve has one pot, so
 * the losing pool is read as everything staked on outcomes that did not win —
 * which is what `staked` is tracked for.
 *
 * Conservation (Σpayouts + fee === pot) only holds when the supplied holdings
 * account for every outstanding winning share, so that is checked first — a
 * seeded market must attribute its q0 shares to whoever holds them.
 */
export function resolve(
  state: MarketState,
  winningOutcomeIndex: number,
  feeRate: Numeric,
  holdings: readonly Holding[],
): ResolutionResult {
  const w = assertIndex(state, winningOutcomeIndex);
  const rate = toDecimal(feeRate);
  if (rate.isNegative() || rate.gt(ONE)) {
    throw new EngineValidationError(`feeRate must be within [0, 1], received ${rate.toString()}`);
  }

  const outstanding = at(state.q, w);
  const claimed = holdings.reduce((acc, holding) => {
    const s = toDecimal(holding.shares);
    if (s.isNegative()) {
      throw new EngineValidationError(
        `holding for ${holding.holderId} is negative: ${s.toString()}`,
      );
    }
    return acc.plus(s);
  }, ZERO);

  if (claimed.minus(outstanding).abs().gt(toleranceFor(outstanding))) {
    throw new EngineValidationError(
      `holdings sum to ${claimed.toString()} but outcome ${w} has ${outstanding.toString()} ` +
        `shares outstanding — every outstanding share must be attributed for the payout to conserve`,
    );
  }

  // The losing pool is a quantity of *money*, so it is bounded by the money in
  // the pot. That bound is not decoration: `staked[i]` is money in per outcome
  // net of exits, and it can go negative — sell an outcome after the book has
  // swung towards it and more money leaves through that outcome than was ever
  // staked on it. `pot − staked[w]` then exceeds the pot, and charging a fee on
  // that basis produces a fee larger than the pot and *negative* payouts: the
  // market would bill its own winners. Clamped here, at the point where the
  // quantity stops being a bookkeeping figure and becomes a fee basis.
  const unclamped = state.pot.minus(at(state.staked, w));
  const losingPool = Decimal.min(Decimal.max(unclamped, ZERO), Decimal.max(state.pot, ZERO));
  const fee = losingPool.times(rate);
  const distributable = state.pot.minus(fee);

  if (fee.gt(state.pot.plus(stateTolerance(state)))) {
    throw new EngineInvariantError(
      `resolution fee ${fee.toString()} exceeds the pot ${state.pot.toString()}`,
    );
  }

  const payouts: Payout[] = holdings.map((holding) => {
    const s = toDecimal(holding.shares);
    const payout = outstanding.lte(0) ? ZERO : distributable.times(s).div(outstanding);
    return { holderId: holding.holderId, shares: s, payout };
  });

  for (const payout of payouts) {
    if (payout.payout.isNegative()) {
      throw new EngineInvariantError(
        `payout for ${payout.holderId} is negative (${payout.payout.toString()}) — ` +
          'a resolution pays winners, it never bills them',
      );
    }
  }

  const paid = payouts.reduce((acc, p) => acc.plus(p.payout), ZERO);
  const residual = paid.plus(fee).minus(state.pot);
  if (residual.abs().gt(stateTolerance(state))) {
    throw new EngineInvariantError(
      `resolution did not conserve: Σpayouts=${paid.toString()} + fee=${fee.toString()} ` +
        `≠ pot=${state.pot.toString()} (residual ${residual.toString()})`,
    );
  }

  return {
    winningOutcomeIndex: w,
    losingPool,
    fee,
    distributable,
    payouts,
    residual,
    // The resolved market is inert: pot drained, trading frozen, and q0 rebased
    // onto q so the pot identity still reads true (0 === C(q) − C(q)) for any
    // caller that re-checks invariants on a terminal state.
    state: {
      ...state,
      frozen: true,
      pot: ZERO,
      q0: state.q,
      staked: Object.freeze(state.staked.map(() => ZERO)),
    },
  };
}

/** How a resolution fee is divided, in basis points. Config, not code (§6.4b). */
export interface FeeSplitBps {
  readonly creatorBps: number;
  readonly platformBps: number;
}

export interface FeeSplit {
  readonly creator: Decimal;
  readonly platform: Decimal;
}

/**
 * Divide a resolution fee into its creator and platform legs.
 *
 * §2.3 splits the community fee 4%/3% and takes the official fee entirely to
 * the platform. Dividing twice and hoping the parts add up is how money goes
 * missing a kobo at a time, so the platform leg is computed as the remainder —
 * the two legs sum to `fee` exactly, by construction.
 */
export function splitResolutionFee(fee: Numeric, split: FeeSplitBps): FeeSplit {
  const total = toDecimal(fee);
  const { creatorBps, platformBps } = split;
  const totalBps = creatorBps + platformBps;

  if (!Number.isInteger(creatorBps) || !Number.isInteger(platformBps)) {
    throw new EngineValidationError('fee split must be whole basis points');
  }
  if (creatorBps < 0 || platformBps < 0 || totalBps <= 0) {
    throw new EngineValidationError(
      `fee split must be non-negative and add to more than zero, received ${creatorBps}/${platformBps}`,
    );
  }

  const creator = total.times(creatorBps).div(totalBps);
  return { creator, platform: total.minus(creator) };
}

export interface SeedResult {
  /** Market state after the seed. */
  readonly state: MarketState;
  /** Shares granted on **every** outcome. Identical by construction. */
  readonly sharesPerOutcome: Decimal;
  /** Money staked into each outcome's pool. Identical by construction. */
  readonly perOutcome: Decimal;
  /** perOutcome × n — what the seeder pays in total. */
  readonly total: Decimal;
  /** Prices after the seed. Unchanged from before it. */
  readonly pricesAfter: readonly Decimal[];
}

/**
 * SYMMETRIC SEED — Path B activation (§2.4, Rulebook Part 3 §2 and §3).
 *
 * "The creator stakes a Symmetric Seed of at least [20,000] points into each
 * pool (equal amounts on every side). The seed must always be symmetric. A
 * creator can never hold an unequal position in their own market."
 *
 * The cost curve makes this exact rather than approximate. Adding the same δ to
 * every outcome factors straight out of the log-sum:
 *
 *   C(q + δ·1) = L·ln( e^(δ/L) · Σ e^(q_j/L) ) = δ + C(q)
 *
 * So granting δ shares of every outcome costs exactly δ and moves **no price at
 * all**. Seeding is therefore the one operation that adds money to a market
 * without expressing an opinion about it — which is precisely what the rulebook
 * is asking for, and is why this is one closed-form step and not a loop of
 * `buy()` calls. Buying `perOutcome` into each side in turn would leave the
 * result depending on the order the outcomes happened to be listed in, and
 * would hand the last outcome bought a better price than the first.
 *
 * With prices flat at 1/n, δ shares of each outcome divides into exactly δ/n of
 * money per outcome, so `perOutcome` is the rulebook's unit — "into each pool"
 * — and δ = perOutcome × n.
 *
 * Precondition: every outcome holds the same number of shares, i.e. the market
 * has not traded. Seeding is defined as "equal money into every pool" and that
 * only coincides with "equal shares of every outcome" while prices are flat;
 * on a traded book the two readings diverge and the rulebook does not say which
 * it means. It never has to — a seed is posted before the market opens.
 *
 * `frozen` is deliberately not checked: a market being seeded is not open for
 * trading yet, and the seed is what opens it.
 */
export function seed(state: MarketState, perOutcome: Numeric): SeedResult {
  const first = at(state.q, 0);
  for (const qi of state.q) {
    if (!qi.equals(first)) {
      throw new EngineValidationError(
        'a symmetric seed needs a market that has not traded — shares outstanding differ ' +
          `across outcomes (${state.q.map((v) => v.toString()).join(', ')})`,
      );
    }
  }

  return translate(state, perOutcome);
}

/**
 * The same symmetric translation, on a market that has already traded.
 *
 * `seed` refuses an uneven share vector, and for its own job that is right: a
 * Path B seed is what *opens* a market, and "equal money in every pool" and
 * "equal shares of every outcome" only coincide while prices are flat. But the
 * refusal is a policy about when a market may be opened, not a limit of the
 * arithmetic — the cost function is translation-invariant, so
 *
 *     C(q + δ·1) = C(q) + δ
 *
 * holds at every q. Adding δ shares of *every* outcome costs exactly δ and
 * leaves every price where it was, whether the market opened this morning or
 * has been traded a thousand times.
 *
 * That is what lets the platform top up a live market's pot without taking a
 * side, which is the whole meaning of a symmetric seed. Note what it does not
 * do: `liquidity` is untouched, so the market is no *deeper* — the same trade
 * moves the price by the same amount afterwards. This adds stake, not depth,
 * and the money it adds is genuinely at risk like anybody else's.
 *
 * Deliberately a separate export rather than a flag on `seed`. Every existing
 * caller keeps the precondition it was written under, and a caller that wants
 * to skip it has to say so by name.
 */
export function topUpSymmetric(state: MarketState, perOutcome: Numeric): SeedResult {
  return translate(state, perOutcome);
}

/**
 * Shift the whole share vector by the same amount, and account for it.
 *
 * One implementation, so `seed` and `topUpSymmetric` cannot drift apart — the
 * thing they disagree about is a precondition, not the money.
 */
function translate(state: MarketState, perOutcome: Numeric): SeedResult {
  const m = toDecimal(perOutcome);
  if (m.lte(0)) {
    throw new EngineValidationError(`seed per outcome must be > 0, received ${m.toString()}`);
  }

  const n = new Decimal(state.q.length);
  const total = m.times(n);
  // δ = total: the grant that costs `total` is `total` shares of every outcome.
  const delta = total;

  const next: MarketState = {
    ...state,
    q: Object.freeze(state.q.map((qi) => qi.plus(delta))),
    pot: state.pot.plus(total),
    staked: Object.freeze(state.staked.map((s) => s.plus(m))),
  };
  assertInvariants(next);

  return {
    state: next,
    sharesPerOutcome: delta,
    perOutcome: m,
    total,
    pricesAfter: prices(next.q, state.liquidity),
  };
}

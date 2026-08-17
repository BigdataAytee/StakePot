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

/** Ceiling on the optional exit fee, per the spec: 0–0.5%. */
export const MAX_EXIT_FEE_RATE = new Decimal('0.005');

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
  /** Trading is closed (event started, or resolution under way). */
  readonly frozen: boolean;
  /** Optional exit fee taken from a seller's refund. 0 by default. */
  readonly exitFeeRate: Decimal;
}

export interface OpenMarketParams {
  /** Number of outcomes, or the initial share vector via `initialShares`. */
  readonly outcomes?: number;
  /** Liquidity constant L. Rule of thumb: L ≈ 25 × typical stake. */
  readonly liquidity: Numeric;
  /** Shares outstanding at open. Defaults to all zeros. */
  readonly initialShares?: readonly Numeric[];
  /** Exit fee rate in [0, 0.005]. Defaults to 0. */
  readonly exitFeeRate?: Numeric;
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
  /** Platform fee, taken off the top of the pot. */
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
  return scale.times(INVARIANT_RELATIVE_TOLERANCE);
}

/**
 * pot − ( C(q) − C(q0) ). Exactly zero in real arithmetic; a few ulp in practice.
 */
export function potIdentityResidual(state: MarketState): Decimal {
  const opened = cost(state.q0, state.liquidity);
  const current = cost(state.q, state.liquidity);
  return state.pot.minus(current.minus(opened));
}

/**
 * Assert the two facts that make the pot trustworthy: it equals the cost the
 * market has travelled, and it is not negative.
 *
 * This is a bug detector, not a rule being enforced — nothing here clamps or
 * repairs state. Every engine operation runs it before returning.
 */
export function assertInvariants(state: MarketState): void {
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

  const exitFeeRate = params.exitFeeRate === undefined ? ZERO : toDecimal(params.exitFeeRate);
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
    frozen: false,
    exitFeeRate,
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
  const next: MarketState = { ...state, q: Object.freeze(q), pot: state.pot.plus(m) };
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
  const next: MarketState = { ...state, q: Object.freeze(q), pot: state.pot.minus(refund) };
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
 *   fee = pot × feeRate;  distributable = pot − fee
 *   holder of s winning shares receives distributable × s / q[w]
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

  const fee = state.pot.times(rate);
  const distributable = state.pot.minus(fee);

  const payouts: Payout[] = holdings.map((holding) => {
    const s = toDecimal(holding.shares);
    const payout = outstanding.lte(0) ? ZERO : distributable.times(s).div(outstanding);
    return { holderId: holding.holderId, shares: s, payout };
  });

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
    fee,
    distributable,
    payouts,
    residual,
    // The resolved market is inert: pot drained, trading frozen, and q0 rebased
    // onto q so the pot identity still reads true (0 === C(q) − C(q)) for any
    // caller that re-checks invariants on a terminal state.
    state: { ...state, frozen: true, pot: ZERO, q0: state.q },
  };
}

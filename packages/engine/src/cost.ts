import { Decimal, ZERO } from './decimal';
import { EngineValidationError } from './errors';

/**
 * Read `arr[index]`, refusing to hand back `undefined`.
 *
 * `noUncheckedIndexedAccess` is on and `any` is banned in this package, so the
 * bounds check is explicit rather than asserted away.
 */
export function at(arr: readonly Decimal[], index: number): Decimal {
  const value = arr[index];
  if (value === undefined) {
    throw new EngineValidationError(`outcome index ${index} is out of range (n=${arr.length})`);
  }
  return value;
}

export function replaceAt(arr: readonly Decimal[], index: number, value: Decimal): Decimal[] {
  at(arr, index);
  return arr.map((existing, i) => (i === index ? value : existing));
}

function assertMarketShape(q: readonly Decimal[], liquidity: Decimal): void {
  if (q.length < 2) {
    throw new EngineValidationError(`a market needs at least 2 outcomes, received ${q.length}`);
  }
  if (!liquidity.isFinite() || liquidity.lte(0)) {
    throw new EngineValidationError(`liquidity L must be > 0, received ${liquidity.toString()}`);
  }
}

/** max(q_j / L), used to factor the exponentials for a stable log-sum-exp. */
function maxScaled(q: readonly Decimal[], liquidity: Decimal): Decimal {
  let max = at(q, 0).div(liquidity);
  for (const qi of q) {
    const scaled = qi.div(liquidity);
    if (scaled.gt(max)) max = scaled;
  }
  return max;
}

/**
 * Cost function.  C(q) = L * ln( Σ_j e^(q_j / L) )
 *
 * Evaluated as L * ( M + ln( Σ_j e^(q_j/L − M) ) ) with M = max_j(q_j / L), so
 * the largest exponential is e^0 = 1 and a market with big share counts cannot
 * overflow the intermediate sum.
 */
export function cost(q: readonly Decimal[], liquidity: Decimal): Decimal {
  assertMarketShape(q, liquidity);
  const m = maxScaled(q, liquidity);
  const sum = q.reduce((acc, qi) => acc.plus(qi.div(liquidity).minus(m).exp()), ZERO);
  return liquidity.times(m.plus(sum.ln()));
}

/**
 * Display prices.  p_i = e^(q_i / L) / Σ_j e^(q_j / L)
 *
 * Same max-shift as `cost`, which is also what makes the returned vector sum to
 * 1 to working precision rather than to whatever the largest term allowed.
 */
export function prices(q: readonly Decimal[], liquidity: Decimal): Decimal[] {
  assertMarketShape(q, liquidity);
  const m = maxScaled(q, liquidity);
  const exps = q.map((qi) => qi.div(liquidity).minus(m).exp());
  const sum = exps.reduce((acc, e) => acc.plus(e), ZERO);
  return exps.map((e) => e.div(sum));
}

/** Price of a single outcome, without materialising the whole vector. */
export function priceOf(q: readonly Decimal[], liquidity: Decimal, outcomeIndex: number): Decimal {
  return at(prices(q, liquidity), outcomeIndex);
}

import DecimalJs from 'decimal.js';

/**
 * Working precision for all money math.
 *
 * 40 significant digits sits far above anything the ledger will ever hold
 * (naira amounts in kobo need ~14) and far above the drift the log-sum-exp
 * cost function accumulates over a market's lifetime, which keeps the pot
 * identity assert in `market.ts` meaningful rather than noisy.
 */
export const DECIMAL_PRECISION = 40;

/**
 * The configured Decimal constructor. Cloned rather than configured globally so
 * importing the engine never mutates a host application's Decimal settings.
 *
 * Floats are forbidden in the ledger — every amount that crosses an engine
 * boundary is a Decimal, and inputs are accepted as strings wherever the value
 * originates from user money.
 */
export const Decimal = DecimalJs.clone({
  precision: DECIMAL_PRECISION,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -60,
  toExpPos: 60,
});

export type Decimal = DecimalJs;

/** Anything the engine will coerce into a Decimal. */
export type Numeric = Decimal | string | number;

export const ZERO: Decimal = new Decimal(0);
export const ONE: Decimal = new Decimal(1);

export function toDecimal(value: Numeric): Decimal {
  const d = value instanceof DecimalJs ? new Decimal(value.toString()) : new Decimal(value);
  if (!d.isFinite()) {
    throw new RangeError(`expected a finite value, received "${String(value)}"`);
  }
  return d;
}

export function toDecimals(values: readonly Numeric[]): Decimal[] {
  return values.map(toDecimal);
}

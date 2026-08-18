/**
 * StakeAm hybrid pricing engine — architecture §2.3 (v1.1).
 *
 * Pure TypeScript with decimal.js as the only runtime dependency. No I/O, no
 * clock, no randomness: every function is a total function of its arguments, so
 * the trade workers, the backtests and the property suite all exercise exactly
 * the same arithmetic.
 */
export { DECIMAL_PRECISION, Decimal, ONE, ZERO, toDecimal, toDecimals } from './decimal';
export type { Numeric } from './decimal';

export { at, cost, priceOf, prices, replaceAt } from './cost';

export {
  DEFAULT_EXIT_FEE_RATE,
  MAX_EXIT_FEE_RATE,
  assertInvariants,
  buy,
  estimatedPayoutPerShare,
  freeze,
  openMarket,
  potIdentityResidual,
  resolve,
  sell,
  splitResolutionFee,
  stakedIdentityResidual,
  unfreeze,
} from './market';
export type {
  FeeSplit,
  FeeSplitBps,
  Holding,
  MarketState,
  OpenMarketParams,
  Payout,
  ResolutionResult,
  TradeResult,
} from './market';

export {
  EngineError,
  EngineInvariantError,
  EngineValidationError,
  InsufficientSharesError,
  MarketFrozenError,
} from './errors';

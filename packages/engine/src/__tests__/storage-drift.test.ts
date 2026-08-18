import { describe, expect, it } from 'vitest';

import { Decimal } from '../decimal';
import { buy, openMarket, potIdentityResidual } from '../market';
import type { MarketState } from '../market';

/**
 * The bug the 10× load run found, pinned.
 *
 * `pot === C(q) − C(q0)` is checked against the *stored* share vector, so every
 * write that truncates q moves C(q) by up to one quantum — in a consistent
 * direction, once per trade. The invariant's tolerance bounds a single round
 * trip, not a market's life, so at the money scale the drift caught up with it
 * after a few hundred trades and the market then refused every subsequent trade
 * with "pot identity violated". Permanently: the state that fails the check is
 * the state on disk, so nothing after it could succeed either.
 *
 * These tests simulate the round trip the database performs — truncate q, keep
 * the pot exact — and assert that shares stored at 30 dp survive a market's
 * lifetime of trading while shares at the money scale do not.
 */
const MONEY_SCALE = 18;
const SHARE_SCALE = 30;

/** What Postgres does to the state between one trade and the next. */
function roundTrip(state: MarketState, shareScale: number): MarketState {
  return {
    ...state,
    q: Object.freeze(state.q.map((value) => value.toDecimalPlaces(shareScale, Decimal.ROUND_DOWN))),
    // Money is exact at its own scale: the pot moves by the amount staked, and
    // two exact additions of the same number always agree.
    pot: state.pot.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_DOWN),
    staked: Object.freeze(
      state.staked.map((value) => value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_DOWN)),
    ),
  };
}

function tradeRepeatedly(shareScale: number, trades: number): Decimal {
  let state = openMarket({ outcomes: 2, liquidity: 50_000, quantum: '1e-18' });

  for (let i = 0; i < trades; i += 1) {
    // Alternating sides and uneven amounts, so the truncation is not a
    // pathological single case.
    const outcome = i % 2;
    const amount = new Decimal(100 + ((i * 37) % 900));
    state = roundTrip(buy(state, outcome, amount).state, shareScale);
  }

  return potIdentityResidual(state).abs();
}

describe('storage drift in the pot identity', () => {
  it('bricks the market when shares are stored at the money scale', () => {
    // Not a requirement — a demonstration of the failure this change fixes.
    // The market does not merely drift: `buy` refuses, and because the state
    // that fails the check is the state on disk, every later trade refuses
    // too. Three markets died this way partway through the 10× load run.
    expect(() => tradeRepeatedly(MONEY_SCALE, 400)).toThrow(/pot identity violated/);
  });

  it('stays far inside tolerance when shares are stored at the share scale', () => {
    const drift = tradeRepeatedly(SHARE_SCALE, 400);
    // The tolerance for a two-outcome market is three quanta, 3e-18. At 30 dp
    // four hundred trades should not reach even one.
    expect(drift.lt(new Decimal('1e-18'))).toBe(true);
  });

  it('does not brick a market over a long life at the share scale', () => {
    // Ten times the trade count that broke it, still comfortably inside.
    const drift = tradeRepeatedly(SHARE_SCALE, 4_000);
    expect(drift.lt(new Decimal('3e-18'))).toBe(true);
  });
});

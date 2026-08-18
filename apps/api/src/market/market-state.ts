import type { Market, Outcome } from '@prisma/client';
import { Decimal, type MarketState } from '@stakeam/engine';

/**
 * The boundary between stored rows and engine state.
 *
 * The engine is pure and indexes outcomes positionally; the database stores
 * them as rows. Everything that translates between the two lives here, so there
 * is exactly one place where an outcome's ordinal is turned into an array index.
 */

export interface LoadedMarket {
  readonly state: MarketState;
  /** Outcome rows, ordered by ordinal — index i is engine index i. */
  readonly outcomes: readonly Outcome[];
}

/**
 * The smallest amount any money or share column can hold: Decimal(38,18).
 *
 * Share counts come out of `ln` and `exp`, so they do not land on any finite
 * scale exactly. The engine is told this so its invariant assertions bound the
 * round trip through storage instead of tripping on it.
 */
export const STORAGE_QUANTUM = new Decimal('1e-18');

export class MarketStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketStateError';
  }
}

/**
 * Rebuild engine state from stored rows.
 *
 * `q0` is the opening share vector. Official markets open flat, so it is zeros;
 * a seeded market (§2.4 Path B) will carry its symmetric seed here once
 * community markets land in step 7.
 */
export function toEngineState(
  market: Market,
  outcomes: readonly Outcome[],
  exitFeeRate: number,
): LoadedMarket {
  if (outcomes.length < 2) {
    throw new MarketStateError(`market ${market.id} has ${outcomes.length} outcomes, needs 2+`);
  }

  const ordered = [...outcomes].sort((a, b) => a.ordinal - b.ordinal);
  ordered.forEach((outcome, index) => {
    if (outcome.ordinal !== index) {
      throw new MarketStateError(
        `market ${market.id} has a gap in outcome ordinals at ${index} ` +
          `(found ${outcome.ordinal}) — the share vector would be misaligned`,
      );
    }
  });

  const q = ordered.map((o) => new Decimal(o.sharesOutstanding.toString()));

  const state: MarketState = {
    liquidity: new Decimal(market.liquidityParam.toString()),
    q0: ordered.map(() => new Decimal(0)),
    q,
    pot: new Decimal(market.potTotal.toString()),
    staked: ordered.map((o) => new Decimal(o.stakedTotal.toString())),
    frozen: market.state !== 'active',
    exitFeeRate: new Decimal(exitFeeRate),
    // Every money and share column is Decimal(38,18).
    quantum: STORAGE_QUANTUM,
  };

  return { state, outcomes: ordered };
}

/** Engine index → outcome row. */
export function outcomeAt(loaded: LoadedMarket, index: number): Outcome {
  const outcome = loaded.outcomes[index];
  if (outcome === undefined) {
    throw new MarketStateError(`no outcome at index ${index}`);
  }
  return outcome;
}

/** Outcome id → engine index. */
export function indexOf(loaded: LoadedMarket, outcomeId: string): number {
  const index = loaded.outcomes.findIndex((o) => o.id === outcomeId);
  if (index < 0) {
    throw new MarketStateError(`outcome ${outcomeId} does not belong to this market`);
  }
  return index;
}

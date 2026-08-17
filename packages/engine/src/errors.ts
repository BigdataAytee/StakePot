/** Base class for every error the engine raises. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A caller passed something the engine will not accept (bad index, non-positive spend, …). */
export class EngineValidationError extends EngineError {}

/** A sell would push shares outstanding below where the market opened. */
export class InsufficientSharesError extends EngineError {}

/** Trading is closed — the event has started, or the market is resolving. */
export class MarketFrozenError extends EngineError {}

/**
 * A post-condition of the engine's own arithmetic did not hold.
 *
 * Per the spec these identities are facts about the cost function, not rules
 * being enforced: if one of these ever throws, the implementation is wrong and
 * the caller must not paper over it.
 */
export class EngineInvariantError extends EngineError {}

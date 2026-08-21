import { Injectable } from '@nestjs/common';
import { Decimal } from '@stakeam/engine';

/**
 * Funding the liquidity tools from a real balance (§2.16) — the seam, not the
 * implementation.
 *
 * Today both tools spend points, and the amount an operator types is the whole
 * story: TEST mode has no funding step because there is nothing to fund from.
 * At licensing the platform will hold a real balance at a processor and the
 * same amount field will need to draw on it — reserve the money, spend it,
 * release what was not used.
 *
 * This file exists now, unimplemented, for one reason: it fixes the *shape* of
 * that operation while the shape is still free to choose. Written later, under
 * a launch deadline, "just take the money" would be a call with no reservation
 * step and no release — and the first time a seed failed halfway, the naira
 * would be gone with no record of what it was for.
 *
 * It throws. It does not return a fake success, and it does not silently no-op
 * in TEST mode — a stub that quietly succeeds is how an unimplemented payment
 * path reaches production believing it works. TEST mode never calls it at all;
 * LIVE mode cannot be reached (see `mode.service.ts`); so the only way to get
 * here is to have wired something new, and the throw is the message.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not implemented: the fintech connector is a stub until licensing. ` +
        'Nothing here has moved money. See docs/architecture §2.16.',
    );
    this.name = 'NotImplementedError';
  }
}

/** Which processor a reservation sits with. Named now so the ledger can carry it. */
export type Processor = 'paystack' | 'flutterwave';

export interface FundingReservation {
  readonly id: string;
  readonly processor: Processor;
  readonly amount: Decimal;
  readonly reference: string;
  readonly reservedAt: Date;
}

/**
 * The contract the liquidity tools will call at licensing.
 *
 * Three steps rather than one, deliberately. A seed executes as a series of
 * engine trades inside a transaction that can fail on its last statement; a
 * maker's quote locks escrow that is released when the quote is cancelled.
 * Neither is "debit an amount" — both are "hold this, tell me it is held, and
 * give back what I did not use", which is exactly what a reservation is.
 */
export interface FundingConnector {
  /** Is there a real balance behind this at all, and how much. */
  available(processor: Processor): Promise<Decimal>;

  /**
   * Hold an amount before anything is spent.
   *
   * Called before the first engine trade, not after: money reserved and then
   * not spent is a refund, money spent and then not reserved is a hole.
   */
  reserve(input: {
    processor: Processor;
    amount: Decimal;
    /** What it is for, carried into the ledger so a reservation is traceable. */
    reference: string;
  }): Promise<FundingReservation>;

  /** Commit part or all of a reservation once the work has actually happened. */
  capture(input: { reservationId: string; amount: Decimal }): Promise<void>;

  /** Give back what was held and not used. Safe to call twice. */
  release(input: { reservationId: string }): Promise<void>;
}

/**
 * The stub.
 *
 * Registered as the `FundingConnector` so the wiring is real and the CI wiring
 * check counts it. Swapping in a working one at licensing is a provider change
 * and nothing else — no call site moves, and the UI above it does not know the
 * difference.
 */
@Injectable()
export class StubFundingConnector implements FundingConnector {
  async available(): Promise<Decimal> {
    throw new NotImplementedError('reading a processor balance');
  }

  async reserve(): Promise<FundingReservation> {
    throw new NotImplementedError('reserving funds');
  }

  async capture(): Promise<void> {
    throw new NotImplementedError('capturing a reservation');
  }

  async release(): Promise<void> {
    throw new NotImplementedError('releasing a reservation');
  }
}

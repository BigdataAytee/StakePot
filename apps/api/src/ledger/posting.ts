import { Decimal } from 'decimal.js';
import type { Currency, FundClass, LedgerType } from '@prisma/client';

/**
 * The double-entry core (§2.2), kept free of Prisma and of I/O so the rule that
 * matters can be tested without a database.
 *
 * A ledger transaction is a set of postings that sum to zero. Money is never
 * created or destroyed by a write — it moves between fund classes and accounts.
 * `LedgerService` refuses to persist a set that does not balance, which is what
 * makes "balances are derivable from the ledger" (§10.5) true by construction
 * rather than by convention.
 */
export interface Posting {
  readonly userId: string;
  readonly marketId?: string;
  readonly type: LedgerType;
  readonly fundClass: FundClass;
  /** Signed. Negative leaves the account, positive arrives. */
  readonly amount: Decimal;
  readonly currency: Currency;
}

export class UnbalancedTransactionError extends Error {
  constructor(
    readonly residual: Decimal,
    readonly postings: readonly Posting[],
  ) {
    super(
      `ledger transaction does not balance: Σ = ${residual.toString()} across ` +
        `${postings.length} postings. Money cannot be created by a write.`,
    );
    this.name = 'UnbalancedTransactionError';
  }
}

export class InvalidPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPostingError';
  }
}

/** Fund classes that belong to a user rather than to the platform. */
export const USER_FUND_CLASSES: readonly FundClass[] = ['user_available', 'user_escrow'];

/**
 * §2.10: "Platform revenue is only ever spendable from `platform_fees`; the
 * system physically cannot pay company costs from user funds."
 */
export const PLATFORM_FUND_CLASSES: readonly FundClass[] = ['platform_fees', 'prize_pool'];

export function sumPostings(postings: readonly Posting[]): Decimal {
  return postings.reduce((acc, p) => acc.plus(p.amount), new Decimal(0));
}

/**
 * Every posting in one transaction must be in the same currency.
 *
 * Cross-currency movement is a conversion, which is two transactions and a
 * rate — never a single unbalanced write. Blocked here so it cannot be done by
 * accident when NGN arrives alongside SPC (§9).
 */
function assertSingleCurrency(postings: readonly Posting[]): void {
  const currencies = new Set(postings.map((p) => p.currency));
  if (currencies.size > 1) {
    throw new InvalidPostingError(
      `a ledger transaction cannot mix currencies (${[...currencies].join(', ')}) — ` +
        'a conversion is two transactions and an explicit rate',
    );
  }
}

/**
 * Validate a transaction. Throws rather than returning a result: there is no
 * safe way for a caller to proceed past an unbalanced set of money movements.
 */
export function assertBalanced(postings: readonly Posting[]): void {
  if (postings.length < 2) {
    throw new InvalidPostingError(
      `a double-entry transaction needs at least two postings, received ${postings.length}`,
    );
  }

  for (const posting of postings) {
    if (!posting.amount.isFinite()) {
      throw new InvalidPostingError(`posting amount is not finite: ${posting.amount.toString()}`);
    }
    if (posting.amount.isZero()) {
      throw new InvalidPostingError(
        `zero-amount posting for ${posting.userId} (${posting.type}) — a movement of nothing is not a movement`,
      );
    }
  }

  assertSingleCurrency(postings);

  const residual = sumPostings(postings);
  if (!residual.isZero()) {
    throw new UnbalancedTransactionError(residual, postings);
  }
}

/** The net effect of a transaction on one account's fund class. */
export function netFor(
  postings: readonly Posting[],
  userId: string,
  fundClass: FundClass,
): Decimal {
  return postings
    .filter((p) => p.userId === userId && p.fundClass === fundClass)
    .reduce((acc, p) => acc.plus(p.amount), new Decimal(0));
}

// ---------------------------------------------------------------- builders
//
// Named transaction shapes, so a caller states intent and the balancing is not
// re-derived (and re-fumbled) at every call site.

export const SYSTEM_PLATFORM_ACCOUNT = 'sys_platform';
export const SYSTEM_PRIZE_POOL_ACCOUNT = 'sys_prize_pool';

/**
 * Issue points to a user — signup bonus, starter balance, prize.
 *
 * Posted out of `prize_pool`, which in points mode doubles as the issuance
 * account: its (negative) balance is the total SPC in circulation, which is
 * exactly the liability figure §2.10's proof-of-reserves export needs.
 */
export function issue(params: {
  userId: string;
  amount: Decimal;
  type: LedgerType;
  currency: Currency;
}): Posting[] {
  return [
    {
      userId: SYSTEM_PRIZE_POOL_ACCOUNT,
      type: params.type,
      fundClass: 'prize_pool',
      amount: params.amount.negated(),
      currency: params.currency,
    },
    {
      userId: params.userId,
      type: params.type,
      fundClass: 'user_available',
      amount: params.amount,
      currency: params.currency,
    },
  ];
}

/** Move a user's own money available → escrow (§2.2: staking or buying). */
export function escrow(params: {
  userId: string;
  marketId: string;
  amount: Decimal;
  type: LedgerType;
  currency: Currency;
}): Posting[] {
  return [
    {
      userId: params.userId,
      marketId: params.marketId,
      type: params.type,
      fundClass: 'user_available',
      amount: params.amount.negated(),
      currency: params.currency,
    },
    {
      userId: params.userId,
      marketId: params.marketId,
      type: params.type,
      fundClass: 'user_escrow',
      amount: params.amount,
      currency: params.currency,
    },
  ];
}

/** Move escrow → available (§2.2: resolution payout or void refund). */
export function release(params: {
  userId: string;
  marketId: string;
  amount: Decimal;
  type: LedgerType;
  currency: Currency;
}): Posting[] {
  return [
    {
      userId: params.userId,
      marketId: params.marketId,
      type: params.type,
      fundClass: 'user_escrow',
      amount: params.amount.negated(),
      currency: params.currency,
    },
    {
      userId: params.userId,
      marketId: params.marketId,
      type: params.type,
      fundClass: 'user_available',
      amount: params.amount,
      currency: params.currency,
    },
  ];
}

/**
 * Take a fee out of a market's escrow and into `platform_fees`.
 *
 * The fee leaves user escrow and lands in the one fund class company costs may
 * be paid from — the tagging is what makes bank-level segregation auditable
 * later (§2.10).
 */
export function collectFee(params: {
  fromUserId: string;
  marketId: string;
  amount: Decimal;
  type: Extract<LedgerType, 'fee_platform' | 'fee_creator'>;
  currency: Currency;
  /** Creator fees land in a creator's available balance, not platform_fees. */
  toUserId?: string;
}): Posting[] {
  const creditAccount = params.toUserId ?? SYSTEM_PLATFORM_ACCOUNT;
  const creditFundClass: FundClass =
    params.toUserId === undefined ? 'platform_fees' : 'user_available';

  return [
    {
      userId: params.fromUserId,
      marketId: params.marketId,
      type: params.type,
      fundClass: 'user_escrow',
      amount: params.amount.negated(),
      currency: params.currency,
    },
    {
      userId: creditAccount,
      marketId: params.marketId,
      type: params.type,
      fundClass: creditFundClass,
      amount: params.amount,
      currency: params.currency,
    },
  ];
}

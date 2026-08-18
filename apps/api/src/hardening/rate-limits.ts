/**
 * §2.7 and §12's rate limits, as a table rather than as numbers scattered
 * through controllers.
 *
 * "Rate limits on trades and market creation." · "Rate limiting per user/IP at
 * the LB and per-endpoint."
 *
 * Each class has two budgets, because they stop different things: a **burst**
 * budget over seconds catches a double-tap or a script hammering an endpoint,
 * and a **sustained** budget over an hour catches the patient version of the
 * same abuse. A single window catches one and misses the other.
 *
 * The numbers are deliberately generous for humans and tight for scripts. A
 * real person on election night refreshing and staking hard should never see a
 * 429; the limits exist for the account placing four hundred trades a minute.
 */

export type LimitClass = 'trade' | 'market_create' | 'auth' | 'comment' | 'share_card' | 'read';

export interface Budget {
  /** Requests allowed in the burst window. */
  readonly points: number;
  /** Burst window, in seconds. */
  readonly duration: number;
  /** How long a caller is locked out after exhausting the budget, in seconds. */
  readonly blockDuration: number;
}

export interface LimitRule {
  /** Per authenticated account. */
  readonly perUser: Budget;
  /** Per IP, which is what an unauthenticated or multi-account caller looks like. */
  readonly perIp: Budget;
  /** What the caller is told. Specific, because a bare 429 is unactionable. */
  readonly message: string;
}

export const RATE_LIMITS: Readonly<Record<LimitClass, LimitRule>> = {
  /**
   * Trades. The tightest per-user limit on the platform, because this is the
   * path that moves money and the one a script would point at.
   */
  trade: {
    perUser: { points: 30, duration: 60, blockDuration: 60 },
    perIp: { points: 120, duration: 60, blockDuration: 60 },
    message: 'You are trading faster than we allow. Give it a minute.',
  },
  /**
   * Creating markets. Rarer, heavier, and each one costs a conduct bond — the
   * limit is about stopping a flood of drafts through the review queue.
   */
  market_create: {
    perUser: { points: 5, duration: 3_600, blockDuration: 600 },
    perIp: { points: 20, duration: 3_600, blockDuration: 600 },
    message: 'That is a lot of markets in an hour. Settle one before opening more.',
  },
  /**
   * Signup and login. Per IP above all: credential stuffing and account farming
   * both look like one address making many attempts.
   */
  auth: {
    perUser: { points: 10, duration: 300, blockDuration: 300 },
    perIp: { points: 20, duration: 300, blockDuration: 900 },
    message: 'Too many attempts. Wait a few minutes and try again.',
  },
  comment: {
    perUser: { points: 20, duration: 3_600, blockDuration: 300 },
    perIp: { points: 60, duration: 3_600, blockDuration: 300 },
    message: 'You are posting too fast.',
  },
  /**
   * Share cards render an image per request and reach out for a font. Cheap to
   * ask for, expensive to serve — which is the shape of an endpoint worth
   * limiting even though it moves nothing.
   */
  share_card: {
    perUser: { points: 60, duration: 60, blockDuration: 60 },
    perIp: { points: 120, duration: 60, blockDuration: 60 },
    message: 'Too many card renders.',
  },
  read: {
    perUser: { points: 300, duration: 60, blockDuration: 30 },
    perIp: { points: 600, duration: 60, blockDuration: 30 },
    message: 'Slow down.',
  },
};

/**
 * Whether a role is exempt.
 *
 * Staff operating the admin panel legitimately click faster than the read limit
 * allows, and locking an operator out mid-incident is a worse outcome than the
 * traffic they generate. Trading is not on this list — staff cannot trade at
 * all (§2.7), so there is nothing to exempt.
 */
export function exemptFromReadLimits(role: string): boolean {
  return ['support', 'resolver', 'trust_safety', 'finance', 'admin'].includes(role);
}

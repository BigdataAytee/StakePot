import { Decimal } from '@stakeam/engine';

/**
 * §2.1's Tier 0 exposure cap, as a rule rather than a query.
 *
 * "Fraud controls tied to tiers: starter-balance trading capped at Tier 0."
 * The point is not to make an unverified account trade small — it is to bound
 * what a farm of throwaway accounts can put behind a price, and to make
 * verifying a contact worth doing.
 *
 * Pure so it can be tested without a database, and so the trade path and the
 * screen that warns about the cap are provably reading the same rule. A UI
 * that computes the limit differently from the engine is how somebody gets
 * told they have room and then refused.
 */

export interface TierCapInput {
  /** 0 = unverified, 1 = verified contact, 2 = KYC. */
  tier: number;
  /** What this account already has at risk across every open market. */
  escrowed: Decimal;
  /** What they are trying to add. */
  amount: Decimal;
  /** `tier0_stake_cap_spc`. Zero or negative means "no cap configured". */
  cap: Decimal;
}

export interface TierCapVerdict {
  allowed: boolean;
  /** What they could still stake. Null when uncapped. */
  remaining: Decimal | null;
}

export function checkTierCap({ tier, escrowed, amount, cap }: TierCapInput): TierCapVerdict {
  // Verifying a contact is exactly what lifts this — that is the incentive the
  // tier ladder is built around, so there is nothing to compute above Tier 0.
  if (tier > 0) return { allowed: true, remaining: null };

  // A cap nobody has configured is "no cap", not "no trading". Reading an unset
  // row as zero would silently stop every unverified account from trading at
  // all, which is a far worse failure than the control being absent.
  if (cap.lte(0)) return { allowed: true, remaining: null };

  const headroom = cap.minus(escrowed);
  const remaining = headroom.lt(0) ? new Decimal(0) : headroom;

  return { allowed: escrowed.plus(amount).lte(cap), remaining };
}

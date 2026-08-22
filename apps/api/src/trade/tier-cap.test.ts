import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { checkTierCap } from './tier-cap';

/**
 * §2.1's Tier 0 cap.
 *
 * Written as a fence rather than as a feature: the cap's whole job is to be
 * the thing a farm of unverified accounts cannot walk around, and the two ways
 * to accidentally remove it are to measure the wrong quantity (ticket size
 * instead of exposure) and to read an unset config row as zero.
 */
const cap = new Decimal(5000);
const d = (n: number) => new Decimal(n);

describe('tier 0 stake cap', () => {
  it('lets an unverified account stake up to the cap', () => {
    expect(checkTierCap({ tier: 0, escrowed: d(0), amount: d(5000), cap }).allowed).toBe(true);
  });

  it('refuses the trade that would cross it', () => {
    expect(checkTierCap({ tier: 0, escrowed: d(0), amount: d(5001), cap }).allowed).toBe(false);
  });

  it('caps exposure, not ticket size — ten small trades cannot walk around it', () => {
    // The failure this exists to prevent: capping each trade instead of the
    // total lets somebody reach any exposure they like in small steps.
    let escrowed = d(0);
    let placed = 0;
    for (let i = 0; i < 20; i += 1) {
      const verdict = checkTierCap({ tier: 0, escrowed, amount: d(500), cap });
      if (!verdict.allowed) break;
      escrowed = escrowed.plus(500);
      placed += 1;
    }
    expect(placed).toBe(10);
    expect(escrowed.eq(cap)).toBe(true);
  });

  it('counts what is already at stake', () => {
    expect(checkTierCap({ tier: 0, escrowed: d(4900), amount: d(200), cap }).allowed).toBe(false);
    expect(checkTierCap({ tier: 0, escrowed: d(4900), amount: d(100), cap }).allowed).toBe(true);
  });

  it('reports the headroom left, so a screen can say it before the refusal does', () => {
    expect(
      checkTierCap({ tier: 0, escrowed: d(1500), amount: d(1), cap }).remaining?.eq(3500),
    ).toBe(true);
  });

  it('never reports negative headroom if exposure somehow exceeds the cap', () => {
    // Reachable if the cap is lowered while positions are open. The answer is
    // "no room", not "minus two thousand".
    const verdict = checkTierCap({ tier: 0, escrowed: d(7000), amount: d(1), cap });
    expect(verdict.allowed).toBe(false);
    expect(verdict.remaining?.eq(0)).toBe(true);
  });

  it('does not cap a verified account', () => {
    const verdict = checkTierCap({ tier: 1, escrowed: d(999_999), amount: d(999_999), cap });
    expect(verdict.allowed).toBe(true);
    expect(verdict.remaining).toBeNull();
  });

  it('treats an unset cap as no cap rather than as zero', () => {
    // The dangerous misreading: a config row nobody set would stop every
    // unverified account from trading at all.
    const verdict = checkTierCap({ tier: 0, escrowed: d(0), amount: d(1), cap: d(0) });
    expect(verdict.allowed).toBe(true);
    expect(verdict.remaining).toBeNull();
  });
});

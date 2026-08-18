import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { assertBalanced, type Posting } from '../ledger/posting';
import { balanceOnLargestPayout } from './resolution.service';

/**
 * The join between two contracts that do not quite meet.
 *
 * The engine conserves the pot within a scaled tolerance — its arithmetic runs
 * on a logarithmic cost curve at fixed precision, where `pot − fee` then
 * `+ fee` is simply not associative. The ledger demands postings summing to
 * zero to the digit. Closing that gap is what `balanceOnLargestPayout` is for,
 * and getting it wrong means a market that intermittently cannot be resolved
 * at all.
 */
const posting = (
  userId: string,
  type: Posting['type'],
  fundClass: Posting['fundClass'],
  amount: string,
): Posting => ({
  userId,
  marketId: 'm1',
  type,
  fundClass,
  amount: new Decimal(amount),
  currency: 'SPC',
});

describe('resolution balancing', () => {
  it('leaves an already-balanced transaction alone', () => {
    const postings: Posting[] = [
      posting('a', 'payout', 'user_escrow', '-100'),
      posting('a', 'payout', 'user_available', '93'),
      posting('sys', 'fee_platform', 'platform_fees', '7'),
    ];
    const before = postings.map((row) => row.amount.toString());

    balanceOnLargestPayout(postings);

    expect(postings.map((row) => row.amount.toString())).toEqual(before);
    expect(() => assertBalanced(postings)).not.toThrow();
  });

  it('folds a rounding residual into a payout', () => {
    const postings: Posting[] = [
      posting('a', 'payout', 'user_escrow', '-100'),
      posting('a', 'payout', 'user_available', '60'),
      posting('b', 'payout', 'user_available', '32.9999999999999999999999999999999999999'),
      posting('sys', 'fee_platform', 'platform_fees', '7'),
    ];

    balanceOnLargestPayout(postings);

    // The transaction now balances exactly, which is the whole point.
    expect(() => assertBalanced(postings)).not.toThrow();
  });

  it('absorbs a one-quantum residual exactly', () => {
    // What the balancer actually sees. Every posting reaching it is a whole
    // multiple of 1e-18 — the scale the money columns hold — because the
    // resolution path quantises before it balances. A residual is then also a
    // multiple of 1e-18, and any leg can carry one exactly.
    const postings: Posting[] = [
      posting('whale', 'payout', 'user_available', '3829999.123456789012345678'),
      posting('minnow', 'payout', 'user_available', '0.000001'),
      posting('esc', 'payout', 'user_escrow', '-3829999.123456790012345678'),
    ];

    balanceOnLargestPayout(postings);

    expect(() => assertBalanced(postings)).not.toThrow();
    // The whale's payout is untouched: the smaller leg carried it.
    expect(postings[0]?.amount.toString()).toBe('3829999.123456789012345678');
  });

  it('cannot rescue a sub-quantum residual, which is why quantising comes first', () => {
    // A tail finer than the storage scale cannot be absorbed at all: at 40
    // significant digits, adding 1e-37 to a number of order 1e6 is a no-op, so
    // the correction vanishes and the transaction is still refused. This is the
    // failure that made the resolution path quantise its postings *before*
    // balancing them, and this test is here so nobody removes that step.
    const postings: Posting[] = [
      posting('whale', 'payout', 'user_available', '3829999.123456789012345678'),
      posting('minnow', 'payout', 'user_available', '0.000001'),
      posting('esc', 'payout', 'user_escrow', '-3829999.1234567890123456790000000000000000001'),
    ];

    balanceOnLargestPayout(postings);

    expect(() => assertBalanced(postings)).toThrow();
  });

  it('never restates an escrow release or a fee', () => {
    const postings: Posting[] = [
      posting('a', 'payout', 'user_escrow', '-100'),
      posting('a', 'payout', 'user_available', '92.9999999999999999999999999999999999999'),
      posting('sys', 'fee_platform', 'platform_fees', '7'),
    ];

    balanceOnLargestPayout(postings);

    // Escrow comes from stored rows and the fee is what §2.3 says is owed;
    // only the winner's share is a division, so only it absorbs a remainder.
    expect(postings[0]?.amount.toString()).toBe('-100');
    expect(postings[2]?.amount.toString()).toBe('7');
    expect(() => assertBalanced(postings)).not.toThrow();
  });

  it('picks the same leg however the postings are ordered', () => {
    const build = (): Posting[] => [
      posting('a', 'payout', 'user_available', '10'),
      posting('b', 'payout', 'user_available', '80'),
      posting('c', 'payout', 'user_available', '10.0000000000000000000000000000000000001'),
      posting('x', 'payout', 'user_escrow', '-100'),
    ];

    const forward = build();
    const reversed = build().reverse();
    balanceOnLargestPayout(forward);
    balanceOnLargestPayout(reversed);

    // The same market resolved twice must produce identical postings.
    const amounts = (rows: Posting[]) =>
      [...rows]
        .sort((left, right) => (left.userId < right.userId ? -1 : 1))
        .map((row) => `${row.userId}:${row.amount.toString()}`);
    expect(amounts(forward)).toEqual(amounts(reversed));
  });

  it('refuses to paper over an imbalance with nothing to absorb it', () => {
    // Every winning share already exited: no payout leg exists. A real
    // imbalance here must reach `assertBalanced` and stop the transaction,
    // rather than being quietly absorbed by a fee or an escrow release.
    const postings: Posting[] = [
      posting('a', 'payout', 'user_escrow', '-100'),
      posting('sys', 'fee_platform', 'platform_fees', '99'),
    ];

    balanceOnLargestPayout(postings);

    expect(() => assertBalanced(postings)).toThrow();
  });
});

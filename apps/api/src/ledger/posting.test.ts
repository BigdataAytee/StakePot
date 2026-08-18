import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InvalidPostingError,
  SYSTEM_PLATFORM_ACCOUNT,
  SYSTEM_PRIZE_POOL_ACCOUNT,
  UnbalancedTransactionError,
  assertBalanced,
  collectFee,
  escrow,
  issue,
  netFor,
  release,
  sumPostings,
  type Posting,
} from './posting';

const money = (v: string | number): Decimal => new Decimal(v);

const amountArb = fc
  .tuple(fc.integer({ min: 1, max: 9_999_999 }), fc.constantFrom('0.01', '1', '100', '10000'))
  .map(([units, scale]) => new Decimal(units).times(scale));

describe('double-entry rule', () => {
  it('accepts a transaction whose postings sum to zero', () => {
    expect(() =>
      assertBalanced([
        {
          userId: 'a',
          type: 'stake',
          fundClass: 'user_available',
          amount: money(-100),
          currency: 'SPC',
        },
        {
          userId: 'a',
          type: 'stake',
          fundClass: 'user_escrow',
          amount: money(100),
          currency: 'SPC',
        },
      ]),
    ).not.toThrow();
  });

  it('refuses a transaction that creates money', () => {
    expect(() =>
      assertBalanced([
        {
          userId: 'a',
          type: 'payout',
          fundClass: 'user_escrow',
          amount: money(-100),
          currency: 'SPC',
        },
        {
          userId: 'a',
          type: 'payout',
          fundClass: 'user_available',
          amount: money(150),
          currency: 'SPC',
        },
      ]),
    ).toThrow(UnbalancedTransactionError);
  });

  it('refuses a single-sided posting — there is no such thing as half a movement', () => {
    expect(() =>
      assertBalanced([
        {
          userId: 'a',
          type: 'stake',
          fundClass: 'user_available',
          amount: money(-100),
          currency: 'SPC',
        },
      ]),
    ).toThrow(InvalidPostingError);
  });

  it('refuses a zero-amount posting', () => {
    expect(() =>
      assertBalanced([
        {
          userId: 'a',
          type: 'stake',
          fundClass: 'user_available',
          amount: money(0),
          currency: 'SPC',
        },
        { userId: 'a', type: 'stake', fundClass: 'user_escrow', amount: money(0), currency: 'SPC' },
      ]),
    ).toThrow(InvalidPostingError);
  });

  it('refuses to mix currencies in one transaction', () => {
    expect(() =>
      assertBalanced([
        {
          userId: 'a',
          type: 'stake',
          fundClass: 'user_available',
          amount: money(-100),
          currency: 'SPC',
        },
        {
          userId: 'a',
          type: 'stake',
          fundClass: 'user_escrow',
          amount: money(100),
          currency: 'NGN',
        },
      ]),
    ).toThrow(InvalidPostingError);
  });
});

describe('transaction builders always balance', () => {
  it('issue', () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const postings = issue({ userId: 'u1', amount, type: 'signup_bonus', currency: 'SPC' });
        expect(() => assertBalanced(postings)).not.toThrow();
        expect(sumPostings(postings).isZero()).toBe(true);
        // Issuance comes out of the prize pool, which is why its negative
        // balance is the total in circulation.
        expect(netFor(postings, SYSTEM_PRIZE_POOL_ACCOUNT, 'prize_pool').eq(amount.negated())).toBe(
          true,
        );
        expect(netFor(postings, 'u1', 'user_available').eq(amount)).toBe(true);
      }),
    );
  });

  it('escrow moves available → escrow and nothing else', () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const postings = escrow({
          userId: 'u1',
          marketId: 'm1',
          amount,
          type: 'stake',
          currency: 'SPC',
        });
        expect(() => assertBalanced(postings)).not.toThrow();
        expect(netFor(postings, 'u1', 'user_available').eq(amount.negated())).toBe(true);
        expect(netFor(postings, 'u1', 'user_escrow').eq(amount)).toBe(true);
      }),
    );
  });

  it('release moves escrow → available', () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const postings = release({
          userId: 'u1',
          marketId: 'm1',
          amount,
          type: 'payout',
          currency: 'SPC',
        });
        expect(() => assertBalanced(postings)).not.toThrow();
        expect(netFor(postings, 'u1', 'user_escrow').eq(amount.negated())).toBe(true);
        expect(netFor(postings, 'u1', 'user_available').eq(amount)).toBe(true);
      }),
    );
  });

  it('collectFee lands platform fees in platform_fees, creator fees in the creator wallet', () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const platform = collectFee({
          fromUserId: 'u1',
          marketId: 'm1',
          amount,
          type: 'fee_platform',
          currency: 'SPC',
        });
        expect(() => assertBalanced(platform)).not.toThrow();
        // §2.10: company costs are only ever payable from platform_fees.
        expect(netFor(platform, SYSTEM_PLATFORM_ACCOUNT, 'platform_fees').eq(amount)).toBe(true);

        const creator = collectFee({
          fromUserId: 'u1',
          marketId: 'm1',
          amount,
          type: 'fee_creator',
          currency: 'SPC',
          toUserId: 'creator1',
        });
        expect(() => assertBalanced(creator)).not.toThrow();
        expect(netFor(creator, 'creator1', 'user_available').eq(amount)).toBe(true);
      }),
    );
  });
});

describe('composed transactions', () => {
  it('a resolution paying winners and a fee out of escrow balances exactly', () => {
    // This is the shape Step 2 will post: the engine's conservation invariant
    // (Σpayouts + fee === pot) is exactly what makes the ledger transaction
    // balance, so the two checks are the same fact seen from two sides.
    fc.assert(
      fc.property(
        fc.array(amountArb, { minLength: 1, maxLength: 6 }),
        amountArb,
        (stakes, feeSeed) => {
          const pot = stakes.reduce((acc, s) => acc.plus(s), new Decimal(0));
          const fee = Decimal.min(feeSeed, pot.times('0.07'));
          const distributable = pot.minus(fee);

          const postings: Posting[] = [];
          stakes.forEach((stake, i) => {
            const share = distributable.times(stake).div(pot);
            postings.push(
              ...release({
                userId: `u${i}`,
                marketId: 'm1',
                amount: stake,
                type: 'payout',
                currency: 'SPC',
              }),
            );
            // Net the payout against the stake already released.
            const delta = share.minus(stake);
            if (!delta.isZero()) {
              postings.push(
                {
                  userId: `u${i}`,
                  marketId: 'm1',
                  type: 'payout',
                  fundClass: 'user_available',
                  amount: delta,
                  currency: 'SPC',
                },
                {
                  userId: `u${i}`,
                  marketId: 'm1',
                  type: 'payout',
                  fundClass: 'user_escrow',
                  amount: delta.negated(),
                  currency: 'SPC',
                },
              );
            }
          });

          if (!fee.isZero()) {
            postings.push(
              ...collectFee({
                fromUserId: 'u0',
                marketId: 'm1',
                amount: fee,
                type: 'fee_platform',
                currency: 'SPC',
              }),
            );
          }

          const residual = sumPostings(postings);
          expect(residual.abs().lte(new Decimal('1e-18')), `residual ${residual.toString()}`).toBe(
            true,
          );
        },
      ),
    );
  });
});

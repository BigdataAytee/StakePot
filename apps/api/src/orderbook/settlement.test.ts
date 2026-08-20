import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { sumPostings } from '../ledger/posting';
import { splitStake } from './matching';
import { MatchedSettlementError, refundMatched, settleMatched, wins } from './settlement';

const d = (v: string | number): Decimal => new Decimal(v);

/** A minted pair: two holdings whose escrow sums to ₦1 a share. */
function pair(
  outcomeId: string,
  longUser: string,
  shortUser: string,
  shares: string,
  priceKobo: number,
) {
  const split = splitStake(d(shares), priceKobo);
  return [
    {
      userId: longUser,
      outcomeId,
      side: 'long' as const,
      shares: split.collateral,
      escrowed: split.long,
    },
    {
      userId: shortUser,
      outcomeId,
      side: 'short' as const,
      shares: split.collateral,
      escrowed: split.short,
    },
  ];
}

describe('settleMatched', () => {
  it('pays the long ₦1 a share when the outcome wins, out of the pair’s own escrow', () => {
    const holdings = pair('yes', 'ada', 'bola', '1000', 62);
    const settled = settleMatched({ marketId: 'm', winningOutcomeId: 'yes', holdings });

    expect(settled.paid.toString()).toBe('1000');
    expect(settled.released.toString()).toBe('1000');
    // Balanced to the digit: what left escrow is what arrived in a balance.
    expect(sumPostings(settled.postings).isZero()).toBe(true);

    const adaCredit = settled.postings.find(
      (p) => p.userId === 'ada' && p.fundClass === 'user_available',
    );
    expect(adaCredit?.amount.toString()).toBe('1000');
    // The loser gets nothing, and their stake is exactly what funded the win.
    expect(
      settled.postings.some((p) => p.userId === 'bola' && p.fundClass === 'user_available'),
    ).toBe(false);
  });

  it('pays the short when the outcome loses', () => {
    const holdings = pair('yes', 'ada', 'bola', '1000', 62);
    const settled = settleMatched({ marketId: 'm', winningOutcomeId: 'no', holdings });

    expect(settled.paid.toString()).toBe('1000');
    expect(sumPostings(settled.postings).isZero()).toBe(true);
    const bolaCredit = settled.postings.find(
      (p) => p.userId === 'bola' && p.fundClass === 'user_available',
    );
    expect(bolaCredit?.amount.toString()).toBe('1000');
  });

  it('contributes nothing from the platform, at every price', () => {
    // The claim the whole layer is built on. Whatever the pair agreed, the
    // winner is paid out of the two of them and out of nobody else.
    for (let price = 1; price < 100; price += 1) {
      for (const winner of ['yes', 'no']) {
        const holdings = pair('yes', 'ada', 'bola', '777.777777777777777777', price);
        const settled = settleMatched({ marketId: 'm', winningOutcomeId: winner, holdings });
        expect(settled.paid.equals(settled.released)).toBe(true);
        expect(sumPostings(settled.postings).isZero()).toBe(true);
        expect(
          settled.postings.every(
            (p) => p.fundClass === 'user_escrow' || p.fundClass === 'user_available',
          ),
        ).toBe(true);
      }
    }
  });

  it('settles each outcome inside itself on a market with pairs on both', () => {
    // Two outcomes, two independent pools. The winner's pool pays its winner;
    // the loser's pool pays its short. Neither borrows from the other.
    const holdings = [
      ...pair('yes', 'ada', 'bola', '100', 60),
      ...pair('no', 'chidi', 'dele', '400', 30),
    ];
    const settled = settleMatched({ marketId: 'm', winningOutcomeId: 'yes', holdings });

    expect(sumPostings(settled.postings).isZero()).toBe(true);
    const credited = (user: string): string =>
      settled.postings
        .filter((p) => p.userId === user && p.fundClass === 'user_available')
        .reduce((total, p) => total.plus(p.amount), new Decimal(0))
        .toString();

    expect(credited('ada')).toBe('100'); // long yes, yes won
    expect(credited('bola')).toBe('0');
    expect(credited('chidi')).toBe('0'); // long no, no lost
    expect(credited('dele')).toBe('400'); // short no, no lost
  });

  it('refuses a pool whose two sides disagree on size', () => {
    // Unmintable by construction, so reaching this means something wrote the
    // table directly. A named error beats an unbalanced-ledger exception.
    expect(() =>
      settleMatched({
        marketId: 'm',
        winningOutcomeId: 'yes',
        holdings: [
          { userId: 'a', outcomeId: 'yes', side: 'long', shares: d('100'), escrowed: d('60') },
          { userId: 'b', outcomeId: 'yes', side: 'short', shares: d('90'), escrowed: d('40') },
        ],
      }),
    ).toThrow(MatchedSettlementError);
  });

  it('refuses a pool holding something other than ₦1 a share', () => {
    expect(() =>
      settleMatched({
        marketId: 'm',
        winningOutcomeId: 'yes',
        holdings: [
          { userId: 'a', outcomeId: 'yes', side: 'long', shares: d('100'), escrowed: d('60') },
          { userId: 'b', outcomeId: 'yes', side: 'short', shares: d('100'), escrowed: d('39') },
        ],
      }),
    ).toThrow(MatchedSettlementError);
  });

  it('says nothing about a market with no matched positions', () => {
    const settled = settleMatched({ marketId: 'm', winningOutcomeId: 'yes', holdings: [] });
    expect(settled.postings).toHaveLength(0);
    expect(settled.paid.toString()).toBe('0');
  });
});

describe('wins', () => {
  it('pays the long on the winner and the short on everything else', () => {
    const long = {
      userId: 'a',
      outcomeId: 'yes',
      side: 'long' as const,
      shares: d('1'),
      escrowed: d('1'),
    };
    const short = { ...long, side: 'short' as const };
    expect(wins(long, 'yes')).toBe(true);
    expect(wins(long, 'no')).toBe(false);
    expect(wins(short, 'yes')).toBe(false);
    expect(wins(short, 'no')).toBe(true);
  });
});

describe('refundMatched', () => {
  it('gives everybody back exactly what they put in', () => {
    const holdings = pair('yes', 'ada', 'bola', '1000', 62);
    const refunded = refundMatched({ marketId: 'm', holdings });

    expect(sumPostings(refunded.postings).isZero()).toBe(true);
    expect(refunded.refunded.toString()).toBe('1000');
    const credit = (user: string): string =>
      refunded.postings
        .filter((p) => p.userId === user && p.fundClass === 'user_available')
        .reduce((total, p) => total.plus(p.amount), new Decimal(0))
        .toString();
    // A void is not a result: no stake moves from one side to the other.
    expect(credit('ada')).toBe('620');
    expect(credit('bola')).toBe('380');
  });
});

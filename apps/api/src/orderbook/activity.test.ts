import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { newestFirst, readMatchedFill, readMatchedFills } from './activity';

const outcomes = [
  { id: 'yes', label: 'YES', ordinal: 0 },
  { id: 'no', label: 'NO', ordinal: 1 },
];

function fill(takerSide: 'buy' | 'sell', priceKobo: number, shares = '1000', atMs = 0) {
  return {
    id: `f-${takerSide}-${priceKobo}`,
    takerUserId: 'ada',
    takerSide,
    outcomeId: 'yes',
    priceKobo,
    shares: new Decimal(shares),
    createdAt: new Date(atMs),
  };
}

describe('readMatchedFill', () => {
  it('reads a long fill as a buy of the outcome, at its own price', () => {
    const row = readMatchedFill(fill('buy', 62), outcomes);

    expect(row).toMatchObject({ outcomeId: 'yes', label: 'YES', side: 'buy', priceKobo: 62 });
  });

  it('reads a short fill as a buy of the other outcome, at the mirrored price', () => {
    // The book stores one price on one outcome. Nobody pressed "short YES";
    // they pressed "Buy NO at 38".
    const row = readMatchedFill(fill('sell', 62), outcomes);

    expect(row).toMatchObject({ outcomeId: 'no', label: 'NO', side: 'buy', priceKobo: 38 });
  });

  it('values the fill at the pair’s whole stake, not the taker’s half', () => {
    // ₦1 a share, both sides together — the money the trade actually moved,
    // and the figure comparable with a pot trade's cost.
    for (const side of ['buy', 'sell'] as const) {
      const row = readMatchedFill(fill(side, 62, '1000'), outcomes);
      expect(row?.naira.toString()).toBe('1000');
      expect(row?.shares.toString()).toBe('1000');
    }
  });

  it('is always a buy, because a matched fill opens a position', () => {
    // On the pot, buy and sell are enter and exit. There is no exit on the
    // book, so the pressure readout keeps meaning what it always meant.
    expect(readMatchedFill(fill('sell', 20), outcomes)?.side).toBe('buy');
  });

  it('drops a fill it cannot account for rather than guessing at it', () => {
    // Unreachable by construction. A mislabelled row on a public feed is worse
    // than a missing one.
    expect(readMatchedFill({ ...fill('buy', 50), outcomeId: 'maybe' }, outcomes)).toBeNull();
    expect(readMatchedFill(fill('sell', 50), [outcomes[0]!])).toBeNull();
  });

  it('reads the book off ordinal, not the order the rows arrived in', () => {
    const shuffled = [outcomes[1]!, outcomes[0]!];
    expect(readMatchedFill(fill('sell', 62), shuffled)?.label).toBe('NO');
  });

  it('maps a list and keeps the ones it could read', () => {
    const rows = readMatchedFills(
      [fill('buy', 62), { ...fill('buy', 40), outcomeId: 'gone' }],
      outcomes,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('newestFirst', () => {
  it('interleaves two streams by time and caps the result', () => {
    const rows = [
      { id: 'a', at: new Date(3_000) },
      { id: 'b', at: new Date(1_000) },
      { id: 'c', at: new Date(2_000) },
    ];

    expect(newestFirst(rows, (row) => row.at, 2).map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('leaves the caller’s array alone', () => {
    const rows = [
      { id: 'a', at: new Date(1) },
      { id: 'b', at: new Date(2) },
    ];
    newestFirst(rows, (row) => row.at, 2);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});

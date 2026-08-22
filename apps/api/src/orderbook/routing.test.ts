import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { averageKobo, routeFor, tightenToPot, withinLimit } from './routing';

const binary = [
  { id: 'yes', ordinal: 0 },
  { id: 'no', ordinal: 1 },
];

describe('routeFor', () => {
  it('puts a buy of the first outcome on the long side of the book', () => {
    expect(routeFor({ outcomes: binary, outcomeId: 'yes', limitKobo: 62 })).toEqual({
      bookOutcomeId: 'yes',
      side: 'buy',
      limitKobo: 62,
    });
  });

  it('turns a buy of the second outcome into a short of the first, mirrored', () => {
    // "Buy No at 38" and "sell Yes at 62" are the same trade. One book, or the
    // two halves of one spread never meet.
    expect(routeFor({ outcomes: binary, outcomeId: 'no', limitKobo: 38 })).toEqual({
      bookOutcomeId: 'yes',
      side: 'sell',
      limitKobo: 62,
    });
  });

  it('leaves a market order without a limit on either side', () => {
    expect(routeFor({ outcomes: binary, outcomeId: 'no', limitKobo: null })?.limitKobo).toBeNull();
  });

  it('reads the book off ordinal, not off the order the rows arrived in', () => {
    const shuffled = [
      { id: 'no', ordinal: 1 },
      { id: 'yes', ordinal: 0 },
    ];
    expect(routeFor({ outcomes: shuffled, outcomeId: 'no', limitKobo: 40 })).toEqual({
      bookOutcomeId: 'yes',
      side: 'sell',
      limitKobo: 60,
    });
  });

  it('refuses a market that is not binary', () => {
    // Nothing in the interface offers "not B" on a three-way market, so a book
    // there would have three one-sided books and never a match.
    const three = [
      { id: 'a', ordinal: 0 },
      { id: 'b', ordinal: 1 },
      { id: 'c', ordinal: 2 },
    ];
    expect(routeFor({ outcomes: three, outcomeId: 'a', limitKobo: 40 })).toBeNull();
  });

  it('refuses an outcome that is not on the market', () => {
    expect(routeFor({ outcomes: binary, outcomeId: 'maybe', limitKobo: 40 })).toBeNull();
  });
});

describe('averageKobo and withinLimit', () => {
  it('measures the limit against what is actually paid per share', () => {
    // ₦620 for 1,000 shares is 62 kobo each, whatever the marginal price says.
    expect(averageKobo(new Decimal('620'), new Decimal('1000'))?.toString()).toBe('62');
  });

  it('lets a market order through, and refuses a fill above its limit', () => {
    expect(withinLimit(new Decimal('62'), null)).toBe(true);
    expect(withinLimit(new Decimal('62'), 62)).toBe(true);
    expect(withinLimit(new Decimal('62.0001'), 62)).toBe(false);
  });

  it('refuses rather than divides when nothing would be bought', () => {
    expect(averageKobo(new Decimal('10'), new Decimal('0'))).toBeNull();
    expect(withinLimit(null, 50)).toBe(false);
  });
});

describe('tightenToPot', () => {
  it('stops a buyer being filled above the pot’s price', () => {
    // The correction that makes the hybrid honest: the pot quotes both sides
    // with no spread, so a resting ask above its price is strictly worse.
    expect(tightenToPot('buy', 70, 65)).toBe(65);
    expect(tightenToPot('buy', 60, 65)).toBe(60);
  });

  it('stops a seller being filled below it', () => {
    // A short's cost is ₦1 less the long price, so the ceiling is a floor here.
    expect(tightenToPot('sell', 60, 65)).toBe(65);
    expect(tightenToPot('sell', 70, 65)).toBe(70);
  });

  it('gives a market order the pot’s price as its limit', () => {
    expect(tightenToPot('buy', null, 65)).toBe(65);
    expect(tightenToPot('sell', null, 65)).toBe(65);
  });

  it('rounds a fractional pot price in the trader’s favour', () => {
    // Never let the book undercut the pot by a rounding artefact.
    expect(tightenToPot('buy', null, 65.9)).toBe(65);
    expect(tightenToPot('sell', null, 65.1)).toBe(66);
  });

  it('leaves the limit alone when there is no pot price to compare with', () => {
    expect(tightenToPot('buy', 62, null)).toBe(62);
    expect(tightenToPot('buy', null, Number.NaN)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { badgeFor, boldness, calledIt, NO_POSITION, parseBadge } from './badges';

describe('position badges', () => {
  it('renders §2.15a’s example', () => {
    expect(badgeFor({ outcomeLabel: 'Yes', priceAtPost: 0.62, shares: 40 })).toBe('YES@62');
  });

  it('says "none" for somebody holding nothing', () => {
    expect(badgeFor({ outcomeLabel: null, priceAtPost: null, shares: 0 })).toBe(NO_POSITION);
    // A closed-out position is no position, whatever label came with it.
    expect(badgeFor({ outcomeLabel: 'Yes', priceAtPost: 0.62, shares: 0 })).toBe(NO_POSITION);
  });

  it('keeps a multi-outcome label whole', () => {
    const badge = badgeFor({ outcomeLabel: 'Peter Obi', priceAtPost: 0.31, shares: 5 });
    expect(badge).toBe('PETER OBI@31');
    expect(parseBadge(badge)).toEqual({ outcomeLabel: 'PETER OBI', pricePct: 31 });
  });

  it('reads an unrecognisable badge as no position rather than guessing', () => {
    expect(parseBadge('')).toEqual({ outcomeLabel: null, pricePct: null });
    expect(parseBadge(NO_POSITION)).toEqual({ outcomeLabel: null, pricePct: null });
    expect(parseBadge('YES@banana')).toEqual({ outcomeLabel: 'YES', pricePct: null });
  });

  it('judges a call against the result', () => {
    expect(calledIt('YES@62', 'Yes')).toBe(true);
    expect(calledIt('NO@38', 'Yes')).toBe(false);
  });

  it('does not mark a disinterested comment wrong', () => {
    // No position is not a bad call — it is not a call.
    expect(calledIt(NO_POSITION, 'Yes')).toBeNull();
  });

  it('scores a longshot above a favourite', () => {
    const longshot = boldness('YES@15', 'Yes');
    const favourite = boldness('YES@90', 'Yes');
    expect(longshot).toBeGreaterThan(favourite as number);
    expect(longshot).toBeCloseTo(0.85, 5);
  });

  it('scores nothing for a call that missed', () => {
    expect(boldness('NO@38', 'Yes')).toBeNull();
    expect(boldness(NO_POSITION, 'Yes')).toBeNull();
  });
});

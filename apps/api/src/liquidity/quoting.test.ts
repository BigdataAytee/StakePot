import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import {
  MIN_FADE,
  THIN_TRADES,
  closingSoon,
  fadedSize,
  quotesFor,
  widenedSpread,
  type MakerView,
} from './quoting';

/**
 * The maker's rules, held to without a database.
 *
 * Every test here is one line of the brief's §C. They are worth having as unit
 * tests rather than only as integration tests because the properties are
 * absolute — "never exceeds its budget", "never posts one side alone" — and an
 * absolute claim wants to be checked against hundreds of inputs, not three
 * fixtures and a running Postgres.
 */
const NOW = new Date('2026-08-21T12:00:00Z');

function view(over: Partial<MakerView> = {}): MakerView {
  return {
    enabled: true,
    killed: false,
    priceKobo: 50,
    budget: new Decimal(10_000),
    spent: new Decimal(0),
    quoteSize: new Decimal(1_000),
    spreadKobo: 3,
    minPriceKobo: 2,
    maxPriceKobo: 98,
    depth: { bid: new Decimal(0), ask: new Decimal(0) },
    depthStop: new Decimal(50_000),
    inventory: { long: new Decimal(0), short: new Decimal(0) },
    inventoryCap: new Decimal(5_000),
    recentTrades: 20,
    freezeAt: new Date('2026-08-30T12:00:00Z'),
    now: NOW,
    stopBeforeFreezeMinutes: 30,
    ...over,
  };
}

describe('symmetric quoting only', () => {
  it('posts both sides, same size, mirrored around the price', () => {
    const plan = quotesFor(view());

    expect(plan.stop).toBeNull();
    expect(plan.quotes).toHaveLength(2);

    const bid = plan.quotes.find((quote) => quote.side === 'buy');
    const ask = plan.quotes.find((quote) => quote.side === 'sell');
    expect(bid).toBeDefined();
    expect(ask).toBeDefined();
    expect(bid?.shares.equals(ask?.shares ?? new Decimal(-1))).toBe(true);

    // Mirrored: the bid is as far below the price as the ask is above it. That
    // symmetry is what makes the maker's expected direction exactly zero.
    expect(50 - (bid?.priceKobo ?? 0)).toBe((ask?.priceKobo ?? 0) - 50);
  });

  it('never posts one side alone, whatever stops it', () => {
    const stoppers: Partial<MakerView>[] = [
      { enabled: false },
      { killed: true },
      { spent: new Decimal(10_000) },
      { depth: { bid: new Decimal(60_000), ask: new Decimal(60_000) } },
      { inventory: { long: new Decimal(9_000), short: new Decimal(0) } },
      { inventory: { long: new Decimal(0), short: new Decimal(9_000) } },
      { freezeAt: new Date(NOW.getTime() + 60_000) },
      { priceKobo: 99, maxPriceKobo: 98 },
    ];

    for (const over of stoppers) {
      const plan = quotesFor(view(over));
      expect(plan.quotes.length, `${JSON.stringify(Object.keys(over))} posted one side`).not.toBe(
        1,
      );
    }
  });

  it('stops entirely when one side is capped rather than quoting the other', () => {
    // The subtle one. A maker that stopped bidding but kept offering would be
    // short-biased by construction — and it would have got there by following
    // a rule that reads as prudent.
    const plan = quotesFor(
      view({ inventory: { long: new Decimal(5_000), short: new Decimal(0) } }),
    );
    expect(plan.stop).toBe('inventory_capped');
    expect(plan.quotes).toHaveLength(0);
  });
});

describe('the budget is a ceiling, not a target', () => {
  it('never locks more than the budget has left', () => {
    for (let spent = 0; spent <= 10_000; spent += 137) {
      const plan = quotesFor(view({ spent: new Decimal(spent) }));
      const remaining = new Decimal(10_000).minus(spent);
      expect(
        plan.locks.lte(remaining),
        `locked ${plan.locks.toString()} against ${remaining.toString()} remaining`,
      ).toBe(true);
    }
  });

  it('stops quoting when the budget is spent, rather than quoting smaller', () => {
    const plan = quotesFor(view({ spent: new Decimal(10_000) }));
    expect(plan.stop).toBe('budget_spent');
    expect(plan.quotes).toHaveLength(0);
  });

  it('shrinks the pair to what is affordable rather than refusing outright', () => {
    // 9,970 spent of 10,000 leaves 30 — enough for a small pair, not for 1,000
    // shares. The maker takes what it can afford; it does not sulk.
    const plan = quotesFor(view({ spent: new Decimal(9_970) }));
    expect(plan.stop).toBeNull();
    expect(plan.locks.lte(30)).toBe(true);
    expect(plan.quotes[0]?.shares.lt(1_000)).toBe(true);
  });

  it('holds across every price in bounds', () => {
    for (let price = 5; price <= 95; price += 1) {
      const plan = quotesFor(view({ priceKobo: price, spent: new Decimal(9_000) }));
      expect(plan.locks.lte(1_000), `price ${price} locked ${plan.locks.toString()}`).toBe(true);
    }
  });
});

describe('it fades as the market fills up, and then leaves', () => {
  it('widens the spread when volume is thin, and never narrows it', () => {
    expect(widenedSpread(3, 20)).toBe(3);
    expect(widenedSpread(3, THIN_TRADES)).toBe(3);
    expect(widenedSpread(3, 0)).toBeGreaterThan(3);
    // Monotone: more trades never means a wider quote.
    let previous = widenedSpread(4, 0);
    for (let trades = 1; trades <= 10; trades += 1) {
      const current = widenedSpread(4, trades);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
    // And never below the configured floor.
    for (let trades = 0; trades <= 50; trades += 1) {
      expect(widenedSpread(4, trades)).toBeGreaterThanOrEqual(4);
    }
  });

  it('shrinks size as real depth arrives', () => {
    const size = new Decimal(1_000);
    const stop = new Decimal(10_000);
    expect(fadedSize(size, new Decimal(0), stop).equals(1_000)).toBe(true);
    expect(fadedSize(size, new Decimal(5_000), stop).equals(500)).toBe(true);
    // Never to nothing while still quoting — that is what the stop is for.
    expect(fadedSize(size, new Decimal(10_000), stop).equals(size.times(MIN_FADE))).toBe(true);
  });

  it('stops quoting entirely above the depth threshold', () => {
    const plan = quotesFor(view({ depth: { bid: new Decimal(50_000), ask: new Decimal(50_000) } }));
    expect(plan.stop).toBe('depth_reached');
  });

  it('measures depth by the thinner side, so one deep side is not enough', () => {
    // A book with 60k of bids and nothing offered is not a market that has
    // found its counterparties — it is a market that needs an offer.
    const plan = quotesFor(view({ depth: { bid: new Decimal(60_000), ask: new Decimal(0) } }));
    expect(plan.stop).toBeNull();
    expect(plan.quotes).toHaveLength(2);
  });
});

describe('it stands down before the market settles', () => {
  it('stops inside the freeze window', () => {
    const plan = quotesFor(view({ freezeAt: new Date(NOW.getTime() + 20 * 60_000) }));
    expect(plan.stop).toBe('market_closing');
  });

  it('is still quoting outside it', () => {
    const plan = quotesFor(view({ freezeAt: new Date(NOW.getTime() + 40 * 60_000) }));
    expect(plan.stop).toBeNull();
  });

  it('treats a market with no freeze time as open', () => {
    expect(closingSoon(view({ freezeAt: null }))).toBe(false);
  });

  it('puts the freeze ahead of every other reason', () => {
    // A frozen market that is also out of budget should say `market_closing`:
    // the first true reason is the one somebody has to act on, and "top up the
    // budget" is the wrong action here.
    const plan = quotesFor(
      view({ freezeAt: new Date(NOW.getTime() + 60_000), spent: new Decimal(10_000) }),
    );
    expect(plan.stop).toBe('market_closing');
  });
});

describe('it declines to have a view near the ends', () => {
  it('will not quote outside its price bounds', () => {
    expect(quotesFor(view({ priceKobo: 3, minPriceKobo: 5 })).stop).toBe('no_room_in_bounds');
    expect(quotesFor(view({ priceKobo: 97, maxPriceKobo: 95 })).stop).toBe('no_room_in_bounds');
  });

  it('will not quote where a leg would price at 0 or 100', () => {
    // At 99 with a 3-kobo half-width the ask would be 102 — not a price.
    expect(quotesFor(view({ priceKobo: 99, maxPriceKobo: 100 })).stop).toBe('no_room_in_bounds');
    expect(quotesFor(view({ priceKobo: 1, minPriceKobo: 0 })).stop).toBe('no_room_in_bounds');
  });
});

describe('the kill switch outranks everything except being off', () => {
  it('halts a maker that would otherwise quote', () => {
    expect(quotesFor(view({ killed: true })).stop).toBe('killed');
  });

  it('reports being disabled ahead of being killed', () => {
    expect(quotesFor(view({ enabled: false, killed: true })).stop).toBe('disabled');
  });
});

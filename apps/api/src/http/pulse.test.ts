import { describe, expect, it } from 'vitest';

import { ACTIVE_MINUTES, PULSE_WINDOW_MINUTES, pulseOf, type PulseTrade } from './pulse';

const NOW = new Date('2026-03-01T12:00:00.000Z');

function trade(minutesAgo: number, side: string, userId = 'u1'): PulseTrade {
  return { userId, side, createdAt: new Date(NOW.getTime() - minutesAgo * 60_000) };
}

describe('pulseOf', () => {
  it('says nothing has happened when nothing has', () => {
    const pulse = pulseOf([], NOW);

    expect(pulse.tradesPerHour).toBe(0);
    expect(pulse.tradersActive).toBe(0);
    expect(pulse.lastTradeAt).toBeNull();
    // Not zero. Zero would draw a bar hard against the sell side of a market
    // in which nobody has ever sold anything.
    expect(pulse.pressure.buyShare).toBeNull();
  });

  it('counts only the window, however long the market has been open', () => {
    const pulse = pulseOf(
      [
        trade(5, 'buy'),
        trade(59, 'buy'),
        trade(PULSE_WINDOW_MINUTES + 1, 'buy'),
        trade(600, 'buy'),
      ],
      NOW,
    );

    expect(pulse.tradesPerHour).toBe(2);
  });

  it('still reports the last trade when it is older than the window', () => {
    const pulse = pulseOf([trade(400, 'buy')], NOW);

    expect(pulse.tradesPerHour).toBe(0);
    expect(pulse.lastTradeAt).toBe(new Date(NOW.getTime() - 400 * 60_000).toISOString());
  });

  it('counts a trader once however many times they traded', () => {
    const pulse = pulseOf(
      [trade(1, 'buy', 'ada'), trade(2, 'sell', 'ada'), trade(3, 'buy', 'bola')],
      NOW,
    );

    expect(pulse.tradersActive).toBe(2);
  });

  it('leaves a trader out once they are past the active window', () => {
    const pulse = pulseOf([trade(ACTIVE_MINUTES + 1, 'buy', 'ada')], NOW);

    expect(pulse.tradersActive).toBe(0);
    expect(pulse.tradesPerHour).toBe(1);
  });

  it('calls a busier recent half rising', () => {
    const trades = [
      ...Array.from({ length: 8 }, (_, i) => trade(i + 1, 'buy')),
      ...Array.from({ length: 2 }, (_, i) => trade(40 + i, 'buy')),
    ];

    expect(pulseOf(trades, NOW).trend).toBe('rising');
  });

  it('calls a quieter recent half falling', () => {
    const trades = [
      ...Array.from({ length: 2 }, (_, i) => trade(i + 1, 'buy')),
      ...Array.from({ length: 8 }, (_, i) => trade(40 + i, 'buy')),
    ];

    expect(pulseOf(trades, NOW).trend).toBe('falling');
  });

  it('refuses to draw a trend from three trades', () => {
    // Three-to-nothing is a 100% swing by ratio and a coincidence in fact.
    expect(pulseOf([trade(1, 'buy'), trade(2, 'buy'), trade(3, 'buy')], NOW).trend).toBe('steady');
  });

  it('reads pressure from executed sides, not from money', () => {
    const pulse = pulseOf(
      [trade(1, 'buy'), trade(2, 'buy'), trade(3, 'buy'), trade(4, 'sell')],
      NOW,
    );

    expect(pulse.pressure).toMatchObject({ buys: 3, sells: 1, buyShare: 0.75 });
  });

  it('keeps pressure inside its own shorter window', () => {
    const pulse = pulseOf([trade(1, 'buy'), trade(45, 'sell')], NOW);

    // The sell is in the hour but outside the half-hour the pressure reads.
    expect(pulse.tradesPerHour).toBe(2);
    expect(pulse.pressure).toMatchObject({ buys: 1, sells: 0 });
  });
});

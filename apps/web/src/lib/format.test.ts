import { describe, expect, it } from 'vitest';

import { closedReason, exactMoney, money } from './format';

/**
 * The closed-trading line, pinned per state.
 *
 * These exist because the original was a ternary chain with a fall-through
 * default, and the states nobody named inherited "the event has started" —
 * wrong, and wrong in the direction that makes a user distrust the screen.
 */
describe('closedReason', () => {
  it('does not tell a funding market its event has started', () => {
    const line = closedReason('funding', null);
    expect(line).not.toMatch(/event has started/);
    expect(line).toMatch(/backers/i);
  });

  it('names the funding deadline when there is one', () => {
    expect(closedReason('funding', '2026-09-01T12:00:00.000Z')).toMatch(/until .*Sep/);
  });

  it('reserves the frozen wording for the frozen state', () => {
    expect(closedReason('frozen')).toBe('Trading is frozen — the event has started.');
  });

  it('distinguishes waiting on a result from waiting out a dispute', () => {
    expect(closedReason('pending_resolution')).toMatch(/official result/);
    expect(closedReason('dispute_window')).toMatch(/dispute window/);
  });

  it('keeps the pre-launch states as they read before', () => {
    expect(closedReason('resolved')).toBe('This market has settled.');
    expect(closedReason('voided')).toMatch(/refunded in full/);
    expect(closedReason('seeding')).toMatch(/filling the seed/);
    expect(closedReason('draft')).toMatch(/symmetric seed/);
  });

  it('falls back to something true rather than something specific', () => {
    expect(closedReason('some_state_added_later')).toBe('Trading is closed on this market.');
  });
});

describe('money formatting', () => {
  it('puts the sign in front of the currency, not inside it', () => {
    expect(exactMoney('-500')).toBe('-₦500.00');
    expect(money('-15000')).toBe('-₦15k');
    expect(money('-2500000')).toBe('-₦2.5m');
  });

  it('is unchanged for positives', () => {
    expect(exactMoney('500')).toBe('₦500.00');
    expect(money('15000')).toBe('₦15k');
    expect(money('9000')).toBe('₦9,000');
  });
});

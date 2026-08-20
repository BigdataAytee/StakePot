import { describe, expect, it } from 'vitest';

import { DEFAULT_FREEZE_BUFFER_SECONDS, freezeAtFor, freezeView, isTradingFrozen } from '../freeze';

const NOW = new Date('2026-08-20T14:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('when trading stops', () => {
  it('stops before the event, not at it', () => {
    const kickOff = new Date('2026-08-22T15:00:00Z');
    expect(freezeAtFor(kickOff).toISOString()).toBe('2026-08-22T14:58:00.000Z');
    expect(DEFAULT_FREEZE_BUFFER_SECONDS).toBe(120);
    // A buffer of zero is allowed — it is a config value — and a negative one
    // is not, because freezing *after* the event starts is the failure the
    // buffer exists to prevent.
    expect(freezeAtFor(kickOff, 0).toISOString()).toBe(kickOff.toISOString());
    expect(freezeAtFor(kickOff, -600).toISOString()).toBe(kickOff.toISOString());
  });

  it('counts down through the final hour and the final five minutes', () => {
    const view = (minutes: number) =>
      freezeView({ freezeAt: at(minutes), eventDate: at(minutes + 2), state: 'active', now: NOW })
        .phase;

    expect(view(180)).toBe('open');
    expect(view(61)).toBe('open');
    expect(view(59)).toBe('closing');
    expect(view(6)).toBe('closing');
    expect(view(4)).toBe('final');
    expect(view(-1)).toBe('frozen');
  });

  it('is frozen the moment the clock reaches the freeze time', () => {
    const exact = freezeView({ freezeAt: NOW, eventDate: at(2), state: 'active', now: NOW });
    expect(exact.frozen).toBe(true);
    expect(exact.msRemaining).toBe(0);
  });

  it('stays closed for every state past trading, whatever the clock says', () => {
    // The clock says there is a day left. The state says the market has been
    // frozen early, or settled, or voided — and the state wins, because an
    // emergency freeze is exactly the case where the clock is wrong.
    for (const state of ['frozen', 'pending_resolution', 'dispute_window', 'resolved', 'voided']) {
      expect(isTradingFrozen({ freezeAt: at(1440), eventDate: at(1442), state, now: NOW })).toBe(
        true,
      );
    }
    expect(
      isTradingFrozen({ freezeAt: at(1440), eventDate: at(1442), state: 'active', now: NOW }),
    ).toBe(false);
  });

  it('takes the earlier of the two, so a moved event cannot leave trading open', () => {
    // The failure this closes: `eventDate` edited backwards — a rescheduled
    // fixture, a migration, a correction — while `freezeAt` stayed where it
    // was. Preferring `freezeAt` would keep the market trading after the event
    // had started, which is the one direction rule 22 cannot bend in.
    expect(
      isTradingFrozen({ freezeAt: at(600), eventDate: at(-1), state: 'active', now: NOW }),
    ).toBe(true);
    // And the ordinary way round: the freeze is before the event, by the buffer.
    expect(isTradingFrozen({ freezeAt: at(-1), eventDate: at(1), state: 'active', now: NOW })).toBe(
      true,
    );
  });

  it('falls back to the event date when a row has no freeze time, and errs closed', () => {
    // Rows written before freeze times existed. Trading on for ever because a
    // column was added later is the wrong direction to fail in.
    expect(isTradingFrozen({ freezeAt: null, eventDate: at(-1), state: 'active', now: NOW })).toBe(
      true,
    );
    expect(isTradingFrozen({ freezeAt: null, eventDate: at(60), state: 'active', now: NOW })).toBe(
      false,
    );
  });

  it('reads timestamps as strings, because that is how they arrive from an API', () => {
    const view = freezeView({
      freezeAt: '2026-08-20T15:00:00.000Z',
      eventDate: '2026-08-20T15:02:00.000Z',
      state: 'active',
      now: NOW,
    });
    // Exactly one hour out is already 'closing' — the boundary is inclusive, so
    // the countdown appears at the hour rather than a tick after it.
    expect(view.phase).toBe('closing');
    expect(view.msRemaining).toBe(3_600_000);
  });

  it('treats an unparseable timestamp as frozen rather than as open', () => {
    expect(
      isTradingFrozen({ freezeAt: 'not a date', eventDate: 'also not', state: 'active' }),
    ).toBe(true);
  });
});

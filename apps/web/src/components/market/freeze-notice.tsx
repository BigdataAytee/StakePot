'use client';

import { freezeView, frozenMessage, type FreezePhase } from '@stakeam/rules';
import { useEffect, useState } from 'react';

/**
 * When this market stops taking trades, said the same way everywhere.
 *
 * One hook and two small components rather than three copies of the same date
 * arithmetic, because the card, the ticket and the trade sheet all have to
 * agree with the server to the second — and the one that matters is the trade
 * sheet, where disagreeing means offering somebody a button that the API will
 * refuse.
 *
 * The countdown only ticks inside the final hour. A clock beside a market that
 * settles in three weeks trains people to ignore the clock beside the one
 * settling in three minutes.
 */
/**
 * The instant the pre-mount render is computed at.
 *
 * Far enough in the past that every unfrozen market reads as `open` — so the
 * server sends the static "Freezes 15:00 WAT Sat" label, which is the same
 * string the client produces on its first pass.
 */
const BEFORE_MOUNT = new Date(0);

export function useFreeze(market: {
  freezeAt?: string | null;
  eventDate: string;
  state: string;
  freezeReason?: string | null;
}): {
  phase: FreezePhase;
  frozen: boolean;
  msRemaining: number;
  freezeAt: Date;
  message: string;
} {
  /**
   * Null until mounted, and that is the whole trick.
   *
   * Reading the clock during render runs it on the server too, so the markup
   * Next sends carries a countdown computed at request time and the browser
   * immediately computes a different one — which React reports as "the server
   * rendered text didn't match the client" and repairs by throwing the tree
   * away. Before mount the view is derived from a fixed instant, so the server
   * and the first client render agree exactly; the clock starts a tick later.
   *
   * `state` still decides on the server: a market the database says is frozen
   * renders frozen in the HTML, which is the half of the answer that does not
   * depend on what time it is.
   */
  const [now, setNow] = useState<Date | null>(null);

  const view = freezeView({
    freezeAt: market.freezeAt ?? null,
    eventDate: market.eventDate,
    state: market.state,
    now: now ?? BEFORE_MOUNT,
  });

  useEffect(() => {
    setNow(new Date());
  }, []);

  useEffect(() => {
    if (now === null || view.frozen) return;
    // Every second in the last hour, every half-minute before it. A ticking
    // clock is the point inside the final hour and pure re-render cost outside
    // it — and the moment it reaches zero, every button on the page has to go
    // with it rather than waiting for the next poll.
    const period = view.msRemaining <= 3_600_000 ? 1_000 : 30_000;
    const timer = setInterval(() => setNow(new Date()), period);
    return () => clearInterval(timer);
  }, [now, view.frozen, view.msRemaining]);

  return { ...view, message: frozenMessage(market.freezeReason) };
}

/** "Freezes 15:00 WAT Sat", or a live countdown once it is close. */
export function FreezeCountdown({
  market,
  className = '',
}: {
  market: { freezeAt?: string | null; eventDate: string; state: string };
  className?: string;
}) {
  const { phase, msRemaining, freezeAt } = useFreeze(market);

  if (phase === 'frozen') {
    return <span className={`font-semibold uppercase tracking-wide ${className}`}>Frozen</span>;
  }
  if (phase === 'open') {
    return (
      <span className={className}>
        Freezes <b className="font-mono text-text">{whenLabel(freezeAt)}</b>
      </span>
    );
  }

  return (
    <span className={className}>
      Freezes in{' '}
      <b
        className={`font-mono ${
          // The last five minutes get the emphasis. Everything before that is
          // information; this is the window where somebody has to decide now.
          phase === 'final' ? 'font-bold text-fall' : 'text-text'
        }`}
      >
        {clock(msRemaining)}
      </b>
    </span>
  );
}

/** The badge a frozen market carries on its card. */
export function FrozenBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`rounded-sm bg-border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-text-muted ${className}`}
    >
      Frozen
    </span>
  );
}

/**
 * "15:00 WAT Sat".
 *
 * Nigeria has one timezone and no daylight saving, so the label is a constant
 * rather than a lookup — and it is printed rather than left implicit, because a
 * bare "15:00" on a phone set to another zone is a promise the platform did not
 * make.
 */
function whenLabel(at: Date): string {
  const time = at.toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Lagos',
  });
  // The weekday always, rather than dropping it when the freeze is today. That
  // shortcut reads better and is a second reading of the clock during render,
  // which is exactly what makes the server's markup disagree with the browser's.
  const day = at.toLocaleDateString('en-NG', { weekday: 'short', timeZone: 'Africa/Lagos' });
  return `${time} WAT ${day}`;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

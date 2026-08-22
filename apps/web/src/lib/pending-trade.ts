'use client';

/**
 * The trade somebody had half-composed when we asked them to sign in.
 *
 * Signing in mid-trade is the worst moment to lose state. Somebody has read a
 * question, picked a side and typed an amount — three decisions — and the app's
 * answer was a dead sentence that did nothing. Even once that sentence became a
 * link, sending them back to an empty sheet would make them redo all three, and
 * the honest measure of this flow is whether the number they typed before
 * signing in is still there afterwards.
 *
 * `sessionStorage`, not the URL: an amount is nobody else's business, and a
 * market link with someone's stake in the query string is a link they might
 * paste. It is also per-tab and dies with the tab, which is the right lifetime
 * for an intention this short-lived.
 */
const KEY = 'stakeam.pending-trade';

export interface PendingTrade {
  marketId: string;
  outcomeId: string;
  amount: string;
}

/** Where to send somebody to sign in, and how to get them back here. */
export function signInHref(pending: PendingTrade, route: '/login' | '/signup' = '/login'): string {
  const back = `/market/${pending.marketId}?side=${encodeURIComponent(pending.outcomeId)}`;
  return `${route}?next=${encodeURIComponent(back)}`;
}

export function rememberTrade(pending: PendingTrade): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Private browsing, or a full quota. Losing the amount is a worse trade
    // than losing the sign-in, so this never throws its way out of a click.
  }
}

/**
 * Read it back and consume it.
 *
 * Consuming is the point: an intention that survives being acted on would
 * re-open the sheet the next time this market is visited, which is the same
 * bug as leaving `?side=` in the URL.
 */
export function takeTrade(marketId: string): PendingTrade | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(KEY);
    const pending = JSON.parse(raw) as Partial<PendingTrade>;
    // Only for the market it was composed on. Anything else is a stale entry
    // from a tab that wandered off, and restoring an amount onto the wrong
    // question is worse than restoring nothing.
    if (pending.marketId !== marketId) return null;
    if (typeof pending.outcomeId !== 'string' || typeof pending.amount !== 'string') return null;
    return { marketId, outcomeId: pending.outcomeId, amount: pending.amount };
  } catch {
    return null;
  }
}

/**
 * Where a sign-in should return to, from `?next=`.
 *
 * Only same-site paths. `next` arrives from the query string, so it is
 * attacker-controlled: without this check, a link to our own login page could
 * bounce somebody to another origin the moment they authenticate, which is the
 * classic open-redirect phishing setup. A path starting `//` is protocol-
 * relative and goes off-site too, hence the second test.
 */
export function safeNext(next: string | null): string | null {
  if (next === null) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

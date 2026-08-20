/**
 * Formatting for money and prices.
 *
 * §7.4 reserves gold for money and Space Mono with tabular numerals for every
 * live figure; this is the other half of that — the shapes those figures take.
 */

const NAIRA = '₦';

/**
 * The sign belongs in front of the currency, not inside it.
 *
 * `₦-500.00` is what you get by concatenating a symbol onto a formatted
 * negative, and it reads as a typo. Wallet history is full of debits, so this
 * is the difference between a statement and a puzzle.
 */
function signed(n: number, body: string): string {
  return n < 0 ? `-${NAIRA}${body}` : `${NAIRA}${body}`;
}

/** ₦9,000 · ₦1.2m — a pot should be readable at a glance, not counted. */
export function money(value: string | number): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return `${NAIRA}0`;
  const magnitude = Math.abs(n);
  if (magnitude >= 1_000_000)
    return signed(n, `${(magnitude / 1_000_000).toFixed(magnitude >= 10_000_000 ? 0 : 1)}m`);
  if (magnitude >= 10_000) return signed(n, `${Math.round(magnitude / 1000)}k`);
  return signed(n, magnitude.toLocaleString('en-NG', { maximumFractionDigits: 0 }));
}

/** Exact to the kobo, for the trade sheet where the number is the commitment. */
export function exactMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return `${NAIRA}0.00`;
  return signed(
    n,
    Math.abs(n).toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  );
}

/** A probability as a percentage: 0.62 → 62. */
export function percent(price: string | number): number {
  const n = typeof price === 'string' ? Number.parseFloat(price) : price;
  return Number.isFinite(n) ? n * 100 : 0;
}

/**
 * §7.2d: the button *is* the price — "Buy YES 62k", kobo per ₦1 share.
 *
 * Kobo rather than a percentage on purpose: it reads as what it costs, which is
 * the question someone about to trade is actually asking.
 */
export function kobo(price: string | number): string {
  return `${Math.round(percent(price))}k`;
}

/** "2h 14m" — how long until trading freezes. */
export function untilFreeze(eventDate: string, now = Date.now()): string {
  const ms = new Date(eventDate).getTime() - now;
  if (ms <= 0) return 'frozen';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "21 Aug 2026, 10:13" — one date shape across the ticket. */
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * "Settles 30 Aug" — the date a market pays out, in the shortest form that is
 * still unambiguous.
 *
 * The year appears only when it is not this one. A card is a dense object and
 * "2026" on every one of fifty of them is fifty repetitions of a fact the
 * reader already has; a market settling in 2027 is the case where it matters,
 * and that is exactly when it is shown.
 */
export function settlesOn(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * "4:35" when settlement is inside a day, otherwise null.
 *
 * A countdown is information while it is urgent and noise while it is not: a
 * market settling in three weeks does not need a ticking clock, and giving it
 * one trains people to ignore the clock on the market settling in three hours.
 */
export function countdown(iso: string, now = Date.now()): string | null {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0 || ms > 86_400_000) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

export const STATE_LABEL: Record<string, string> = {
  draft: 'AWAITING SEED',
  seeding: 'SEEDING',
  funding: 'FUNDING',
  active: 'LIVE',
  frozen: 'FROZEN',
  pending_resolution: 'RESOLVING',
  dispute_window: 'DISPUTE',
  resolved: 'RESOLVED',
  voided: 'VOID',
};

/**
 * Why trading is closed, in the words that fit the state it is closed *for*.
 *
 * The ticket used to fall through to "the event has started" for anything it
 * did not name, which told a `funding` market's visitor — a market still
 * looking for its backers, days before the event — something flatly untrue.
 * Every state that closes trading now says its own reason, because the whole
 * point of the line is to tell somebody what they are waiting for.
 */
export function closedReason(state: string, fundingClosesAt: string | null = null): string {
  switch (state) {
    case 'resolved':
      return 'This market has settled.';
    case 'seeding':
      return 'Sponsors are still filling the seed. Trading opens the moment the round fills.';
    case 'draft':
      return 'Waiting on the creator’s symmetric seed.';
    case 'voided':
      return 'This market voided — every stake was refunded in full.';
    case 'funding':
      return fundingClosesAt === null
        ? 'Still gathering backers. Trading opens once it activates.'
        : `Still gathering backers until ${dateTime(fundingClosesAt)}. Trading opens once it activates.`;
    case 'frozen':
      return 'Trading is frozen — the event has started.';
    case 'pending_resolution':
      return 'The event is over. Waiting on the official result.';
    case 'dispute_window':
      return 'The result is in. Payouts settle once the dispute window closes.';
    default:
      return 'Trading is closed on this market.';
  }
}

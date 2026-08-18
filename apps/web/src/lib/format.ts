/**
 * Formatting for money and prices.
 *
 * §7.4 reserves gold for money and Space Mono with tabular numerals for every
 * live figure; this is the other half of that — the shapes those figures take.
 */

const NAIRA = '₦';

/** ₦9,000 · ₦1.2m — a pot should be readable at a glance, not counted. */
export function money(value: string | number): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return `${NAIRA}0`;
  if (Math.abs(n) >= 1_000_000)
    return `${NAIRA}${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (Math.abs(n) >= 10_000) return `${NAIRA}${Math.round(n / 1000)}k`;
  return `${NAIRA}${n.toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

/** Exact to the kobo, for the trade sheet where the number is the commitment. */
export function exactMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) return `${NAIRA}0.00`;
  return `${NAIRA}${n.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

export const STATE_LABEL: Record<string, string> = {
  funding: 'FUNDING',
  active: 'LIVE',
  frozen: 'FROZEN',
  pending_resolution: 'RESOLVING',
  dispute_window: 'DISPUTE',
  resolved: 'RESOLVED',
  voided: 'VOID',
};

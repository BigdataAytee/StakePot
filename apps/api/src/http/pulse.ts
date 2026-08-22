/**
 * A market's pulse: how busy it is right now, derived from nothing but the
 * trades that actually executed.
 *
 * This module exists to make one boundary impossible to cross by accident.
 * Every figure here is a count, a rate or a ratio over rows in the trade
 * record — none of it touches price, and none of it can. A market's price is
 * a function of shares outstanding and moves only when a trade moves it
 * (§2.3); "activity" is a different quantity that happens to live on the same
 * screen, and the two must never be confused by a reader or by a maintainer.
 *
 * Hence `pressure`. It is the buy share of recent executed trades and it is
 * named, typed and rendered as recent activity — never as a price, a forecast,
 * or an implied probability. If it read as any of those it would be a second,
 * softer price on a screen that already has the real one.
 */

/** The only columns any of this needs. */
export interface PulseTrade {
  readonly userId: string;
  readonly side: string;
  readonly createdAt: Date;
}

export type Trend = 'rising' | 'falling' | 'steady';

export interface Pulse {
  /** The server's clock at the moment of the read, so the client can age it. */
  readonly now: string;
  /** How far back every rate below is measured. */
  readonly windowMinutes: number;
  /** Executed trades in the window, expressed as a per-hour rate. */
  readonly tradesPerHour: number;
  /** Whether the recent half of the window is busier than the earlier half. */
  readonly trend: Trend;
  /** Distinct traders in the last `activeMinutes`. */
  readonly tradersActive: number;
  readonly activeMinutes: number;
  /** When the last trade landed, or null if this market has never traded. */
  readonly lastTradeAt: string | null;
  readonly pressure: Pressure;
}

/**
 * Which way recent money went — as a count of trades, not a weight of naira.
 *
 * Counting trades rather than summing cost is deliberate. A single ₦2m buy and
 * forty ₦500 buys are different facts, and the naira-weighted version of this
 * would let one large order present itself as a crowd. "Eleven of the last
 * fourteen trades were buys" is a claim about the room; "94% of recent volume
 * was buying" is a claim about one person wearing the room's clothes.
 */
export interface Pressure {
  readonly buys: number;
  readonly sells: number;
  /** Buys as a share of the two, 0–1. Null when nothing has traded. */
  readonly buyShare: number | null;
  readonly windowMinutes: number;
}

export const PULSE_WINDOW_MINUTES = 60;
export const ACTIVE_MINUTES = 15;
export const PRESSURE_WINDOW_MINUTES = 30;

/**
 * A market that averages fewer trades than this over the window is described
 * as steady rather than rising or falling.
 *
 * Two trades in one half-hour and one in the next is not a market cooling
 * off, it is three people. Below the floor the trend is suppressed, because an
 * arrow drawn from a sample this small is decoration pretending to be
 * information.
 */
const TREND_FLOOR = 6;

/** Half the window has to beat the other by this much before it is a trend. */
const TREND_MARGIN = 1.25;

/**
 * Everything the pulse says, from a list of executed trades.
 *
 * Seeds are the caller's job to exclude: a seed takes no side and moves no
 * price (§2.4), so counting it as activity would report a busy market to
 * somebody looking at a market where nobody has traded at all.
 */
export function pulseOf(trades: readonly PulseTrade[], now: Date): Pulse {
  const at = now.getTime();
  const since = (minutes: number): PulseTrade[] =>
    trades.filter((trade) => at - trade.createdAt.getTime() <= minutes * 60_000);

  const window = since(PULSE_WINDOW_MINUTES);
  const half = PULSE_WINDOW_MINUTES / 2;
  const recent = since(half).length;
  const earlier = window.length - recent;

  const latest = trades.reduce<Date | null>(
    (best, trade) => (best === null || trade.createdAt > best ? trade.createdAt : best),
    null,
  );

  const pressureWindow = since(PRESSURE_WINDOW_MINUTES);
  const buys = pressureWindow.filter((trade) => trade.side === 'buy').length;
  const sells = pressureWindow.filter((trade) => trade.side === 'sell').length;

  return {
    now: now.toISOString(),
    windowMinutes: PULSE_WINDOW_MINUTES,
    // The window is an hour, so the count is already a rate. Kept as an
    // explicit conversion rather than a bare count, because the day somebody
    // shortens the window this line is what stops the number silently
    // becoming a different quantity under the same name.
    tradesPerHour: Math.round((window.length * 60) / PULSE_WINDOW_MINUTES),
    trend: trendOf(recent, earlier, window.length),
    tradersActive: new Set(since(ACTIVE_MINUTES).map((trade) => trade.userId)).size,
    activeMinutes: ACTIVE_MINUTES,
    lastTradeAt: latest?.toISOString() ?? null,
    pressure: {
      buys,
      sells,
      buyShare: buys + sells === 0 ? null : buys / (buys + sells),
      windowMinutes: PRESSURE_WINDOW_MINUTES,
    },
  };
}

function trendOf(recent: number, earlier: number, total: number): Trend {
  if (total < TREND_FLOOR) return 'steady';
  if (recent > earlier * TREND_MARGIN) return 'rising';
  if (earlier > recent * TREND_MARGIN) return 'falling';
  return 'steady';
}

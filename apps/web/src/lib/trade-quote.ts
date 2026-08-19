import type { OutcomeView } from './api';

/**
 * What a trade will cost and return, quoted client-side.
 *
 * Extracted from the trade sheet so the detail page's side panel can quote the
 * same numbers without a second copy of the engine's arithmetic. There must be
 * exactly one of these in the app: two implementations of a cost curve drift,
 * and the day they drift is the day one screen promises a fill the other one
 * cannot honour.
 *
 * None of this decides anything. The API recomputes every figure server-side;
 * this only decides what the screen says the trade will do before it is sent.
 */

export interface QuoteMarket {
  pot: string;
  liquidity: string;
  outcomes: OutcomeView[];
}

export interface Quote {
  /** Shares bought, or shares sold. */
  shares: number;
  /** What leaves the wallet on a buy, or lands in it on a sell. */
  total: number;
  gross: number;
  fee: number;
  /** Where this outcome's price ends up once the trade fills. */
  priceAfter: number;
  /** §2.3's pre-resolution payout estimate. Null when selling. */
  estWin: number | null;
}

/**
 * The LMSR cost function, C(q) = L·ln(Σ e^(qᵢ/L)).
 *
 * Shifted by the maximum before exponentiating: without that, a market with a
 * large outstanding position overflows to Infinity in a float and the quote
 * comes back NaN at exactly the size where it matters most.
 */
export function costOf(q: readonly number[], liquidity: number): number {
  const scaled = q.map((value) => value / liquidity);
  const peak = Math.max(...scaled);
  const sum = scaled.reduce((total, value) => total + Math.exp(value - peak), 0);
  return liquidity * (peak + Math.log(sum));
}

export function quote({
  market,
  outcome,
  side,
  amount,
  price,
  exitFeeRate,
}: {
  market: QuoteMarket;
  outcome: OutcomeView;
  side: 'buy' | 'sell';
  /** Naira on a buy, shares on a sell, as typed. */
  amount: string;
  price: number;
  exitFeeRate: number;
}): Quote | null {
  const entered = Number.parseFloat(amount);
  if (!Number.isFinite(entered) || entered <= 0 || price <= 0 || price >= 1) return null;

  const liquidity = Number.parseFloat(market.liquidity);
  const pot = Number.parseFloat(market.pot);
  const outstanding = Number.parseFloat(outcome.shares);
  if (!Number.isFinite(liquidity) || liquidity <= 0) return null;

  if (side === 'sell') {
    // The same curve the engine uses, so the screen quotes what the fill will
    // actually be worth: gross = C(q) − C(q with these shares returned). A
    // linear shares × price is not the curve, and on a large exit it
    // overstates the proceeds — the wrong direction to be wrong in on a
    // number somebody is about to act on.
    const q = market.outcomes.map((row) => Number.parseFloat(row.shares));
    const index = market.outcomes.findIndex((row) => row.id === outcome.id);
    if (index === -1) return null;

    const held = q[index] ?? 0;
    if (entered > held) return null;

    const after = [...q];
    after[index] = held - entered;

    const gross = costOf(q, liquidity) - costOf(after, liquidity);
    if (!Number.isFinite(gross) || gross <= 0) return null;

    // §2.3: the early-exit fee is withheld from the seller, never taken from
    // the pot. Quoted here so the number on the button is the number that
    // lands in the wallet.
    const fee = gross * exitFeeRate;

    return { shares: entered, total: gross - fee, gross, fee, priceAfter: price, estWin: null };
  }

  // The engine's closed form: Δ = L·ln((e^(m/L) − 1 + p)/p).
  const shares = liquidity * Math.log((Math.exp(entered / liquidity) - 1 + price) / price);

  // Price after this fill, from the same shifted exponentials.
  const odds = (1 - price) / price;
  const priceAfter = 1 / (1 + odds * Math.exp(-shares / liquidity));

  // §2.3's pre-resolution estimate is pot / q[w] per share. An estimate
  // because it moves with every trade until the market freezes.
  const potAfter = pot + entered;
  const outstandingAfter = outstanding + shares;
  const estWin = outstandingAfter > 0 ? (potAfter * shares) / outstandingAfter : 0;

  return { shares, total: entered, gross: entered, fee: 0, priceAfter, estWin };
}

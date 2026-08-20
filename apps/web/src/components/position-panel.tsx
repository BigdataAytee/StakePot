'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFreeze } from './market/freeze-notice';
import type { MarketDetail, OutcomeView } from '@/lib/api';
import { exactMoney, kobo } from '@/lib/format';
import { authed, getToken } from '@/lib/session';

interface PositionRow {
  marketId: string;
  outcomeId: string;
  outcomeLabel: string;
  shares: string;
  avgPrice: string;
  /** The outcome's last stored price; the live feed overrides it when present. */
  price: string;
}

/**
 * §7.2d's position panel — what you hold on this market, and the way out.
 *
 * Without it the ticket could take your money but never show it back: the sell
 * path existed only as a toggle inside the buy sheet, which meant a person who
 * had staked had no screen anywhere that said what they owned. A market you can
 * enter and not see yourself in is not a position, it is a donation.
 *
 * The value shown is a mark-to-market at the live price, labelled as such —
 * what you would get for selling now is that figure less the early-exit fee,
 * and the sheet states the fee before anything is committed.
 */
export function PositionPanel({
  market,
  livePrices,
  refreshKey,
  onSell,
}: {
  market: MarketDetail;
  livePrices: Record<string, string>;
  refreshKey: number;
  onSell: (outcome: OutcomeView, held: string) => void;
}) {
  const [positions, setPositions] = useState<PositionRow[] | null>(null);

  const load = useCallback(async () => {
    if (getToken() === null) {
      setPositions([]);
      return;
    }
    try {
      const all = await authed<PositionRow[]>('/me/positions');
      setPositions(all.filter((row) => row.marketId === market.id));
    } catch {
      // Signed out, or the API is unreachable. Either way the ticket above
      // still works, so this stays quiet rather than throwing a panel-sized
      // error onto a screen that is mostly fine.
      setPositions([]);
    }
  }, [market.id]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (positions === null || positions.length === 0) return null;

  const freeze = useFreeze(market);
  const tradable = market.state === 'active' && !freeze.frozen;
  // Frozen but not settled. The distinction matters to whoever is looking:
  // "locked" is a state their money comes back out of, and a panel that simply
  // dropped the Sell button without saying so reads as the button being broken.
  const locked = freeze.frozen && market.state !== 'resolved' && market.state !== 'voided';

  return (
    <section className="mt-5 rounded-lg border border-border bg-surface-raised p-4">
      <h2 className="font-mono text-xs uppercase tracking-widest text-text-muted">Your position</h2>
      {locked && (
        <p className="mt-1 text-xs text-text-muted">
          Locked until settlement — the value below still moves with the last traded price.
        </p>
      )}

      <ul className="mt-3 flex flex-col gap-3">
        {positions.map((row) => {
          const outcome = market.outcomes.find((candidate) => candidate.id === row.outcomeId);
          const price = Number(livePrices[row.outcomeId] ?? row.price);
          const shares = Number(row.shares);
          const value = shares * price;
          const cost = shares * Number(row.avgPrice);
          const up = value >= cost;

          return (
            <li key={row.outcomeId} className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-md font-bold">{row.outcomeLabel}</p>
                <p className="mt-0.5 font-mono text-xs text-text-muted">
                  {shares.toFixed(2)} shares · bought at {kobo(row.avgPrice)} · now{' '}
                  {kobo(String(price))}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <div className="text-right">
                  <p className="font-mono text-md font-black tabular-nums">{exactMoney(value)}</p>
                  <p className={`font-mono text-xs ${up ? 'text-rise' : 'text-fall'}`}>
                    {up ? '+' : ''}
                    {exactMoney(value - cost)}
                  </p>
                </div>
                {tradable && outcome !== undefined && (
                  <button
                    type="button"
                    onClick={() => onSell(outcome, row.shares)}
                    className="rounded-sm border border-border px-3 py-2 text-sm font-bold transition-colors hover:border-fall"
                  >
                    Sell
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 font-mono text-xs text-text-muted">
        Value at the current price. Selling early costs a small exit fee, shown before you confirm.
      </p>
    </section>
  );
}

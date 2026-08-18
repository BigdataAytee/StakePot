'use client';

import { useEffect, useState } from 'react';

import { admin, type DashboardView } from '@/lib/admin-api';
import { exactMoney, money } from '@/lib/format';

/**
 * §6.1's morning screen.
 *
 * "Reconciliation status, total escrow vs user liabilities, live market count,
 * 24h volume & fees, queue health." Read top-left to bottom-right it answers one
 * question: is the money right, and what is waiting for a human.
 */
export default function AdminDashboard() {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void admin
      .dashboard()
      .then(setView)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  if (error !== null) return <p className="text-sm text-fall">{error}</p>;
  if (view === null) return <p className="text-sm text-text-muted">Loading…</p>;

  const solvent = Number(view.solvency.surplus) >= 0;

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-lg font-black">Dashboard</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every figure here is derived from the ledger, not from the wallet cache — the cache is
          what reconciliation checks.
        </p>
      </section>

      {/* The one line that pages on-call. */}
      <section
        className={`rounded-md border px-4 py-3 ${
          view.reconciliation.status === 'clean' ? 'border-border' : 'border-fall bg-fall/10'
        }`}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Reconciliation</h2>
          <span
            className={`font-mono text-sm uppercase ${
              view.reconciliation.status === 'clean' ? 'text-rise' : 'text-fall'
            }`}
          >
            {view.reconciliation.status}
          </span>
        </div>
        <p className="mt-1 font-mono text-xs text-text-muted">
          {view.reconciliation.runDate === null
            ? 'no run recorded yet'
            : `last run ${new Date(view.reconciliation.runDate).toLocaleString('en-NG')} · diff ${
                view.reconciliation.diff ?? '0'
              }`}
        </p>
      </section>

      <section className="grid grid-cols-3 gap-3">
        <Tile label="User liabilities" value={exactMoney(view.solvency.userLiabilities)} money />
        <Tile label="Issued (backing)" value={exactMoney(view.solvency.held)} money />
        <Tile
          label="Surplus"
          value={exactMoney(view.solvency.surplus)}
          money
          {...(solvent ? {} : { tone: 'alarm' as const })}
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold">Fund classes</h2>
        <p className="mt-1 text-sm text-text-muted">
          §2.10&rsquo;s segregation, visible: company costs can only ever be paid from platform
          fees.
        </p>
        <div className="mt-3 grid grid-cols-4 gap-3">
          <Tile
            label="user_available"
            value={exactMoney(view.solvency.byFundClass.user_available)}
            money
          />
          <Tile
            label="user_escrow"
            value={exactMoney(view.solvency.byFundClass.user_escrow)}
            money
          />
          <Tile
            label="platform_fees"
            value={exactMoney(view.solvency.byFundClass.platform_fees)}
            money
          />
          <Tile label="prize_pool" value={exactMoney(view.solvency.byFundClass.prize_pool)} money />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-sm font-semibold">Escrow by market state</h2>
          {view.solvency.escrowByMarketState.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">Nothing escrowed.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead className="text-left font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="py-1">state</th>
                  <th className="py-1 text-right">markets</th>
                  <th className="py-1 text-right">escrowed</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {view.solvency.escrowByMarketState.map((row) => (
                  <tr key={row.state} className="border-t border-border">
                    <td className="py-1.5">{row.state}</td>
                    <td className="py-1.5 text-right">{row.markets}</td>
                    <td className="py-1.5 text-right text-money">{money(row.escrowed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 className="text-sm font-semibold">Last 24 hours</h2>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Tile label="Live markets" value={String(view.activity.liveMarkets)} />
            <Tile label="Trades" value={String(view.activity.trades24h)} />
            <Tile label="Volume" value={money(view.activity.volume24h)} money />
            <Tile label="Fees" value={money(view.activity.fees24h)} money />
          </div>
        </div>
      </section>
    </div>
  );
}

/** Gold is money and nothing else (§7.4). Red is an alarm and nothing else. */
function Tile({
  label,
  value,
  money: isMoney = false,
  tone,
}: {
  label: string;
  value: string;
  money?: boolean;
  tone?: 'alarm';
}) {
  const colour = tone === 'alarm' ? 'text-fall' : isMoney ? 'text-money' : 'text-text';
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className="font-mono text-xs text-text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg tabular-nums ${colour}`}>{value}</p>
    </div>
  );
}

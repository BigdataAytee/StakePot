'use client';

import { useEffect, useState } from 'react';

import {
  admin,
  type LedgerRow,
  type ReconciliationRow,
  type ReservesExport,
} from '@/lib/admin-api';
import { exactMoney } from '@/lib/format';

/**
 * §6.4's money room.
 *
 * Three things on one screen: the ledger explorer ("drill from any balance to
 * every entry behind it"), reconciliation history, and the proof-of-reserves
 * export. There is deliberately no control here that changes a balance — those
 * live in the approvals inbox, because a balance nobody approved is exactly what
 * §2.10 exists to prevent.
 */
export default function MoneyRoom() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [runs, setRuns] = useState<ReconciliationRow[]>([]);
  const [reserves, setReserves] = useState<ReservesExport | null>(null);
  const [userId, setUserId] = useState('');
  const [marketId, setMarketId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const search = (): void => {
    void admin
      .ledger({ userId, marketId })
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(() => {
    search();
    void admin
      .reconciliation()
      .then(setRuns)
      .catch(() => undefined);
    void admin
      .reserves()
      .then(setReserves)
      .catch(() => undefined);
    // Deliberately once: the money room is for looking closely, not for watching.
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-black">Money room</h1>
        <p className="mt-1 text-sm text-text-muted">
          The ledger is append-only. Nothing on this screen edits it — corrections are reversing
          entries, proposed in the approvals inbox.
        </p>
      </header>

      {reserves !== null && (
        <section className="rounded-md border border-border p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Proof of reserves</h2>
            <span
              className={`font-mono text-xs uppercase ${
                reserves.solvent ? 'text-rise' : 'text-fall'
              }`}
            >
              {reserves.solvent ? 'solvent' : 'shortfall'}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-4 gap-3 font-mono text-sm tabular-nums">
            <Figure label="liabilities" value={exactMoney(reserves.userLiabilities)} />
            <Figure label="issued" value={exactMoney(reserves.totalIssued)} />
            <Figure label="platform fees" value={exactMoney(reserves.platformFees)} />
            <Figure label="surplus" value={exactMoney(reserves.surplus)} />
          </dl>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-xs text-text-muted">
              generated {new Date(reserves.generatedAt).toLocaleString('en-NG')}
            </p>
            <ExportButton />
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold">Ledger explorer</h2>
        <div className="mt-2 flex gap-2">
          <input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="user id"
            aria-label="Filter by user"
            className="w-64 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-xs"
          />
          <input
            value={marketId}
            onChange={(event) => setMarketId(event.target.value)}
            placeholder="market id"
            aria-label="Filter by market"
            className="w-64 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={search}
            className="rounded-sm border border-border px-3 py-1.5 text-sm"
          >
            Search
          </button>
        </div>

        {error !== null && <p className="mt-2 text-sm text-fall">{error}</p>}

        <div className="mt-3 max-h-96 overflow-auto rounded-md border border-border">
          <table className="w-full text-left font-mono text-xs">
            <thead className="sticky top-0 bg-surface-raised text-text-muted">
              <tr>
                <th className="px-2 py-1.5">when</th>
                <th className="px-2 py-1.5">account</th>
                <th className="px-2 py-1.5">type</th>
                <th className="px-2 py-1.5">fund class</th>
                <th className="px-2 py-1.5 text-right">amount</th>
                <th className="px-2 py-1.5">ref</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-2 py-1.5 text-text-muted">
                    {new Date(row.createdAt).toLocaleString('en-NG')}
                  </td>
                  <td className="px-2 py-1.5">{row.userId.slice(0, 10)}…</td>
                  <td className="px-2 py-1.5">{row.type}</td>
                  <td className="px-2 py-1.5 text-text-muted">{row.fundClass}</td>
                  <td
                    className={`px-2 py-1.5 text-right ${
                      row.amount.startsWith('-') ? 'text-fall' : 'text-money'
                    }`}
                  >
                    {row.amount}
                  </td>
                  <td className="px-2 py-1.5 text-text-muted">{row.ref ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-text-muted">
                    No entries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Reconciliation history</h2>
        <p className="mt-1 text-sm text-text-muted">
          The sums are whole-book, house accounts included, so a balanced ledger nets to zero. The
          check that matters is per-account, and it is what sets the status.
        </p>
        <table className="mt-2 w-full text-left font-mono text-xs">
          <thead className="text-text-muted">
            <tr>
              <th className="py-1.5">run</th>
              <th className="py-1.5">status</th>
              <th className="py-1.5 text-right">Σ ledger</th>
              <th className="py-1.5 text-right">Σ wallets</th>
              <th className="py-1.5 text-right">diff</th>
              <th className="py-1.5">cleared by</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {runs.map((run) => (
              <tr key={run.id} className="border-t border-border">
                <td className="py-1.5">{new Date(run.runDate).toLocaleDateString('en-NG')}</td>
                <td className={`py-1.5 ${run.status === 'clean' ? 'text-rise' : 'text-fall'}`}>
                  {run.status}
                </td>
                <td className="py-1.5 text-right">{run.ledgerTotal}</td>
                <td className="py-1.5 text-right">{run.walletTotal}</td>
                <td className="py-1.5 text-right">{run.diff}</td>
                <td className="py-1.5 text-text-muted">{run.clearedBy ?? '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-text-muted">
                  No runs recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/**
 * §2.10's "one-click signed export".
 *
 * Fetched and handed over as a blob rather than linked: the endpoint is
 * role-guarded, and a plain `<a download>` carries no Authorization header, so
 * a link would download a 401 page named like a reserves report — the single
 * worst possible artefact to hand an auditor.
 *
 * The filename carries the date because these get filed, and the button says
 * outright when the document came back unsigned rather than letting somebody
 * discover it at the point of attestation.
 */
function ExportButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const document_ = await admin.reservesExport();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `stakeam-reserves-${document_.generatedAt.slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      if (document_.signature === null) {
        setNote('Exported unsigned — RESERVES_SIGNING_KEY is not set for this environment.');
      }
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : 'export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        className="rounded-sm border border-border px-3 py-1.5 text-xs font-semibold hover:border-text disabled:opacity-40"
      >
        {busy ? 'Preparing…' : 'Signed export'}
      </button>
      {note !== null && <p className="mt-1 max-w-xs text-xs text-fall">{note}</p>}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-money">{value}</dd>
    </div>
  );
}

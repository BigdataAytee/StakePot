'use client';

import { Megaphone, Send, Trash2, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { growth, type LeaderboardRow, type PrizeRunView } from '@/lib/admin-api';

/**
 * §6.8's prize desk: "weekly prize runs (approve airtime payouts)".
 *
 * The table is drawn up here and *signed elsewhere*. That split is the control:
 * this screen can propose a payout and can never make one, so the person who
 * chooses the winners is not the person who releases the money. The submit
 * button files an ordinary four-eyes proposal, which lands in the same
 * approvals inbox as a ledger adjustment.
 */
export default function PrizeDesk() {
  const [runs, setRuns] = useState<PrizeRunView[]>([]);
  const [preview, setPreview] = useState<LeaderboardRow[]>([]);
  const [period, setPeriod] = useState('all-time');
  const [board, setBoard] = useState<'profit' | 'accuracy'>('profit');
  const [pool, setPool] = useState('100000');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load(): void {
    void growth
      .prizeRuns()
      .then(setRuns)
      .catch((caught: Error) => setError(caught.message));
  }

  useEffect(() => {
    void growth
      .prizeRuns()
      .then(setRuns)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(() => {
    void growth
      .prizePreview(period, board)
      .then(setPreview)
      .catch(() => setPreview([]));
  }, [period, board]);

  async function act(key: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await action();
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-black">
          <Trophy size={18} className="text-money" /> Prize runs
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Draw a run from a published board, then send it for a second signature. Nothing here pays
          anybody — the approval does.
        </p>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      <section className="rounded-md border border-border p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">New run</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-text-muted">
            Period
            <input
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className="mt-1 block rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="text-xs text-text-muted">
            Board
            <select
              value={board}
              onChange={(event) => setBoard(event.target.value as 'profit' | 'accuracy')}
              className="mt-1 block rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm"
            >
              <option value="profit">profit</option>
              <option value="accuracy">accuracy</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Pot (SPC)
            <input
              value={pool}
              onChange={(event) => setPool(event.target.value)}
              className="mt-1 block rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            disabled={busy === 'draft' || preview.length === 0}
            onClick={() =>
              void act('draft', () => growth.draftRun({ period, board, poolSpc: pool }))
            }
            className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
          >
            Draw it up
          </button>
        </div>

        {preview.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            That board has not been published. A run can only pay against numbers people can see.
          </p>
        ) : (
          <ol className="mt-3 space-y-1 font-mono text-xs text-text-muted">
            {preview.slice(0, 10).map((row) => (
              <li key={row.userId}>
                {row.rank}. {row.handle === null ? row.userId.slice(0, 8) : `@${row.handle}`} ·{' '}
                {board === 'profit'
                  ? // Money columns are Decimal(38,18); showing the raw string
                    // puts eighteen decimal places on a screen somebody is
                    // meant to read a ranking off.
                    `${Number(row.profit).toLocaleString('en-NG', {
                      maximumFractionDigits: 0,
                    })} SPC`
                  : `${row.accuracyPct}%`}
              </li>
            ))}
          </ol>
        )}
      </section>

      {runs.map((run) => (
        <section key={run.id} className="rounded-md border border-border p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-bold">
              {run.period} · {run.board}
            </h2>
            <span
              className={`font-mono text-xs uppercase ${
                run.state === 'paid'
                  ? 'text-rise'
                  : run.state === 'cancelled'
                    ? 'text-text-muted'
                    : 'text-money'
              }`}
            >
              {run.state.replace('_', ' ')}
            </span>
          </div>

          <p className="mt-1 font-mono text-xs text-text-muted">
            <span className="text-money">
              {Number(run.total).toLocaleString('en-NG', { maximumFractionDigits: 0 })} SPC
            </span>{' '}
            across {run.awards.length} places
          </p>

          <ol className="mt-3 space-y-0.5 font-mono text-xs">
            {run.awards.map((award) => (
              <li key={award.userId} className="flex justify-between">
                <span className="text-text-muted">
                  {award.rank}.{' '}
                  {award.handle === null ? award.userId.slice(0, 8) : `@${award.handle}`}
                  {award.tier < 1 && (
                    <span className="ml-2 text-fall">Tier 0 — will not be paid</span>
                  )}
                </span>
                <span className="text-money">
                  {Number(award.amount).toLocaleString('en-NG', { maximumFractionDigits: 0 })}
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-3 flex flex-wrap gap-2">
            {run.state === 'draft' && (
              <>
                <button
                  type="button"
                  disabled={busy === run.id}
                  onClick={() =>
                    void act(run.id, () =>
                      growth.submitRun(run.id, `Prize run for ${run.period} (${run.board}).`),
                    )
                  }
                  className="flex items-center gap-1.5 rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
                >
                  <Send size={14} /> Send for approval
                </button>
                <button
                  type="button"
                  disabled={busy === run.id}
                  onClick={() => void act(run.id, () => growth.cancelRun(run.id))}
                  className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  <Trash2 size={14} /> Cancel
                </button>
              </>
            )}
            {run.state === 'pending_approval' && (
              <p className="text-sm text-text-muted">Waiting on a second signature in Approvals.</p>
            )}
            {run.state === 'paid' && (
              <button
                type="button"
                disabled={busy === run.id}
                onClick={() => void act(run.id, () => growth.announceRun(run.id))}
                className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-40"
              >
                <Megaphone size={14} /> Tell the winners
              </button>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

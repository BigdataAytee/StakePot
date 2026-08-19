'use client';

import { useEffect, useState } from 'react';

import { ops, type ConfigConsole, type ConfigNote } from '@/lib/admin-api';
import { dateTime } from '@/lib/format';

/**
 * §6.4b's Platform Config Console.
 *
 * "Maximum-security zone." The service, the versioning and the 24-hour delay
 * have all existed since step 8 — what did not exist is the screen, and what
 * makes it a security zone rather than a settings page is two things:
 *
 * The blast radius. `exit_fee_rate` and `comment_max_length` are both one
 * number in one table. One of them changes what every member pays on every
 * early exit. Rendering them identically is how somebody comes to treat them
 * identically, so every row carries what it controls and what goes wrong.
 *
 * The clock. §6.4b's delay is only a safeguard if somebody can see it running,
 * so pending changes are shown first, as a diff, with the moment they land.
 *
 * Nothing here writes. A change is an approvals proposal, and the approve
 * endpoint already demands a step-up TOTP code — putting a second challenge in
 * front of a read-only screen would train operators to type codes on demand,
 * which is the habit every credential-phishing attack needs.
 */
const BLAST: Record<ConfigNote['blast'], { label: string; className: string }> = {
  money: { label: 'money', className: 'bg-fall/15 text-fall' },
  market: { label: 'market', className: 'bg-caution/20 text-caution' },
  guard: { label: 'guard', className: 'bg-brand/15 text-brand' },
  cosmetic: { label: 'cosmetic', className: 'bg-surface-raised text-text-muted' },
};

export default function ConfigPage() {
  const [view, setView] = useState<ConfigConsole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConfigNote['blast'] | 'all'>('all');

  useEffect(() => {
    void ops
      .config()
      .then(setView)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const keys = (view?.keys ?? []).filter((row) => filter === 'all' || row.note?.blast === filter);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-black">Platform config</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every tunable value in the architecture. Read-only here — a change is a four-eyes proposal
          in the approvals inbox and takes effect after the configured delay.
        </p>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {view !== null && view.pending.length > 0 && (
        <section className="rounded-md border border-caution/50 bg-caution/10 p-4">
          <h2 className="text-sm font-semibold">Approved and waiting</h2>
          <p className="mt-1 text-sm text-text-muted">
            These land on their own. The delay exists so a mistake can be caught before it does
            anything — cancelling one is a new proposal, never an edit.
          </p>
          <ul className="mt-3 space-y-2">
            {view.pending.map((change) => (
              <li key={`${change.key}:${change.version}`} className="rounded-sm bg-surface p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">{change.key}</span>
                  <span className="font-mono text-xs text-caution">
                    lands {dateTime(change.effectiveAt)}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs">
                  <span className="text-text-muted line-through">{format(change.from)}</span>
                  <span className="mx-2">→</span>
                  <span className="font-bold">{format(change.to)}</span>
                </p>
                {change.note !== null && (
                  <p className="mt-1 text-xs text-fall">{change.note.risk}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Live values</h2>
          <div className="flex gap-1">
            {(['all', 'money', 'market', 'guard', 'cosmetic'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                aria-pressed={filter === option}
                className={`rounded-sm px-2 py-1 font-mono text-xs ${
                  filter === option
                    ? 'bg-surface-raised text-text'
                    : 'text-text-muted hover:text-text'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {keys.map((row) => (
            <li key={row.key} className="p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  {row.note !== null && (
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-xs ${BLAST[row.note.blast].className}`}
                    >
                      {BLAST[row.note.blast].label}
                    </span>
                  )}
                  <span className="font-mono text-sm">{row.key}</span>
                </span>
                <span className="font-mono text-sm font-bold tabular-nums">
                  {format(row.value)}
                  <span className="ml-2 text-xs font-normal text-text-muted">v{row.version}</span>
                </span>
              </div>
              {row.note !== null && (
                <p className="mt-1 text-xs text-text-muted">
                  {row.note.what} <span className="text-fall">{row.note.risk}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold">What changed</h2>
        <p className="mt-1 text-sm text-text-muted">
          Append-only. A rollback is a new proposal, so this is the whole history of who changed
          platform economics and why.
        </p>
        <ul className="mt-3 space-y-1">
          {(view?.history ?? []).map((entry, index) => (
            <li
              key={`${entry.key}:${entry.proposedAt}:${index}`}
              className="rounded-sm border border-border p-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs">
                <span className="font-semibold">{entry.key}</span>
                <span className="text-text-muted">
                  {entry.proposedBy} → {entry.approvedBy} ·{' '}
                  {entry.activatedAt === null ? 'pending' : dateTime(entry.activatedAt)}
                </span>
              </div>
              <p className="mt-1 font-mono text-xs">
                <span className="text-text-muted line-through">{format(entry.from)}</span>
                <span className="mx-2">→</span>
                <span>{format(entry.to)}</span>
              </p>
              <p className="mt-1 text-xs text-text-muted">{entry.reason}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** A config value as one readable line. Objects are settings too. */
function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

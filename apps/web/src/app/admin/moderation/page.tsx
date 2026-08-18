'use client';

import { AlertTriangle, Check, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { community, type ModerationRow } from '@/lib/community-api';

/**
 * §2.15e's moderation queue, for the Trust & Safety desk (§6.5).
 *
 * Held comments come first, because those are the ones nobody can see yet —
 * somebody's words are waiting on this screen, not merely being watched by it.
 * Every row shows what the rules matched and what people reported, so the
 * decision is checkable rather than a matter of taste.
 */
export default function ModerationQueue() {
  const [rows, setRows] = useState<ModerationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load(): void {
    void community
      .moderationQueue()
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  }

  useEffect(() => {
    void community
      .moderationQueue()
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  async function decide(id: string, decision: 'publish' | 'remove'): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await community.moderate(id, decision);
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-black">Moderation</h1>
        <p className="mt-1 text-sm text-text-muted">
          Held comments are invisible to everyone but their author until you decide. Nothing here
          was removed by a rule — the rules only hold and flag.
        </p>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">Queue is clear.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`rounded-md border p-4 ${
                row.state === 'held' ? 'border-fall' : 'border-border'
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-xs uppercase text-text-muted">
                  {row.state === 'held' ? (
                    <span className="flex items-center gap-1 text-fall">
                      <AlertTriangle size={11} /> held
                    </span>
                  ) : (
                    'flagged'
                  )}
                </span>
                <span className="font-mono text-xs text-text-muted">
                  {row.reports > 0 && `${row.reports} reports · `}
                  {row.badge}
                </span>
              </div>

              <p className="mt-2 text-sm">{row.text}</p>

              <p className="mt-1 font-mono text-xs text-text-muted">
                {row.author.handle === null ? row.author.id : `@${row.author.handle}`} on{' '}
                {row.market.question}
              </p>

              {row.flags.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {row.flags.map((flag) => (
                    <li
                      key={`${flag.kind}-${flag.evidence}`}
                      className="rounded-sm bg-fall/10 px-1.5 py-0.5 font-mono text-[10px] text-fall"
                    >
                      {flag.kind.replace(/_/g, ' ')}: {flag.evidence}
                    </li>
                  ))}
                </ul>
              )}

              {row.recentReasons.length > 0 && (
                <ul className="mt-2 border-l border-border pl-3 text-xs text-text-muted">
                  {row.recentReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void decide(row.id, 'publish')}
                  className="flex items-center gap-1.5 rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
                >
                  <Check size={14} /> Let it stand
                </button>
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void decide(row.id, 'remove')}
                  className="flex items-center gap-1.5 rounded-sm border border-fall px-3 py-1.5 text-sm font-semibold text-fall disabled:opacity-40"
                >
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

import { ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { admin, type DraftRow } from '@/lib/admin-api';

/**
 * §6.2's drafts queue.
 *
 * "Fed by the AI drafts queue (§2.9: ranked, scored, one-click open
 * pre-filled)." The one thing this screen must never become is a publish
 * button with a spinner in front of it, so the whole template is on the page —
 * the question, every outcome's settlement criteria, the source, the dates —
 * and the refusals are one toggle away, because what the engine turned down is
 * how you tell whether it is behaving.
 */
export default function DraftsQueue() {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [showRefused, setShowRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = (includeRejected = showRefused): void => {
    void admin
      .drafts(includeRejected)
      .then(setDrafts)
      .catch((caught: Error) => setError(caught.message));
  };

  // Reloads when the refusals toggle changes; `load` is re-created each render,
  // so it is deliberately not a dependency.
  useEffect(() => {
    void admin
      .drafts(showRefused)
      .then(setDrafts)
      .catch((caught: Error) => setError(caught.message));
  }, [showRefused]);

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(id);
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
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-black">Drafts</h1>
          <p className="mt-1 text-sm text-text-muted">
            The engine suggests; you open. Nothing here is live, and nothing here goes live without
            this click.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 font-mono text-xs text-text-muted">
            <input
              type="checkbox"
              checked={showRefused}
              onChange={(event) => setShowRefused(event.target.checked)}
            />
            show what it refused
          </label>
          <button
            type="button"
            disabled={busy === 'generate'}
            onClick={() => void act('generate', () => admin.generateDrafts())}
            className="flex items-center gap-1.5 rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
          >
            <Sparkles size={14} />
            {busy === 'generate' ? 'Drafting…' : 'Draft a cycle'}
          </button>
        </div>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {drafts.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing waiting. The shelf may already be full — the engine only drafts for free slots.
        </p>
      ) : (
        <ul className="space-y-3">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className={`rounded-md border p-4 ${
                draft.state === 'rejected' ? 'border-border opacity-70' : 'border-border'
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-md font-bold">
                  {/*
                    §6.2: "first-time creators always flagged for human
                    review". The flag was filed on every draft and shown on
                    none, which made the rule true in the database and
                    invisible at the desk where it has to change what somebody
                    does. These sort to the top of the queue too.
                  */}
                  {draft.firstMarket && (
                    <span className="mr-2 rounded-full bg-caution/20 px-2 py-0.5 align-middle text-xs font-bold uppercase tracking-wide text-caution">
                      First market
                    </span>
                  )}
                  {draft.question}
                </h2>
                <span className="whitespace-nowrap font-mono text-xs text-text-muted">
                  {draft.slot ?? draft.source} · score{' '}
                  <span className="text-money">{draft.score.toFixed(2)}</span>
                </span>
              </div>

              <p className="mt-1 text-sm text-text-muted">{draft.rationale}</p>

              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <h3 className="font-mono text-xs uppercase text-text-muted">Outcomes</h3>
                  <ul className="mt-1 space-y-1">
                    {draft.template.outcomes.map((outcome) => (
                      <li key={outcome.label}>
                        <span className="font-semibold">{outcome.label}</span>{' '}
                        <span className="text-text-muted">{outcome.criteria}</span>
                      </li>
                    ))}
                  </ul>
                  {draft.estimates.length > 0 && (
                    <p className="mt-2 font-mono text-xs text-text-muted">
                      estimate {draft.estimates.map((value) => Math.round(value * 100)).join('/')}
                    </p>
                  )}
                </div>
                <div className="font-mono text-xs text-text-muted">
                  <a
                    href={draft.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-rise underline underline-offset-2"
                  >
                    {draft.sourceName} <ExternalLink size={11} />
                  </a>
                  <p className="mt-1">
                    event {new Date(draft.eventDate).toLocaleDateString('en-NG')} · voids{' '}
                    {new Date(draft.voidDate).toLocaleDateString('en-NG')}
                  </p>
                  <p className="mt-1">engagement {Math.round(draft.engagement * 100)}%</p>
                </div>
              </div>

              {draft.refusals.length > 0 && (
                <ul className="mt-3 space-y-1 border-l border-fall pl-3 text-sm text-fall">
                  {draft.refusals.map((refusal) => (
                    <li key={refusal}>{refusal}</li>
                  ))}
                </ul>
              )}

              {draft.state === 'suggested' && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy === draft.id}
                    onClick={() => void act(draft.id, () => admin.openDraft(draft.id))}
                    className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
                  >
                    Open it
                  </button>
                  <input
                    value={notes[draft.id] ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [draft.id]: event.target.value }))
                    }
                    placeholder="Why not? Kept on the record."
                    aria-label={`Reason for refusing ${draft.question}`}
                    className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={busy === draft.id || (notes[draft.id] ?? '').trim().length < 5}
                    onClick={() =>
                      void act(draft.id, () =>
                        admin.rejectDraft(draft.id, (notes[draft.id] ?? '').trim()),
                      )
                    }
                    className="rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-30"
                  >
                    Pass
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

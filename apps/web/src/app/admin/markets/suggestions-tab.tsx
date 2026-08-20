'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { admin, type DraftRow } from '@/lib/admin-api';

/**
 * What the engine has drafted, and what it refused.
 *
 * Refusals are shown by default here, unlike on the old queue where they sat
 * behind a toggle. The checklist made the engine state *why* it threw a draft
 * away, and that reason is the most useful thing on the screen: a cycle that
 * refused four drafts for "no source with a settling page" tells you something
 * about the shelf that four accepted drafts cannot.
 */
export function SuggestionsTab() {
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void admin
      .drafts(true)
      .then(setDrafts)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await admin.generateDrafts();
      setDrafts(await admin.drafts(true));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-sm text-text-muted">
          The engine suggests; you open. Nothing here is live.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="ml-auto flex items-center gap-1.5 rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
        >
          <Sparkles size={14} />
          {busy ? 'Drafting…' : 'Draft a cycle'}
        </button>
      </div>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {drafts === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : drafts.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface-raised p-4 text-sm text-text-muted">
          Nothing drafted yet. A cycle only drafts for slots the shelf has free.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {drafts.map((draft) => (
            <li key={draft.id} className="rounded-xl border border-border bg-surface-raised p-3.5">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                    draft.state === 'suggested' ? 'bg-rise/15 text-rise' : 'bg-fall/15 text-fall'
                  }`}
                >
                  {draft.state}
                </span>
                <span className="flex-1 font-semibold">{draft.question}</span>
                <span className="font-mono text-xs text-text-muted">
                  {Math.round(draft.score * 100)}
                </span>
              </div>

              <p className="mt-1 text-xs text-text-muted">
                {draft.sourceName} · settles{' '}
                {new Date(draft.eventDate).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              </p>

              {draft.refusals.length > 0 && (
                <ul className="mt-2 space-y-1 border-l-2 border-fall pl-3 text-xs text-fall">
                  {draft.refusals.map((refusal) => (
                    <li key={refusal}>{refusal}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-text-muted">
        Opening a draft happens on the{' '}
        <a href="/admin/drafts" className="text-brand underline">
          drafts queue
        </a>
        , where the checklist’s sign-off questions are asked.
      </p>
    </div>
  );
}

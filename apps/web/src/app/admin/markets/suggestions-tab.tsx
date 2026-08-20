'use client';

import { AlertTriangle, ExternalLink, Sparkles } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';

import { admin, type DraftEvidence, type DraftRow } from '@/lib/admin-api';

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

              <Evidence evidence={draft.evidence} />
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

/**
 * The reading behind a draft.
 *
 * Collapsed by default and open in one click, because the reviewer's first
 * question is "is this any good" and their second is "on what". A panel that
 * pushed six headlines between every two drafts would make the queue unreadable
 * and get scrolled past, which is the same as not being there.
 *
 * Three things and no summary: the stories, the figures, the disagreements.
 * Every line carries its source and links out, so the panel is a way into the
 * reading rather than a substitute for it — a reviewer who wants to check a
 * claim gets there in one click instead of taking the engine's word.
 */
function Evidence({ evidence }: { evidence: DraftEvidence | null }) {
  if (evidence === null) {
    return (
      <p className="mt-2 text-xs text-text-muted">
        {/* Not an empty evidence list: "nobody looked" and "nothing was
            published" are different, and only one is a reason to distrust it. */}
        No research was attached to this draft.
      </p>
    );
  }

  if (evidence.itemsRead === 0) {
    return (
      <p className="mt-2 text-xs text-caution">
        Nothing our sources carry was published about this in {evidence.windowDays} days. The
        question is not grounded in recent reporting — check it against a scheduled event before
        opening it.
      </p>
    );
  }

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-wide text-text-muted hover:text-text">
        Evidence · {evidence.stories.length} stories · {evidence.figures.length} figures ·{' '}
        {evidence.itemsRead} items read
        {evidence.conflicts.length > 0 && (
          <span className="ml-1.5 text-caution">· {evidence.conflicts.length} disputed</span>
        )}
      </summary>

      <div className="mt-2 space-y-2.5 border-l-2 border-border pl-3">
        {evidence.conflicts.length > 0 && (
          <ul className="space-y-1">
            {evidence.conflicts.map((conflict) => (
              <li
                key={conflict.factKey}
                className="flex items-start gap-1.5 rounded-md bg-caution-bg px-2 py-1.5 text-xs text-caution"
              >
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  {/* Flagged, never averaged — the same rule the live ticket
                      follows. The criteria have to name which source settles. */}
                  <b className="font-mono">{conflict.factKey}</b> —{' '}
                  {conflict.claims
                    .map((claim) => `${claim.sourceName} says ${String(claim.value)}`)
                    .join('; ')}
                </span>
              </li>
            ))}
          </ul>
        )}

        {evidence.stories.length > 0 && (
          <ul className="space-y-1.5">
            {evidence.stories.map((story) => (
              <li key={story.url} className="text-xs">
                <a
                  href={story.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-start gap-1 text-text hover:underline"
                >
                  {story.headline}
                  <ExternalLink size={11} className="mt-0.5 shrink-0 opacity-60" />
                </a>
                <span className="ml-1 text-text-muted">
                  {story.sourceName} · {story.publishedAt.slice(0, 10)}
                  {/* One outlet is a report; nine is a story, and the count is
                      what tells a reviewer which. */}
                  {story.sourceCount > 1 && ` · ${story.sourceCount} outlets`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {evidence.figures.length > 0 && (
          <dl className="grid grid-cols-[auto,1fr] gap-x-2.5 gap-y-1 text-xs">
            {evidence.figures.map((figure) => (
              <Fragment key={`${figure.url}:${figure.key}`}>
                <dt className="font-mono text-text-muted">{figure.key}</dt>
                <dd>
                  <b>{figure.value}</b>{' '}
                  <a
                    href={figure.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-text-muted hover:underline"
                  >
                    {figure.sourceName}
                  </a>
                  <span className="text-text-muted"> · {figure.publishedAt.slice(0, 10)}</span>
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}

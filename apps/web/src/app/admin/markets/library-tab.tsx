'use client';

import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  admin,
  type LibraryTemplate,
  type RepeatableMarket,
  type StudioDraft,
} from '@/lib/admin-api';

type Cadence = 'weekly' | 'fortnightly' | 'monthly';

/**
 * The two things that stop the shelf being retyped from scratch every cycle:
 * the starter templates, and the markets worth running again.
 *
 * They share a tab because they answer the same question at different scales —
 * "what shape has already been thought through" — and because neither is big
 * enough to be a screen an operator would navigate to on purpose.
 */
export function LibraryTab({ onReuse }: { onReuse: (draft: StudioDraft) => void }) {
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(null);
  const [series, setSeries] = useState<RepeatableMarket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cadence, setCadence] = useState<Cadence>('monthly');

  const load = useCallback(() => {
    void admin
      .studioTemplates()
      .then(setTemplates)
      .catch((caught: Error) => setError(caught.message));
    void admin
      .studioSeries()
      .then(setSeries)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(load, [load]);

  async function repeat(market: RepeatableMarket): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Straight into the wizard, not into the shelf. The whole checklist runs
      // on it there like any other draft — a repeat is exactly the market that
      // gets waved through because the last one was fine.
      onReuse(await admin.nextInSeries(market.id, cadence));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && templates === null && series === null)
    return <p className="text-sm text-fall">{error}</p>;

  return (
    <div className="space-y-5">
      {error !== null && <p className="text-sm text-fall">{error}</p>}

      <section>
        <h3 className="text-sm font-semibold">Run it again</h3>
        <p className="mt-0.5 text-xs text-text-muted">
          Settled markets, with what they did. Repeating one opens it in the Create tab with the
          dates rolled forward — nothing is published until it passes the checklist there.
        </p>

        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-text-muted">Roll the dates</span>
          {(['weekly', 'fortnightly', 'monthly'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={cadence === option}
              onClick={() => setCadence(option)}
              className={`rounded-sm border px-2 py-0.5 text-xs ${
                cadence === option ? 'border-brand bg-brand/10 font-semibold' : 'border-border'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {series === null ? (
          <p className="mt-2 text-sm text-text-muted">Loading…</p>
        ) : series.length === 0 ? (
          <p className="mt-2 rounded-xl border border-border bg-surface-raised p-3.5 text-sm text-text-muted">
            Nothing has settled yet, so there is nothing to run again.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {series.map((market) => (
              <li key={market.id} className="p-3">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="flex-1 text-sm font-semibold">{market.question}</span>
                  <span className="font-mono text-xs text-text-muted">
                    {market.finalSplit === null
                      ? 'no split'
                      : `settled ${Math.round(market.finalSplit * 100)}/${
                          100 - Math.round(market.finalSplit * 100)
                        }`}
                    {market.disputes > 0 && ` · ${market.disputes} disputed`}
                    {market.warningsFired.length > 0 &&
                      ` · flagged ${market.warningsFired.join(', ')}`}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void repeat(market)}
                    className="flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-xs font-semibold disabled:opacity-40"
                  >
                    <RotateCw size={12} />
                    Run again
                  </button>
                </div>
                {/* The advice said once, plainly, rather than left as an
                    inference from two numbers on the row. */}
                {market.retune !== null && (
                  <p className="mt-1 text-xs text-caution">{market.retune}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold">Starter templates</h3>
        <p className="mt-0.5 text-xs text-text-muted">
          What the create page offers. Retired ones are listed too — a template somebody withdrew is
          only reviewable if it is visible. Retiring and restoring happens on the creators desk,
          which is where the change is audited.
        </p>
        {templates === null ? (
          <p className="mt-2 text-sm text-text-muted">Loading…</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {templates.map((template) => (
              <li key={template.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 p-3">
                <span
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                    template.active ? 'bg-rise/15 text-rise' : 'bg-border text-text-muted'
                  }`}
                >
                  {template.active ? 'offered' : 'retired'}
                </span>
                <b className="text-sm">{template.name}</b>
                <span className="font-mono text-[10px] uppercase text-text-muted">
                  {template.category}
                </span>
                <span className="w-full text-xs text-text-muted">{template.question}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

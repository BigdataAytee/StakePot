'use client';

import { useEffect, useState } from 'react';

import { growth, type AnalyticsOverview } from '@/lib/admin-api';

/**
 * §6.8's analytics dashboard.
 *
 * The funnel counts *people*, not events: one person viewing forty markets is
 * not forty people considering a stake, and a dashboard that says otherwise
 * flatters every stage and hides the drop-off that matters.
 */
export default function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [days, setDays] = useState(14);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void growth
      .analytics(days)
      .then(setData)
      .catch((caught: Error) => setError(caught.message));
  }, [days]);

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-black">Analytics</h1>
          <p className="mt-1 text-sm text-text-muted">
            Counted from the events table. The funnel is distinct people, not event counts.
          </p>
        </div>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          aria-label="Window"
          className="rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-xs"
        >
          {[7, 14, 30, 90].map((option) => (
            <option key={option} value={option}>
              {option} days
            </option>
          ))}
        </select>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {data !== null && (
        <>
          <section className="rounded-md border border-border p-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Funnel</h2>
            <ul className="mt-3 space-y-2">
              {data.funnel.map((stage) => (
                <li key={stage.stage} className="flex items-center gap-3 text-sm">
                  <span className="w-40 font-mono text-xs text-text-muted">
                    {stage.stage.replace(/_/g, ' ')}
                  </span>
                  <div className="h-2 flex-1 rounded-full bg-border">
                    <div
                      className="h-2 rounded-full bg-rise"
                      style={{ width: `${Math.round((stage.shareOfTop ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span className="w-24 text-right font-mono text-xs">
                    {stage.people}
                    {stage.shareOfTop !== null && (
                      <span className="ml-1 text-text-muted">
                        {Math.round(stage.shareOfTop * 100)}%
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-md border border-border p-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">
              Events, last {data.days} days
            </h2>
            {data.counts.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">Nothing recorded in this window.</p>
            ) : (
              <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs">
                {data.counts.map((entry) => (
                  <li key={entry.name} className="flex justify-between">
                    <span className="text-text-muted">{entry.name.replace(/_/g, ' ')}</span>
                    <span className="font-bold">{entry.count.toLocaleString('en-NG')}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

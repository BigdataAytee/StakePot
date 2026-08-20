'use client';

import { AlertTriangle, Power } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { admin, type CrawlHealth } from '@/lib/admin-api';

/**
 * Is the research pipeline actually finding anything?
 *
 * A research pipeline fails silently by construction. Nothing throws when a
 * feed stops carrying a section, or when a site's markup changes and every
 * fetch returns zero items, or when the market settling tomorrow has nothing
 * linked to it. The job runs, reports success, and every screen downstream
 * still renders — just emptier. The failure is an absence, and absences are
 * invisible unless something counts them.
 *
 * So the two headline numbers are the ones a "pipeline healthy" light would
 * never show: sources that are up and producing nothing, and live markets with
 * no coverage at all.
 */
export function ResearchTab() {
  const [health, setHealth] = useState<CrawlHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void admin
      .crawlHealth()
      .then(setHealth)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(load, [load]);

  async function switchSources(
    body: Parameters<typeof admin.setSourcesEnabled>[0],
    confirmation: string,
  ): Promise<void> {
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    setError(null);
    try {
      await admin.setSourcesEnabled(body);
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Switching something off needs a reason. The API refuses a thin one. */
  function kill(body: Omit<Parameters<typeof admin.setSourcesEnabled>[0], 'reason' | 'enabled'>) {
    const reason = window.prompt(
      'Why? A source switched off at 3am has to be explicable at 9.',
      '',
    );
    if (reason === null) return;
    void switchSources(
      { ...body, enabled: false, reason },
      body.scope === 'all'
        ? 'Stop all research? Every market’s context panel stops updating.'
        : 'Stop this source?',
    );
  }

  if (error !== null && health === null) return <p className="text-sm text-fall">{error}</p>;
  if (health === null) return <p className="text-sm text-text-muted">Loading…</p>;

  const { totals, budgets } = health;

  return (
    <div className="space-y-4">
      {error !== null && <p className="text-sm text-fall">{error}</p>}

      <div className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4">
        <Stat label="Items / hour" value={totals.itemsPerHour.toString()} />
        <Stat
          label="Up but silent"
          value={totals.stale.toString()}
          // The quiet failure. A source that is enabled, not erroring and has
          // produced nothing in a day looks exactly like a slow news week.
          alarm={totals.stale > 0}
        />
        <Stat label="Failing" value={totals.failing.toString()} alarm={totals.failing > 0} />
        <Stat
          label="Markets uncovered"
          value={totals.uncoveredMarkets.toString()}
          alarm={totals.uncoveredMarkets > 0}
        />
      </div>

      <p className="text-xs text-text-muted">
        {totals.enabled} of {totals.sources} sources on · {totals.itemsLast24h} items in 24h ·{' '}
        {totals.openConflicts} unresolved disagreement{totals.openConflicts === 1 ? '' : 's'}.{' '}
        {/* The caps, printed rather than assumed: a ceiling nobody can see is
            indistinguishable from having found everything there was. */}
        Each pass reads at most {budgets.sourcesPerPass} sources and keeps {budgets.itemsPerMarket}{' '}
        items per market.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => kill({ scope: 'all' })}
          className="flex items-center gap-1.5 rounded-sm border border-fall px-3 py-1.5 text-sm font-semibold text-fall disabled:opacity-40"
        >
          <Power size={14} />
          Stop all research
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void switchSources(
              { scope: 'all', enabled: true, reason: 'resumed from the Studio' },
              'Turn every source back on?',
            )
          }
          className="rounded-sm border border-border px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
        >
          Resume all
        </button>
      </div>

      {health.conflicts.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold">Sources disagree</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Flagged, never averaged. Whichever market turns on one of these needs criteria naming
            which source settles it.
          </p>
          <ul className="mt-2 space-y-1.5">
            {health.conflicts.map((conflict) => (
              <li
                key={conflict.id}
                className="flex items-start gap-1.5 rounded-md bg-caution-bg px-2 py-1.5 text-xs text-caution"
              >
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  <b className="font-mono">{conflict.factKey}</b> —{' '}
                  {conflict.claims
                    .map((claim) => `${claim.sourceName} says ${String(claim.value)}`)
                    .join('; ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-sm font-semibold">Sources</h3>
        <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
          {health.sources.length === 0 && (
            <li className="p-3.5 text-sm text-text-muted">
              No sources imported yet. Nothing is being read, which is why every context panel is
              empty.
            </li>
          )}
          {health.sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 p-3">
              <StatusPill status={source.status} />
              <b className="text-sm">{source.name}</b>
              <span className="font-mono text-[10px] uppercase text-text-muted">{source.tier}</span>
              <span className="ml-auto font-mono text-xs text-text-muted">
                {source.itemsLast24h} in 24h · trust {source.trust.toFixed(2)}
                {source.conflicts > 0 && ` · ${source.conflicts} conflicts`}
              </span>
              {source.status !== 'off' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => kill({ scope: 'source', sourceId: source.id })}
                  className="rounded-sm border border-border px-2 py-0.5 text-xs disabled:opacity-40"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void switchSources(
                      {
                        scope: 'source',
                        sourceId: source.id,
                        enabled: true,
                        reason: 'resumed from the Studio',
                      },
                      `Turn ${source.name} back on?`,
                    )
                  }
                  className="rounded-sm border border-border px-2 py-0.5 text-xs disabled:opacity-40"
                >
                  Resume
                </button>
              )}
              {source.disabledReason !== null && (
                <span className="w-full text-xs text-text-muted">Off: {source.disabledReason}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Coverage</h3>
        <p className="mt-0.5 text-xs text-text-muted">
          {/* Ordered by how soon each settles, not by how thin it is: a bare
              market three weeks out is a gap, and the same market settling
              tomorrow is this morning's job. */}
          Live markets, soonest first. A market with nothing linked to it has no context panel and
          no dossier to settle from.
        </p>
        <ul className="mt-2 space-y-1">
          {health.coverage.map((market) => (
            <li key={market.marketId} className="flex items-baseline gap-2.5 text-xs">
              <span
                className={`w-14 shrink-0 text-right font-mono ${
                  market.items === 0 ? 'font-bold text-fall' : 'text-text-muted'
                }`}
              >
                {market.items} item{market.items === 1 ? '' : 's'}
              </span>
              <span className="flex-1 truncate">{market.question}</span>
              <span className="shrink-0 font-mono text-text-muted">
                {market.hoursToEvent <= 0
                  ? 'settling'
                  : market.hoursToEvent < 48
                    ? `${market.hoursToEvent}h`
                    : `${Math.round(market.hoursToEvent / 24)}d`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, alarm = false }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-2.5">
      <div className={`font-mono text-xl font-bold ${alarm ? 'text-fall' : ''}`}>{value}</div>
      <div className="text-xs text-text-muted">{label}</div>
    </div>
  );
}

function StatusPill({ status }: { status: 'ok' | 'stale' | 'failing' | 'off' }) {
  const tone =
    status === 'ok'
      ? 'bg-rise/15 text-rise'
      : status === 'off'
        ? 'bg-border text-text-muted'
        : status === 'failing'
          ? 'bg-fall/15 text-fall'
          : 'bg-caution-bg text-caution';
  return (
    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${tone}`}>
      {status}
    </span>
  );
}

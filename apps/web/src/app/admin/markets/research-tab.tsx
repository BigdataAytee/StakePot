'use client';

import { AlertTriangle, Plus, Power } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { admin, type CrawlHealth } from '@/lib/admin-api';
import { SkeletonRows } from '@/components/skeleton';

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
  /** What the last on-demand pass did, so pressing the button says something. */
  const [pass, setPass] = useState<{
    sourcesRead: number;
    itemsStored: number;
    linksMade: number;
    conflictsFound: number;
    unchanged: number;
  } | null>(null);
  const [adding, setAdding] = useState(false);

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
  if (health === null) return <SkeletonRows rows={4} height="h-16" label="Loading crawl health" />;

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

      {/*
        The state that is invisible from the counts alone, and the one that
        actually bit: for a while nothing was scheduled to run a pass, so every
        screen downstream rendered an empty list — which reads exactly like a
        quiet news week. "Zero items" and "nothing is reading" have to be
        different sentences.
      */}
      {!health.pipeline.fetching && (
        <p className="rounded-md bg-caution-bg px-2.5 py-2 text-sm text-caution">
          No fetcher is configured ({health.pipeline.fetcher}), so nothing is being read and nothing
          ever will be. Everything below is history, not a live picture.
        </p>
      )}

      <p className="text-xs text-text-muted">
        {totals.enabled} of {totals.sources} sources on · {totals.itemsLast24h} items in 24h ·{' '}
        {totals.openConflicts} unresolved disagreement{totals.openConflicts === 1 ? '' : 's'}.{' '}
        {/* The caps, printed rather than assumed: a ceiling nobody can see is
            indistinguishable from having found everything there was. */}
        Each pass reads at most {budgets.sourcesPerPass} sources and keeps {budgets.itemsPerMarket}{' '}
        items per market. A pass runs every five minutes;{' '}
        {health.pipeline.lastFetchAt === null
          ? 'no source has been read yet'
          : `last read ${new Date(health.pipeline.lastFetchAt).toLocaleString('en-NG')}`}
        .
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await admin.runCrawlPass();
                setPass(result);
                load();
              } catch (caught) {
                setError((caught as Error).message);
              } finally {
                setBusy(false);
              }
            })()
          }
          className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
        >
          {busy ? 'Reading…' : 'Run a pass now'}
        </button>
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

      {pass !== null && (
        <p className="font-mono text-xs text-text-muted">
          Last pass: read {pass.sourcesRead} sources ({pass.unchanged} unchanged since we last
          asked), stored {pass.itemsStored} items, linked {pass.linksMade}, flagged{' '}
          {pass.conflictsFound} disagreement{pass.conflictsFound === 1 ? '' : 's'}.
        </p>
      )}

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
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Sources</h3>
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            className="flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-xs font-semibold"
          >
            <Plus size={12} />
            {adding ? 'Cancel' : 'Add a source'}
          </button>
        </div>
        {/*
          Said out loud because the two are not the same thing and a trader who
          conflates them is being misled: prices and trades arrive over a socket
          the moment they happen, and news is polled on a schedule. "Checked
          4 minutes ago" is the honest label for the second, and the timestamps
          below are what makes it checkable.
        */}
        <p className="mt-0.5 text-xs text-text-muted">
          News is <b>polled</b> — each source shows when it was last checked. Prices and trades are
          live over a socket; the two are never mixed.
        </p>
        {adding && <AddSource busy={busy} onAdded={load} onError={setError} />}
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
              <span className="font-mono text-fine uppercase text-text-muted">{source.tier}</span>
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
              <span className="w-full font-mono text-fine text-text-muted">
                {/*
                  Three timestamps rather than one, because they fail apart. A
                  feed can be checked every minute, answer 200 every time, and
                  have published nothing for a fortnight — green by "last
                  checked" and dead by "last item".
                */}
                checked {ago(source.lastFetchAt)} · last item {ago(source.lastItemAt)} · every{' '}
                {everyLabel(source.intervalMs)} ({source.cadence})
                {source.attachedHours !== null &&
                  ` · settles in ${source.attachedHours < 48 ? `${Math.round(source.attachedHours)}h` : `${Math.round(source.attachedHours / 24)}d`}`}
                {source.failureCount > 0 && ` · ${source.failureCount} failures in a row`}
              </span>
              {source.lastError !== null && source.status !== 'off' && (
                <span className="w-full text-xs text-caution">{source.lastError}</span>
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

/**
 * Add one source, from a phone.
 *
 * Deliberately the whole checklist and nothing more: what to read, where, and
 * how often. Everything else about a source — its trust, when it is due, what
 * it may settle — is derived rather than typed, because a registry meant to
 * hold thousands cannot be a form with twenty fields.
 */
function AddSource({
  busy,
  onAdded,
  onError,
}: {
  busy: boolean;
  onAdded: () => void;
  onError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    name: '',
    homeUrl: '',
    feedUrl: '',
    tier: 'news' as 'resolution' | 'news' | 'signal',
    kind: 'rss' as 'api' | 'rss' | 'sitemap' | 'crawl',
    cadence: 'auto' as 'auto' | 'urgent' | 'normal' | 'background',
    publishWindow: '',
  });
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const field = 'w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm';

  return (
    <form
      className="mt-2 space-y-2 rounded-xl border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          setSaving(true);
          onError(null);
          setDone(null);
          try {
            const result = await admin.importSources([
              {
                name: form.name.trim(),
                homeUrl: form.homeUrl.trim(),
                tier: form.tier,
                kind: form.kind,
                ...(form.feedUrl.trim() === '' ? {} : { feedUrl: form.feedUrl.trim() }),
                ...(form.cadence === 'auto' ? {} : { cadence: form.cadence }),
                ...(form.publishWindow.trim() === ''
                  ? {}
                  : { publishWindow: form.publishWindow.trim() }),
              },
            ]);
            setDone(
              result.added === 1
                ? 'Added. Press "Run a pass now" to see whether it answers.'
                : 'Updated the source that was already there.',
            );
            setForm((current) => ({ ...current, name: '', homeUrl: '', feedUrl: '' }));
            onAdded();
          } catch (caught) {
            onError((caught as Error).message);
          } finally {
            setSaving(false);
          }
        })();
      }}
    >
      <input
        className={field}
        required
        placeholder="Name — what a market cites. CAF, CBN, NBS"
        value={form.name}
        onChange={set('name')}
      />
      <input
        className={field}
        required
        type="url"
        placeholder="Home URL — https://www.cafonline.com"
        value={form.homeUrl}
        onChange={set('homeUrl')}
      />
      <input
        className={field}
        type="url"
        placeholder="Feed URL — the RSS/Atom address, if it has one"
        value={form.feedUrl}
        onChange={set('feedUrl')}
      />
      <div className="grid grid-cols-2 gap-2">
        <select className={field} value={form.tier} onChange={set('tier')}>
          <option value="resolution">Tier 1 — settles markets</option>
          <option value="news">Tier 2 — context</option>
          <option value="signal">Tier 3 — staff only</option>
        </select>
        <select className={field} value={form.kind} onChange={set('kind')}>
          <option value="rss">RSS / Atom feed</option>
          <option value="api">JSON or XML API</option>
          <option value="sitemap">Sitemap</option>
          <option value="crawl">Page to scrape</option>
        </select>
        <select className={field} value={form.cadence} onChange={set('cadence')}>
          <option value="auto">Cadence: follow the markets</option>
          <option value="urgent">Pin: every minute</option>
          <option value="normal">Pin: every 5 minutes</option>
          <option value="background">Pin: every 45 minutes</option>
        </select>
        <input
          className={field}
          placeholder="Window — mon-fri 08:00-10:30"
          value={form.publishWindow}
          onChange={set('publishWindow')}
        />
      </div>
      {/*
        Only feeds are read today. Saying so at the point of entry rather than
        letting the row sit at "stale" for a week and be mistaken for a quiet
        source.
      */}
      {form.kind !== 'rss' && form.kind !== 'api' && (
        <p className="text-xs text-caution">
          Only feeds and APIs are fetched so far. This will be registered and shown, and read once
          extraction rules exist for it.
        </p>
      )}
      {done !== null && <p className="text-xs text-rise">{done}</p>}
      <button
        type="submit"
        disabled={saving || busy}
        className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
      >
        {saving ? 'Adding…' : 'Add source'}
      </button>
    </form>
  );
}

/** "4 min ago", or "never". Absolute timestamps are on the row's title. */
function ago(iso: string | null): string {
  if (iso === null) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function everyLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)}h`;
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
    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-fine font-bold uppercase ${tone}`}>
      {status}
    </span>
  );
}

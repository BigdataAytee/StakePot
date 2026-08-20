'use client';

import { AlertTriangle, Eye } from 'lucide-react';
import { useEffect, useState } from 'react';

import { CreateTab } from './create-tab';
import { SuggestionsTab } from './suggestions-tab';
import { admin, type StudioMarketRow } from '@/lib/admin-api';
import { money } from '@/lib/format';

/**
 * The Market Studio (§6.2, and `docs/ticket-creation-checklist.md`).
 *
 * Three tabs, because opening a market is three different jobs that happen to
 * share a subject: writing one, reading what the engine has drafted, and
 * watching the ones already live. Split across three screens they get done at
 * three different times by three different people, and the fourth job —
 * noticing that a market you opened on Tuesday is running 90/10 — never gets
 * done at all.
 *
 * The tab lives in the URL rather than in state. This is run from a phone, and
 * a Studio you cannot send somebody a link into is one they have to be talked
 * through.
 */
const TABS = ['Manage', 'Create', 'Suggestions'] as const;
type Tab = (typeof TABS)[number];

export default function MarketStudio() {
  const [tab, setTab] = useState<Tab>('Manage');

  // Read once on mount rather than through a router hook: the tab is a
  // deep-link target, not a route, and re-rendering the whole studio on every
  // history entry would drop a half-written draft in the Create tab.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    const match = TABS.find((name) => name.toLowerCase() === wanted?.toLowerCase());
    if (match !== undefined) setTab(match);
  }, []);

  function choose(next: Tab): void {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next.toLowerCase());
    window.history.replaceState(null, '', url);
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-black">Market Studio</h1>
        <p className="mt-1 text-sm text-text-muted">
          Everything that opens a market, and everything that watches one after it opens. Every
          publish runs the ticket-creation checklist.
        </p>
      </header>

      <div role="tablist" aria-label="Market Studio" className="flex border-b border-border">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => choose(name)}
            className={`px-4 py-2.5 text-sm font-semibold transition-colors ${
              tab === name
                ? 'border-b-2 border-brand text-text'
                : 'border-b-2 border-transparent text-text-muted hover:text-text'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === 'Manage' && <ManageTab />}
      {tab === 'Create' && <CreateTab />}
      {tab === 'Suggestions' && <SuggestionsTab />}
    </div>
  );
}

/**
 * Every market that is not finished, with its Part 5 flags beside it.
 *
 * Flags on the row rather than on a separate alerts screen: a list of problems
 * detached from the markets they belong to is a list somebody has to reconcile
 * by hand, and the reconciling is where things get missed.
 */
function ManageTab() {
  const [rows, setRows] = useState<StudioMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  useEffect(() => {
    void admin
      .studioMarkets()
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  if (error !== null) return <p className="text-sm text-fall">{error}</p>;
  if (rows === null) return <p className="text-sm text-text-muted">Loading…</p>;

  const flagged = rows.filter((row) => row.flags.length > 0);
  const shown = onlyFlagged ? flagged : rows;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-sm text-text-muted">
          {rows.length} open · <b className="text-text">{flagged.length}</b> needing a look
        </p>
        <label className="ml-auto flex items-center gap-1.5 font-mono text-xs text-text-muted">
          <input
            type="checkbox"
            checked={onlyFlagged}
            onChange={(event) => setOnlyFlagged(event.target.checked)}
          />
          only flagged
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface-raised p-4 text-sm text-text-muted">
          {onlyFlagged
            ? 'Nothing flagged. Every live market is inside the checklist’s Part 5 thresholds.'
            : 'No open markets.'}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((row) => (
            <MarketRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MarketRow({ row }: { row: StudioMarketRow }) {
  const staked = row.outcomes.map((outcome) => Number(outcome.staked));
  const pot = staked.reduce((a, b) => a + b, 0);
  const leading = pot > 0 ? Math.max(...staked) / pot : null;

  return (
    <li className="rounded-xl border border-border bg-surface-raised p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="rounded-sm bg-chip px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-text-muted">
          {row.state}
        </span>
        <a href={`/market/${row.id}`} className="flex-1 font-semibold hover:underline">
          {row.question}
        </a>
        <a
          href={`/market/${row.id}`}
          aria-label={`Open ${row.question} as a trader sees it`}
          className="text-text-muted hover:text-text"
        >
          <Eye size={15} />
        </a>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
        <span>
          Pot <b className="font-mono text-text">{money(row.pot)}</b>
        </span>
        <span>
          Traders <b className="font-mono text-text">{row.holders}</b>
        </span>
        {leading !== null && (
          <span>
            Split{' '}
            <b className="font-mono text-text">
              {Math.round(leading * 100)}/{Math.round((1 - leading) * 100)}
            </b>
          </span>
        )}
        <span>
          Settles{' '}
          <b className="font-mono text-text">
            {new Date(row.eventDate).toLocaleString('en-NG', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </b>
        </span>
        <span>
          Source <b className="text-text">{row.sourceName}</b>
        </span>
      </dl>

      {row.flags.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {row.flags.map((flag) => (
            <li
              key={flag.rule}
              className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs ${
                flag.severity === 'act' ? 'bg-fall/[.08] text-fall' : 'bg-caution-bg text-caution'
              }`}
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {/* The rule number, so a flag can be looked up rather than
                    argued with. */}
                <b className="font-mono">Rule {flag.rule}</b> — {flag.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

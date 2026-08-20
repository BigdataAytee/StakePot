'use client';

import { AlertTriangle, Eye } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { CreateTab } from './create-tab';
import { LibraryTab } from './library-tab';
import { ResearchTab } from './research-tab';
import { SuggestionsTab } from './suggestions-tab';
import {
  admin,
  type FreezeDesk,
  type FreezeRow,
  type StudioDraft,
  type StudioMarketRow,
} from '@/lib/admin-api';
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
const TABS = ['Manage', 'Create', 'Library', 'Suggestions', 'Research'] as const;
type Tab = (typeof TABS)[number];

export default function MarketStudio() {
  const [tab, setTab] = useState<Tab>('Manage');
  /** A repeat handed over from the Library, waiting for the wizard. */
  const [seed, setSeed] = useState<StudioDraft | undefined>(undefined);

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
      {/* Keyed on the seed so handing over a repeat remounts the wizard with
          it, rather than leaving the previous draft half-overwritten. */}
      {tab === 'Create' && <CreateTab key={seed?.question ?? 'blank'} seed={seed} />}
      {tab === 'Library' && (
        <LibraryTab
          onReuse={(draft) => {
            setSeed(draft);
            choose('Create');
          }}
        />
      )}
      {tab === 'Suggestions' && <SuggestionsTab />}
      {tab === 'Research' && <ResearchTab />}
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
  const [desk, setDesk] = useState<FreezeDesk | null>(null);

  const load = useCallback(() => {
    void admin
      .studioMarkets()
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
    void admin
      .freezeDesk()
      .then(setDesk)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(load, [load]);

  if (error !== null && rows === null) return <p className="text-sm text-fall">{error}</p>;
  if (rows === null) return <p className="text-sm text-text-muted">Loading…</p>;

  const flagged = rows.filter((row) => row.flags.length > 0);
  const shown = onlyFlagged ? flagged : rows;

  return (
    <div className="space-y-3">
      {desk !== null && <FreezeDeskPanel desk={desk} onChanged={load} />}
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

/**
 * The freeze desk.
 *
 * Three lists, and the third is the reason the panel exists. A market past its
 * freeze time and still reading `active` means the sweep is not running — and
 * the symptom of that is an absence, which stays invisible unless something
 * counts it. The money path refuses those trades whatever the column says, so
 * this is a defect alarm rather than an open door; but a defect alarm nobody
 * can see is a defect.
 */
function FreezeDeskPanel({ desk, onChanged }: { desk: FreezeDesk; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(run: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      await run();
      setNote(done);
      onChanged();
    } catch (caught) {
      setNote((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function freezeNow(row: FreezeRow): void {
    const reason = window.prompt(
      `Stop trading on "${row.question}" now. Why? This is recorded and shown on the chart.`,
      '',
    );
    if (reason === null || reason.trim().length < 3) return;
    void act(() => admin.freezeMarket(row.id, reason), 'Frozen.');
  }

  function unfreeze(row: FreezeRow): void {
    const reason = window.prompt(
      `Reopening "${row.question}" needs a second approver. Why should it reopen?`,
      '',
    );
    if (reason === null || reason.trim().length < 10) return;
    const when = window.prompt(
      'New freeze time (ISO, e.g. 2026-08-21T15:00:00Z). It must be in the future.',
      '',
    );
    if (when === null || when.trim() === '') return;
    void act(
      () => admin.proposeUnfreeze(row.id, { freezeAt: new Date(when).toISOString(), reason }),
      'Proposed. It needs a second approver in the Approvals inbox.',
    );
  }

  const clock = (iso: string | null) =>
    iso === null
      ? '—'
      : new Date(iso).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="rounded-xl border border-border bg-surface-raised p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">Freeze desk</h3>
        <p className="text-xs text-text-muted">
          Trading stops when the event starts, less the buffer. Freezing takes one person; reopening
          takes two.
        </p>
      </div>
      {note !== null && <p className="mt-2 text-xs text-caution">{note}</p>}

      {desk.overdue.length > 0 && (
        <div className="mt-2.5 rounded-md bg-fall/10 p-2.5">
          <p className="text-xs font-bold text-fall">
            {desk.overdue.length} past its freeze time and still open — the sweep is not doing its
            job. Trades are refused anyway; this needs looking at.
          </p>
          <ul className="mt-1.5 space-y-1">
            {desk.overdue.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="flex-1 truncate">{row.question}</span>
                <span className="font-mono text-text-muted">due {clock(row.freezeAt)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => freezeNow(row)}
                  className="rounded-sm border border-fall px-2 py-0.5 font-semibold text-fall disabled:opacity-40"
                >
                  Freeze now
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2.5 grid gap-3 min-[900px]:grid-cols-2">
        <div>
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            Freezing within 6h
          </h4>
          <ul className="mt-1 space-y-1">
            {desk.freezingSoon.length === 0 && (
              <li className="text-xs text-text-muted">Nothing due in the next six hours.</li>
            )}
            {desk.freezingSoon.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="flex-1 truncate">{row.question}</span>
                <span className="font-mono text-text-muted">{clock(row.freezeAt)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => freezeNow(row)}
                  className="rounded-sm border border-border px-2 py-0.5 disabled:opacity-40"
                >
                  Freeze now
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            Frozen, not yet settled
          </h4>
          <ul className="mt-1 space-y-1">
            {desk.frozen.length === 0 && (
              <li className="text-xs text-text-muted">Nothing waiting on a result.</li>
            )}
            {desk.frozen.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="flex-1 truncate">{row.question}</span>
                <span className="font-mono text-text-muted">
                  {row.freezeReason ?? 'frozen'} · {clock(row.frozenAt)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => unfreeze(row)}
                  className="rounded-sm border border-border px-2 py-0.5 disabled:opacity-40"
                >
                  Propose reopen
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
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
                {/* How long it has held. A flag that appeared this morning and
                    one that has stood for four days need different answers, and
                    the message alone cannot tell them apart. */}
                {flag.since !== null && <span className="opacity-70"> {standing(flag.since)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Flagged 3 days ago" — how long a Part 5 flag has been standing. */
function standing(since: string): string {
  const hours = (Date.now() - new Date(since).getTime()) / 3_600_000;
  if (hours < 1) return 'Flagged just now.';
  if (hours < 48) return `Flagged ${Math.round(hours)}h ago.`;
  const days = Math.round(hours / 24);
  return `Flagged ${days} days ago.`;
}

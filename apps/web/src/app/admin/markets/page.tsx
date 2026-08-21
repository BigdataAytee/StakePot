'use client';

import { AlertTriangle, Eye, Plus } from 'lucide-react';
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
import { SkeletonRows } from '@/components/skeleton';

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

      {/* Scrolls rather than overflows: five labels do not fit across a phone,
          and a tab row that pushes the page wider takes every screen under it
          with it. */}
      <div
        role="tablist"
        aria-label="Market Studio"
        className="-mx-4 flex overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0"
      >
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => choose(name)}
            className={`shrink-0 px-4 py-2.5 text-sm font-semibold transition-colors ${
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
  if (rows === null) return <SkeletonRows rows={4} height="h-20" label="Loading markets" />;

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
            <MarketRow key={row.id} row={row} onSeeded={load} />
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
          <h4 className="font-mono text-fine uppercase tracking-widest text-text-muted">
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
          <h4 className="font-mono text-fine uppercase tracking-widest text-text-muted">
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

/**
 * States where platform money can still be added.
 *
 * Mirrors the server's list; the server is the one that decides, and it
 * refuses a market this misses. Duplicated rather than fetched because the
 * cost of being wrong here is a button that fails with a clear message.
 */
const TOPPABLE = ['draft', 'seeding', 'funding', 'active'];

function MarketRow({ row, onSeeded }: { row: StudioMarketRow; onSeeded: () => void }) {
  const [seeding, setSeeding] = useState(false);
  const staked = row.outcomes.map((outcome) => Number(outcome.staked));
  const pot = staked.reduce((a, b) => a + b, 0);
  const leading = pot > 0 ? Math.max(...staked) / pot : null;
  // Community markets are seeded by their creator, out of the creator's own
  // money, at creation. Platform money going into one would be the platform
  // taking a position in somebody else's market.
  const canSeed = row.shelf === 'official' && TOPPABLE.includes(row.state);

  return (
    <li className="rounded-xl border border-border bg-surface-raised p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="rounded-sm bg-chip px-1.5 py-0.5 font-mono text-fine font-bold uppercase text-text-muted">
          {row.state}
        </span>
        <a href={`/market/${row.id}`} className="flex-1 font-semibold hover:underline">
          {row.question}
        </a>
        {canSeed && (
          <button
            type="button"
            onClick={() => setSeeding((open) => !open)}
            aria-expanded={seeding}
            className="flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-xs font-semibold text-text-muted hover:text-text"
          >
            <Plus size={12} /> Add stake
          </button>
        )}
        <a
          href={`/market/${row.id}`}
          aria-label={`Open ${row.question} as a trader sees it`}
          className="text-text-muted hover:text-text"
        >
          <Eye size={15} />
        </a>
      </div>

      {seeding && (
        <SeedForm
          row={row}
          onDone={() => {
            setSeeding(false);
            onSeeded();
          }}
        />
      )}

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

/**
 * Put platform money into a live official market, equally across outcomes.
 *
 * The thing worth saying on screen is the thing an operator will not believe:
 * adding money to a running market does not move the odds. It is true because
 * the money is spread equally — the engine's cost function has C(q + δ·1) =
 * C(q) + δ, so buying δ of every outcome costs exactly δ and leaves every
 * price where it was. So the panel says it, and shows the pot before and
 * after so it can be checked rather than trusted.
 *
 * There is no amount field on a market row anywhere else in this app, and
 * this is not one either: the number goes through the engine as a trade and
 * lands in the ledger. Nothing here writes a pot total.
 */
function SeedForm({ row, onDone }: { row: StudioMarketRow; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: string; potAfter: string } | null>(null);
  // One id per open panel, so a double-click or a retry after a timeout seeds
  // once. Regenerated only when the panel is reopened for a fresh decision.
  const [requestId] = useState(() => crypto.randomUUID());

  const perOutcome = Number(amount);
  const outcomes = row.outcomes.length;
  const total = Number.isFinite(perOutcome) && perOutcome > 0 ? perOutcome * outcomes : 0;
  const ready = total > 0 && reason.trim().length >= 3 && !busy;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await admin.seedMarket(row.id, {
        perOutcome: String(perOutcome),
        reason: reason.trim(),
        requestId,
      });
      setDone({ added: result.added, potAfter: result.potAfter });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <div className="mt-2.5 rounded-md border border-rise/40 bg-rise/[.08] p-2.5 text-xs">
        <p className="font-semibold text-rise">
          Added {money(done.added)}. Pot is now {money(done.potAfter)}.
        </p>
        <p className="mt-1 text-text-muted">
          Every price is exactly where it was. It is in the ledger and the audit log.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="mt-1.5 rounded-sm border border-border px-2 py-0.5 font-semibold"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2.5 rounded-md border border-border bg-surface p-2.5">
      <p className="text-xs text-text-muted">
        Platform money, split equally over {outcomes} outcomes. It deepens the pot and moves no
        price.
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[8rem]">
          <span className="font-mono text-fine uppercase tracking-widest text-text-muted">
            Per outcome (₦)
          </span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="5000"
            aria-label="Amount per outcome in naira"
            className="mt-0.5 w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <label className="flex-[2] min-w-[12rem]">
          <span className="font-mono text-fine uppercase tracking-widest text-text-muted">Why</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={300}
            placeholder="Thin pot before kickoff"
            aria-label="Reason for the seed"
            className="mt-0.5 w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-muted">
          Total <b className="font-mono text-text">{total > 0 ? money(String(total)) : '—'}</b>
        </span>
        <button
          type="submit"
          disabled={!ready}
          className="ml-auto rounded-sm bg-brand px-2.5 py-1 font-semibold text-paper disabled:opacity-40"
        >
          {busy ? 'Seeding…' : 'Add stake'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm border border-border px-2 py-1"
        >
          Cancel
        </button>
      </div>

      {error !== null && <p className="mt-1.5 text-xs text-fall">{error}</p>}
    </form>
  );
}

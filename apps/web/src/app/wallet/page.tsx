'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { MobileNav } from '@/components/market/mobile-nav';
import { SiteHeader } from '@/components/market/site-header';
import { dateTime, exactMoney, money } from '@/lib/format';
import { PAGE_WIDTH } from '@/lib/layout';
import { authed, getToken, useSession } from '@/lib/session';

interface HistoryRow {
  id: string;
  type: string;
  amount: string;
  createdAt: string;
  marketId: string | null;
  marketQuestion: string | null;
  ref: string | null;
}

/**
 * §7.5 — the customer's own money view.
 *
 * "Available (spendable now) and In Open Markets (escrowed) shown separately
 * with a one-line explainer; every ledger event in plain language, filterable,
 * complete history because the ledger is append-only; monthly statement
 * download; receipt view per transaction."
 *
 * Every row here is a ledger row. Nothing is summarised, derived or rounded
 * for display beyond the money formatter, because the point of showing
 * somebody their history is that it agrees with the books to the kobo.
 */
const LABELS: Record<string, string> = {
  signup_bonus: 'Bonus',
  trade_buy: 'Stake',
  trade_sell: 'Early exit',
  stake: 'Stake',
  seed: 'Seed',
  payout: 'Winnings',
  refund: 'Refund',
  fee_platform: 'Platform fee',
  fee_creator: 'Creator fee',
  bond_post: 'Bond posted',
  bond_refund: 'Bond returned',
  bond_forfeit: 'Bond forfeited',
  prize: 'Prize',
  adjustment: 'Adjustment',
};

/**
 * §7.5's "filterable".
 *
 * Grouped by what a person is looking for rather than by ledger type — nobody
 * opens their wallet wanting `fee_creator`, they want "where did my money
 * go". `all` is not in the map: it means no filter at all.
 */
const FILTERS: { key: string; label: string; types: string[] }[] = [
  { key: 'stakes', label: 'Stakes', types: ['trade_buy', 'stake', 'seed'] },
  { key: 'wins', label: 'Wins', types: ['payout', 'prize'] },
  { key: 'exits', label: 'Exits & refunds', types: ['trade_sell', 'refund'] },
  { key: 'fees', label: 'Fees', types: ['fee_platform', 'fee_creator'] },
  { key: 'bonuses', label: 'Bonuses', types: ['signup_bonus'] },
  { key: 'bonds', label: 'Bonds', types: ['bond_post', 'bond_refund', 'bond_forfeit'] },
];

export default function WalletPage() {
  const { me, loading } = useSession();
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [openRow, setOpenRow] = useState<string | null>(null);

  useEffect(() => {
    if (getToken() === null) return;
    void authed<HistoryRow[]>('/me/wallet/history')
      .then(setHistory)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'could not load your history'),
      );
  }, []);

  const shown = useMemo(() => {
    if (history === null) return null;
    if (filter === 'all') return history;
    const types = FILTERS.find((option) => option.key === filter)?.types ?? [];
    return history.filter((row) => types.includes(row.type));
  }, [history, filter]);

  if (!loading && me === null) {
    return (
      <>
        <Header />
        <main className={`px-4 py-8 sm:px-5 ${PAGE_WIDTH}`}>
          <p className="text-base text-text-muted">
            <Link href="/login" className="font-semibold text-brand underline">
              Log in
            </Link>{' '}
            to see your wallet.
          </p>
        </main>
        <Nav />
      </>
    );
  }

  return (
    <>
      <Header />

      <main className={`px-4 pb-[72px] pt-5 sm:px-5 md:pb-10 ${PAGE_WIDTH}`}>
        <h1 className="text-xl font-bold">Wallet</h1>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Balance
            label="Available"
            value={me === null ? '—' : money(me.available)}
            note="Yours to stake or hold."
            tone="money"
          />
          <Balance
            label="In open markets"
            value={me === null ? '—' : money(me.escrowed)}
            note="Held in escrow until those markets settle."
          />
        </div>

        <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-md font-bold">History</h2>
            <p className="text-sm text-text-muted">
              Every money event on your account, straight from the ledger.
            </p>
          </div>
          <StatementButton />
        </div>

        {/* §7.5's filter. One scrolling row on a phone, like the shelf's. */}
        <div className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          <FilterPill on={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </FilterPill>
          {FILTERS.map((option) => (
            <FilterPill
              key={option.key}
              on={filter === option.key}
              onClick={() => setFilter(option.key)}
            >
              {option.label}
            </FilterPill>
          ))}
        </div>

        {error !== null && (
          <p role="alert" className="mt-3 rounded-md bg-fall-bg px-3 py-2 text-sm text-fall">
            {error}
          </p>
        )}

        {history === null && error === null && (
          <p className="mt-4 text-sm text-text-muted">Loading…</p>
        )}

        {shown !== null && shown.length === 0 && (
          <p className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
            {history?.length === 0
              ? 'Nothing here yet. Your first stake will show up the moment it fills.'
              : 'No events of that kind yet.'}
          </p>
        )}

        {shown !== null && shown.length > 0 && (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {shown.map((row) => (
              <Row
                key={row.id}
                row={row}
                open={openRow === row.id}
                onToggle={() => setOpenRow(openRow === row.id ? null : row.id)}
              />
            ))}
          </ul>
        )}
      </main>

      <Nav />
    </>
  );
}

/**
 * The page chrome, behind a suspense boundary.
 *
 * `SiteHeader` and `MobileNav` both call `useSearchParams()` — the header for
 * the search field, the nav for the watchlist tab's active state. Next cannot
 * prerender a page that reads the query string outside a boundary, so without
 * these the production build fails on `/wallet` even though the dev server is
 * perfectly happy. The fallbacks are sized to the real chrome so the page does
 * not jump when it hydrates.
 */
function Header() {
  return (
    <Suspense fallback={<div className="h-[60px] border-b border-border" />}>
      <SiteHeader />
    </Suspense>
  );
}

function Nav() {
  return (
    <Suspense>
      <MobileNav />
    </Suspense>
  );
}

function Balance({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'money';
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-[.05em] text-text-muted">{label}</p>
      <p
        className={`mt-1 font-mono text-2xl font-bold tabular-nums ${tone === 'money' ? 'text-money' : ''}`}
      >
        {value}
      </p>
      <p className="mt-1 text-sm text-text-muted">{note}</p>
    </div>
  );
}

function FilterPill({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`h-11 shrink-0 whitespace-nowrap rounded-[20px] px-[11px] text-sm font-medium transition-colors ${
        on ? 'bg-text text-paper' : 'bg-chip text-text-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One ledger event, and — when opened — §7.5's receipt view of it.
 *
 * The receipt is an expansion rather than a separate screen because there is
 * nothing on it that is not already in the row: it is the same event with its
 * reference and its exact figure shown, which is what somebody querying a line
 * with support actually needs to read out.
 */
function Row({ row, open, onToggle }: { row: HistoryRow; open: boolean; onToggle: () => void }) {
  const credit = !row.amount.startsWith('-');

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-4 p-4 text-left hover:bg-chip"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold">{labelFor(row)}</span>
          {row.marketQuestion !== null && (
            <span className="mt-0.5 block truncate text-sm text-text-muted">
              {row.marketQuestion}
            </span>
          )}
          <span className="mt-0.5 block font-mono text-xs text-text-muted">
            {dateTime(row.createdAt)}
          </span>
        </span>
        <span
          className={`shrink-0 font-mono text-base font-bold tabular-nums ${
            credit ? 'text-money' : 'text-text'
          }`}
        >
          {credit ? '+' : ''}
          {exactMoney(row.amount)}
        </span>
      </button>

      {open && (
        <div className="border-t border-border bg-chip px-4 py-3 text-sm">
          <dl className="flex flex-col gap-1">
            <Detail label="Exact amount" value={`${credit ? '+' : ''}${exactMoney(row.amount)}`} />
            <Detail label="Recorded" value={dateTime(row.createdAt)} />
            {row.ref !== null && <Detail label="Reference" value={row.ref} />}
            <Detail label="Ledger entry" value={row.id} />
          </dl>
          {row.marketId !== null && (
            <Link
              href={`/market/${row.marketId}`}
              className="mt-2 inline-block font-semibold text-brand underline"
            >
              Open the market
            </Link>
          )}
          <p className="mt-2 text-xs text-text-muted">
            Straight from the append-only ledger — this line cannot disagree with your balance.
          </p>
        </div>
      )}
    </li>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  );
}

/**
 * §7.5's monthly statement.
 *
 * Fetched with the session token and handed over as a blob rather than linked
 * directly: the endpoint is authenticated, and a plain `<a download>` carries
 * no Authorization header, so a link would download an error page.
 */
function StatementButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const month = new Date().toISOString().slice(0, 7);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const statement = await authed<{ month: string; csv: string; rows: number }>(
        `/me/wallet/statement?month=${month}`,
      );
      const url = URL.createObjectURL(new Blob([statement.csv], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `stakeam-statement-${statement.month}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        className="h-11 rounded-md border border-border px-3 text-sm font-semibold hover:border-text disabled:opacity-45"
      >
        {busy ? 'Preparing…' : 'Download this month'}
      </button>
      {failed && <p className="mt-1 text-xs text-fall">Could not build that statement.</p>}
    </div>
  );
}

/**
 * The row's name.
 *
 * `signup_bonus` covers both the starter balance and the Tier 1 verification
 * bonus, so on a new account the history showed two identical "Bonus" lines
 * for two different things. The ledger already distinguishes them by ref —
 * the screen just was not reading it.
 */
function labelFor(row: HistoryRow): string {
  if (row.type === 'signup_bonus') {
    if (row.ref?.startsWith('tier1-bonus:') === true) return 'Verification bonus';
    if (row.ref?.startsWith('signup:') === true) return 'Starter balance';
  }
  return LABELS[row.type] ?? row.type;
}

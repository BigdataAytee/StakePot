'use client';

import { Flame, Trophy } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { API_URL } from '@/lib/api';
import { PageShell } from '@/components/market/page-shell';

/**
 * §2.8's leaderboards.
 *
 * Two boards, because they measure different people: profit rewards size and
 * nerve, accuracy rewards being right. Both are shown with the counts behind
 * them — a rank with no sample size beside it is a number somebody can dismiss.
 */
interface Row {
  rank: number;
  userId: string;
  handle: string | null;
  displayName: string | null;
  profit: string;
  accuracyPct: number;
  marketsSettled: number;
  marketsWon: number;
  streak: number;
}

export default function LeaderboardPage() {
  const [board, setBoard] = useState<'profit' | 'accuracy'>('profit');
  const [period, setPeriod] = useState<string>('');
  const [periods, setPeriods] = useState<string[]>([]);
  const [allTime, setAllTime] = useState('all-time');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`${API_URL}/leaderboard/periods`)
      .then((response) => response.json())
      .then((data: { current: string; allTime: string; periods: string[] }) => {
        setAllTime(data.allTime);
        setPeriods(data.periods.length > 0 ? data.periods : [data.current]);
        setPeriod((current) => (current === '' ? data.current : current));
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(() => {
    if (period === '') return;
    void fetch(`${API_URL}/leaderboard?period=${encodeURIComponent(period)}&board=${board}`)
      .then((response) => response.json())
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  }, [period, board]);

  return (
    <PageShell width="narrow">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-black">
          <Trophy size={20} className="text-money" /> Leaderboard
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Counted from markets that have settled. Open positions are not a standing.
        </p>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-sm border border-border">
          {(['profit', 'accuracy'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setBoard(option)}
              aria-pressed={board === option}
              className={`px-3 py-1.5 text-sm font-semibold capitalize ${
                board === option ? 'bg-rise text-paper' : 'text-text-muted'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <select
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          aria-label="Period"
          className="rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm"
        >
          {[allTime, ...periods.filter((entry) => entry !== allTime)].map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </div>

      {error !== null && <p className="mt-3 text-sm text-fall">{error}</p>}

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-text-muted">
          Nothing here yet. A board appears once markets have settled.
        </p>
      ) : (
        <ol className="mt-5 space-y-1">
          {rows.map((row) => (
            <li
              key={row.userId}
              className="flex items-center gap-3 border-b border-border py-2.5 last:border-0"
            >
              <span
                className={`w-7 text-right font-mono text-sm font-bold ${
                  row.rank <= 3 ? 'text-money' : 'text-text-muted'
                }`}
              >
                {row.rank}
              </span>

              <div className="min-w-0 flex-1">
                {row.handle === null ? (
                  <span className="text-sm font-semibold text-text-muted">Someone</span>
                ) : (
                  <Link href={`/c/${row.handle}`} className="text-sm font-semibold">
                    {row.displayName ?? `@${row.handle}`}
                  </Link>
                )}
                <p className="font-mono text-xs text-text-muted">
                  {row.marketsWon}/{row.marketsSettled} called
                  {row.streak > 1 && (
                    <span className="ml-2 inline-flex items-center gap-0.5 text-money">
                      <Flame size={10} /> {row.streak}
                    </span>
                  )}
                </p>
              </div>

              <div className="text-right">
                {board === 'profit' ? (
                  <span
                    className={`font-mono text-sm font-bold ${
                      Number(row.profit) >= 0 ? 'text-money' : 'text-fall'
                    }`}
                  >
                    {Number(row.profit) >= 0 ? '+' : ''}
                    {Number(row.profit).toLocaleString('en-NG', { maximumFractionDigits: 0 })}
                  </span>
                ) : (
                  <span className="font-mono text-sm font-bold">{row.accuracyPct}%</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </PageShell>
  );
}

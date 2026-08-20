'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';

import { API_URL, type SeedComposition } from '@/lib/api';
import { dateTime, exactMoney, money, untilFreeze } from '@/lib/format';

/**
 * Path B, made legible (§2.4, §2.14a, Rulebook Part 3 §2–§3).
 *
 * Two facts have to survive contact with a real reader. First: a seed is not a
 * position. The creator or the syndicate holds every outcome equally, so nobody
 * reading this ticket should wonder whether the person settling it is on a side.
 * Second: a seeded market is not yet a safe market — it still has to find [10]
 * backers by the deadline or everything, seed included, goes back.
 *
 * §3 also requires the fee split to be "displayed on the market page before any
 * sponsor joins", so the terms render while the round is open, not after.
 */
export function SeedPanel({
  composition,
  token,
  onChanged,
}: {
  composition: SeedComposition;
  token: string | null;
  onChanged?: () => void;
}) {
  const { syndicate } = composition;
  const seedTotal = composition.seeded.reduce((acc, s) => acc + Number(s.amount), 0);
  const openRound = syndicate !== null && syndicate.state === 'open';

  if (!openRound && composition.seeded.length === 0) return null;

  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {openRound ? 'Seeding round' : 'How this market was seeded'}
        </h2>
        {openRound && (
          <span className="font-mono text-xs text-text-muted">
            closes in {untilFreeze(syndicate.roundEndsAt)}
          </span>
        )}
      </div>

      {openRound ? (
        <RoundProgress
          raised={Number(syndicate.raised)}
          target={Number(syndicate.minTotal)}
          sponsors={syndicate.sponsors.length}
          maxSponsors={syndicate.maxSponsors}
        />
      ) : (
        <p className="mt-3 text-md">
          <span className="font-mono font-bold tabular-nums">{money(seedTotal)}</span>{' '}
          <span className="text-text-muted">
            split equally across every outcome — {composition.seeded.length}{' '}
            {composition.seeded.length === 1 ? 'seeder' : 'sponsors'}, no side taken.
          </span>
        </p>
      )}

      {syndicate !== null && syndicate.sponsors.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {syndicate.sponsors.map((sponsor) => (
            <li key={sponsor.userId} className="flex items-baseline justify-between text-sm">
              <span className="truncate font-mono text-text-muted">
                {sponsor.userId.slice(0, 8)}…
              </span>
              <span className="font-mono tabular-nums">
                {exactMoney(sponsor.contribution)}
                {Number(sponsor.feeSharePct) > 0 && (
                  <span className="ml-2 text-text-muted">
                    {Math.round(Number(sponsor.feeSharePct) * 100)}% of the fee
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {syndicate !== null && (
        <p className="mt-3 text-sm text-text-muted">
          {syndicate.organiserBps > 0
            ? `The creator takes ${syndicate.organiserBps / 100}% of the market's creator fee as organiser; the rest is split by what each sponsor put in.`
            : "The market's creator fee is split among sponsors by what each put in."}{' '}
          Locked when the round opened.
        </p>
      )}

      {composition.fundingClosesAt !== null && composition.state === 'active' && (
        <p className="mt-3 rounded-sm bg-border/40 px-3 py-2 text-sm">
          Still needs backers by {dateTime(composition.fundingClosesAt)}. If it doesn&rsquo;t find
          them, everything — including the seed — is refunded.
        </p>
      )}

      {openRound && (
        <ContributeBox
          marketId={composition.marketId}
          minContribution={syndicate.minContribution}
          token={token}
          {...(onChanged === undefined ? {} : { onChanged })}
        />
      )}
    </section>
  );
}

/** Raised against the Symmetric Seed minimum — the round's one number. */
function RoundProgress({
  raised,
  target,
  sponsors,
  maxSponsors,
}: {
  raised: number;
  target: number;
  sponsors: number;
  maxSponsors: number;
}) {
  const filled = target <= 0 ? 0 : Math.min(1, raised / target);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-lg font-bold tabular-nums">{money(raised)}</span>
        <span className="font-mono text-sm text-text-muted tabular-nums">of {money(target)}</span>
      </div>
      <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-sm bg-border">
        <motion.div
          className="absolute inset-y-0 left-0 bg-rise"
          initial={false}
          animate={{ width: `${filled * 100}%` }}
          transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </div>
      <p className="mt-2 text-sm text-text-muted">
        {sponsors} of {maxSponsors} sponsors. The market opens the moment the round fills.
      </p>
    </div>
  );
}

function ContributeBox({
  marketId,
  minContribution,
  token,
  onChanged,
}: {
  marketId: string;
  minContribution: string;
  token: string | null;
  onChanged?: () => void;
}) {
  const [amount, setAmount] = useState(minContribution);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function join(): Promise<void> {
    if (token === null) {
      setError('Sign in to sponsor this market.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${API_URL}/community/markets/${marketId}/syndicate/contributions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount }),
        },
      );
      const body = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? `Could not join (${response.status})`);
      onChanged?.();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          aria-label="Amount to sponsor"
          className="w-32 rounded-md border border-border bg-surface px-3 py-2.5 font-mono tabular-nums outline-none focus:border-rise"
        />
        <button
          type="button"
          onClick={join}
          disabled={busy}
          className="flex-1 rounded-md bg-rise py-2.5 font-bold text-paper transition-transform active:scale-press disabled:opacity-40"
        >
          {busy ? 'Joining…' : 'Sponsor this market'}
        </button>
      </div>
      <p className="mt-2 text-sm text-text-muted">
        From {exactMoney(minContribution)}. Your money is split equally across every outcome, so you
        never hold a side through the seed — and it comes back in full if the round falls short.
      </p>
      {error !== null && <p className="mt-2 text-sm text-fall">{error}</p>}
    </div>
  );
}

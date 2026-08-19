'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { community, sessionToken, type ChallengeView } from '@/lib/community-api';
import { PageShell } from '@/components/market/page-shell';

/**
 * §2.15d's challenge landing.
 *
 * "Recipient lands on the market with the challenger's position shown.
 * Registering-to-disagree is the strongest signup motivator."
 *
 * So the page is built for somebody with no account: the claim is the headline,
 * the market is one tap away, and signing up is framed as disagreeing rather
 * than as joining. Nothing here asks for a login before it shows the argument.
 */
export default function ChallengeLanding({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [challenge, setChallenge] = useState<ChallengeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setSignedIn(sessionToken() !== null);
    void community
      .openChallenge(token)
      .then(setChallenge)
      .catch((caught: Error) => setError(caught.message));
  }, [token]);

  if (error !== null) {
    return <PageShell width="narrow">{error}</PageShell>;
  }
  if (challenge === null) {
    return <PageShell width="narrow">Loading…</PageShell>;
  }

  const name =
    challenge.challenger.displayName ??
    (challenge.challenger.handle === null ? 'Someone' : `@${challenge.challenger.handle}`);

  return (
    <PageShell width="narrow">
      <p className="font-mono text-xs uppercase tracking-widest text-text-muted">
        A challenge on StakeAm
      </p>

      <h1 className="mt-3 text-2xl font-black leading-tight">
        {name} says{' '}
        <span className="text-rise">
          {challenge.outcomeLabel ?? 'their side'}
          {challenge.pricePct !== null && ` at ${challenge.pricePct}%`}
        </span>
        .
      </h1>

      <p className="mt-4 text-md text-text-muted">{challenge.question}</p>

      <div className="mt-8 flex flex-col gap-2">
        <Link
          href={`/market/${challenge.marketId}?src=share`}
          className="rounded-md bg-rise px-4 py-3 text-center font-bold text-paper"
        >
          Prove them wrong
        </Link>

        {challenge.isChallenger ? (
          <p className="text-center text-sm text-text-muted">
            This is your challenge. Send the link to someone who disagrees.
          </p>
        ) : challenge.accepted ? (
          <p className="text-center text-sm text-text-muted">
            Somebody already took the other side.
          </p>
        ) : signedIn ? (
          <button
            type="button"
            disabled={accepted}
            onClick={() =>
              void community
                .acceptChallenge(token)
                .then(() => setAccepted(true))
                .catch((caught: Error) => setError(caught.message))
            }
            className="rounded-md border border-border px-4 py-3 text-sm font-semibold disabled:opacity-40"
          >
            {accepted ? 'You took the other side' : 'I took the other side'}
          </button>
        ) : (
          <p className="text-center text-sm text-text-muted">
            Take a position on the market, and it counts as your answer.
          </p>
        )}
      </div>

      <p className="mt-10 text-center font-mono text-xs text-text-muted">
        Winners split the pot. No house, no house edge.
      </p>
    </PageShell>
  );
}

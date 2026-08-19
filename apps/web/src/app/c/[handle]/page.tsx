'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';

import { creator, type PublicProfile } from '@/lib/creator-api';
import { PageShell } from '@/components/market/page-shell';

/**
 * §2.14c's public creator profile.
 *
 * "Live markets, resolution accuracy, total volume hosted, followers." The
 * record is shown whole — including what went wrong — because a track record
 * that only lists wins is not a track record, and the whole point of §2.14c is
 * that a creator's standing is something a stranger can check.
 */
export default function CreatorProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void creator
      .profile(handle)
      .then(setProfile)
      .catch((caught: Error) => setError(caught.message));
  }, [handle]);

  async function toggleFollow(): Promise<void> {
    if (profile === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = profile.following
        ? await creator.unfollow(profile.userId)
        : await creator.follow(profile.userId);
      setProfile({ ...profile, following: result.following, followerCount: result.followerCount });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error !== null) {
    return <PageShell width="narrow">{error}</PageShell>;
  }
  if (profile === null) {
    return <PageShell width="narrow">Loading…</PageShell>;
  }

  const settled =
    profile.cleanResolutions + profile.disputedResolutions + profile.voidedAfterActivation;

  return (
    <PageShell width="narrow">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black">
            {profile.displayName}
            {profile.badge !== null && (
              <span className="rounded-full bg-rise px-2 py-0.5 text-xs font-bold text-paper">
                {profile.badge}
              </span>
            )}
          </h1>
          <p className="mt-0.5 font-mono text-sm text-text-muted">@{profile.handle}</p>
        </div>

        {!profile.isSelf && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggleFollow()}
            className={`rounded-sm px-4 py-2 text-sm font-bold disabled:opacity-40 ${
              profile.following ? 'border border-border text-text-muted' : 'bg-rise text-paper'
            }`}
          >
            {profile.following ? 'Following' : 'Follow'}
          </button>
        )}
      </header>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="followers" value={profile.followerCount.toLocaleString('en-NG')} />
        <Figure
          label="volume hosted"
          value={
            <span className="text-money">
              {Number(profile.volumeHosted).toLocaleString('en-NG', { maximumFractionDigits: 0 })}
            </span>
          }
        />
        <Figure
          label="clean rate"
          value={profile.cleanRatePct === null ? '—' : `${profile.cleanRatePct}%`}
        />
        <Figure label="settled" value={settled.toLocaleString('en-NG')} />
      </dl>

      {settled > 0 && (
        <p className="mt-3 font-mono text-xs text-text-muted">
          {profile.cleanResolutions} clean
          {profile.disputedResolutions > 0 && ` · ${profile.disputedResolutions} disputed`}
          {profile.voidedAfterActivation > 0 && ` · ${profile.voidedAfterActivation} voided`}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Live now</h2>
        {profile.liveMarkets.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">Nothing open at the moment.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {profile.liveMarkets.map((market) => (
              <li key={market.id} className="rounded-md border border-border p-3">
                <Link href={`/market/${market.id}`} className="font-semibold">
                  {market.question}
                </Link>
                <p className="mt-1 font-mono text-xs text-text-muted">
                  {market.state} · pot{' '}
                  <span className="text-money">
                    {Number(market.potTotal).toLocaleString('en-NG', {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  );
}

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold">{value}</dd>
    </div>
  );
}

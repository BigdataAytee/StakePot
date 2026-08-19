import Link from 'next/link';

import { SiteFooter } from '@/components/site-footer';

/**
 * The 404.
 *
 * Next's default is a bare "This page could not be found" on a white page with
 * no way out — which on a phone, arriving from a shared link to a market that
 * has since been removed, is a dead end and the last thing that visitor sees of
 * the product. This one says what probably happened and points at the shelves.
 *
 * A settled market is the commonest way to land here, so it is the first
 * explanation offered rather than a generic apology.
 */
export const metadata = {
  title: 'Not found',
  description: 'That page does not exist. The markets are this way.',
};

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10">
      <Link href="/" className="font-mono text-xs text-text-muted underline">
        ← StakeAm
      </Link>

      <div className="mt-16">
        <p className="font-mono text-sm text-text-muted">404</p>
        <h1 className="mt-2 text-2xl font-black leading-none">There is nothing here</h1>
        <p className="mt-3 text-md leading-relaxed text-text-muted">
          The link may be old, or the market it pointed at may have settled and closed. Nothing has
          gone wrong with your account, and nothing has happened to your balance.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/markets"
            className="flex min-h-11 items-center justify-center rounded-md bg-rise px-5 font-bold text-paper"
          >
            Open markets
          </Link>
          <Link
            href="/leaderboard"
            className="flex min-h-11 items-center justify-center rounded-md border border-border px-5 font-bold"
          >
            Leaderboard
          </Link>
        </div>

        <p className="mt-6 text-sm text-text-muted">
          Followed a link that should have worked?{' '}
          <Link href="/support" className="font-bold underline">
            Tell us
          </Link>{' '}
          — a broken link is a bug.
        </p>
      </div>

      <SiteFooter />
    </main>
  );
}

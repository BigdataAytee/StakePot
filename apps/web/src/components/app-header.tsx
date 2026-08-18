'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { money } from '@/lib/format';
import { clearToken, useSession } from '@/lib/session';

/**
 * The signed-in header: who you are, what you have, where you can go.
 *
 * The balance lives here rather than on a wallet screen you have to navigate to
 * because §7.5's whole argument is that a person deciding whether to stake
 * ₦2,000 should never have to leave the question to find out whether they can.
 */
export function AppHeader() {
  const { me, loading } = useSession();
  const router = useRouter();

  function logOut() {
    clearToken();
    router.push('/');
    router.refresh();
  }

  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div>
        <Link href="/markets" className="text-2xl font-black leading-none">
          StakeAm
        </Link>
        <p className="mt-2 text-md text-text-muted">
          Winners split the pot. No house, no house edge.
        </p>
      </div>

      {loading ? null : me === null ? (
        <div className="flex shrink-0 items-center gap-3">
          <Link href="/login" className="text-sm font-bold underline">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-md bg-rise px-3 py-2 text-sm font-black text-paper"
          >
            Sign up
          </Link>
        </div>
      ) : (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Link href="/wallet" className="text-right">
            <span className="block font-mono text-xs text-text-muted">Balance</span>
            <span className="font-mono text-lg font-black tabular-nums text-money">
              {money(me.available)}
            </span>
          </Link>
          {me.escrowed !== '0' && (
            <span className="font-mono text-xs text-text-muted">
              {money(me.escrowed)} in open markets
            </span>
          )}
          {!me.contactVerified && (
            <Link href="/verify" className="font-mono text-xs text-rise underline">
              Verify to unlock more
            </Link>
          )}
          <button type="button" onClick={logOut} className="font-mono text-xs text-text-muted">
            Log out
          </button>
        </div>
      )}
    </header>
  );
}

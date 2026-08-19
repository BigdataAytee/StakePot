'use client';

import { useCallback, useEffect, useState } from 'react';

import { useSession } from './session';

/**
 * The markets somebody has starred.
 *
 * Kept in this browser, keyed by the account that starred them, so two people
 * sharing a phone do not share a watchlist and signing out does not hand the
 * next person yours.
 *
 * A known limit, stated rather than hidden: this does not follow the account
 * to another device. Making it do so needs a column and a pair of endpoints,
 * which is a backend change rather than a styling one — the seam is here, so
 * that work is a swap of these two functions.
 */
function keyFor(userId: string | null): string {
  return `stakeam.watchlist.${userId ?? 'guest'}`;
}

function read(userId: string | null): Set<string> {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : new Set();
  } catch {
    // Corrupt or unavailable storage means an empty watchlist, not a crash.
    return new Set();
  }
}

function write(userId: string | null, ids: Set<string>): void {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify([...ids]));
  } catch {
    // Nothing to do — the star still works for this session.
  }
}

export interface Watchlist {
  ids: Set<string>;
  has: (marketId: string) => boolean;
  toggle: (marketId: string) => void;
  /** False until the stored list has been read, so the server and the first
   *  client render agree and no star flickers on. */
  ready: boolean;
}

export function useWatchlist(): Watchlist {
  const { me } = useSession();
  const userId = me?.id ?? null;
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);

  // Re-read whenever the account changes: logging in must not leave the
  // previous account's stars on screen.
  useEffect(() => {
    setIds(read(userId));
    setReady(true);
  }, [userId]);

  const toggle = useCallback(
    (marketId: string) => {
      setIds((current) => {
        const next = new Set(current);
        if (next.has(marketId)) next.delete(marketId);
        else next.add(marketId);
        write(userId, next);
        return next;
      });
    },
    [userId],
  );

  const has = useCallback((marketId: string) => ids.has(marketId), [ids]);

  return { ids, has, toggle, ready };
}

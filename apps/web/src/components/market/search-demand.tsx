'use client';

import { useEffect, useRef } from 'react';

import { API_URL } from '@/lib/api';
import { getToken } from '@/lib/session';

/**
 * §7.1 → §2.14b: a search that found nothing is the most valuable row in the
 * table, not a dead end.
 *
 * The opportunity feed reads unmet search demand, and the endpoint that
 * records it has existed since step 11. Nothing called it: the header search
 * filters the catalogue through the query string, server-side, so no request
 * ever reached the search route and the feed was quietly running on an empty
 * signal. That is the worst failure shape available — a feature that looks
 * built, works, and is fed nothing.
 *
 * This reports what the reader actually searched and how many markets it
 * matched. Fire-and-forget: a failure to record demand must never be visible
 * to somebody who was just looking for a market.
 *
 * Debounced and deduplicated per (query, count) because the page re-renders as
 * filters move, and forty identical rows would say "forty people wanted this"
 * when one person did.
 */
export function SearchDemand({ query, results }: { query: string; results: number }) {
  const reported = useRef<string | null>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) return undefined;

    const key = `${term}:${results}`;
    if (reported.current === key) return undefined;

    // A second of quiet first: somebody typing "election" should not file
    // eight rows for "e", "el", "ele"…
    const timer = setTimeout(() => {
      reported.current = key;
      const token = getToken();

      void fetch(`${API_URL}/search/q?q=${encodeURIComponent(term)}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }, 1_000);

    return () => clearTimeout(timer);
  }, [query, results]);

  return null;
}

'use client';

import { useCallback, useEffect, useState } from 'react';

import { API_URL } from './api';

/**
 * The browser's half of §2.1's session.
 *
 * One place that knows where the token lives, so the answer can change once.
 * It lives in `localStorage` today, which the Phase 0 security review names as
 * a gap (an XSS anywhere would expose it); the licensed-phase answer is an
 * httpOnly cookie, and this module is the seam that swap goes through.
 */
const TOKEN_KEY = 'stakeam.token';

export interface Me {
  id: string;
  email: string | null;
  phone: string | null;
  handle: string | null;
  displayName: string | null;
  tier: number;
  contactVerified: boolean;
  role: string;
  status: string;
  available: string;
  escrowed: string;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

/** POST to the API with the session token attached, if there is one. */
export async function authed<T>(
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    // The API answers refusals with a message a person can act on ("that code
    // is not right", "insufficient funds"). Surfacing the status code instead
    // would throw that away, which is how a product ends up saying
    // "Error 400" to someone who mistyped a digit.
    const detail = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = Array.isArray(detail?.message)
      ? String(detail.message[0])
      : typeof detail?.message === 'string'
        ? detail.message
        : `that didn't work (${response.status})`;
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/**
 * The signed-in user, or null.
 *
 * `loading` is deliberately distinct from "signed out": rendering the
 * logged-out landing page for a split second before the token resolves is the
 * kind of flicker that makes an app feel broken.
 */
export function useSession(): { me: Me | null; loading: boolean; refresh: () => Promise<void> } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (getToken() === null) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await authed<Me>('/auth/me'));
    } catch {
      // A token the API will not accept is worse than no token: it makes every
      // subsequent call fail in a way the user cannot see or fix.
      clearToken();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { me, loading, refresh };
}

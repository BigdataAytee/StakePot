import { API_URL } from '@/lib/api';

/** §2.15's community layer, from the browser. */

export interface ThreadComment {
  id: string;
  text: string | null;
  badge: string;
  handle: string | null;
  displayName: string | null;
  fromTrade: boolean;
  parentId: string | null;
  state: 'live' | 'flagged' | 'held' | 'removed';
  calledIt: boolean | null;
  boldness: number | null;
  removed: boolean;
  mine: boolean;
  reports: number;
  createdAt: string;
}

export interface PostedComment {
  id: string;
  state: string;
  badge: string;
  notice: string | null;
}

export interface ChallengeView {
  marketId: string;
  question: string;
  state: string;
  challenger: { handle: string | null; displayName: string | null };
  badge: string;
  outcomeLabel: string | null;
  pricePct: number | null;
  accepted: boolean;
  isChallenger: boolean;
}

export interface ModerationRow {
  id: string;
  text: string;
  state: 'held' | 'flagged';
  badge: string;
  author: { id: string; handle: string | null; displayName: string | null };
  market: { id: string; question: string };
  flags: { kind: string; evidence: string }[];
  reports: number;
  recentReasons: string[];
  createdAt: string;
}

export function sessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('stakeam.token');
}

async function request<T>(path: string, init?: RequestInit, requireToken = false): Promise<T> {
  const token = sessionToken();
  if (requireToken && token === null) throw new Error('Sign in first.');

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // Only when there is a body: Fastify's JSON parser refuses an empty body
      // that claims to be JSON, which turns every bodyless POST into a parser
      // error that reads like a server fault.
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init?.headers ?? {}),
    },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body !== null && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `${path} responded ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const community = {
  /** Public: the argument is the marketing, so it reads without an account. */
  thread: (marketId: string) => request<ThreadComment[]>(`/markets/${marketId}/thread`),
  post: (marketId: string, text: string, parentId?: string) =>
    request<PostedComment>(
      `/markets/${marketId}/thread`,
      {
        method: 'POST',
        body: JSON.stringify({ text, ...(parentId === undefined ? {} : { parentId }) }),
      },
      true,
    ),
  report: (commentId: string, reason: string) =>
    request<{ reports: number; flagged: boolean }>(
      `/comments/${commentId}/report`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      true,
    ),

  challenge: (marketId: string) =>
    request<{ token: string; badge: string; marketId: string }>(
      `/markets/${marketId}/challenge`,
      { method: 'POST', body: JSON.stringify({}) },
      true,
    ),
  openChallenge: (token: string) => request<ChallengeView>(`/challenges/${token}`),
  acceptChallenge: (token: string) =>
    request<{ accepted: boolean }>(
      `/challenges/${token}/accept`,
      { method: 'POST', body: JSON.stringify({}) },
      true,
    ),

  moderationQueue: () => request<ModerationRow[]>('/admin/moderation', undefined, true),
  moderate: (commentId: string, decision: 'publish' | 'remove') =>
    request<{ state: string }>(
      `/admin/moderation/${commentId}`,
      { method: 'POST', body: JSON.stringify({ decision }) },
      true,
    ),
};

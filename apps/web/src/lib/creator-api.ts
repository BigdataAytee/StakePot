import { API_URL } from '@/lib/api';

/**
 * §2.14's creator platform, from the browser.
 *
 * Split from `admin-api` because the audience is different in the way that
 * matters: a creator's own token, on their own numbers. Profiles and the
 * opportunity feed read without one — a public record has to render for
 * somebody who has not signed up yet, or it is not public.
 */

export interface Requirement {
  label: string;
  have: number;
  need: number;
  met: boolean;
}

export interface Privileges {
  level: 1 | 2 | 3;
  maxLiveMarkets: number;
  bondMultiplier: number;
  creatorBps: number;
  autoApproveTemplateStandard: boolean;
  featuredPlacement: boolean;
  customSyndicateSplits: boolean;
  bonusPoolShare: boolean;
  badge: string | null;
}

export interface AutopsyRow {
  marketId: string;
  question: string;
  kind: 'resolved' | 'voided';
  summary: string;
  tip: string | null;
  worked: string[];
  volume: string;
  distinctStakers: number;
  finalSplit: string | null;
  createdAt: string;
}

export interface Standing {
  handle: string | null;
  displayName: string | null;
  level: 1 | 2 | 3;
  privileges: Privileges;
  record: {
    cleanResolutions: number;
    disputedResolutions: number;
    voidedAfterActivation: number;
    volumeHosted: number;
  };
  progress: { target: 2 | 3; requirements: Requirement[] } | null;
  liveMarkets: number;
  autopsies: AutopsyRow[];
}

export interface Nudge {
  kind: string;
  urgency: 'now' | 'soon' | 'fyi';
  body: string;
  action: 'share' | 'seed' | 'propose_resolution' | 'review_criteria';
}

export interface MarketAnalytics {
  marketId: string;
  question: string;
  state: string;
  views: number;
  distinctViewers: number;
  stakers: number;
  conversion: number | null;
  volume: string;
  creatorFeeAccrued: string;
  sources: { source: string; views: number }[];
  pools: {
    outcomeId: string;
    label: string;
    staked: string;
    price: string;
    activationProgress: number | null;
  }[];
  balanceOverTime: { at: string; prices: string[] }[];
}

export interface StudioMarket {
  id: string;
  question: string;
  state: string;
  createdAt: string;
  analytics: MarketAnalytics | null;
  nudges: Nudge[];
}

export interface PublicProfile {
  userId: string;
  handle: string;
  displayName: string;
  level: 1 | 2 | 3;
  badge: string | null;
  cleanResolutions: number;
  disputedResolutions: number;
  voidedAfterActivation: number;
  cleanRatePct: number | null;
  volumeHosted: string;
  followerCount: number;
  since: string;
  liveMarkets: { id: string; question: string; state: string; potTotal: string }[];
  following: boolean;
  isSelf: boolean;
}

export interface Opportunity {
  id: string;
  source: 'calendar' | 'search_gap' | 'seasonal';
  title: string;
  score: number;
  expiresAt: string;
  claimed: boolean;
  evidence: { searchers?: number; query?: string } | null;
  template: {
    id: string;
    category: string;
    templateJson: unknown;
    localisableFields: unknown;
  } | null;
}

export function creatorToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('stakeam.token');
}

async function request<T>(path: string, init?: RequestInit, requireToken = true): Promise<T> {
  const token = creatorToken();
  if (requireToken && token === null) throw new Error('Sign in to see your studio.');

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
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

export const creator = {
  standing: () => request<Standing>('/creators/me'),
  myMarkets: () => request<StudioMarket[]>('/creators/me/markets'),
  market: (id: string) =>
    request<MarketAnalytics & { nudges: Nudge[]; autopsy: AutopsyRow | null }>(
      `/creators/me/markets/${id}`,
    ),
  claimHandle: (handle: string, displayName?: string) =>
    request<{ handle: string; displayName: string }>('/creators/me/handle', {
      method: 'POST',
      body: JSON.stringify({ handle, ...(displayName === undefined ? {} : { displayName }) }),
    }),

  /** Public — renders for a signed-out visitor, with `following` false. */
  profile: (handle: string) =>
    request<PublicProfile>(`/creators/handle/${encodeURIComponent(handle)}`, undefined, false),
  follow: (creatorId: string) =>
    request<{ following: boolean; followerCount: number }>(`/creators/${creatorId}/follow`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  unfollow: (creatorId: string) =>
    request<{ following: boolean; followerCount: number }>(`/creators/${creatorId}/follow`, {
      method: 'DELETE',
    }),

  opportunities: () => request<Opportunity[]>('/creators/opportunities/feed', undefined, false),
  claimOpportunity: (id: string, marketId: string) =>
    request<{ claimed: boolean }>(`/creators/opportunities/${id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ marketId }),
    }),
};

/**
 * Tell the API somebody looked (§2.14d).
 *
 * Fire-and-forget on purpose: a failed analytics beacon must never be something
 * the reader finds out about.
 */
export function recordView(marketId: string, source?: string): void {
  const token = creatorToken();
  void fetch(`${API_URL}/markets/${marketId}/view`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(source === undefined ? {} : { source }),
    keepalive: true,
  }).catch(() => undefined);
}

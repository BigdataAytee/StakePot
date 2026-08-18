import { API_URL } from '@/lib/api';

/**
 * The admin cockpit's data layer.
 *
 * Everything here is called from the browser with the operator's own bearer
 * token — there is no server-side admin session, so a screen can never render
 * data the person looking at it is not entitled to fetch. The API enforces
 * §6.11's role matrix on every route; this just carries the credential.
 */

export interface DashboardView {
  reconciliation: {
    status: string;
    runDate: string | null;
    diff: string | null;
    clearedBy: string | null;
  };
  solvency: {
    userLiabilities: string;
    held: string;
    surplus: string;
    byFundClass: {
      user_available: string;
      user_escrow: string;
      platform_fees: string;
      prize_pool: string;
    };
    escrowByMarketState: { state: string; escrowed: string; markets: number }[];
  };
  activity: { liveMarkets: number; volume24h: string; trades24h: number; fees24h: string };
  queues: { openDisputes: number; pendingApprovals: number; resultsDue: number };
}

export interface QueueMarket {
  id: string;
  question: string;
  shelf: 'official' | 'community';
  state: string;
  creatorId: string | null;
  sourceName: string;
  sourceUrl: string;
  criteria: unknown;
  eventDate: string;
  voidDate: string;
  pot: string;
  disputeClosesAt: string | null;
  windowClosed: boolean;
  outcomes: { id: string; label: string; price: string; staked: string }[];
  proposal: {
    id: string;
    proposedBy: string;
    proposedOutcomeId: string;
    evidenceUrl: string;
    proposedAt: string;
    finalizedAt: string | null;
  } | null;
  disputes: {
    id: string;
    userId: string;
    state: string;
    evidenceUrl: string;
    text: string;
    decision: string | null;
    createdAt: string;
  }[];
}

export interface PendingApproval {
  id: string;
  actionType: string;
  summary: string;
  payload: unknown;
  /** The live value this proposal would replace, where there is one. */
  current: unknown;
  reason: string;
  requestedBy: string;
  createdAt: string;
}

export interface LedgerRow {
  id: string;
  userId: string;
  marketId: string | null;
  type: string;
  fundClass: string;
  amount: string;
  currency: string;
  ref: string | null;
  createdAt: string;
}

export interface ReconciliationRow {
  id: string;
  runDate: string;
  status: string;
  diff: string;
  ledgerTotal: string;
  walletTotal: string;
  clearedBy: string | null;
}

export interface ReservesExport {
  generatedAt: string;
  currency: string;
  userLiabilities: string;
  totalIssued: string;
  platformFees: string;
  surplus: string;
  solvent: boolean;
}

export function adminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('stakeam.token');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = adminToken();
  if (token === null) throw new Error('Sign in with a staff account.');

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
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

export const admin = {
  dashboard: () => request<DashboardView>('/admin/dashboard'),
  resolutionQueue: () => request<QueueMarket[]>('/admin/resolution-queue'),
  approvals: () => request<PendingApproval[]>('/admin/approvals'),
  approve: (id: string) =>
    request<{ state: string }>(`/admin/approvals/${id}/approve`, {
      method: 'POST',
    }),
  reject: (id: string, reason: string) =>
    request<{ state: string }>(`/admin/approvals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  propose: (marketId: string, outcomeId: string, evidenceUrl: string) =>
    request<{ disputeClosesAt: string }>(`/admin/markets/${marketId}/resolution/propose`, {
      method: 'POST',
      body: JSON.stringify({ outcomeId, evidenceUrl }),
    }),
  finalize: (marketId: string, outcomeId: string, reasoning: string) =>
    request<{ state: string; fee: string; paid: number }>(
      `/admin/markets/${marketId}/resolution/finalize`,
      { method: 'POST', body: JSON.stringify({ outcomeId, reasoning }) },
    ),
  ledger: (params: { userId?: string; marketId?: string }) => {
    const query = new URLSearchParams();
    if (params.userId !== undefined && params.userId !== '') query.set('userId', params.userId);
    if (params.marketId !== undefined && params.marketId !== '')
      query.set('marketId', params.marketId);
    const suffix = query.toString();
    return request<LedgerRow[]>(`/admin/ledger${suffix === '' ? '' : `?${suffix}`}`);
  },
  reconciliation: () => request<ReconciliationRow[]>('/admin/reconciliation'),
  reserves: () => request<ReservesExport>('/admin/reserves'),
  decideDispute: (disputeId: string, upheld: boolean, decision: string) =>
    request<{ state: string }>(`/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ upheld, decision }),
    }),
};

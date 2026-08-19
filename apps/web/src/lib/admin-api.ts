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

/**
 * §2.10's signed export — the document, as opposed to the panel.
 *
 * `signature` is null when no signing key is configured for the environment.
 * That is a real state, not an error: the figures are still correct, they just
 * cannot be attested to anybody outside the building.
 */
export interface SignedReserves extends ReservesExport {
  document: 'stakeam.proof-of-reserves';
  version: 1;
  byFundClass: Record<string, string>;
  accounts: number;
  reconciliation: { runDate: string | null; status: string; diff: string | null };
  signature: {
    algorithm: string;
    keyId: string;
    value: string;
    canonicalisation: string;
  } | null;
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

export interface SupportQueueTicket {
  id: string;
  subject: string;
  category: string;
  state: string;
  slaState: 'ok' | 'due_soon' | 'breached' | 'paused';
  slaDue: string;
  createdAt: string;
  user: { id: string; email: string | null; phone: string | null; tier: number; status: string };
  market: { id: string; question: string; state: string } | null;
  messages: { id: string; authorId: string; body: string; staffOnly: boolean; createdAt: string }[];
}

export interface DraftRow {
  id: string;
  source: 'ai' | 'community';
  state: 'suggested' | 'approved' | 'rejected';
  slot: string | null;
  score: number;
  question: string;
  outcomes: string[];
  sourceName: string;
  sourceUrl: string;
  eventDate: string;
  voidDate: string;
  estimates: number[];
  engagement: number;
  rationale: string;
  refusals: string[];
  creatorId: string | null;
  firstMarket: boolean;
  createdAt: string;
  template: {
    question: string;
    outcomes: { label: string; criteria: string }[];
    otherLabel?: string;
    sourceName: string;
    sourceUrl: string;
    eventDate: string;
    voidDate: string;
  };
}

export interface TotpStatus {
  enrolled: boolean;
  confirmedAt: string | null;
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
  approve: (id: string, totpCode: string) =>
    request<{ state: string }>(`/admin/approvals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ totpCode }),
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
  drafts: (includeRejected = false) =>
    request<DraftRow[]>(`/admin/drafts${includeRejected ? '?includeRejected=true' : ''}`),
  generateDrafts: () =>
    request<{ draftId: string; state: string; score: number; question: string }[]>(
      '/admin/drafts/generate',
      { method: 'POST' },
    ),
  openDraft: (id: string) =>
    request<{ marketId: string; seeded: string }>(`/admin/drafts/${id}/open`, { method: 'POST' }),
  rejectDraft: (id: string, reason: string) =>
    request<{ state: string }>(`/admin/drafts/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  supportQueue: () => request<SupportQueueTicket[]>('/admin/support'),
  supportReply: (id: string, body: string, staffOnly = false) =>
    request<{ state: string }>(`/admin/support/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body, staffOnly }),
    }),
  supportResolve: (id: string) =>
    request<{ state: string }>(`/admin/support/${id}/resolve`, { method: 'POST' }),
  totpStatus: () => request<TotpStatus>('/account/2fa'),
  totpEnrol: () =>
    request<{ otpauth: string; qr: string; secret: string }>('/account/2fa/enrol', {
      method: 'POST',
    }),
  totpConfirm: (code: string) =>
    request<TotpStatus>('/account/2fa/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  reserves: () => request<ReservesExport>('/admin/reserves'),
  reservesExport: () => request<SignedReserves>('/admin/reserves/export'),
  decideDispute: (disputeId: string, upheld: boolean, decision: string) =>
    request<{ state: string }>(`/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ upheld, decision }),
    }),
};

// ---------------------------------------------------------------- step 13

export interface LeaderboardRow {
  rank: number;
  userId: string;
  handle: string | null;
  displayName: string | null;
  profit: string;
  accuracyPct: number;
  marketsSettled: number;
  marketsWon: number;
  streak: number;
  staked: string;
}

export interface PrizeRunView {
  id: string;
  period: string;
  board: 'profit' | 'accuracy';
  state: 'draft' | 'pending_approval' | 'paid' | 'cancelled';
  total: string;
  note: string | null;
  paidAt: string | null;
  createdAt: string;
  awards: {
    rank: number;
    userId: string;
    handle: string | null;
    displayName: string | null;
    tier: number;
    amount: string;
  }[];
}

export interface AnalyticsOverview {
  days: number;
  counts: { name: string; count: number }[];
  funnel: { stage: string; people: number; shareOfTop: number | null }[];
}

export const growth = {
  prizeRuns: () => request<PrizeRunView[]>('/admin/prizes'),
  prizePreview: (period: string, board: string) =>
    request<LeaderboardRow[]>(
      `/admin/prizes/preview?period=${encodeURIComponent(period)}&board=${board}`,
    ),
  draftRun: (body: { period: string; board: string; places?: number; poolSpc?: string }) =>
    request<{ runId: string; awards: number; total: string }>('/admin/prizes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  submitRun: (id: string, reason: string) =>
    request<{ approvalId: string }>(`/admin/prizes/${id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  announceRun: (id: string) =>
    request<{ told: number }>(`/admin/prizes/${id}/announce`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  cancelRun: (id: string) =>
    request<{ cancelled: boolean }>(`/admin/prizes/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  analytics: (days = 14) => request<AnalyticsOverview>(`/admin/analytics?days=${days}`),
};

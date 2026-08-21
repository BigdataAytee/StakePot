import type { HealthFlag, RuleReport } from '@stakeam/rules';

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
  /**
   * What the research layer makes of this market. Advisory only — it cannot
   * settle anything, and the propose/confirm path is untouched by it.
   *
   * Null when nobody has built one, which the screen says out loud: "no dossier"
   * and "a dossier that found nothing" are different facts.
   */
  dossier: MarketDossier | null;
}

/** A resolution dossier as the Resolution Centre shows it. */
export interface MarketDossier {
  proposedOutcomeId: string | null;
  confidence: number;
  recommendVoid: boolean;
  reasoning: string;
  evidence: { headline: string; url: string; sourceName: string; publishedAt: string }[];
  conflicts: { factKey: string; claims: { sourceName: string; value: unknown }[] }[];
  builtAt: string;
  reviewedAt: string | null;
  accepted: boolean | null;
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
  /**
   * What the research pipeline had read when the draft was made.
   *
   * Null on community submissions and on anything drafted before the pipeline
   * existed — which the panel says out loud rather than rendering as an empty
   * evidence list, because "nobody looked" and "nothing was published" are
   * different things and only one of them is a reason to distrust the draft.
   */
  evidence: DraftEvidence | null;
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
      // Only when there is actually a body. Fastify's JSON parser rejects an
      // empty body that claims to be JSON — "Body cannot be empty when
      // content-type is set to 'application/json'" — so declaring it
      // unconditionally broke every bodyless POST on the admin panel: run a
      // research pass, resolve a ticket, start a 2FA enrolment. Each of them
      // failed with a parser error that reads like a server fault.
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
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

/** A market as the Studio's Manage tab sees it, flags and all. */
export interface StudioMarketRow {
  id: string;
  question: string;
  shelf: 'official' | 'community';
  state: string;
  sourceName: string;
  eventDate: string;
  voidDate: string;
  createdAt: string;
  pot: string;
  holders: number;
  outcomes: { id: string; label: string; price: string; staked: string }[];
  flags: StandingFlag[];
}

/**
 * A live flag, plus when the monitoring sweep first recorded it.
 *
 * The wording and severity are computed fresh on every request, so nothing on
 * the screen is stale; `since` comes from the recorded row. Both, because
 * "running 82/18" is a number and "running 82/18 since Tuesday" is a decision.
 * Null when the sweep has not run since the condition appeared.
 */
export interface StandingFlag extends HealthFlag {
  since: string | null;
}

/** A starter template as the Studio's Library tab lists it. */
export interface LibraryTemplate {
  id: string;
  category: string;
  active: boolean;
  name: string;
  question: string;
}

/** A settled market offered back, with what it did last time. */
export interface RepeatableMarket {
  id: string;
  question: string;
  sourceName: string;
  eventDate: string;
  volume: string;
  finalSplit: number | null;
  disputes: number;
  warningsFired: string[];
  /** Said plainly when the last run suggests moving the threshold. */
  retune: string | null;
}

/** The pipeline's own vital signs — see the Studio's Research tab. */
export interface CrawlHealth {
  sources: {
    id: string;
    name: string;
    tier: string;
    kind: string;
    feedUrl: string | null;
    status: 'ok' | 'stale' | 'failing' | 'off';
    trust: number;
    failureCount: number;
    conflicts: number;
    lastFetchAt: string | null;
    lastOkAt: string | null;
    /** When it last published something we kept — not when we last asked. */
    lastItemAt: string | null;
    lastError: string | null;
    itemsLast24h: number;
    cadence: string;
    intervalMs: number;
    nextCheckAt: string | null;
    attachedHours: number | null;
    disabledReason: string | null;
  }[];
  totals: {
    sources: number;
    enabled: number;
    failing: number;
    stale: number;
    itemsLast24h: number;
    itemsPerHour: number;
    openConflicts: number;
    uncoveredMarkets: number;
  };
  budgets: { sourcesPerPass: number; itemsPerMarket: number };
  /** Whether anything is actually reading, and when it last did. */
  pipeline: { fetcher: string; fetching: boolean; lastFetchAt: string | null };
  coverage: {
    marketId: string;
    question: string;
    sourceName: string;
    items: number;
    lastItemAt: string | null;
    hoursToEvent: number;
  }[];
  conflicts: {
    id: string;
    marketId: string | null;
    factKey: string;
    claims: { sourceName: string; tier: string; value: unknown }[];
    detectedAt: string;
  }[];
  builtAt: string;
}

/** One market on the freeze desk. */
export interface FreezeRow {
  id: string;
  question: string;
  shelf: string;
  state: string;
  eventDate: string;
  freezeAt: string | null;
  frozenAt: string | null;
  freezeReason: string | null;
  pot: string;
}

export interface FreezeDesk {
  freezingSoon: FreezeRow[];
  frozen: FreezeRow[];
  /**
   * Past its freeze time and still open. The money path refuses those trades
   * anyway, so this is a defect alarm — the sweep is not running, or is failing
   * on these rows — rather than an open door.
   */
  overdue: FreezeRow[];
  builtAt: string;
}

/** The reading behind an AI draft, as the Studio's evidence panel shows it. */
export interface DraftEvidence {
  brief: string;
  windowDays: number;
  itemsRead: number;
  stories: {
    headline: string;
    url: string;
    sourceName: string;
    tier: 'resolution' | 'news';
    publishedAt: string;
    sourceCount: number;
    relevance: number;
  }[];
  figures: {
    key: string;
    value: string;
    sourceName: string;
    tier: 'resolution' | 'news';
    publishedAt: string;
    url: string;
  }[];
  conflicts: {
    factKey: string;
    claims: { sourceName: string; tier: string; value: string | number }[];
  }[];
  builtAt: string;
}

/**
 * A market as the wizard has it so far.
 *
 * Optional everywhere the checklist allows, because the wizard reviews on every
 * step and posts half a market for most of a session.
 */
export interface StudioDraft {
  question: string;
  outcomes: { label: string; criteria: string }[];
  otherLabel?: string | undefined;
  sourceName: string;
  sourceUrl: string;
  eventDate: string;
  voidDate: string;
  edgeCases: Record<string, string>;
  balanceEstimates?: number[] | undefined;
  liquidityParam?: string | undefined;
  expectedStake?: string | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
  icon?: string | undefined;
  blockbuster?: boolean | undefined;
}

/** What the reviewer answers: the attestation and the judgement questions. */
export interface StudioAnswers {
  attestedNoInfluence?: boolean;
  confirmations?: Record<string, boolean>;
}

export const admin = {
  dashboard: () => request<DashboardView>('/admin/dashboard'),
  resolutionQueue: () => request<QueueMarket[]>('/admin/resolution-queue'),
  /** Assemble (or refresh) the dossier for one market. Advisory only. */
  buildDossier: (marketId: string) =>
    request<MarketDossier>(`/admin/markets/${marketId}/dossier`, { method: 'POST' }),
  /** Record that a human read the dossier, and whether they agreed with it. */
  recordDossierDecision: (marketId: string, accepted: boolean) =>
    request<{ recorded: boolean }>(`/admin/markets/${marketId}/dossier/decision`, {
      method: 'POST',
      body: JSON.stringify({ accepted }),
    }),
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
  openDraft: (id: string, answers: StudioAnswers) =>
    request<{ marketId: string; seeded: string }>(`/admin/drafts/${id}/open`, {
      method: 'POST',
      body: JSON.stringify(answers),
    }),
  /** The Studio's Manage tab: live markets with their Part 5 health flags. */
  studioMarkets: (state?: string) =>
    request<StudioMarketRow[]>(
      `/admin/studio/markets${state === undefined || state === '' ? '' : `?state=${state}`}`,
    ),
  /** Is the research pipeline actually finding anything? */
  /** The starter templates, retired ones included. */
  studioTemplates: () => request<LibraryTemplate[]>('/admin/studio/templates'),
  /** Settled markets worth running again, with what happened last time. */
  studioSeries: () => request<RepeatableMarket[]>('/admin/studio/series'),
  /** The next one in a series, as a draft for the wizard. Publishes nothing. */
  nextInSeries: (marketId: string, cadence: 'weekly' | 'fortnightly' | 'monthly') =>
    request<StudioDraft>(`/admin/studio/markets/${marketId}/next`, {
      method: 'POST',
      body: JSON.stringify({ cadence }),
    }),
  crawlHealth: () => request<CrawlHealth>('/admin/studio/crawl'),
  /** Run a research pass now instead of waiting for the five-minute sweep. */
  runCrawlPass: () =>
    request<{
      sourcesRead: number;
      itemsStored: number;
      linksMade: number;
      conflictsFound: number;
      unchanged: number;
    }>('/admin/studio/crawl/pass', { method: 'POST' }),
  /**
   * Add one source, or a list of them.
   *
   * The same endpoint the bulk import uses, called with a single entry: an
   * operator adding CAF from a phone and an admin pasting eighty rows are the
   * same operation, and two paths would be two sets of validation to keep in
   * step.
   */
  importSources: (
    sources: {
      tier: 'resolution' | 'news' | 'signal';
      kind: 'api' | 'rss' | 'sitemap' | 'crawl';
      name: string;
      homeUrl: string;
      feedUrl?: string;
      categories?: string[];
      region?: string;
      cadence?: 'auto' | 'urgent' | 'normal' | 'background';
      publishWindow?: string;
    }[],
  ) =>
    request<{ added: number; updated: number }>('/admin/studio/sources/import', {
      method: 'POST',
      body: JSON.stringify({ sources }),
    }),
  /** The kill switch: one source, a whole tier, or everything. */
  setSourcesEnabled: (body: {
    scope: 'source' | 'tier' | 'all';
    sourceId?: string;
    tier?: string;
    enabled: boolean;
    reason?: string;
  }) =>
    request<{ affected: number }>('/admin/studio/sources/enabled', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Put platform money into a live official market, equally on every outcome.
   *
   * Equally, so it moves no price: the engine's translation identity says
   * adding the same number of shares to every outcome costs exactly what it
   * adds and leaves the odds where they were. It runs as a real trade through
   * the engine and lands in the ledger — there is no "pot size" field to type
   * a number into, here or anywhere.
   *
   * `requestId` is generated per attempt so a double-click, or a retry after a
   * timeout, seeds once.
   */
  seedMarket: (id: string, body: { perOutcome: string; reason: string; requestId: string }) =>
    request<{ marketId: string; added: string; potAfter: string; perOutcome: string }>(
      `/admin/markets/${id}/seed`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Freezing soon, frozen, and anything that should have frozen and has not. */
  freezeDesk: () => request<FreezeDesk>('/admin/studio/freezes'),
  /**
   * Stop trading now. One person and a reason: freezing is the safe direction,
   * and waiting for a second signature while a result leaks is not.
   */
  freezeMarket: (id: string, reason: string) =>
    request<{ froze: boolean; state: string }>(`/admin/studio/markets/${id}/freeze`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  /** Move a freeze time that has not arrived. Audited and announced. */
  amendFreeze: (id: string, body: { freezeAt: string; eventDate?: string; reason: string }) =>
    request<{ freezeAt: string; eventDate: string }>(`/admin/studio/markets/${id}/freeze-at`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Propose reopening. Returns a proposal for somebody else to approve. */
  proposeUnfreeze: (id: string, body: { freezeAt: string; reason: string }) =>
    request<{ approvalId: string; state: string }>(`/admin/studio/markets/${id}/unfreeze`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** The checklist over whatever the wizard currently has. */
  studioReview: (draft: StudioDraft, answers: StudioAnswers) =>
    request<RuleReport>('/admin/studio/review', {
      method: 'POST',
      body: JSON.stringify({ draft, ...answers }),
    }),
  studioPublish: (
    draft: StudioDraft,
    answers: StudioAnswers & { seedPerOutcome?: string; warningReason?: string },
  ) =>
    request<{ marketId: string; seeded: string; report: RuleReport }>('/admin/studio/publish', {
      method: 'POST',
      body: JSON.stringify({ draft, ...answers }),
    }),
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

// ------------------------------------------------------- blocks E & F consoles

export interface FundingWindow {
  id: string;
  question: string;
  state: string;
  shelf: string;
  activationPath: string | null;
  closesAt: string | null;
  pot: string;
  trades: number;
  outcomes: { label: string; staked: string; funded: boolean }[];
  fundedOutcomes: number;
}

export interface Composition {
  market: {
    id: string;
    question: string;
    state: string;
    activationPath: string | null;
    creatorId: string | null;
    pot: string;
  };
  outcomes: { label: string; staked: string }[];
  syndicates: {
    id: string;
    state: string;
    target: string;
    perOutcomeMin: string;
    raised: string;
    organiserBps: number;
    maxSponsors: number;
    roundEndsAt: string;
    members: { userId: string; amount: string; feeShare: string; joinedAt: string }[];
  }[];
  bonds: { id: string; creatorId: string; amount: string; state: string }[];
}

export interface ConfigNote {
  blast: 'money' | 'market' | 'guard' | 'cosmetic';
  what: string;
  risk: string;
}

export interface ConfigConsole {
  keys: { key: string; value: unknown; version: number; note: ConfigNote | null }[];
  pending: {
    key: string;
    from: unknown;
    to: unknown;
    version: number;
    effectiveAt: string;
    note: ConfigNote | null;
  }[];
  history: {
    key: string;
    from: unknown;
    to: unknown;
    reason: string;
    proposedBy: string;
    approvedBy: string;
    proposedAt: string;
    activatedAt: string | null;
  }[];
}

export interface CreatorDeskRow {
  userId: string;
  handle: string | null;
  displayName: string | null;
  status: string;
  level: number;
  cleanResolutions: number;
  disputedResolutions: number;
  voidedAfterActivation: number;
  volumeHosted: string;
  followers: number;
  levelUpdatedAt: string | null;
  liveMarkets: number;
  bonds: { id: string; marketId: string; amount: string; state: string }[];
}

export interface FeatureFlagRow {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPct: number;
  allowList: string[];
  updatedBy: string | null;
  updatedAt: string;
}

export interface BroadcastRow {
  id: string;
  title: string;
  body: string;
  segment: string;
  channel: string;
  createdBy: string;
  approvedBy: string | null;
  sentAt: string | null;
  recipients: number;
  createdAt: string;
}

export interface SystemRoom {
  backups: {
    lastDrill: {
      ranAt: string;
      passed: boolean;
      durationSec: number;
      backupRef: string;
      notes: string;
    } | null;
    ageDays: number | null;
    stale: boolean;
    history: { ranAt: string; passed: boolean; durationSec: number }[];
  };
  queues: {
    pendingApprovals: number;
    openDisputes: number;
    draftsWaiting: number;
    resultsDue: number;
    overdueFundingWindows: number;
    unsentNotifications: number;
  };
  keys: {
    name: string;
    configured: boolean;
    currentKeyId: string | null;
    acceptedVersions: number;
  }[];
  canary: { key: string; rolloutPct: number; updatedAt: string }[];
  incidents: { id: string; title: string; state: string; severity: string; startedAt: string }[];
  audit: { staffId: string; action: string; targetRef: string; at: string }[];
}

export interface TopCallRow {
  id: string;
  handle: string | null;
  displayName: string | null;
  marketId: string;
  question: string;
  pot: string;
  entryPrice: string;
  resolvedOutcome: string;
  featured: boolean;
}

export const ops = {
  funding: (hours = 72) => request<FundingWindow[]>(`/admin/lifecycle/funding?hours=${hours}`),
  composition: (marketId: string) =>
    request<Composition>(`/admin/lifecycle/markets/${marketId}/composition`),

  config: () => request<ConfigConsole>('/admin/config'),

  creators: (q = '') => request<CreatorDeskRow[]>(`/admin/creators?q=${encodeURIComponent(q)}`),
  setLevel: (userId: string, level: number, reason: string) =>
    request<{ level: number }>(`/admin/creators/${userId}/level`, {
      method: 'POST',
      body: JSON.stringify({ level, reason }),
    }),

  flags: () => request<FeatureFlagRow[]>('/admin/growth/flags'),
  saveFlag: (flag: {
    key: string;
    description: string;
    enabled: boolean;
    rolloutPct: number;
    allowList?: string[];
  }) =>
    request<FeatureFlagRow>('/admin/growth/flags', {
      method: 'POST',
      body: JSON.stringify(flag),
    }),

  broadcasts: () => request<BroadcastRow[]>('/admin/growth/broadcasts'),
  draftBroadcast: (body: { title: string; body: string; segment: string }) =>
    request<BroadcastRow>('/admin/growth/broadcasts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  broadcastReach: (id: string) =>
    request<{ segment: string; recipients: number }>(`/admin/growth/broadcasts/${id}/reach`),
  sendBroadcast: (id: string) =>
    request<BroadcastRow>(`/admin/growth/broadcasts/${id}/send`, { method: 'POST' }),

  system: () => request<SystemRoom>('/admin/system'),

  topCalls: (week?: string) =>
    request<{ week: string; calls: TopCallRow[] }>(
      `/admin/top-calls${week === undefined ? '' : `?week=${week}`}`,
    ),
  proposeTopCalls: (week?: string) =>
    request<{ proposed: number }>(
      `/admin/top-calls/propose${week === undefined ? '' : `?week=${week}`}`,
      { method: 'POST' },
    ),
  featureTopCall: (id: string, featured: boolean) =>
    request<{ featured: boolean }>(`/admin/top-calls/${id}/feature`, {
      method: 'POST',
      body: JSON.stringify({ featured }),
    }),

  revealPii: (userId: string, fields: ('email' | 'phone')[], reason: string) =>
    request<{ email?: string; phone?: string }>(`/admin/users/${userId}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ fields, reason }),
    }),
  accessLog: (userId: string) =>
    request<{ staffId: string; fields: string[]; reason: string; at: string }[]>(
      `/admin/users/${userId}/access-log`,
    ),
};
